//! Multi-client MCP registration on Unix hosts. macOS is the only platform
//! we ship and test today; other Unix-likes (Linux, BSDs) would mostly
//! work but the per-client config-file locations are macOS-shaped.
//! Windows is deliberately out of scope until we add a target-specific
//! sibling — different config directories, no shared mode-preservation
//! primitive, no `PermissionsExt`.
//!
//! Five "targets" — clients that each have their own config file and a
//! slot for declaring an MCP server. Four are JSON-shaped with a top-level
//! `mcpServers` map (Claude, Claude Desktop, Cursor, Windsurf); Codex CLI
//! uses TOML with `[mcp_servers.<name>]` tables. Detection is best-effort:
//! we look for the config dir or file.
//!
//! Writes preserve everything we don't touch — including unrelated fields
//! inside our own `shippable` entry. If the user added `args`, `env`, or
//! custom fields to the entry, we update only `command` and leave the rest.
//! JSON preserves order via `serde_json` with `preserve_order`; TOML keeps
//! comments and key ordering via `toml_edit`.
//!
//! JSON vs TOML shape: fresh entries we create are minimal — `{ command }`
//! is enough for every client we target. JSON omits `type` because all four
//! JSON clients (Claude, Claude Desktop, Cursor, Windsurf) treat stdio as
//! the default; Codex's TOML schema is `#[serde(untagged)]` with no `type`
//! field at all (variant is discriminated by `command` vs `url`).

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
        // Registration writes to `~/.claude.json`, which is specifically
        // Claude Code's config file — Claude Desktop has its own
        // (handled below). Detection is looser (any `.claude/` dir
        // counts); registering on a machine that doesn't actually have
        // Claude Code installed is harmless.
        id: "claude-code",
        display_name: "Claude",
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

/// One copy-pasteable install snippet per client. The UI renders these
/// verbatim — Shippable no longer writes to user configs itself. `kind`
/// drives the rendering hint (command line vs. JSON/TOML block + path).
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SnippetBody {
    /// A shell command the user pastes into a terminal (Claude Code CLI).
    Command { value: String },
    /// A JSON fragment the user pastes into `config_path`.
    /// `value` is a self-contained `"shippable": { ... }` entry — callers
    /// merge it into their `mcpServers` map.
    Json { value: String },
    /// A TOML fragment for Codex CLI's `~/.codex/config.toml`.
    Toml { value: String },
}

#[derive(Serialize, Clone)]
pub struct TargetSnippet {
    pub id: String,
    pub display_name: String,
    /// Where the snippet goes — `claude` for the command form, a config
    /// file path for JSON/TOML. Rendered as plain text next to the chip.
    pub config_path: String,
    pub detected: bool,
    /// What `command` field is currently set on the user's `shippable` entry,
    /// if any. Drives the "already set up" / "currently points elsewhere"
    /// hint next to the chip.
    pub current_command: Option<String>,
    #[serde(flatten)]
    pub body: SnippetBody,
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

/// Follows symlinks to the underlying real path so we can rewrite the
/// target rather than replace the link. Handles three cases:
/// - File exists (possibly through a symlink): full `canonicalize`.
/// - File doesn't exist but parent dir does (possibly symlinked): join the
///   canonical parent with the original file name.
/// - Neither exists: return the path as-is; `create_dir_all` will follow
///   whatever symlinks materialize during creation.
fn resolve_path_following_symlinks(path: &Path) -> PathBuf {
    if let Ok(real) = fs::canonicalize(path) {
        return real;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(real_parent) = fs::canonicalize(parent) {
            return real_parent.join(name);
        }
    }
    path.to_path_buf()
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    // Resolve symlinks before touching anything. If `path` is a symlink
    // into a dotfiles repo (chezmoi / stow / etc.), `fs::rename` over it
    // would replace the link with a regular file — the dotfiles repo
    // would silently stop being the source of truth. By operating on the
    // canonical path we rewrite the file the link points at, leaving the
    // link itself intact.
    let resolved = resolve_path_following_symlinks(path);
    let path = resolved.as_path();

    let dir = path
        .parent()
        .ok_or_else(|| format!("config path has no parent: {}", path.display()))?;
    // Lock down newly-created config dirs to 0700. These dirs typically
    // hold API tokens / credentials for the client. If the dir already
    // exists, respect the user's chosen perms.
    let dir_was_missing = !dir.exists();
    fs::create_dir_all(dir)
        .map_err(|e| format!("could not create directory {}: {e}", dir.display()))?;
    if dir_was_missing {
        // Best-effort: a failure to chmod doesn't justify aborting the
        // whole write — but log it via the error path if we somehow can't.
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
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
        // fsync the data before the rename — the rename is only atomic in
        // the directory-entry sense; data durability requires sync. If
        // sync fails (disk full, IO error), we must not promote the tmp.
        f.sync_all().map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("could not fsync temp file {}: {e}", tmp.display())
        })?;
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
        format!(
            "could not rename {} → {}: {e}",
            tmp.display(),
            path.display()
        )
    })
}

/// What `register_json` / `register_toml` did. `Unchanged` means the file
/// was not rewritten — so reporting `NoChange` upstream is honest about
/// mtime and content. `Added` and `Updated { previous }` both involve a
/// write.
enum WriteOutcome {
    Unchanged,
    Added,
    Updated { previous: String },
}

fn register_json(path: &Path, binary: &str) -> Result<WriteOutcome, String> {
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

    let outcome = match servers.get_mut("shippable") {
        Some(Value::Object(entry)) => {
            let previous = entry
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_string);
            match previous {
                Some(p) if p == binary => return Ok(WriteOutcome::Unchanged),
                Some(p) => {
                    entry.insert("command".to_string(), Value::String(binary.to_string()));
                    WriteOutcome::Updated { previous: p }
                }
                None => {
                    entry.insert("command".to_string(), Value::String(binary.to_string()));
                    WriteOutcome::Added
                }
            }
        }
        // Entry missing or not an object — replace/insert a fresh minimal
        // record. We only ship `command` here because every JSON client we
        // target (Claude Code, Claude Desktop, Cursor, Windsurf) treats
        // stdio as the default and fills in `args`/`env` itself.
        _ => {
            servers.insert(
                "shippable".to_string(),
                json!({ "command": binary }),
            );
            WriteOutcome::Added
        }
    };

    let serialized = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("could not serialize JSON: {e}"))?;
    write_atomic(path, &serialized)?;
    Ok(outcome)
}

fn register_toml(path: &Path, binary: &str) -> Result<WriteOutcome, String> {
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

    let outcome = match servers.get_mut("shippable").and_then(Item::as_table_mut) {
        Some(entry) => {
            let previous = entry
                .get("command")
                .and_then(Item::as_str)
                .map(str::to_string);
            match previous {
                Some(p) if p == binary => return Ok(WriteOutcome::Unchanged),
                Some(p) => {
                    entry.insert("command", toml_edit::value(binary));
                    WriteOutcome::Updated { previous: p }
                }
                None => {
                    entry.insert("command", toml_edit::value(binary));
                    WriteOutcome::Added
                }
            }
        }
        // Entry missing or not a table — insert a fresh one. Codex's TOML
        // schema is `#[serde(untagged)]` with no `type` field; `args`
        // defaults to `[]` when absent.
        None => {
            let mut entry = Table::new();
            entry.insert("command", toml_edit::value(binary));
            servers.insert("shippable", Item::Table(entry));
            WriteOutcome::Added
        }
    };

    write_atomic(path, &doc.to_string())?;
    Ok(outcome)
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
    let status = match result {
        Ok(WriteOutcome::Unchanged) => OutcomeStatus::NoChange,
        Ok(WriteOutcome::Added) => OutcomeStatus::Added,
        Ok(WriteOutcome::Updated { previous }) => OutcomeStatus::Replaced {
            previous_command: previous,
        },
        Err(e) => OutcomeStatus::Failed { error: e },
    };
    RegisterOutcome {
        id: spec.id.to_string(),
        display_name: spec.display_name.to_string(),
        config_path: config_path_str,
        status,
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

/// Tilde-home form of `~/...` paths — what we show in the UI. Users paste
/// these straight into their editor; expansion happens at read time by the
/// client. Falls back to the absolute form if `$HOME` isn't a prefix.
fn tildify(path: &Path) -> String {
    let abs = path.to_string_lossy().into_owned();
    let Ok(h) = home() else { return abs };
    let home_s = h.to_string_lossy().into_owned();
    abs.strip_prefix(&home_s)
        .map(|rest| format!("~{rest}"))
        .unwrap_or(abs)
}

/// Placeholder rendered when there's no bundled sidecar next to the app
/// (i.e. `tauri dev`). The user sees a clear marker that the path will be
/// real in a packaged DMG build; copying the snippet still works as a
/// template.
const BINARY_PLACEHOLDER: &str = "<path-to-shippable-mcp-from-packaged-build>";

fn build_snippet(spec: &Spec, binary: &str) -> TargetSnippet {
    let path = config_path(spec).unwrap_or_default();
    // Clients that ship their own MCP-install CLI get a one-line command;
    // anything else gets a config-file snippet the user pastes themselves.
    // Codex CLI: `codex mcp add <name> -- <command>` (in tree since 0.x;
    // see openai/codex codex-rs/cli/src/mcp_cmd.rs).
    let body = match (spec.id, spec.format) {
        ("claude-code", _) => SnippetBody::Command {
            value: format!("claude mcp add shippable -- {binary}"),
        },
        ("codex", _) => SnippetBody::Command {
            value: format!("codex mcp add shippable -- {binary}"),
        },
        (_, Format::Json) => SnippetBody::Json {
            value: format!(
                "\"shippable\": {{\n  \"command\": \"{binary}\"\n}}"
            ),
        },
        (_, Format::Toml) => SnippetBody::Toml {
            value: format!(
                "[mcp_servers.shippable]\ncommand = \"{binary}\""
            ),
        },
    };
    let config_path = match spec.id {
        // For CLI commands, the "path" we show is the CLI invocation point —
        // users run a tool, they don't open a file.
        "claude-code" => "claude (CLI)".to_string(),
        "codex" => "codex (CLI)".to_string(),
        _ => tildify(&path),
    };
    TargetSnippet {
        id: spec.id.to_string(),
        display_name: spec.display_name.to_string(),
        config_path,
        detected: detected(spec),
        current_command: read_current_command(spec),
        body,
    }
}

#[tauri::command]
pub fn mcp_install_snippets() -> Vec<TargetSnippet> {
    let binary = sibling_mcp_binary()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| BINARY_PLACEHOLDER.to_string());
    SPECS.iter().map(|spec| build_snippet(spec, &binary)).collect()
}

/// Auto-install replaced by copy-paste snippets in the UI (see
/// `mcp_install_snippets`). The writer is left in tree for one release so
/// any external caller fails loudly instead of silently disappearing;
/// scheduled for deletion alongside `register_json` / `register_toml` /
/// `write_atomic` in a follow-up commit.
#[deprecated(
    note = "auto-install removed; UI now shows copy-paste snippets via mcp_install_snippets"
)]
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

    #[test]
    fn write_atomic_preserves_symlink_to_real_file() {
        // Simulates a dotfiles-symlink setup: ~/.claude.json -> ~/dotfiles/claude.json.
        // After rewriting via the symlink, the link must still exist and
        // point at the same target, and the target must have the new content.
        let real = unique_tmp_path("dotfiles-real.json");
        let link = unique_tmp_path("dotfiles-link.json");
        fs::write(&real, "{\"old\":true}").unwrap();
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        write_atomic(&link, "{\"new\":true}").expect("write should succeed via the link");

        // Link itself must still be a symlink.
        let link_meta = fs::symlink_metadata(&link).unwrap();
        assert!(
            link_meta.file_type().is_symlink(),
            "symlink should survive rewrite"
        );
        // It must still point at the same real file.
        assert_eq!(fs::read_link(&link).unwrap(), real);
        // And the real file got the new content.
        assert_eq!(fs::read_to_string(&real).unwrap(), "{\"new\":true}");

        let _ = fs::remove_file(&link);
        let _ = fs::remove_file(&real);
    }

    #[test]
    fn write_atomic_locks_down_newly_created_parent_dir() {
        // First write into a path whose parent directory doesn't exist yet
        // should leave that parent dir at 0o700.
        let parent = unique_tmp_path("locked-parent");
        let _ = fs::remove_dir_all(&parent);
        let path = parent.join("config.json");

        write_atomic(&path, "{}").expect("write_atomic should succeed");

        let parent_mode = fs::metadata(&parent).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            parent_mode, 0o700,
            "freshly-created config dir should be locked to 0700, was {parent_mode:o}"
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn write_atomic_leaves_existing_parent_dir_perms_alone() {
        // If the parent dir already exists, we must not change its perms —
        // it might belong to another tool whose chosen mode we should respect.
        let parent = unique_tmp_path("existing-parent");
        fs::create_dir_all(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        let path = parent.join("config.json");

        write_atomic(&path, "{}").expect("write_atomic should succeed");

        let parent_mode = fs::metadata(&parent).unwrap().permissions().mode() & 0o777;
        assert_eq!(parent_mode, 0o755, "pre-existing dir perms should survive");
        let _ = fs::remove_dir_all(&parent);
    }

    fn matches_added(o: &WriteOutcome) -> bool {
        matches!(o, WriteOutcome::Added)
    }
    fn matches_unchanged(o: &WriteOutcome) -> bool {
        matches!(o, WriteOutcome::Unchanged)
    }
    fn matches_updated(o: &WriteOutcome, prev: &str) -> bool {
        matches!(o, WriteOutcome::Updated { previous } if previous == prev)
    }

    #[test]
    fn register_json_preserves_user_customizations() {
        let path = unique_tmp_path("preserve-customizations.json");
        // User has set custom args and env on the shippable entry, plus
        // another unrelated server. None of this should disappear when we
        // bump the binary path.
        let existing = r#"{
  "mcpServers": {
    "shippable": {
      "command": "/old/path/shippable-mcp",
      "args": ["--verbose"],
      "env": { "RUST_LOG": "debug" }
    },
    "other-server": { "command": "/path/to/other" }
  }
}"#;
        fs::write(&path, existing).unwrap();

        let outcome =
            register_json(&path, "/new/path/shippable-mcp").expect("register should succeed");
        assert!(
            matches_updated(&outcome, "/old/path/shippable-mcp"),
            "outcome = {:?}",
            matches_unchanged(&outcome)
        );

        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let shippable = v
            .get("mcpServers")
            .and_then(|s| s.get("shippable"))
            .and_then(Value::as_object)
            .expect("shippable entry");
        assert_eq!(
            shippable.get("command").and_then(Value::as_str),
            Some("/new/path/shippable-mcp")
        );
        assert_eq!(
            shippable
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.len()),
            Some(1),
            "args should be preserved"
        );
        assert_eq!(
            shippable
                .get("env")
                .and_then(Value::as_object)
                .and_then(|o| o.get("RUST_LOG"))
                .and_then(Value::as_str),
            Some("debug"),
            "env should be preserved"
        );
        assert!(
            v.get("mcpServers")
                .and_then(|s| s.get("other-server"))
                .is_some(),
            "other servers should survive"
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn register_json_unchanged_leaves_file_byte_identical() {
        let path = unique_tmp_path("byte-identical.json");
        let existing = r#"{
  "mcpServers": {
    "shippable": {
      "command": "/path/to/binary",
      "args": ["--quiet"]
    }
  }
}"#;
        fs::write(&path, existing).unwrap();
        let mtime_before = fs::metadata(&path).unwrap().modified().unwrap();
        let bytes_before = fs::read(&path).unwrap();

        // Sleep enough that the filesystem mtime resolution can tick over,
        // otherwise an erroneous write would still look unchanged here.
        std::thread::sleep(std::time::Duration::from_millis(10));

        let outcome = register_json(&path, "/path/to/binary").expect("register should succeed");
        assert!(matches_unchanged(&outcome));

        let mtime_after = fs::metadata(&path).unwrap().modified().unwrap();
        let bytes_after = fs::read(&path).unwrap();
        assert_eq!(
            mtime_before, mtime_after,
            "mtime must not advance on NoChange"
        );
        assert_eq!(bytes_before, bytes_after, "file must be byte-identical");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn register_json_creates_minimal_entry_on_fresh_file() {
        let path = unique_tmp_path("fresh.json");
        let _ = fs::remove_file(&path);

        let outcome = register_json(&path, "/new/binary").expect("register should succeed");
        assert!(matches_added(&outcome));

        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let shippable = v
            .get("mcpServers")
            .and_then(|s| s.get("shippable"))
            .and_then(Value::as_object)
            .expect("shippable entry");
        assert_eq!(
            shippable.get("command").and_then(Value::as_str),
            Some("/new/binary")
        );
        // Fresh entries should be minimal — no `type`, no empty `args`/`env`.
        assert!(shippable.get("type").is_none());
        assert!(shippable.get("args").is_none());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn register_toml_preserves_user_customizations_and_comments() {
        let path = unique_tmp_path("preserve.toml");
        let existing = r#"# Codex MCP servers
[mcp_servers.shippable]
command = "/old/path/shippable-mcp"
args = ["--verbose"]
# bumped because of issue 42
startup_timeout_sec = 30

[mcp_servers.other]
command = "/other"
"#;
        fs::write(&path, existing).unwrap();

        let outcome =
            register_toml(&path, "/new/path/shippable-mcp").expect("register should succeed");
        assert!(matches_updated(&outcome, "/old/path/shippable-mcp"));

        let after = fs::read_to_string(&path).unwrap();
        assert!(
            after.contains("startup_timeout_sec = 30"),
            "user customization should survive\n---\n{after}"
        );
        assert!(
            after.contains("--verbose"),
            "args should be preserved\n---\n{after}"
        );
        assert!(
            after.contains("# Codex MCP servers"),
            "top-level comment should survive\n---\n{after}"
        );
        assert!(
            after.contains("# bumped because of issue 42"),
            "inline comment should survive\n---\n{after}"
        );
        assert!(
            after.contains("\"/new/path/shippable-mcp\""),
            "command should be updated\n---\n{after}"
        );
        assert!(
            after.contains("[mcp_servers.other]"),
            "other servers should survive\n---\n{after}"
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn register_toml_unchanged_leaves_file_byte_identical() {
        let path = unique_tmp_path("byte-identical.toml");
        let existing = r#"[mcp_servers.shippable]
command = "/path/to/binary"
args = ["--quiet"]
"#;
        fs::write(&path, existing).unwrap();
        let bytes_before = fs::read(&path).unwrap();

        std::thread::sleep(std::time::Duration::from_millis(10));
        let outcome = register_toml(&path, "/path/to/binary").expect("register should succeed");
        assert!(matches_unchanged(&outcome));

        let bytes_after = fs::read(&path).unwrap();
        assert_eq!(
            bytes_before, bytes_after,
            "file must be byte-identical on NoChange"
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn register_toml_creates_minimal_entry_on_fresh_file() {
        let path = unique_tmp_path("fresh.toml");
        let _ = fs::remove_file(&path);

        let outcome = register_toml(&path, "/new/binary").expect("register should succeed");
        assert!(matches_added(&outcome));

        let after = fs::read_to_string(&path).unwrap();
        assert!(after.contains("[mcp_servers.shippable]"));
        assert!(after.contains("\"/new/binary\""));
        // Codex's untagged enum has no `type`; fresh entries shouldn't write one.
        assert!(!after.contains("type ="));
        // Empty args = [] is also unnecessary noise; serde default handles it.
        assert!(!after.contains("args ="));
        let _ = fs::remove_file(&path);
    }
}
