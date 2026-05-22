use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::Instant;

use tauri::webview::WebviewWindowBuilder;
use tauri::{Emitter, Manager, RunEvent, State, WebviewUrl, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod keychain;
mod mcp_targets;
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
    /// Set once either the forwarder or the probe has decided the sidecar
    /// won't come up. Coordinates between the two tasks so we emit
    /// `shippable:sidecar-failed` at most once.
    failed: bool,
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

/// What the run-loop should do in response to a window being destroyed.
/// Computed under the registry lock; consumed without it so we don't hold
/// the mutex across `app.emit` / window destruction.
#[derive(Debug, PartialEq, Eq)]
enum DestroyAction {
    /// A review window died; its detached children need to follow.
    CascadeClose(Vec<String>),
    /// A detached child died; tell its parent's bridge so it can refresh
    /// the dock button.
    NotifyParent(String),
    /// Nothing to do (unknown label or detached child without a parent).
    Nothing,
}

impl WindowRegistry {
    /// Atomically remove an entry and decide what cleanup the run-loop
    /// should perform.
    fn on_window_destroyed(&mut self, label: &str) -> DestroyAction {
        let Some(entry) = self.by_label.remove(label) else {
            return DestroyAction::Nothing;
        };
        match entry.kind {
            WindowKind::Review => {
                let children: Vec<String> = self
                    .by_label
                    .iter()
                    .filter(|(_, e)| e.parent.as_deref() == Some(label))
                    .map(|(k, _)| k.clone())
                    .collect();
                DestroyAction::CascadeClose(children)
            }
            WindowKind::Sidebar | WindowKind::Inspector => match entry.parent {
                Some(p) => DestroyAction::NotifyParent(p),
                None => DestroyAction::Nothing,
            },
        }
    }
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

    // Atomic check-or-reserve: one lock pass decides whether we focus an
    // existing child or take ownership of the slot. Two concurrent opens
    // of the same parent+kind can't both pass the check-then-insert
    // without this — the second would silently overwrite the first.
    let reserved = {
        let mut reg = state.inner.lock().unwrap();
        if reg.by_label.contains_key(&child_label) {
            false
        } else {
            reg.by_label.insert(
                child_label.clone(),
                RegistryEntry {
                    changeset_id: None,
                    parent: Some(parent_label.clone()),
                    kind: kind_enum,
                },
            );
            true
        }
    };

    if !reserved {
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

    let builder = WebviewWindowBuilder::new(&app, &child_label, url)
        .title(title)
        .inner_size(width, height)
        .min_inner_size(280.0, 360.0)
        .position((base_x + 30) as f64, (base_y + 30) as f64)
        .resizable(true);

    if let Err(e) = builder.build() {
        // Build failed — roll back the slot we reserved so a retry can
        // succeed and so duplicate-focus doesn't latch onto a ghost.
        state.inner.lock().unwrap().by_label.remove(&child_label);
        return Err(e.to_string());
    }

    Ok(child_label)
}

/// Re-dock a detached sidebar/inspector child. Called from the child's
/// re-attach button. Synchronously drops the registry entry, emits the
/// parent's children-changed signal, then destroys the window — so the
/// parent's bridge state is already up-to-date by the time the OS-level
/// close fires (and the existing Destroyed arm short-circuits cleanly on
/// an already-removed entry). Calling `close()` from the closing window's
/// own JS context is racy on macOS WKWebView: the destroy event can fire
/// before the parent's `listen()` handler runs, leaving the docked panel
/// hidden. This path moves the cleanup to Rust where the ordering is
/// guaranteed.
#[tauri::command]
fn reattach_detached_window(
    app: tauri::AppHandle,
    state: State<WindowRegistryState>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let label = window.label().to_string();
    let parent = {
        let mut reg = state.inner.lock().unwrap();
        reg.by_label.remove(&label).and_then(|e| e.parent)
    };
    if let Some(parent) = parent {
        let _ = app.emit(&format!("shippable:detach-children-changed:{parent}"), ());
    }
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.destroy();
    }
    Ok(())
}

#[tauri::command]
fn set_window_changeset(
    window: tauri::WebviewWindow,
    state: State<WindowRegistryState>,
    changeset_id: Option<String>,
) {
    let label = window.label().to_string();
    let mut reg = state.inner.lock().unwrap();
    if let Some(entry) = reg.by_label.get_mut(&label) {
        entry.changeset_id = changeset_id;
    } else {
        // Every window has its entry inserted up-front (main at setup,
        // others in open_window_impl / open_detached_window). Reaching
        // this branch means an upstream invariant broke — log it rather
        // than silently fabricating a Review entry that would
        // misclassify the window in list_window_changesets /
        // list_detached_children.
        log::warn!("set_window_changeset: no registry entry for label {label}");
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
    // Force-empty ANTHROPIC_API_KEY in the sidecar's env. The sidecar
    // inherits the parent shell's environment by default; if the user has
    // this var set, the Anthropic SDK's implicit fallback (when no
    // explicit key is passed) would silently authenticate with that key
    // instead of the Keychain credential the web app rehydrates via
    // /api/auth/set. We've audited the sidecar (`grep process.env
    // server/src/`): `@anthropic-ai/sdk` is the only SDK present that
    // silently falls back to a secret-bearing env var. PATH, HTTPS_PROXY,
    // NO_PROXY, CLAUDE_MODEL, and the SHIPPABLE_* vars are intentional
    // pass-through and don't carry credentials. If we ever add another
    // SDK with that pattern (openai-sdk, aws-sdk, @octokit-auth-token),
    // the corresponding env var should join this scrub list.
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

            // Two tasks coordinate to surface readiness:
            //
            // 1. Forwarder (this task): pipes the sidecar's stdout/stderr
            //    into our logger and notifies on premature termination.
            //    Does NOT decide readiness — log format is not part of any
            //    contract.
            // 2. Probe (next task, started below): opens TCP connections
            //    to 127.0.0.1:port until one succeeds or a deadline
            //    elapses. That's the actual moment the listener is
            //    accepting connections.
            //
            // They coordinate via `SidecarState`: probe writes `port`,
            // either task can mark `failed`. Whoever crosses the line
            // first emits to the WebView; the other observes and stays
            // quiet.
            let app_for_forwarder = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            log::info!(
                                "[sidecar] {}",
                                String::from_utf8_lossy(&bytes).trim_end()
                            );
                        }
                        CommandEvent::Stderr(bytes) => {
                            log::warn!(
                                "[sidecar] {}",
                                String::from_utf8_lossy(&bytes).trim_end()
                            );
                        }
                        CommandEvent::Terminated(payload) => {
                            log::warn!(
                                "[sidecar] terminated (code={:?}, signal={:?})",
                                payload.code,
                                payload.signal
                            );
                            let claimed_failure = {
                                let state = app_for_forwarder.state::<SidecarState>();
                                let mut guard = state.inner.lock().unwrap();
                                if guard.port.is_some() || guard.failed {
                                    false
                                } else {
                                    guard.failed = true;
                                    true
                                }
                            };
                            if claimed_failure {
                                let _ = app_for_forwarder.emit(
                                    "shippable:sidecar-failed",
                                    format!(
                                        "sidecar exited before listening \
                                         (code={:?}, signal={:?})",
                                        payload.code, payload.signal
                                    ),
                                );
                            }
                            break;
                        }
                        other => {
                            // CommandEvent is `#[non_exhaustive]`; the
                            // current set includes an `Error` variant
                            // among others. Log unknown shapes instead of
                            // swallowing so future-us has something to
                            // grep for when the sidecar misbehaves.
                            log::debug!("[sidecar] unhandled event: {other:?}");
                        }
                    }
                }
            });

            spawn_sidecar_probe(app.clone(), port, startup);
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

/// Connect-loop on 127.0.0.1:<port> until the listener accepts or a hard
/// deadline elapses. This is the *real* readiness signal; the previous
/// substring-sniff on sidecar stdout coupled us to a log line and offered
/// no timeout. A TCP probe also catches the port-allocation race: if
/// another process grabbed the port between `find_free_port` and the
/// sidecar binding, the sidecar crashes on EADDRINUSE and we surface that
/// as a clear "didn't come up" error rather than an indefinite UI hang.
fn spawn_sidecar_probe(app: tauri::AppHandle, port: u16, startup: Instant) {
    tauri::async_runtime::spawn_blocking(move || {
        use std::net::{SocketAddr, TcpStream};
        use std::time::Duration;

        let addr: SocketAddr = match format!("127.0.0.1:{port}").parse() {
            Ok(a) => a,
            Err(e) => {
                log::warn!("sidecar probe: could not build socket addr: {e}");
                return;
            }
        };
        let deadline = startup + Duration::from_secs(15);

        loop {
            // The forwarder may have already marked failure; bail before
            // we waste another connect attempt.
            {
                let state = app.state::<SidecarState>();
                let guard = state.inner.lock().unwrap();
                if guard.failed {
                    return;
                }
                if guard.port.is_some() {
                    return;
                }
            }

            match TcpStream::connect_timeout(&addr, Duration::from_millis(200)) {
                Ok(_) => {
                    let state = app.state::<SidecarState>();
                    state.inner.lock().unwrap().port = Some(port);
                    log::info!(
                        "sidecar listener ready on 127.0.0.1:{port} in {}ms",
                        startup.elapsed().as_millis()
                    );
                    let _ = app.emit("shippable:sidecar-ready", port);
                    return;
                }
                Err(e) => {
                    if Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    // Took too long. Most likely: another process grabbed
                    // the port between find_free_port() and the sidecar
                    // binding (so the sidecar crashed on EADDRINUSE), or
                    // the sidecar hung during startup. Either way, the
                    // user can't do anything but retry.
                    let claimed_failure = {
                        let state = app.state::<SidecarState>();
                        let mut guard = state.inner.lock().unwrap();
                        if guard.port.is_some() || guard.failed {
                            false
                        } else {
                            guard.failed = true;
                            true
                        }
                    };
                    if claimed_failure {
                        let msg = format!(
                            "sidecar listener did not come up on 127.0.0.1:{port} \
                             within 15s. Most likely the port was taken between us \
                             and the sidecar, or the sidecar crashed during startup. \
                             Last connect error: {e}"
                        );
                        log::warn!("{msg}");
                        let _ = app.emit("shippable:sidecar-failed", msg);
                    }
                    return;
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_sidecar_port,
            open_new_window,
            open_detached_window,
            reattach_detached_window,
            set_window_changeset,
            list_window_changesets,
            list_detached_children,
            focus_window,
            keychain::keychain_get,
            keychain::keychain_set,
            keychain::keychain_remove,
            mcp_targets::discover_mcp_targets,
            mcp_targets::mcp_install_snippets,
            #[allow(deprecated)]
            mcp_targets::register_mcp_targets,
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
            // Compute the cleanup action under the registry lock, then
            // drop the lock before destroying / emitting — otherwise we'd
            // hold the mutex across re-entrant work.
            let action = app_handle
                .try_state::<WindowRegistryState>()
                .map(|state| state.inner.lock().unwrap().on_window_destroyed(&label))
                .unwrap_or(DestroyAction::Nothing);
            match action {
                DestroyAction::CascadeClose(children) => {
                    // Use destroy() to mirror reattach_detached_window —
                    // it's synchronous from the OS perspective, so by the
                    // time the loop completes the children are gone from
                    // `app.webview_windows()` and the empty-check below
                    // fires correctly. close() was racy: a child blocking
                    // in a beforeunload-like listener could leave us with
                    // an empty parent set but live children.
                    for child_label in &children {
                        if let Some(win) = app_handle.get_webview_window(child_label) {
                            let _ = win.destroy();
                        }
                    }
                }
                DestroyAction::NotifyParent(parent) => {
                    let _ =
                        app_handle.emit(&format!("shippable:detach-children-changed:{parent}"), ());
                }
                DestroyAction::Nothing => {}
            }
            // Quit when the last window closes. Tauri 2 keeps the macOS
            // app alive by default; for a per-window reviewer that just
            // means an invisible orphan process holding the sidecar.
            if app_handle.webview_windows().is_empty() {
                app_handle.exit(0);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encode_passes_unreserved_through() {
        assert_eq!(url_encode("abc-XYZ_0.9~"), "abc-XYZ_0.9~");
    }

    #[test]
    fn url_encode_percent_encodes_special_characters() {
        assert_eq!(url_encode("a b"), "a%20b");
        assert_eq!(url_encode("a/b"), "a%2Fb");
        assert_eq!(url_encode("a&b=c"), "a%26b%3Dc");
        assert_eq!(url_encode("%"), "%25");
    }

    #[test]
    fn url_encode_handles_multibyte_utf8() {
        // "—" is U+2014 EM DASH, encoded as 0xE2 0x80 0x94 in UTF-8.
        assert_eq!(url_encode("—"), "%E2%80%94");
    }

    fn review_entry() -> RegistryEntry {
        RegistryEntry::review()
    }

    fn detached_entry(parent: &str, kind: WindowKind) -> RegistryEntry {
        RegistryEntry {
            changeset_id: None,
            parent: Some(parent.to_string()),
            kind,
        }
    }

    #[test]
    fn on_window_destroyed_cascades_children_of_a_review_window() {
        let mut reg = WindowRegistry::default();
        reg.by_label.insert("window-1".into(), review_entry());
        reg.by_label
            .insert("detached-window-1-sidebar".into(), detached_entry("window-1", WindowKind::Sidebar));
        reg.by_label
            .insert("detached-window-1-inspector".into(), detached_entry("window-1", WindowKind::Inspector));
        // Sibling review window's children must NOT be swept.
        reg.by_label.insert("window-2".into(), review_entry());
        reg.by_label
            .insert("detached-window-2-sidebar".into(), detached_entry("window-2", WindowKind::Sidebar));

        let action = reg.on_window_destroyed("window-1");

        let DestroyAction::CascadeClose(mut children) = action else {
            panic!("expected CascadeClose, got {action:?}");
        };
        children.sort();
        assert_eq!(
            children,
            vec![
                "detached-window-1-inspector".to_string(),
                "detached-window-1-sidebar".to_string(),
            ]
        );
        // Parent itself was dropped from the registry.
        assert!(!reg.by_label.contains_key("window-1"));
        // Sibling tree is untouched.
        assert!(reg.by_label.contains_key("window-2"));
        assert!(reg.by_label.contains_key("detached-window-2-sidebar"));
    }

    #[test]
    fn on_window_destroyed_notifies_parent_when_a_detached_child_dies() {
        let mut reg = WindowRegistry::default();
        reg.by_label.insert("window-1".into(), review_entry());
        reg.by_label
            .insert("detached-window-1-sidebar".into(), detached_entry("window-1", WindowKind::Sidebar));

        let action = reg.on_window_destroyed("detached-window-1-sidebar");

        assert_eq!(action, DestroyAction::NotifyParent("window-1".to_string()));
        // Parent survives.
        assert!(reg.by_label.contains_key("window-1"));
    }

    #[test]
    fn on_window_destroyed_returns_nothing_for_unknown_label() {
        let mut reg = WindowRegistry::default();
        reg.by_label.insert("window-1".into(), review_entry());

        let action = reg.on_window_destroyed("ghost-window");

        assert_eq!(action, DestroyAction::Nothing);
        // Registry is undisturbed.
        assert!(reg.by_label.contains_key("window-1"));
    }

    #[test]
    fn on_window_destroyed_returns_nothing_for_review_with_no_children() {
        let mut reg = WindowRegistry::default();
        reg.by_label.insert("window-1".into(), review_entry());

        let action = reg.on_window_destroyed("window-1");

        // No children, but it's still CascadeClose with an empty list —
        // the action expresses "this was a review window, do the review
        // cleanup". The run-loop's match handles the empty case naturally.
        assert_eq!(action, DestroyAction::CascadeClose(vec![]));
        assert!(!reg.by_label.contains_key("window-1"));
    }
}
