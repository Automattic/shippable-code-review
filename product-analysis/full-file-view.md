# Full file view

## 1. Product reasoning & priority

The full-file view is the "zoom out" gesture from hunk-mode review. When a hunk hides too much structure — a refactored function whose context is split across boundaries, a new file you want to read end-to-end before validating the diff — the reviewer needs to see the full post-change file with the diff signs intact. The product job is "give me file shape without leaving review mode": old/new line numbers preserved, +/− signs in place, the file path in the header. It is not a separate editor view; it is the same diff surface re-projected against `fullContent`.

**Priority: nice-to-have.** The product can ship without it — most diffs are readable as hunks with context expansion. But for big refactors and new-file additions the absence becomes notable. For a clean rebuild, treat this as one of three render modes of the diff surface rather than a separate feature. (Markdown preview is the third mode and lives under the same toggle.)

## 2. Acceptance criteria for a rebuild

- Toggleable per file: the diff view header carries a single `↗ expand entire file` / `↙ collapse to hunks` button, or — when the file can also be rendered as markdown preview — a three-tab `ModeToggle` (Diff / Source / Preview).
- Tabs are mutually exclusive at the state-shape level: `fullExpandedFiles` and `previewedFiles` are two `Set<fileId>` whose reducer enforces no overlap (`state.ts:511-528`).
- When ON: hides the per-hunk render and shows one continuous `FullFileView` body — `oldNo`, `newNo`, AI glyph column (empty), sign column (`+`/`-`/space), text, optional comment column. Same 5-column grid as the diff (`DiffView.tsx:799-823`).
- Lines come from `DiffFile.fullContent: DiffLine[]`, built by `expandContext.buildFullContent()` which stitches hunk lines into the post-change file (`expandContext.ts:125-155`).
- For files where the worktree-changeset endpoint didn't ship post-change source (everything but `.md` today), the toggle button still shows: clicking it lazy-fetches via `fetchFileAt(worktreePath, sha, path)` → dispatches `HYDRATE_FILE` → `enrichWithFileContent` runs → render switches. While in flight, the user sees the empty bar; on success, the mode flips automatically. (Today: hydration is awaited *before* the dispatch, so visual feedback during the fetch is none — open question for the rebuild.)
- Mode toggle hides entirely if the file has no `fullContent` and no `worktreeSource` — `canExpandFile` gate at `view.ts:230`.
- Switching files preserves per-file mode (`Set<fileId>`-keyed); a file in Source mode stays in Source mode when you come back via `]/[`.
- Source mode for a `.md` file is allowed alongside Preview mode (they're different render paths for the same `postChangeText`).
- Header line, cursor, and inline-thread regions: today the full-file render is a single `<section class="hunk hunk--full">` with no `data-line-idx` attributes — mouse selection and `onLineFocus` do **not** fire in Source mode. The cursor stays parked in whatever hunk it was on. A rebuild should decide whether to support cursor + selection in Source mode (recommended: yes) or document the limitation explicitly.

## 3. Existing architecture & system design

### Data model

- `DiffFile.fullContent?: DiffLine[]` — `types.ts:42` ("Full file contents for the 'expand entire file' view.").
- `DiffFile.postChangeText?: string` — `types.ts:50` (raw text; the canonical post-change carrier).
- `ReviewState.fullExpandedFiles: Set<fileId>` — `types.ts:285`.
- `ReviewState.previewedFiles: Set<fileId>` — `types.ts:289-290` (mutually exclusive with the above).
- View model: `DiffViewModel.fullFileLines: FullFileLineViewModel[]`, `fileFullyExpanded: boolean`, `canExpandFile: boolean` — `view.ts:152-159, 244-256`.
- `FullFileLineViewModel = { kind, text, oldNo?, newNo?, sign }` — `view.ts:131-138`. The only thing it adds over `DiffLine` is the precomputed `sign`.

### Current architecture decisions

- **It's a mode of `DiffView`, not a separate component.** `DiffView.tsx:454-499` branches on `filePreviewing` / `fileFullyExpanded` and picks one of three render paths. The `<FullFileView>` subcomponent (`DiffView.tsx:771-827`) is internal.
- **`fullContent` is derived from hunks + post-change text** by `expandContext.buildFullContent()`. It stitches hunk-line spans into the surrounding context, walking by `newNo` indices. Add/del/context kinds are preserved (`expandContext.ts:125-155`).
- **Hydration is lazy and idempotent.** `enrichWithFileContent` populates `expandAbove`/`expandBelow` and `fullContent` from `postChangeText`. The `HYDRATE_FILE` reducer (`state.ts:549-566`) no-ops if `fullContent` is already set. The orchestrator coalesces racing fetches via `hydrationPromisesRef` (`ReviewWorkspace.tsx:307-350`).
- **The mode toggle UI shape depends on `canPreview`.** A markdown-capable file gets the 3-tab `ModeToggle`; everything else gets the single `expand entire file` button (`DiffView.tsx:429-451`).
- **Reducer enforces mutual exclusion.** `TOGGLE_EXPAND_FILE` removes the file from `previewedFiles` if it's being turned on; `TOGGLE_PREVIEW_FILE` does the inverse.
- **Highlighting still runs.** `useHighlightedLines(lines, language, …)` is called on the full-file line array. Large files will see this as a single Shiki pass — but it isn't memoized at the file level.

### How it evolved

- `ca608a1` (`feat(web): derive expand-context blocks and full-file lines from post-change text`) is the introduction of the `expandContext` module: both `expandAbove/Below` and `fullContent` were collapsed into one derivation pass.
- `0846c92` (`feat(web): lazy-fetch source for non-markdown expand-context`) added the worktree hydration path so non-markdown files could also offer the Source toggle.
- `e4ddd8e` (`Add markdown preview mode for diff'd .md files`) introduced Preview as a third mode, which is why the toggle now has both a 1-button and a 3-tab variant.

### Gaps

- **No `data-line-idx` on full-file rows** (`DiffView.tsx:802-823`). Cursor placement, mouse selection, line context menus, and inline-thread mounting are all silently disabled in Source mode. This is an unstated limitation; the user sees "Source" and assumes it's a working diff view.
- **No virtualization.** A 5000-line file renders 5000 `<div class="line">`s. The hunk view at least chunks; Source mode has no chunking.
- **`buildFullContent` walks unsorted hunks**, then sorts a copy (`expandContext.ts:128`). Cheap enough for current sizes, but the sort is per-render of any state change that doesn't memoize the file (the reducer mostly does; render does not).
- **The hydration fetch path is silent.** No optimistic "loading…" indicator on the button. If `fetchFileAt` is slow, the user gets a click that "does nothing" for seconds.
- **Hydration warns via `console.warn` on failure** (`ReviewWorkspace.tsx:343`) but doesn't surface to the UI. The optimistic bar stays; the toggle keeps appearing to do nothing.
- **`FullFileLineViewModel` is structurally identical to `DiffLine` plus a `sign`.** A computed-in-renderer `sign` removes one type.

## 4. Rebuild opportunities

### Data unification

- **Collapse the three modes into one enum.** `Record<fileId, "diff" | "source" | "preview">` (default `"diff"`) replaces `fullExpandedFiles: Set<fileId>` + `previewedFiles: Set<fileId>`. The reducer's mutual-exclusion logic vanishes (the enum can't represent overlap).
- **Drop `FullFileLineViewModel`.** Either compute the `sign` from `kind` in the renderer (it's `line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "`) or attach it to `DiffLine` once. Same applies to the diff view's hunk-line VM.
- **Make `fullContent` a derived view, not a stored field.** `DiffFile.fullContent` is built once on ingest by `enrichWithFileContent` and never changes — it could be a memoised getter on the file, or computed when Source mode is requested.
- **`postChangeText` is the carrier; `fullContent` is a projection** — but both live on `DiffFile`. A rebuild could keep only `postChangeText` and derive `fullContent` + `expandAbove/Below` on read. This makes the lazy-fetch story simpler: hydrate `postChangeText`, render mode flips automatically.

### Better architecture

- **Unify Diff and Source render paths.** A single render walks a `LineSequence` (an array of `DiffLine`s); Diff mode passes hunk lines + context, Source mode passes `fullContent`. The grid, the highlight pipeline, the mouse handlers, the inline-thread mounting all work uniformly. Today's `FullFileView` is a near-duplicate of `HunkLinesBlock` minus the mouse handlers.
- **Surface hydration state.** A `HydrationStatus` field on the file (`"idle" | "loading" | "ready" | "error"`) drives a button label change and avoids "click does nothing" UX. The orchestrator's `hydrationPromisesRef` already has this signal; just publish it.
- **Virtualize Source mode.** Same hook as the diff view (see diff-view rebuild notes); Source mode benefits most.
- **Move the mode toggle into the view model.** A single `modeToggle: { available: ("diff" | "source" | "preview")[], current: ... }` shape replaces the `canPreview` / `canExpandFile` / `fileFullyExpanded` / `filePreviewing` tetrad in `DiffViewModel`. The renderer becomes "render the tab list and the body for `current`."
- **Decide cursor semantics in Source mode** explicitly. Either disable navigation (and grey out keyboard nav cues in the header), or wire `data-line-idx` and let `j/k`/click work. The current silent-no-op is the worst of both.

## Sources

- `/workspace/web/src/components/DiffView.tsx:412-451, 454-499, 771-827` — mode branching, `ModeToggle`, `FullFileView`.
- `/workspace/web/src/view.ts:131-138, 152-170, 209-256` — full-file line VM + `canExpandFile`/`fileFullyExpanded` flags.
- `/workspace/web/src/expandContext.ts:120-155` — `buildFullContent`.
- `/workspace/web/src/state.ts:511-528, 549-566` — mode mutual-exclusion + `HYDRATE_FILE` reducer.
- `/workspace/web/src/components/ReviewWorkspace.tsx:307-352, 1959-1969` — hydration + handler wiring.
- `/workspace/web/src/types.ts:42-50, 285-290` — `fullContent`, `postChangeText`, `fullExpandedFiles`, `previewedFiles`.
- `/workspace/docs/features/full-file-view.md`.
- Commits: `ca608a1`, `0846c92`, `e4ddd8e`.
