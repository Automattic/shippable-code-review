// Multi-client MCP registration. We support five "targets" — clients that
// each have their own config file and a slot for declaring an MCP server.
// Four are JSON-shaped with a top-level `mcpServers` map (Claude Code, Claude
// Desktop, Cursor, Windsurf); Codex CLI uses TOML with `[mcp_servers.<name>]`
// tables. Detection is best-effort: we look for the config dir or file.
//
// Writes preserve everything we don't touch: JSON via serde_json with
// `preserve_order`, TOML via `toml_edit` which keeps comments and key
// ordering intact.

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use toml_edit::{DocumentMut, Item, Table};

#[derive(Clone, Copy)]
enum Format {
    Json,
    Toml,
}

struct Spec {
    id: &'static str,
    display_name: &'static str,
    relative_path: &'static str,
    /// Optional sibling dir to also check for detection — Claude Code, for
    /// example, has a `.claude/` dir alongside `.claude.json`. Helps when the
    /// canonical file hasn't been created yet but the client is installed.
    detection_hint_dir: Option<&'static str>,
    format: Format,
}

const SPECS: &[Spec] = &[
    Spec {
        id: "claude-code",
        display_name: "Claude Code",
        relative_path: ".claude.json",
        detection_hint_dir: Some(".claude"),
        format: Format::Json,
    },
    Spec {
        id: "claude-desktop",
        display_name: "Claude Desktop",
        relative_path: "Library/Application Support/Claude/claude_desktop_config.json",
        detection_hint_dir: Some("Library/Application Support/Claude"),
        format: Format::Json,
    },
    Spec {
        id: "codex",
        display_name: "Codex CLI",
        relative_path: ".codex/config.toml",
        detection_hint_dir: Some(".codex"),
        format: Format::Toml,
    },
    Spec {
        id: "cursor",
        display_name: "Cursor",
        relative_path: ".cursor/mcp.json",
        detection_hint_dir: Some(".cursor"),
        format: Format::Json,
    },
    Spec {
        id: "windsurf",
        display_name: "Windsurf",
        relative_path: ".codeium/windsurf/mcp_config.json",
        detection_hint_dir: Some(".codeium/windsurf"),
        format: Format::Json,
    },
];

#[derive(Serialize, Clone)]
pub struct TargetInfo {
    pub id: String,
    pub display_name: String,
    pub config_path: String,
    pub detected: bool,
    pub current_command: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct DiscoverResult {
    pub targets: Vec<TargetInfo>,
    /// The sidecar path that would be written on apply. `None` in `tauri dev`
    /// (no bundled binary next to the app); callers should still let the user
    /// pick, but skip "already registered" comparisons.
    pub binary_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum OutcomeStatus {
    Added,
    Replaced { previous_command: String },
    NoChange,
    Failed { error: String },
}

#[derive(Serialize, Clone)]
pub struct RegisterOutcome {
    pub id: String,
    pub display_name: String,
    pub config_path: String,
    #[serde(flatten)]
    pub status: OutcomeStatus,
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME environment variable is not set".to_string())
}

fn config_path(spec: &Spec) -> Result<PathBuf, String> {
    Ok(home()?.join(spec.relative_path))
}

fn detected(spec: &Spec) -> bool {
    let Ok(h) = home() else {
        return false;
    };
    if h.join(spec.relative_path).exists() {
        return true;
    }
    if let Some(dir) = spec.detection_hint_dir {
        if h.join(dir).is_dir() {
            return true;
        }
    }
    false
}

fn read_current_command(spec: &Spec) -> Option<String> {
    let path = config_path(spec).ok()?;
    let text = fs::read_to_string(&path).ok()?;
    match spec.format {
        Format::Json => {
            let v: Value = serde_json::from_str(&text).ok()?;
            v.get("mcpServers")?
                .get("shippable")?
                .get("command")?
                .as_str()
                .map(|s| s.to_string())
        }
        Format::Toml => {
            let doc: DocumentMut = text.parse().ok()?;
            doc.as_table()
                .get("mcp_servers")?
                .as_table()?
                .get("shippable")?
                .as_table()?
                .get("command")?
                .as_str()
                .map(|s| s.to_string())
        }
    }
}

pub fn discover() -> Vec<TargetInfo> {
    SPECS
        .iter()
        .map(|spec| TargetInfo {
            id: spec.id.to_string(),
            display_name: spec.display_name.to_string(),
            config_path: config_path(spec)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            detected: detected(spec),
            current_command: read_current_command(spec),
        })
        .collect()
}

pub fn sibling_mcp_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("could not resolve current executable: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current executable has no parent directory".to_string())?;
    let candidate = dir.join("shippable-mcp");
    if !candidate.exists() {
        return Err(format!(
            "shippable-mcp binary not found next to the app at {}. \
             This is expected during `tauri dev` — install the .dmg build to register the MCP.",
            candidate.display()
        ));
    }
    Ok(candidate)
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("config path has no parent: {}", path.display()))?;
    fs::create_dir_all(dir)
        .map_err(|e| format!("could not create directory {}: {e}", dir.display()))?;
    // Preserve the original file's mode across the rename. `fs::File::create`
    // gives us 0644-after-umask; without this, a user's `chmod 600` config
    // would silently widen to world-readable when we rewrite it.
    let original_mode = fs::metadata(path).ok().map(|m| m.permissions().mode());
    let tmp = dir.join(format!(
        ".{}.shippable-tmp.{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "config".to_string()),
        std::process::id()
    ));
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| format!("could not create temp file {}: {e}", tmp.display()))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("could not write temp file {}: {e}", tmp.display()))?;
        f.sync_all().ok();
    }
    if let Some(mode) = original_mode {
        if let Err(e) = fs::set_permissions(&tmp, fs::Permissions::from_mode(mode)) {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "could not restore mode {:o} on {}: {e}",
                mode,
                tmp.display()
            ));
        }
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not rename {} → {}: {e}", tmp.display(), path.display())
    })
}

fn register_json(path: &Path, binary: &str) -> Result<Option<String>, String> {
    let mut root: Value = match fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => Value::Object(Map::new()),
        Ok(t) => serde_json::from_str(&t)
            .map_err(|e| format!("could not parse {}: {e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Object(Map::new()),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let obj = root
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "mcpServers must be a JSON object".to_string())?;

    let previous = servers
        .get("shippable")
        .and_then(|v| v.get("command"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    servers.insert(
        "shippable".to_string(),
        json!({ "type": "stdio", "command": binary, "args": [], "env": {} }),
    );

    let serialized = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("could not serialize JSON: {e}"))?;
    write_atomic(path, &serialized)?;
    Ok(previous)
}

fn register_toml(path: &Path, binary: &str) -> Result<Option<String>, String> {
    let mut doc: DocumentMut = match fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => DocumentMut::new(),
        Ok(t) => t
            .parse()
            .map_err(|e| format!("could not parse {}: {e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DocumentMut::new(),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };

    if !doc.as_table().contains_key("mcp_servers") {
        let mut t = Table::new();
        t.set_implicit(true);
        doc.insert("mcp_servers", Item::Table(t));
    }
    let servers = doc["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| "mcp_servers must be a TOML table".to_string())?;
    servers.set_implicit(true);

    let previous = servers
        .get("shippable")
        .and_then(|item| item.as_table())
        .and_then(|t| t.get("command"))
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());

    let mut entry = Table::new();
    entry.insert("command", toml_edit::value(binary));
    entry.insert("args", toml_edit::value(toml_edit::Array::new()));
    servers.insert("shippable", Item::Table(entry));

    write_atomic(path, &doc.to_string())?;
    Ok(previous)
}

fn register_one(spec: &Spec, binary: &str) -> RegisterOutcome {
    let path = match config_path(spec) {
        Ok(p) => p,
        Err(e) => {
            return RegisterOutcome {
                id: spec.id.to_string(),
                display_name: spec.display_name.to_string(),
                config_path: String::new(),
                status: OutcomeStatus::Failed { error: e },
            };
        }
    };
    let result = match spec.format {
        Format::Json => register_json(&path, binary),
        Format::Toml => register_toml(&path, binary),
    };
    let config_path_str = path.to_string_lossy().into_owned();
    match result {
        Ok(Some(prev)) if prev == binary => RegisterOutcome {
            id: spec.id.to_string(),
            display_name: spec.display_name.to_string(),
            config_path: config_path_str,
            status: OutcomeStatus::NoChange,
        },
        Ok(Some(prev)) => RegisterOutcome {
            id: spec.id.to_string(),
            display_name: spec.display_name.to_string(),
            config_path: config_path_str,
            status: OutcomeStatus::Replaced {
                previous_command: prev,
            },
        },
        Ok(None) => RegisterOutcome {
            id: spec.id.to_string(),
            display_name: spec.display_name.to_string(),
            config_path: config_path_str,
            status: OutcomeStatus::Added,
        },
        Err(e) => RegisterOutcome {
            id: spec.id.to_string(),
            display_name: spec.display_name.to_string(),
            config_path: config_path_str,
            status: OutcomeStatus::Failed { error: e },
        },
    }
}

#[tauri::command]
pub fn discover_mcp_targets() -> DiscoverResult {
    DiscoverResult {
        targets: discover(),
        binary_path: sibling_mcp_binary()
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn register_mcp_targets(ids: Vec<String>) -> Result<Vec<RegisterOutcome>, String> {
    let binary = sibling_mcp_binary()?;
    let binary_str = binary.to_string_lossy().into_owned();
    Ok(ids
        .into_iter()
        .map(|id| match SPECS.iter().find(|s| s.id == id) {
            Some(spec) => register_one(spec, &binary_str),
            None => RegisterOutcome {
                id: id.clone(),
                display_name: id,
                config_path: String::new(),
                status: OutcomeStatus::Failed {
                    error: "unknown target id".to_string(),
                },
            },
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn unique_tmp_path(name: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "shippable-mcp_targets-{}-{}-{}",
            std::process::id(),
            n,
            name
        ))
    }

    #[test]
    fn write_atomic_preserves_existing_file_mode() {
        let path = unique_tmp_path("preserve.json");
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        write_atomic(&path, "{\"x\":1}").expect("write_atomic should succeed");

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "mode should survive rewrite");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"x\":1}");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn write_atomic_creates_new_file_when_absent() {
        let path = unique_tmp_path("new.json");
        let _ = fs::remove_file(&path);

        write_atomic(&path, "{}").expect("write_atomic should succeed");

        assert!(path.exists());
        let _ = fs::remove_file(&path);
    }
}
