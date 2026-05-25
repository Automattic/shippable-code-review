# Worktree Directory Picker

## 1. Product reasoning & priority

The original worktree ingest design (`docs/plans/worktrees.md`) asked the user to type a directory path into a text box. That's a fine prototype affordance but it shows the seam — the reviewer has to know exactly where their worktrees live, has to spell the path right, and has no way to discover the path. The directory picker replaces that paste-first flow with a chooser-first one: a primary "choose folder…" button opens a native macOS folder dialog (today, via AppleScript run on the local server), and on resolve the scan fires automatically. Manual path entry stays available as a secondary affordance for users who already have the path in their clipboard. This is the entry point for the entire "review-while-they-work" loop the worktrees plan opens with — without it the loop is gated on filesystem literacy.

Suggested priority: **must-have** for the local-worktree flow. The flow is the entire worktree path's entry point on the Welcome screen and in `LoadModal`; replacing it with a typed-path field would regress the flow back to the prototype's first cut. **Drop-it** is unthinkable; **nice-to-have** undersells how often new users hit the seam if you make them type a path on first run.

## 2. Acceptance criteria for a rebuild

- Primary `choose folder…` button on Welcome's hero and in `LoadModal`'s worktrees section.
- Clicking the button calls `POST /api/worktrees/pick-directory` with `{ startPath?: string }` where `startPath` is the last directory the user worked from (loaded from `localStorage["shippable.worktreesDir"]`).
- The server opens a native macOS folder chooser via `osascript` (`server/src/worktrees.ts:189-231`). The chooser dialog title is "Choose a local repo or worktrees folder."
- A `{ cancelled: true }` response is a silent no-op — the user pressed Cancel.
- A `{ path: string }` response triggers an immediate scan via `scanWorktrees(json.path)` and the path is persisted to `localStorage["shippable.worktreesDir"]` for next time.
- A failure (no `osascript`, non-darwin host, AppleScript error) surfaces the message inline and falls back to the manual-path input ("paste path instead").
- The scanned path must be an absolute path, exist on disk, be a directory, and contain a `.git` entry (file *or* directory — worktrees use a `gitdir:` file, the main repo uses a directory). `assertGitDir` (`server/src/worktrees.ts:142-170`) enforces all of these.
- The scan returns `Worktree[]` via `git worktree list --porcelain`, parsing `worktree` / `HEAD` / `branch` / `detached` lines per block (`server/src/worktrees.ts:239-280`).
- The first worktree in the list is marked `isMain: true` — git always lists the main worktree first.
- A successful scan stores the path in localStorage even if it returns zero worktrees (so the rescan / manual path fields stay seeded for the next attempt).
- The worktrees section is invisible (not rendered) when `/api/health` doesn't answer OK — the directory picker is unreachable in browser-only deployment modes by design.
- The hero swap is capability-aware: Welcome shows the worktree-first hero when `serverAvailable === true`, the drop-zone hero otherwise.

## 3. Existing architecture & system design

### Data model

- `Worktree` (`server/src/worktrees.ts:46-52`, mirrored in `web/src/useWorktreeLoader.ts:16-21`) — `{ path, branch, head, isMain }`. The frontend never sees the porcelain output; the server parses it.
- `PickDirectoryResult` (`server/src/worktrees.ts:129-131`) — `{ path: string } | { cancelled: true }`. No third "failure" variant — failures throw and the HTTP layer returns `400`.
- localStorage key `shippable.worktreesDir` (`web/src/useWorktreeLoader.ts:14`) — last successfully scanned directory; pre-fills the `startPath` of the next picker invocation and the manual-path input.

### Current architecture decisions

- **Server, not Tauri, owns the file dialog.** Despite the Tauri shell having `tauri_plugin_dialog` available, the picker is implemented in `server/src/worktrees.ts:189-231` via `osascript -e 'choose folder ...'`. Reason (inferred from `docs/plans/worktrees.md:42-45`): "the existing git-backed path API stays intact" — the server already needs to do the directory validation and `git worktree list`, so the chooser opening from the server gets the absolute path into the same code path with no extra round-trip. This is also why the picker is `darwin`-only today: `osascript` only exists on macOS.
- **`/api/worktrees/pick-directory` only opens the dialog.** It does not validate the chosen path is a git repo. The follow-up `/api/worktrees/list` call (`assertGitDir`) is what surfaces "this isn't a git repo" errors. Two-step: chooser then scan.
- **Auto-scan on resolve.** `useWorktreeLoader.pickDirectory` (`web/src/useWorktreeLoader.ts:89-108`) calls `scanWorktrees(json.path)` immediately on success — no second click required. This is what makes the chooser-first flow feel one-step.
- **Manual-path fallback is always available.** A "paste path instead" toggle reveals the same text input the original prototype shipped with. Useful when the picker fails (non-darwin host) or when the user pastes from the terminal.
- **Server-availability gate.** Both Welcome (`web/src/components/Welcome.tsx:326`) and LoadModal (`web/src/components/LoadModal.tsx:211`) render the worktree section only when `worktrees.serverAvailable === true`, which is set from a `GET /api/health` probe in `useWorktreeLoader` (`useWorktreeLoader.ts:49-62`). This matches the "deployment-mode matrix" of `worktrees.md:70-80` — memory-only deployments hide the tab rather than show it disabled.

### How it evolved

`docs/plans/worktrees.md` slice (a) shipped with a paste-first directory input. The chooser-first refactor landed alongside it once the AppleScript path proved reliable. The plan explicitly contemplated a future native Tauri equivalent ("Tauri shell could later replace `/api/worktrees*` with native FS / `git` calls inside the Rust shell" — `worktrees.md:68`); that hasn't happened. The shape evolved further when `branch-picker-worktree-creation.md` was drafted — that plan re-frames the entry from "scan for worktrees" to "scan for review targets" (worktrees + unchecked-out branches). The picker UI in that plan is unchanged; the response shape from the scan endpoint changes.

### Gaps

- **macOS-only chooser.** `worktrees.ts:192-194` hard-fails on non-darwin: `"directory chooser is only wired up on macOS right now"`. Linux users get an inline error and the manual path input. Tauri's `tauri-plugin-dialog` would close this gap.
- **No `EACCES` / sandbox guidance.** macOS may deny `osascript` filesystem access for unsigned bundles; the user sees a raw error string.
- **No validation pre-flight.** The chooser will happily return any folder; the user only learns it's not a git repo when the *scan* fails.
- **No "recent directories" affordance.** Only the most recent path is remembered. Power users juggling 4 worktrees folders have to re-pick every time.
- **No support for `worktrees`-folder vs `repo-root` distinction.** Per `docs/plans/branch-picker-worktree-creation.md:264-278`, the next iteration wants to distinguish those — a repo root unlocks unchecked-out branches. Today the scan endpoint treats both identically.
- **No worktree-creation affordance.** `branch-picker-worktree-creation.md` plans the `create worktree…` path; not yet built. Today, picking a branch with no worktree just hides the branch.
- **`assertGitDir` is "prototype-grade" per its own docstring.** No realpath check; no allowed-roots list; no symlink-out-of-dir defense. Documented in the comment on `worktrees.ts:135-141`.

## 4. Rebuild opportunities

### Data unification

The directory picker is the cleanest of the five ingest flows because its data model is genuinely small: in goes a path, out comes a list of `Worktree`. The data unification opportunity is *cross*-feature: the picker's `localStorage["shippable.worktreesDir"]` key is the only place the reviewer remembers where the user works from. Generalising that to a `recentWorktreeFolders: string[]` and surfacing the list as the chooser's defaults would let one storage key serve both the directory picker and the future "branch picker" without inventing a second one.

### Better architecture

- **Move the chooser into Tauri.** `tauri-plugin-dialog` would replace the AppleScript path with a cross-platform native dialog, fix the macOS sandbox case, and keep the server's responsibility narrow ("validate + scan"). The browser-dev path can stay on the AppleScript fallback or grow a hosted dialog via `<input type="file" webkitdirectory>` (with the usual caveats).
- **Split the scan endpoint.** `/api/worktrees/pick-directory` returns just the path; the very next call is `/api/worktrees/list`. Folding both into a single `pick-and-scan` round-trip would shave one HTTP request and (more importantly) consolidate the error-surfacing logic. Trade-off: separation is useful when the user wants to scan a directory they've already typed in the manual-path input.
- **Land `branch-picker-worktree-creation.md`'s `POST /api/review-targets/list` endpoint.** The plan already names it correctly: the user is picking a *review target* (worktree or branch-needing-checkout), not just a worktree. The directory picker becomes a sub-step of that broader picker.
- **Pre-flight validation in the chooser endpoint.** If the chosen folder isn't a git repo, surface that *before* the auto-scan; today both errors look the same to the user.
- **Recents drawer for folders.** Last-five worktree roots, one-click rescan. Cheap; closes the "I work in three projects" gap.
- **Default-location prefilling.** `worktrees.md:96-99` already names this: default the chooser to `.claude/worktrees/` if it exists in the chosen project root. The pattern is the "we're an agent-friendly tool" affordance that justifies the whole worktree ingest path; it's worth landing.

## Sources

- `/workspace/web/src/useWorktreeLoader.ts:14, 33-164`
- `/workspace/web/src/components/LoadModal.tsx:211-271`
- `/workspace/web/src/components/Welcome.tsx:326-386`
- `/workspace/server/src/worktrees.ts:46-52, 129-231, 239-280`
- `/workspace/server/src/index.ts:111, 764-797`
- `/workspace/docs/plans/worktrees.md:42-99`
- `/workspace/docs/plans/branch-picker-worktree-creation.md:204-278`
- `/workspace/docs/features/worktree-directory-picker.md`
