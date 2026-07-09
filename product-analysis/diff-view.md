# Diff view

## 1. Product reasoning & priority

The diff view is the main reading surface — everything else (sidebar, inspector, status bar) orbits it. It exists to turn a flat patch blob into something a human can move through deliberately: cursor-tracked lines, per-line "I've been here" marks, AI notes and comment glyphs surfaced inline, hunk-level metadata in headers. The user job is "show me the changes and let me read them under my own control, without losing my place." This is the load-bearing surface of Shippable; if it isn't good, nothing else matters.

**Priority: must-have.** A code review tool with no diff view is not a code review tool. For a clean rebuild this is the first thing to land and the largest single component to design carefully — it carries the cursor model, the read-track, the AI-glyph contract, inline thread mounting, and the drag/keyboard input pipeline.

## 2. Acceptance criteria for a rebuild

- Renders a `DiffFile`'s hunks in order, each as a labeled section with hunk header text and a coverage % derived from `readLines`.
- Renders each `DiffLine` with old line number, new line number, an AI/comment glyph column, a +/- sign column, and the line text — five columns in that order (`DiffView.css` grid `40px 40px 14px 16px 1fr`).
- Highlights the cursor line (`isCursor`), dims previously-visited lines (`isRead`), tints lines in the active line-range selection (`isSelected`), and renders a per-line glyph from `aiGlyph` (one of `✓ ! ? ✦ " ` `).
- Keyboard cursor moves: `j/k/↓/↑` step lines; at the end of a hunk, `j` advances to the first line of the next hunk; at end of file it stays put. Across files, cursor moves only via `]/[` (`MOVE_FILE`) or sidebar clicks — `j/k` do not cross files.
- Shift+arrow extends a same-hunk line range; crossing a hunk boundary collapses the selection.
- Mouse: clicking a gutter line places the cursor; dragging in the gutter forms a line-range selection (clamped to the originating hunk); dragging across the viewport edge auto-scrolls and re-resolves the head line. Right-click opens a `LineContextMenu` (mark read/unread, etc.).
- Mouse text selection inside `.line__text` falls through to the browser; on mouseup, a single-line text selection captures a `CharRange` (UTF-16 cols into the line text), a multi-line text drag collapses to a line-range selection.
- Symbol tokens (`[data-symbol]`) intercept clicks for go-to-definition and don't move the cursor.
- Each non-current hunk's `AI ✓` / teammate-verdict badge is clickable and moves the cursor into that hunk (hunks have inline hunk-level threads that expand there).
- Cursor stays visible: a single-line `scrollIntoView({block:"nearest"})` after the cursor moves, plus a `ResizeObserver` on inline-thread regions that only re-scrolls if the cursor is still on-screen (a user-deliberate off-screen scroll is preserved).
- Comments-column ("+ comment" rail) appears as a trailing 6th column **only** when inline-threads are on (`inlineThreads` prop present); the column hosts a "+ comment" button on the cursor line.
- Three view modes per file: Diff (default), Source (full file with diff signs interleaved — `fileFullyExpanded`), Preview (rendered markdown — `filePreviewing`). Mode tabs render only when a file *can* preview (markdown); otherwise a single ↗/↙ "expand entire file" toggle replaces them. Modes are mutually exclusive.
- Inline thread regions mount: line-anchored threads beneath each line that has one (`InlineLineThreads`), hunk-level threads in the cursor hunk's header area, detached threads at the bottom of the file.
- Honors a `interactionsEnabled=false` prop that disables pointer plumbing while a modal owns input (symbol click path still works).

## 3. Existing architecture & system design

### Data model

- `DiffFile` → `Hunk` → `DiffLine` — `web/src/types.ts:3-31, 35-51`.
- View model layer: `buildDiffViewModel()` returns `DiffViewModel { hunks: HunkViewModel[], fullFileLines, filePreviewing, canPreview, … }` — `web/src/view.ts:140-170, 209-402`.
- Per-line VM: `DiffLineViewModel { isCursor, isRead, isSelected, aiNote, aiGlyph, hasUserComment, … }` — `web/src/view.ts:45-69`.
- Per-hunk VM: `HunkViewModel { coverage, isCurrent, aiReviewed, teammateReview, contextAbove, contextBelow, expandAbove, expandBelow, … }` — `web/src/view.ts:91-127`.
- Cursor: `Cursor { changesetId, fileId, hunkId, lineIdx }` — `types.ts:206-211`.
- Read track: `readLines: Record<hunkId, Set<lineIdx>>` — `types.ts:264`. Auto-extended every cursor move via `addLine()` in `state.ts:145-153`.
- Selection: `LineSelection { hunkId, anchor, head, charRange? }` — `types.ts:249-254`.

### Current architecture decisions

- **Presenter / view-model split.** `DiffView.tsx` is a pure presenter: it receives a `DiffViewModel` and renders. All derivations (glyph picking, coverage, expand-bar levels, full-file-line synthesis, AI-note attachment) happen in `view.ts`. See `docs/concepts/view-model-layer.md`.
- **AI signals come through the seam.** `aiNote` is attached per-line by `view.ts:339` reading the `signals.aiNoteByLine` lookup; the `Hunk`/`DiffLine` itself no longer carries AI fields. This is part of the typed-review-interactions migration (`docs/architecture.md § Review interactions`).
- **Delegated mouse handlers.** A single `pointerdown/move/up`/`contextmenu` handler lives on each `hunk__body` div (`DiffView.tsx:216-341`). The grid template enforces column meaning so a `target.closest()` walk disambiguates gutter-vs-text deterministically (`DiffView.tsx:30-46`).
- **Drag state is a ref, not React state.** `dragRef` in `DiffView.tsx:151` — avoids re-render on every move tick. Edge-scroll uses `requestAnimationFrame` and re-resolves the line under the pointer each tick (`startEdgeScroll`, `DiffView.tsx:169-210`).
- **Cursor scroll has two triggers, intentionally separate.** A cursor-move effect (`DiffView.tsx:357-366`) and a `ResizeObserver` on inline thread regions (`DiffView.tsx:377-405`). The observer is lazily instantiated on first ref and explicitly bails when the cursor is off-screen, so resize from a composer opening doesn't yank a user who scrolled away.
- **Three modes encoded as two booleans on state.** `fullExpandedFiles: Set<fileId>` and `previewedFiles: Set<fileId>` are mutually exclusive (the reducer enforces this — `state.ts:511-528`). Mode is derived in render (`DiffView.tsx:412-416`).
- **Comment column is opt-in by prop presence.** `commentColOn = !!inlineThreads` (`DiffView.tsx:410`). The CSS grid adds a column via `hunk__body--comment-col`.
- **Cursor focus delegation.** `onLineFocus` is the only seam that says "move the cursor here." Hunk badges call a separate `onHunkFocus` because the badges sit outside `hunk__body` and aren't reached by the delegated drag handler (`DiffView.tsx:80-86`).

### How it evolved

- Original: `Track read per line, reviewed per file` (`ecb42f7`) — read state + per-line cursor were added on top of an existing diff render.
- `Move cursor on glyph and hunk-badge click` (`9ce0e32`) split badge-click from in-body cursor moves.
- The presenter/view-model seam landed in `c0e6699` — diff render moved out of state computation.
- Lazy hydration for non-markdown full-file view shipped in `0846c92` (`feat(web): lazy-fetch source for non-markdown expand-context`).
- The "+ comment column" replaced an earlier left-rail in `6fb4561` (`replace the comment rail with a right-side + comment column`).
- AI-note inline rendering: notes used to ride on `DiffLine`/`Hunk` directly; the typed-review-interactions migration moved them into the `Interaction` store and the diff view now reads them through `IngestSignals` (see `docs/architecture.md § Review interactions`).
- The mouse-driven selection + char-range capture shipped in `7f04771`. Inline threads in the diff body (vs. inspector panel) landed across `b54cc7f`, `ea848f5`, `b138c8f`, `b5c79b3`, `88f72df`, then the resize observer was tightened (`991630b`, `5f7b162`, `a3b8a69`).

### Gaps

- **No virtualization.** Every line of every hunk renders. The component runs `useHighlightedLines` per hunk (Shiki) and the line list maps in-place. Large changesets will struggle. The full-file Source mode magnifies this further.
- **`useHighlightedLines` runs per-hunk independently.** Three near-duplicate call sites (`HunkLinesBlock`, `ContextLinesBlock`, `FullFileView`) each re-derive highlighting against their own line slice. Hunks that share a language pay the highlight cost N times per file.
- **Scroll behaviour around inline regions is subtle.** The two scroll triggers + the "stay-if-offscreen" rule are correct but have already produced three follow-up fixes (`5f7b162`, `68cfa91`, `a3b8a69`). The complexity hints the load-bearing constraint (resize without yanking) deserves a single owner.
- **Comment column conditionality leaks into 5 places.** Every line-rendering branch (`Line`, `ContextLine`, `FullFileView`, `HunkLinesBlock`, `ContextLinesBlock`) takes a `commentColOn` prop and applies a class — the column is implicit-by-grid rather than declared once.
- **`DiffView` plus its subcomponents is ~1300 lines.** Most of it is mouse-handling, char-selection resolution, and inline-thread wiring — none of which is conceptually about diff rendering.
- **No keyboard hint that "drag the gutter" makes a selection.** Discovery is via blog-post / tooltip. (Out of scope for diff-view; tied to keyboard-help.)
- **Full-file mode reuses the same delegated handlers via the `FullFileView` div, but those lines carry no `data-line-idx`** (look at `FullFileView`'s line render — `DiffView.tsx:802-823`). Mouse selection / cursor placement is silently inert in Source mode.

## 4. Rebuild opportunities

### Data unification

- **`fullFileLines` is just `DiffLine` plus a precomputed `sign`.** The `FullFileLineViewModel` (`view.ts:131-138`) exists only to carry the sign glyph. Either compute the sign in the renderer (it's a one-liner) and drop the type, or have `DiffLine` always carry it. Same applies to `HunkViewModel.lines[i]` carrying `aiGlyph` precomputed.
- **`contextAbove`/`contextBelow` arrays of `DiffLine` are flattened from `Hunk.expandAbove: DiffLine[][]`.** The flattening + reverse step in `view.ts:275-281` is fiddly and reduces twice for no good reason. Either keep blocks at the hunk level and let the renderer iterate them, or store them already flat and remember the level→count mapping separately.
- **`HunkViewModel.aiReviewed`, `aiSummary`, `teammateReview`** are three independent fields with three independent signal lookups (`signals.aiSummaryByHunk`, `signals.teammateByHunk`, `hunk.aiReviewed`). They render as one badge row and conceptually represent "what others said about this hunk." Unify into one `hunkInteractions` shape (the seam already groups them — `selectIngestSignals`).
- **`fullExpandedFiles` and `previewedFiles` are two mutually-exclusive Set<string>**. One enum-valued `Record<fileId, "diff" | "source" | "preview">` would carry the constraint at the type level rather than enforce it in the reducer.

### Better architecture

- **Lift the mouse pipeline into a hook.** `useDiffPointer({ onLineFocus, onLineSelectRange, onLineCharSelect, onLineContextMenu })` returns `{ ref, handlers }`. Pulls ~150 lines of `DragState` + edge-scroll + native-selection resolution out of `DiffView.tsx` and lets it be unit-tested without a React render.
- **One owner for "scroll cursor into view".** A `useFollowCursor(cursor)` hook with the on-screen check, owning the `ResizeObserver`, would consolidate the two triggers and the four bug-fix commits. The component's `useEffect` becomes a one-liner.
- **Drop `FullFileView` as a separate render path; treat Source-mode as another hunk.** `enrichWithFileContent` already builds `fullContent: DiffLine[]`. The diff render is already capable of rendering a single sequence of `DiffLine` — Source mode is "one giant hunk." A unified path also gives Source mode mouse selection / cursor placement for free.
- **Make the comment column a CSS variable, not a prop.** `--comment-col: 1fr` vs `--comment-col: 0` on the diff root, decided once. Every `commentColOn` prop disappears.
- **Virtualize per-hunk.** `react-virtuoso` or hand-rolled — only render lines in the visible band. Today's `useHighlightedLines` already memoizes per-hunk; a virtualized row would just read from that memo. Cursor scroll-into-view interacts with virtualization, but the existing single-scroll target makes that tractable.
- **Move the "delegated handler reads `data-line-idx`" contract into a typed predicate.** Today the disambiguation (gutter vs text vs symbol) lives in two places: the grid CSS and `handlePointerDown`'s body. A `resolveLineGesture(event): GestureKind` would centralize the rule.

## Sources

- `/workspace/web/src/components/DiffView.tsx` — full file (1303 lines), especially the mouse handlers (216-341), scroll effects (357-405), `HunkBlock` (550-683), `FullFileView` (771-827).
- `/workspace/web/src/view.ts:45-402` — `DiffViewModel` and `buildDiffViewModel`.
- `/workspace/web/src/types.ts:3-31, 35-51, 206-254, 264, 282-292` — `DiffLine`, `Hunk`, `DiffFile`, `Cursor`, `LineSelection`, `readLines`, expand-level fields.
- `/workspace/web/src/state.ts:511-528, 549-566` — mode mutual-exclusion and `HYDRATE_FILE` reducer.
- `/workspace/web/src/components/ReviewWorkspace.tsx:319-352, 1959-1969` — lazy hydration and `DiffView` wiring.
- `/workspace/web/src/expandContext.ts` — context derivation feeding hunk-bar / full-file rendering.
- `/workspace/docs/features/diff-view.md` (4-12), `/workspace/docs/concepts/view-model-layer.md`, `/workspace/docs/architecture.md § Review interactions`.
