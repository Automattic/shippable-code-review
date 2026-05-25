# File sidebar

## 1. Product reasoning & priority

The file sidebar is the orientation surface for a multi-file changeset. It exists to answer two questions at a glance: "which files am I looking at, and where am I in them?" The product separates **read progress** (a meter, automatic, "where I have been") from **explicit sign-off** (a checkmark + row tint, deliberate, "I am done with this"). That separation is a load-bearing product opinion — it shows up in the meter copy, the row check, and the title text — and it's what stops the sidebar from collapsing into a "checked items" list. The sidebar also hosts the prompt-runs panel and the quiz panel when those are active, so it doubles as the left-rail tray for non-diff activity.

**Priority: must-have.** Even a single-file diff benefits from the orientation; multi-file work requires it. For a rebuild this is the second-largest UI primitive after the diff view itself. The detach-to-its-own-window affordance is nice-to-have for a clean rebuild — keep the data but defer the multi-window wiring.

## 2. Acceptance criteria for a rebuild

- Lists every file in the active changeset in changeset order. Empty changeset shows "No files in this changeset."
- Per file row, renders (left → right): a check column (`✓` when reviewed, blank otherwise), the read meter (8-block bar + 3-char % string), the status character (`A`/`M`/`D`/`R`/`?`), and the file path.
- Active file row has the `row--active`/`row-wrap--active` modifier; reviewed file rows have `row--file-reviewed`/`row-wrap--file-reviewed`. The two modifiers compose (reviewed + active is valid and visible).
- Read meter is always neutral in colour. Reading is "where I have been," never a verdict (see Meter docstring, `Sidebar.tsx:128-134`). The verdict is the row check + tint.
- Meter % matches `Math.round(fileCoverage(file, readLines) * 100)`; the bar matches `"█".repeat(round(coverage*8)) + "░".repeat(8 - round(coverage*8))`.
- Clicking a row dispatches `onPickFile(fileId)` — the reducer's `MOVE_FILE` doesn't run; the orchestrator dispatches `SET_CURSOR` to file's first hunk, line 0.
- When a file has user-driven comment activity, a trailing comment-count badge renders: `❝ N`, clickable; click fires `onJumpToFirstComment(fileId)` and the orchestrator places the cursor on the first comment stop in that file (uses `buildCommentStops`).
- Comment count counts replies and user/block/agent threads — **not** AI annotations and **not** the teammate-verdict head (`view.ts:466-495`). Re-counting an AI thread would conflate "I have not yet looked at AI signals" with "no one has said anything."
- Title attribute (hover) reads `path — [reviewed —] read NN% [— K comment(s)]` (`Sidebar.tsx:119-127`).
- Hosts `QuizPanel` above the file list when a quiz is active; `PromptRunsPanel` between the quiz panel and the file list when runs exist.
- Optional `↗` detach chrome at the top, rendered only when `onDetach` is set (browser mode and gallery hide it).
- Cursor sync: the file the cursor is in is `isCurrent: true`; this is computed in `buildSidebarViewModel({ currentFileId: state.cursor.fileId, … })` (`view.ts:497-533`).
- Updating the cursor scrolls through files (via `MOVE_FILE` or sidebar click); the sidebar does not autoscroll its own list to the current file. (Today's behaviour — worth carrying or revisiting; not a hidden assumption.)

## 3. Existing architecture & system design

### Data model

- `SidebarViewModel { files: SidebarFileItem[]; changesetId; quiz }` — `view.ts:429-433`.
- `SidebarFileItem { fileId, path, status, statusChar, isReviewed, readCoverage, readPct, meterBar, isCurrent, commentCount }` — `view.ts:406-427`.
- Source data: `ReviewState.readLines: Record<hunkId, Set<lineIdx>>`, `reviewedFiles: Set<fileId>`, `interactions: Record<threadKey, Interaction[]>`, plus the active `ChangeSet`'s `files: DiffFile[]` and the cursor's `fileId`.
- The status-char map is a tiny pure function — `fileStatusChar` (`view.ts:435-443`).

### Current architecture decisions

- **Pure presenter.** `Sidebar.tsx` receives a `SidebarViewModel` and renders. No state, no derivation. The meter bar string, the status char, the read %, and the comment count all come pre-computed.
- **Per-file comment count is computed by walking every interaction.** `buildCommentCounts` (`view.ts:466-495`) builds `hunkId → fileId`, then iterates `state.interactions`, parses the thread key, maps the parent hunk to a file, and filters out ingest (AI/teammate-head) entries. O(threads).
- **Quiz panel and prompt-runs are wired in alongside the file list, not floated.** Both are conditional children of `<aside class="sidebar">` (`Sidebar.tsx:54-66`). This keeps the left rail a single tray, but couples three concerns into one component.
- **Two separate click affordances per row.** The main row button (`<button class="row">`) fires `onPickFile`; the trailing comment badge is its own button that fires `onJumpToFirstComment`. They live in a wrapper `<li class="row-wrap">` so the badge sits outside the larger click target.
- **Detach chrome is a prop boundary.** `onDetach` being defined is the gate (`Sidebar.tsx:41-53`); browser-only contexts pass `undefined`. Multi-window plumbing lives entirely outside `Sidebar.tsx`.
- **`isCurrent` lives in the view model**, derived from cursor → file. The Sidebar itself never reads cursor; the orchestrator does, builds the VM, and passes it in.

### How it evolved

- Originally just a file list. `ecb42f7` added read tracking and a per-row read meter.
- `b72a30e` added the per-file comment count badge.
- `b626733` made the badge clickable and added `n`/`N` keyboard nav for comments (the `MOVE_TO_COMMENT` reducer + `buildCommentStops`).
- `cff4d74` added the empty-state message.
- `5980b81` moved the *detached* thread pile out of the Sidebar and into the Inspector — the Sidebar used to also host detached threads; that's gone.
- `9bda200` moved prompt runs into the Sidebar (they previously floated).
- `7539d68` added the detach-to-own-window foundation; later slices (`779ec6f`, `ed042f7`) added the QuizPanel.
- `docs/plans/detached-sidebars.md` is the multi-window plan that the `onDetach` prop hangs off of.

### Gaps

- **The sidebar shows comment count but not AI-note count.** `IDEA.md` and the prompt mention AI-note counts at the file level, but the implementation doesn't have it — `SidebarFileItem` carries `commentCount` only. The AI-note count would help reviewers find unread AI signals before opening each file.
- **Comment-count predicate is subtle.** The "skip teammate heads structurally" filter (`view.ts:484-489`) lives inline in `buildCommentCounts`; it's effectively a local subset of `selectInteractions`. Easy to drift away from the sidebar canonical "user-driven activity" definition.
- **No virtualization.** Same as the diff view: a 500-file PR renders 500 rows. Not a near-term concern for prototype changesets but worth flagging for the rebuild.
- **The file list isn't scrolled to the active file when the cursor moves into a file off-screen.** If a user `]`-keys through 50 files, the sidebar list does not autoscroll. (Worth verifying with a long fixture; behaviour is "doesn't appear to follow.")
- **Three responsibilities (quiz host, runs panel host, files list) compete for vertical real estate.** When all three are non-empty the file list is crowded out. There's no collapse / priority logic.
- **Meter bar is rendered as text (`█░` characters).** Cute, but it ships fonts-dependent glyph widths and can't easily express partial blocks. A CSS-driven track would render more crisply.
- **`row__check` is two states (`✓` or space) but the type uses booleans across multiple places** — the file-reviewed status flows through `f.isReviewed`, the wrapper class `row-wrap--file-reviewed`, the button class `row--file-reviewed`, the title text, and the leading char. Five touchpoints for one signal.

## 4. Rebuild opportunities

### Data unification

- **One `IngestSignals`-style projection for the sidebar.** Today `view.ts:buildCommentCounts` re-parses thread keys and reduces interactions. The diff view, inspector, and `n/N` navigation already do similar passes. A single per-file projection (`{ fileId, commentCount, aiNoteCount, detachedCount, … }`) computed once per (cs, interactions) tick removes the duplicate.
- **`SidebarFileItem.readPct`, `readCoverage`, `meterBar` are three projections of one underlying number.** Drop `meterBar` and `readPct`; let the renderer compute both from `readCoverage`. `meterBar` is presentation; `readPct` is a `Math.round` away.
- **`statusChar` is `fileStatusChar(status)`** — a 5-line function. Either inline it into the renderer or accept that pre-computing it crystallizes "what the sidebar shows," and remove the case where both `status` and `statusChar` live on the same item (today's behaviour). Keep one.
- **Detach chrome's `onDetach?` plus the multi-window plumbing could share a capability flag.** Today the Sidebar's existence of `onDetach` is the toggle; whether the rebuilt sidebar lives at all is a workspace-capability question (per `AGENTS.md` deployment-mode notes). A `capabilities.detachable` field already in scope makes the prop redundant.

### Better architecture

- **Move the "click here to jump" logic out of the Sidebar.** Today the Sidebar emits `onJumpToFirstComment(fileId)` and the orchestrator walks `buildCommentStops` to resolve. The Sidebar VM could carry `firstCommentTarget?: Cursor` per row; click then dispatches `SET_CURSOR` directly. Removes one indirection.
- **Add an AI-note count column** if the product wants it (per the IDEA brief). The `IngestSignals.aiNoteByLine` lookup already exists; pre-aggregating per file in the VM is a few lines.
- **Split the sidebar into a `LeftRail` shell + `FileList` content.** The shell hosts QuizPanel / PromptRunsPanel / detach chrome; the FileList is what 90% of sessions show. Lets the file list scroll independently and lets the rail panels collapse without affecting list virtualization later.
- **Decide what "current file" does to scroll position.** Add an effect that scrolls the active row into view (1 line of code) — today this likely fails silently on long lists.
- **Make the meter a CSS track.** A 1-line `<div style={{ '--p': readPct }}>` with a `linear-gradient` removes the character-art and lets the meter render at any width.

## Sources

- `/workspace/web/src/components/Sidebar.tsx` (full, 143 lines).
- `/workspace/web/src/view.ts:406-533` — `SidebarFileItem`, `SidebarViewModel`, `buildCommentCounts`, `buildSidebarViewModel`.
- `/workspace/web/src/state.ts:1031-1076, 1456-1491` — `buildCommentStops`, `fileCoverage`.
- `/workspace/web/src/components/Sidebar.css:108-180` — class anatomy for `.row*` and `.meter*`.
- `/workspace/web/src/components/ReviewWorkspace.tsx:1049-1057` — call site that builds the VM.
- `/workspace/docs/features/file-sidebar.md` and `/workspace/docs/plans/detached-sidebars.md`.
- Commit history: `ecb42f7`, `b72a30e`, `b626733`, `cff4d74`, `5980b81`, `9bda200`, `7539d68`, `779ec6f`, `ed042f7`.
