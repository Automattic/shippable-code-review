# `shippable` CLI: `diff` command (and friends)

The worktree picker is the only way into a review today. If you're in a terminal in your repo and want to look at what you've just changed, you have to launch Shippable, click through the picker, and find your path. This plan adds a tiny CLI so `shippable diff` from any worktree opens the running (or just-launched) app straight to that diff — the GUI equivalent of `git diff`.

## Goal

What this enables:

- `shippable diff` — opens Shippable on the cwd's unstaged diff (literal `git diff` semantics: working tree vs index).
- `shippable diff HEAD` — `git diff HEAD`, i.e. staged + unstaged.
- `shippable diff main..feature` — opens a SHA-range review, same shape the picker produces.
- `shippable open <path>` — opens the default worktree-picker changeset for that path (uncommitted + commits since base). `shippable` with no subcommand is shorthand for `shippable open .`.
- `shippable install-cli` — manual symlink helper. Also offered as a one-time prompt during first-launch onboarding.

What it explicitly does not try to do:

- Print a diff to stdout. `git diff` already does that; the CLI's whole job is opening the GUI.
- Run a `shippable serve` daemon. There is no daemon — the desktop app is the server-bearing process.
- Linux/Windows in this slice. macOS-only, matching the current ship target. The argv parser sits behind a platform check so a future port (e.g. `xdg-open` + URL scheme on Linux) is an addition, not a rewrite.
- Pipe arbitrary git flags. The args mirror `git diff`'s revision/range syntax only — no `--stat`, `--name-only`, etc.

## What already works (so the plan is smaller than it looks)

- **Tauri multi-window with a shared sidecar.** One process, many windows, deterministic per-window changeset ids in `WindowRegistry` (`src-tauri/src/lib.rs:118`). Duplicate detection already focuses the existing window when a duplicate id opens — exactly the behavior CLI invocations should ride.
- **Sidecar bundling.** `server/` is compiled to a single binary via `bun build --compile` and shipped inside `Shippable.app/Contents/MacOS/`. The same toolchain compiles the CLI script to a self-contained binary, no Node runtime required from the user.
- **Dirty-only changeset.** `server/src/worktrees.ts:561-567` already implements `git diff HEAD` for a worktree path and synthesizes a `dirty:<hash>` changeset id. The default `shippable diff` flow calls into this path; nothing new server-side.
- **Recents-style hydration on window boot.** `loadFromRecent()` in the web app reads a `{path, fromRef, toRef}` payload and skips straight past the picker. The CLI re-uses this path verbatim — its open intent is just a synthetic recent.

The real work is the CLI binary, a Tauri single-instance + argv plumbing layer, and a small "hydrate from intent" hook on the web side.

## The slices

**(a) Single-instance plugin + argv intent.** Add `tauri-plugin-single-instance` to `src-tauri/Cargo.toml`. Parse argv on launch (both cold start and second-instance forwarding) into a typed `OpenIntent` enum: `Diff { path, range }` or `Open { path }`. Resolve the path by walking up to the nearest `.git` (matches `git`'s own behavior). Two paths from here, depending on launch state:

- **Cold launch (no windows yet):** open a new window with the intent encoded into its URL fragment (`tauri://localhost/#open=<base64-json>`). The web side hydrates from the fragment once `ServerHealthGate` clears. No dedup needed — there's nothing to dedup against.
- **Warm launch (windows exist):** emit a `cli:open` event to the most recently focused window. JS in that window owns the dedup check using the existing `list_window_changesets()` + recents-style id formula, then either calls `focus_window(label)` or `open_new_window` with the intent payload. This keeps the changeset-id formula in one place (TS) instead of duplicating it into Rust.

*Done when:* `open -a Shippable.app --args diff --path /some/repo` twice in a row opens one new window then focuses it the second time. *Blocks (c).*

**(b) CLI binary.** A small Bun script in `cli/src/index.ts`, compiled to `Shippable.app/Contents/Resources/cli/shippable` via the same `bun build --compile` pattern as the sidecar. Parses `diff [<rev>|<range>]`, `open <path>`, `install-cli`. For the GUI subcommands it shells out to `open -a /Applications/Shippable.app --args <subcommand> ...`. For `install-cli` it creates a symlink at `/usr/local/bin/shippable` pointing at the bundled binary (uses `osascript` for an admin prompt if the target dir isn't user-writable). *Done when:* the binary is in the DMG, runs the right subcommands, and CLI args are passed safely (no shell interpolation of `$PWD`). *Independent of (a) and (c).*

**(c) Web side: open-intent hydration.** New windows opened with an intent param (URL fragment `#open=<base64-json>`) hydrate straight into the review on mount, bypassing the picker. Uses the existing `loadFromRecent()` for the diff case and the picker's normal changeset-building path for `open <path>`. Errors (path not a git repo, can't read diff) land in the existing toast surface, not as `window.alert` (Wry/WKWebView). *Done when:* the new window from slice (a) actually shows the diff and error cases surface cleanly. *Blocked by (a).*

**(d) First-launch CLI install prompt.** A one-time modal at the end of the first-launch onboarding sequence: "Install `shippable` command in PATH" (calls the same logic as `shippable install-cli`), "Maybe later" (sets a localStorage flag), "Don't ask again." Also exposed as a button in Settings → General so anyone who skipped can install (or re-install) later. *Done when:* the prompt appears once after onboarding completes, the symlink works, the Settings button re-installs/updates it. *Independent.*

## Architecture sketch

```
$ shippable diff
        │
        ▼
┌─ cli (bundled binary) ─────┐
│  parse argv                │
│  → open -a Shippable.app   │
│    --args diff --path PWD  │
└────────────┬───────────────┘
             │
             ▼
   macOS launch services
             │
             ▼  (cold launch OR delivered via single-instance plugin)
┌─ Rust shell (one process) ─────────────────────────────────────────┐
│  parse argv → OpenIntent { Diff { path, range } | Open { path } }  │
│  resolve path (walk up to nearest .git)                            │
│                                                                    │
│  any windows open?                                                 │
│    no  → open_new_window(#open=<intent>)         ────── done.      │
│    yes → emit `cli:open` event to focused window ──┐               │
└────────────────────────────────────────────────────┼───────────────┘
                                                     │
                                                     ▼
┌─ web (focused window) ────────────────────────────────────────┐
│  on `cli:open`: compute id, list_window_changesets()          │
│    match  → focus_window(label)                ────── done.   │
│    miss   → open_new_window(#open=<intent>)    ────── done.   │
└───────────────────────────────────────────────────────────────┘
                                                     │
                                                     ▼
┌─ web (new window, tauri://localhost/#open=...) ───┐
│  on mount: parse intent → call existing           │
│  loadFromRecent() / picker path → show review     │
└───────────────────────────────────────────────────┘
```

## Things to watch out for

- **macOS-only argv shape.** `open -a --args` is mac-specific; gate the argv handler behind `#[cfg(target_os = "macos")]` so future Linux/Windows support adds a sibling rather than rewriting.
- **Single-instance + `tauri dev`.** During development, the plugin will block a second `cargo tauri dev` invocation. Confirm dev iteration still works; gate the plugin to release builds via a feature flag if it bites.
- **Argv injection.** The CLI shells out to `open` with a user-controlled cwd. Quote `$PWD` properly and pass as a single argv element, never via string interpolation. The Rust side shouldn't trust the path either — let the existing worktrees code reject non-repo paths.
- **Path resolution.** `shippable diff` from a subdirectory of a repo should open the repo, not the subdirectory. Walk up to the nearest `.git` (matches `git`'s own behavior) before shelling out.
- **First-launch prompt timing.** The CLI install prompt belongs at the *end* of the first-launch onboarding sequence (after the API-key/skip decision), not the beginning.
- **Cold-launch race.** On cold launch the sidecar isn't reachable when Rust receives the intent, but that's fine — the intent rides on the new window's URL fragment, and the web side hydrates after `ServerHealthGate` clears. Rust never has to talk to the sidecar in the CLI path.
- **Changeset-id formula in one place.** The id formula lives in TS (`web/src/worktreeChangeset.ts`) and the warm-launch path routes through a focused window so we don't have to mirror that logic into Rust. Cold launch needs no dedup. If we ever want Rust-side dedup (e.g. to skip the window-event hop), expose the formula as a small sidecar endpoint rather than copying it.
- **CLI parser footprint.** Two subcommands and a flag or two. Write it by hand; don't pull in commander/clap.

## Open questions

- **Dedup key for the dirty case.** `shippable diff` (unstaged) produces a `dirty:<hash>` id that changes every time the working tree changes. Re-invoking with no edits in between focuses the existing window; with edits, the hash differs and a new window opens. Is that the right call, or should the *path alone* be the dedup key for the dirty case? Lean toward "hash" — same answer multi-window chose for everything else, and it gives you a clean "snapshot then diverge" workflow if you want it.
- **`shippable` with no subcommand.** Suggesting `shippable` = `shippable open .` (matches `code .`). Alternative: print help. Going with `open .` unless there's pushback.
- **Symlink upkeep.** When users update Shippable.app the symlink keeps working (we point at a stable path inside the bundle), but if someone moves the app the link breaks. Add a one-line check at CLI startup that warns if the target is gone, with a one-liner to re-run `shippable install-cli`.
- **Distribution beyond the DMG.** A future `npm i -g @shippable/cli` or `brew install shippable` would let people install the CLI without grabbing the desktop bundle (e.g. on a teammate's machine the app already lives on). Not in scope here, but the binary's I/O surface (argv shape, exit codes) should be stable enough to be re-packaged later without breaking users.
