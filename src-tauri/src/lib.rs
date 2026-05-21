use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::Instant;

use tauri::webview::WebviewWindowBuilder;
use tauri::{Emitter, Manager, RunEvent, State, WebviewUrl, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod keychain;
mod menu;

// Origins the bundled sidecar should accept. Covers the WebView origin Tauri
// uses on macOS/Linux (`tauri://localhost`) and the equivalent Windows form
// (`http://tauri.localhost`). In debug builds (`cargo tauri dev`) the page is
// served by Vite, so we also allow the dev origins — without this the
// preflight from the dev webview gets rejected with 403.
#[cfg(debug_assertions)]
const SIDECAR_ALLOWED_ORIGINS: &str =
    "tauri://localhost,http://tauri.localhost,http://localhost:5173,http://127.0.0.1:5173";
#[cfg(not(debug_assertions))]
const SIDECAR_ALLOWED_ORIGINS: &str = "tauri://localhost,http://tauri.localhost";

struct SidecarState {
    inner: Mutex<SidecarRuntime>,
}

#[derive(Default)]
struct SidecarRuntime {
    port: Option<u16>,
    child: Option<CommandChild>,
}

#[tauri::command]
fn get_sidecar_port(state: State<SidecarState>) -> Option<u16> {
    state.inner.lock().unwrap().port
}

// ── Multi-window registry ──────────────────────────────────────────────
// One entry per OS window. The label is the Tauri window label; the entry
// carries the changeset id loaded in the window (None on picker/welcome),
// its `kind` (review window vs detached child), and — for children — the
// label of their parent review window. Used to:
//   - power duplicate-window detection (refuse opening the same id twice;
//     focus the existing window instead) — only Review-kind entries count,
//   - bind detached sidebar/inspector children to their parent so we can
//     cascade-close them and route per-parent events,
//   - keep counter monotonically increasing so labels aren't reused after
//     a window closes (an old label rejoining would collide with stale
//     bookkeeping on the JS side).

const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum WindowKind {
    Review,
    Sidebar,
    Inspector,
}

impl WindowKind {
    fn as_str(self) -> &'static str {
        match self {
            WindowKind::Review => "review",
            WindowKind::Sidebar => "sidebar",
            WindowKind::Inspector => "inspector",
        }
    }
}

struct RegistryEntry {
    changeset_id: Option<String>,
    /// Label of the parent review window, when this entry is a detached child.
    /// None for Review windows.
    parent: Option<String>,
    kind: WindowKind,
}

impl RegistryEntry {
    fn review() -> Self {
        Self {
            changeset_id: None,
            parent: None,
            kind: WindowKind::Review,
        }
    }
}

#[derive(Default)]
struct WindowRegistry {
    next_label: u32,
    by_label: HashMap<String, RegistryEntry>,
}

struct WindowRegistryState {
    inner: Mutex<WindowRegistry>,
}

#[derive(serde::Serialize, Clone)]
struct WindowEntry {
    label: String,
    #[serde(rename = "changesetId")]
    changeset_id: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct DetachedChildEntry {
    label: String,
    kind: &'static str,
}

#[tauri::command]
fn open_new_window(
    app: tauri::AppHandle,
    state: State<WindowRegistryState>,
    changeset_id: Option<String>,
) -> Result<String, String> {
    open_window_impl(&app, &state, changeset_id)
}

/// Spawn a detached child window (the sidebar/inspector popped out of a
/// review window). Called by the parent review window via `multiWindow.ts`;
/// the caller's window label is the parent. Idempotent: if a child of the
/// same kind already exists for this parent, the existing one is focused
/// and its label returned instead of building a second window.
#[tauri::command]
fn open_detached_window(
    app: tauri::AppHandle,
    state: State<WindowRegistryState>,
    window: tauri::WebviewWindow,
    kind: String,
) -> Result<String, String> {
    let parent_label = window.label().to_string();
    let kind_enum = match kind.as_str() {
        "sidebar" => WindowKind::Sidebar,
        "inspector" => WindowKind::Inspector,
        other => return Err(format!("unknown detached kind: {other}")),
    };
    let child_label = format!("detached-{parent_label}-{}", kind_enum.as_str());

    // Idempotent open. The registry is authoritative; only spawn when the
    // slot is empty. This mirrors the duplicate-focus path in multiWindow.ts.
    let already_open = state
        .inner
        .lock()
        .unwrap()
        .by_label
        .contains_key(&child_label);
    if already_open {
        if let Some(existing) = app.get_webview_window(&child_label) {
            if existing.is_minimized().unwrap_or(false) {
                let _ = existing.unminimize();
            }
            let _ = existing.set_focus();
        }
        return Ok(child_label);
    }

    // Per-kind defaults. Sidebar mirrors the docked file list shape;
    // inspector is wider to fit the AI/comment thread cards.
    let (width, height) = match kind_enum {
        WindowKind::Sidebar => (360.0, 800.0),
        WindowKind::Inspector => (480.0, 900.0),
        WindowKind::Review => unreachable!(),
    };
    let title = match kind_enum {
        WindowKind::Sidebar => "Files — Shippable",
        WindowKind::Inspector => "Inspector — Shippable",
        WindowKind::Review => unreachable!(),
    };

    // Cascade offset from the parent's position so a fresh child doesn't
    // land pixel-perfect over the parent. Same idiom as open_new_window.
    let (base_x, base_y) = app
        .get_webview_window(&parent_label)
        .and_then(|w| w.outer_position().ok())
        .map(|p| (p.x, p.y))
        .unwrap_or((100, 100));

    let url_path = format!(
        "detached.html?kind={kind}&parent={parent}",
        kind = kind_enum.as_str(),
        parent = url_encode(&parent_label),
    );
    let url = WebviewUrl::App(std::path::PathBuf::from(url_path));

    // Reserve the slot before building so the JS side sees a coherent
    // registry from the moment the child loads. Roll back on build failure.
    state.inner.lock().unwrap().by_label.insert(
        child_label.clone(),
        RegistryEntry {
            changeset_id: None,
            parent: Some(parent_label.clone()),
            kind: kind_enum,
        },
    );

    let builder = WebviewWindowBuilder::new(&app, &child_label, url)
        .title(title)
        .inner_size(width, height)
        .min_inner_size(280.0, 360.0)
        .position((base_x + 30) as f64, (base_y + 30) as f64)
        .resizable(true);

    if let Err(e) = builder.build() {
        state.inner.lock().unwrap().by_label.remove(&child_label);
        return Err(e.to_string());
    }

    Ok(child_label)
}

#[tauri::command]
fn set_window_changeset(
    window: tauri::WebviewWindow,
    state: State<WindowRegistryState>,
    changeset_id: Option<String>,
) {
    let label = window.label().to_string();
    let mut reg = state.inner.lock().unwrap();
    match reg.by_label.get_mut(&label) {
        Some(entry) => entry.changeset_id = changeset_id,
        None => {
            // Defensive: if the window somehow reports before its seed
            // landed (shouldn't happen in practice — open_window_impl and
            // the main-window setup both insert up-front), insert a Review
            // entry rather than dropping the value silently.
            reg.by_label.insert(
                label,
                RegistryEntry {
                    changeset_id,
                    parent: None,
                    kind: WindowKind::Review,
                },
            );
        }
    }
}

#[tauri::command]
fn list_window_changesets(state: State<WindowRegistryState>) -> Vec<WindowEntry> {
    state
        .inner
        .lock()
        .unwrap()
        .by_label
        .iter()
        .filter(|(_, entry)| entry.kind == WindowKind::Review)
        .map(|(label, entry)| WindowEntry {
            label: label.clone(),
            changeset_id: entry.changeset_id.clone(),
        })
        .collect()
}

#[tauri::command]
fn list_detached_children(
    state: State<WindowRegistryState>,
    parent: String,
) -> Vec<DetachedChildEntry> {
    state
        .inner
        .lock()
        .unwrap()
        .by_label
        .iter()
        .filter(|(_, entry)| entry.parent.as_deref() == Some(parent.as_str()))
        .map(|(label, entry)| DetachedChildEntry {
            label: label.clone(),
            kind: entry.kind.as_str(),
        })
        .collect()
}

#[tauri::command]
fn focus_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window with label {label}"))?;
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    win.set_focus().map_err(|e| e.to_string())
}

fn open_window_impl(
    app: &tauri::AppHandle,
    state: &State<WindowRegistryState>,
    changeset_id: Option<String>,
) -> Result<String, String> {
    // Reserve a label up-front so the JS side sees `{label, None}` the
    // moment the window starts loading — closes the race where the new
    // window comes up but its `set_window_changeset(None)` hasn't fired
    // yet and a peer asks "is X open elsewhere?".
    let label = {
        let mut reg = state.inner.lock().unwrap();
        reg.next_label += 1;
        let label = format!("window-{}", reg.next_label);
        reg.by_label.insert(label.clone(), RegistryEntry::review());
        label
    };

    // Cascade 30px down-and-right from whichever window is currently
    // focused so the new window doesn't land pixel-perfect on top.
    let (base_x, base_y) = focused_position(app).unwrap_or((100, 100));

    let url_path = match changeset_id.as_deref() {
        Some(id) => format!("index.html?cs={}", url_encode(id)),
        None => "index.html".to_string(),
    };
    let url = WebviewUrl::App(std::path::PathBuf::from(url_path));

    let builder = WebviewWindowBuilder::new(app, &label, url)
        .title("Shippable")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .position((base_x + 30) as f64, (base_y + 30) as f64)
        .resizable(true);

    if let Err(e) = builder.build() {
        // Roll back the registry slot we reserved if window creation failed,
        // otherwise duplicate detection would think a ghost window owns
        // whatever id is associated with it later.
        state.inner.lock().unwrap().by_label.remove(&label);
        return Err(e.to_string());
    }

    Ok(label)
}

fn focused_position(app: &tauri::AppHandle) -> Option<(i32, i32)> {
    for (_label, w) in app.webview_windows().iter() {
        if w.is_focused().unwrap_or(false) {
            if let Ok(pos) = w.outer_position() {
                return Some((pos.x, pos.y));
            }
        }
    }
    None
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn find_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn start_sidecar(app: tauri::AppHandle) {
    let startup = Instant::now();

    let port = match find_free_port() {
        Ok(port) => port,
        Err(e) => {
            log::warn!(
                "port allocation failed after {}ms: {e}",
                startup.elapsed().as_millis()
            );
            return;
        }
    };

    let sidecar = match app.shell().sidecar("shippable-server") {
        Ok(sidecar) => sidecar,
        Err(e) => {
            log::warn!(
                "sidecar lookup failed after {}ms: {e}",
                startup.elapsed().as_millis()
            );
            return;
        }
    }
    .env("PORT", port.to_string())
    .env("SHIPPABLE_ALLOWED_ORIGINS", SIDECAR_ALLOWED_ORIGINS)
    // Opt the sidecar into writing its OS-conventional port-discovery file
    // so the MCP server (a separate process with no IPC channel to Tauri)
    // can find the ephemeral port we picked. Gated here so the bare dev
    // server doesn't also write and clobber the file in mixed setups.
    .env("SHIPPABLE_WRITE_PORT_FILE", "1")
    // Defense-in-depth: tauri-plugin-shell inherits the parent process's
    // environment by default. Override ANTHROPIC_API_KEY to an empty string
    // so a key set in the shell that launched the .app can't shadow the
    // Keychain-backed credential the web app rehydrates via /api/auth/set.
    .env("ANTHROPIC_API_KEY", "");

    // The Bun-compiled sidecar binary can't resolve the `library/` dir
    // from `import.meta.url` the way `tsx` can, so we point it at one
    // explicitly. Dev: the source repo (edits hot-pick up without a
    // rebuild). Release: the library bundled into the .app's Resources
    // dir via `tauri.conf.json#bundle.resources`.
    #[cfg(debug_assertions)]
    let sidecar = {
        let library_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("library");
        sidecar.env(
            "SHIPPABLE_LIBRARY_PATH",
            library_path.to_string_lossy().to_string(),
        )
    };
    #[cfg(not(debug_assertions))]
    let sidecar = match app
        .path()
        .resolve("library", tauri::path::BaseDirectory::Resource)
    {
        Ok(library_path) => sidecar.env(
            "SHIPPABLE_LIBRARY_PATH",
            library_path.to_string_lossy().to_string(),
        ),
        Err(e) => {
            log::warn!("bundled library resource not resolvable: {e}");
            sidecar
        }
    };

    match sidecar.spawn() {
        Ok((mut rx, child)) => {
            log::info!(
                "sidecar spawned (port={port}) in {}ms; awaiting listener",
                startup.elapsed().as_millis()
            );

            // Stash the child immediately for kill-on-exit, but leave `port`
            // unset — clients use port presence as the readiness signal, and
            // Node hasn't bound the listener yet at this point.
            {
                let state = app.state::<SidecarState>();
                state.inner.lock().unwrap().child = Some(child);
            }

            let app_for_task = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut announced = false;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            let trimmed = line.trim_end();
                            log::info!("[sidecar] {trimmed}");
                            // Server logs this once `listen()` callback fires
                            // (server/src/index.ts). That's the moment the
                            // loopback port is actually accepting connections,
                            // so it's the moment we can let the WebView probe.
                            if !announced && trimmed.contains("[server] listening") {
                                announced = true;
                                let state = app_for_task.state::<SidecarState>();
                                state.inner.lock().unwrap().port = Some(port);
                                log::info!(
                                    "sidecar listener ready on 127.0.0.1:{port} in {}ms",
                                    startup.elapsed().as_millis()
                                );
                                let _ = app_for_task.emit("shippable:sidecar-ready", port);
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            log::warn!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end());
                        }
                        CommandEvent::Terminated(payload) => {
                            log::warn!(
                                "[sidecar] terminated (code={:?}, signal={:?})",
                                payload.code,
                                payload.signal
                            );
                            if !announced {
                                let _ = app_for_task.emit(
                                    "shippable:sidecar-failed",
                                    format!(
                                        "sidecar exited before listening (code={:?}, signal={:?})",
                                        payload.code, payload.signal
                                    ),
                                );
                            }
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => {
            log::warn!(
                "sidecar spawn failed after {}ms: {e}",
                startup.elapsed().as_millis()
            );
            let _ = app.emit("shippable:sidecar-failed", format!("spawn failed: {e}"));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_sidecar_port,
            open_new_window,
            open_detached_window,
            set_window_changeset,
            list_window_changesets,
            list_detached_children,
            focus_window,
            keychain::keychain_get,
            keychain::keychain_set,
            keychain::keychain_remove,
        ])
        .setup(|app| {
            // Logger runs in both debug and release. The .app bundle has no
            // attached terminal once launched from Finder, but `log!` calls
            // still surface in Console.app and are captured when the binary
            // is launched directly from a shell.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            app.manage(SidecarState {
                inner: Mutex::new(SidecarRuntime::default()),
            });

            // Seed the registry with the main window so duplicate detection
            // sees it from boot. New windows insert themselves in
            // open_window_impl; the global window-event handler in run()
            // cleans up entries when any window is destroyed.
            let registry = WindowRegistryState {
                inner: Mutex::new(WindowRegistry::default()),
            };
            registry
                .inner
                .lock()
                .unwrap()
                .by_label
                .insert(MAIN_WINDOW_LABEL.to_string(), RegistryEntry::review());
            app.manage(registry);

            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if let Some(action) = menu::action_for(event.id()) {
                    if action == "new-window" {
                        let state = app.state::<WindowRegistryState>();
                        if let Err(e) = open_window_impl(app, &state, None) {
                            log::warn!("New Window from menu failed: {e}");
                        }
                        return;
                    }
                    let _ = app.emit("shippable:menu", action);
                }
            });

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || start_sidecar(app_handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<SidecarState>() {
                if let Some(child) = state.inner.lock().unwrap().child.take() {
                    let _ = child.kill();
                }
            }
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } => {
            // Drop the entry first so subsequent registry queries are
            // consistent. Capture parent + kind out of the removed entry
            // so we can drive cascade-close (when a Review dies) and the
            // children-changed signal (when a detached child dies) without
            // holding the lock across `.close()` calls.
            let mut to_cascade_close: Vec<String> = Vec::new();
            let mut child_parent: Option<String> = None;
            if let Some(state) = app_handle.try_state::<WindowRegistryState>() {
                let mut reg = state.inner.lock().unwrap();
                let removed = reg.by_label.remove(&label);
                if let Some(entry) = removed {
                    match entry.kind {
                        WindowKind::Review => {
                            for (child_label, child_entry) in reg.by_label.iter() {
                                if child_entry.parent.as_deref() == Some(label.as_str()) {
                                    to_cascade_close.push(child_label.clone());
                                }
                            }
                        }
                        WindowKind::Sidebar | WindowKind::Inspector => {
                            child_parent = entry.parent;
                        }
                    }
                }
            }
            for child_label in &to_cascade_close {
                if let Some(win) = app_handle.get_webview_window(child_label) {
                    let _ = win.close();
                }
            }
            if let Some(parent) = child_parent {
                let _ = app_handle.emit(
                    &format!("shippable:detach-children-changed:{parent}"),
                    (),
                );
            }
            // Quit when the last window closes. Tauri 2 keeps the macOS app
            // alive by default; for a per-window reviewer that just means
            // an invisible orphan process holding the sidecar. Cascade-
            // initiated child closes are still in flight here (`.close()`
            // is async), so `webview_windows()` is non-empty and we don't
            // quit prematurely — the children's own Destroyed events tip
            // the count to zero at the right moment.
            if app_handle.webview_windows().is_empty() {
                app_handle.exit(0);
            }
        }
        _ => {}
    });
}
