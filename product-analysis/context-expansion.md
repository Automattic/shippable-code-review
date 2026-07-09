# Context expansion

## 1. Product reasoning & priority

Context expansion is the "show me one more block" gesture from within a hunk. A hunk gives the reviewer just enough to see what changed; sometimes the change makes sense only with the surrounding function signature, the import, or the next conditional. Most diff tools dump 3 lines or the whole file. Shippable splits the surrounding region into **nearest-first blocks**, broken at blank lines (a natural reading boundary), bounded at 20 lines per block. Click once → reveal one block. Click again → reveal the next. The level → max-level counter on the button tells you how much further you can go before you've seen everything between hunks.

The product job is "let me peek without losing the hunk frame." It's a small feature but it's load-bearing for big-PR review — most "unfamiliar codebase" reviews stall here.

**Priority: must-have.** Cheap to implement, big readability win, no competitor does it quite this way. The block-derivation rule (blank-line split, 20-line max, nearest-first) is a real product opinion and worth keeping. The "render an optimistic bar before hydration" behaviour is nice-to-have polish.

## 2. Acceptance criteria for a rebuild

- Each hunk header is followed (above) by an `ExpandBar` when blocks exist above the hunk, and followed (below) by another when blocks exist below.
- The "above" bar is rendered above the hunk body; the "below" bar is rendered below. (Per current code: `DiffView.tsx:614-621, 664-671`.)
- Block ordering: **nearest first.** `expandAbove[0]` is the block immediately above the hunk; `expandAbove[1]` is the block above that, etc. (Same for `below`.) See `types.ts:23-30`.
- Block sizing: walk lines toward the hunk-boundary-distant edge; emit a block when you hit a blank line (with at least one preceding non-blank line in the block — `expandContext.ts:84`) OR when the block has hit 20 lines (`MAX_BLOCK_LINES`).
- When a block is fully revealed and there's more to show: button reads `↑ expand N lines above (to next block L/M)` (above) or `↓ expand N lines below (to next block L/M)` (below). `N` is the line count of the *next* block; `L` is current level + 1; `M` is `expandAbove.length` / `expandBelow.length`.
- When everything in a direction is revealed: button text becomes `✓ all M blocks above revealed` / `✓ all M blocks below revealed` — non-clickable.
- When `level > 0`, a secondary `× collapse` button appears alongside the main bar and resets the level for that direction to 0.
- When `level === 0` and there's nothing to show in that direction: no bar.
- When the file has a `worktreeSource` but `fullContent` isn't loaded yet, the bar renders in **pending** state (`pending: true`): "↑ load context above" / "↓ load context below", no level counter. Click triggers hydration; the bar re-renders against the real `expandAbove`/`expandBelow` blocks once `HYDRATE_FILE` fires.
- Revealed context lines render as `line line--context line--ctx-expand`, identical to in-hunk context lines but with a faint visual cue. They participate in syntax highlighting via `useHighlightedLines`.
- Revealed lines do **not** become part of `readLines` — visiting an expanded line via cursor doesn't extend coverage (today: cursor can't even land there because they aren't part of `hunk.lines`). This is intentional: read-coverage tracks "hunk lines I've passed over," not "context I peeked at."
- Above-blocks render top-to-bottom by *level slice + reduceRight* — the farthest revealed block sits at the top, nearest just above the hunk body. See `view.ts:275-281`.
- Per-hunk expand-state is stored as `expandLevelAbove: Record<hunkId, number>` and `expandLevelBelow: Record<hunkId, number>` — `types.ts:282-284`.
- Expand-state is **not persisted across reloads.** It's not in `persist.ts`'s snapshot — `persist.ts:73-84`. Reloading the page collapses every expansion.

## 3. Existing architecture & system design

### Data model

- `Hunk.expandAbove?: DiffLine[][]` — ordered nearest → farthest, each inner array a block. (`types.ts:23-30`.)
- `Hunk.expandBelow?: DiffLine[][]` — same shape.
- `ReviewState.expandLevelAbove: Record<hunkId, number>` / `expandLevelBelow` — `types.ts:282-284`.
- View model: `ExpandBarViewModel { level, maxLevel, nextSize, pending? }` — `view.ts:73-87`. `HunkViewModel.contextAbove` / `contextBelow` are pre-flattened `DiffLine[]` slices (`view.ts:115-123`).

### Current architecture decisions

- **Block derivation is offline, at ingest.** `enrichWithFileContent(file, postChangeText)` builds `expandAbove`, `expandBelow`, and `fullContent` for each hunk and returns a new `DiffFile`. Called from `parseDiff.ts:54` (paste/upload), `state.ts:557` (`HYDRATE_FILE`), and worktree-changeset ingest. (`expandContext.ts:20-54`.)
- **There is no `/api/expand-context` endpoint.** Expansion is a client-side derivation against post-change source text. The server's role is *only* to ship the source text — via `/api/worktrees/changeset` (initial load), via `fetchFileAt` (lazy hydration), or via the diff content being parsed (paste/upload).
- **The bar is rendered inline as a sibling of `hunk__body`.** It's not part of the line grid; it sits between `hunk__h` (header) and `hunk__body` (lines). Two component instances per hunk (above + below), inside `HunkBlock` (`DiffView.tsx:614-671`).
- **State stays minimal.** Just an integer per hunk per direction. The reducer's `SET_EXPAND_LEVEL` clamps to `Math.max(0, level)`; the view layer clamps to `aboveBlocks.length` etc.
- **Hydration is opt-in via `canHydrateExpansion`.** The view model gates `pending: true` on `!!canHydrateExpansion && !file.fullContent` (`view.ts:229`). `canHydrateExpansion` is computed by `ReviewWorkspace` as `!!cs.worktreeSource && file.status !== "deleted" && !file.fullContent` (`ReviewWorkspace.tsx:351-352`).
- **Click flow.** Renderer fires `onSetExpandLevel(hunkId, dir, level+1)` → `ReviewWorkspace` awaits `ensureFileHydrated(file)` → dispatches `SET_EXPAND_LEVEL`. The hydration `await` is *before* the dispatch; the bar's "loading…" state is therefore not visible.
- **`MAX_BLOCK_LINES = 20`** — `expandContext.ts:7`. This and the blank-line splitter are the only product knobs in this feature.

### How it evolved

- `ca608a1` introduced `expandContext.ts` and folded `expandAbove`/`expandBelow` derivation off the diff parser into a single enrichment pass. Before that, fixtures hand-crafted expand blocks (the `hunk.expandAbove ??` fallback at `expandContext.ts:42` still honours that).
- `0846c92` added the lazy-fetch path so non-markdown files could offer expansion in worktree-loaded changesets (the same commit that lit up Source mode). The "pending" view-model state was introduced here.
- The current shape is stable; no follow-up fixes since the introduction.

### Gaps

- **Hydration loading state is invisible.** The bar is rendered as `pending` based on file state, not request state. A click that triggers hydration shows no immediate feedback; the bar disappears or repopulates only after the fetch resolves.
- **No error path.** `ensureFileHydrated` swallows fetch errors with `console.warn` (`ReviewWorkspace.tsx:339-346`). A repeated click yields nothing, no toast, no banner.
- **Expand state isn't persisted.** A reviewer who expanded context on 6 hunks loses all of it on reload. Cheap to add to `persist.ts` (`expandLevelAbove` / `expandLevelBelow` are already plain objects of numbers).
- **No keyboard shortcut.** Today expansion is mouse-only. A reviewer driving the diff with `j/k` can't reveal context without reaching for the trackpad. Not a major gap but contradicts the keyboard-first framing.
- **Block derivation runs once at ingest** and is then frozen in the `DiffFile`. If the algorithm changes (different `MAX_BLOCK_LINES`, different boundary rule), the only way to re-derive is to reload. For a stable rule this is fine; for tuning it's awkward.
- **`buildExpandAbove` / `buildExpandBelow` are near-duplicates.** They differ only in walk direction. ~30 lines of shared code split across two functions (`expandContext.ts:66-118`).
- **No virtualization, again** — revealed context lines render in full. A "show everything above" gesture on a 2000-line file renders all of them.
- **No `expandContext.ts` test of the blank-line splitter against pathological input** — files with no blank lines anywhere become single 20-line blocks; files made of only blank lines emit lots of tiny blocks. Behavior is fine but undocumented.

## 4. Rebuild opportunities

### Data unification

- **Two `Record<hunkId, number>` maps could be one `Record<hunkId, { above: number; below: number }>`.** Cosmetic, but trims the reducer (`state.ts:504-510`).
- **`pending` is a view-model bool derived from "do we have content yet?"** It could equally be a view-model field on the file (`hydrationStatus`) shared with the full-file mode toggle. One status value, two consumers.
- **`expandAbove: DiffLine[][]` and `fullContent: DiffLine[]`** both live on `DiffFile`. They are two projections of the same source (post-change text + hunk windows). A rebuild could keep only `postChangeText` and derive both on read — currently they're computed once at ingest and frozen, but that's an implementation choice, not a structural requirement.
- **`contextAbove` / `contextBelow` arrays in the view model are pre-flattened from blocks.** The renderer never needs the original block boundaries again (the expand button knows the *next* block size via `nextSize`). Drop the flatten step and store level as "lines revealed" rather than "blocks revealed."

### Better architecture

- **Make hydration request-state visible.** A `useHydrationStatus(fileId): "idle" | "loading" | "ready" | "error"` hook drives a `pending`-vs-`loading` distinction; the bar can render "loading…" with a spinner.
- **Merge `buildExpandAbove` and `buildExpandBelow`** into one `buildBlocks(fileLines, range, dir: 1 | -1)`. The reverse-on-emit in the above case becomes "reverse if dir === -1."
- **Add a keyboard shortcut.** `+` for "expand context below," `-` for "above" (no conflict with existing keymap). The status bar context hint could mention it when the cursor sits on a hunk boundary.
- **Persist expand state.** Add `expandLevelAbove` / `expandLevelBelow` to the `PersistedSnapshot` (`persist.ts:73-84`) — they're already `Record<string, number>`. Bump `v` to 8.
- **Consider lifting `MAX_BLOCK_LINES` to a reviewer preference.** Probably not worth a setting, but worth flagging: 20 lines is a Shippable opinion, not a universal one.
- **Make the bar a render-prop / slot.** Today the bar's text logic is inline in `DiffView.tsx:685-735`. If the rebuild splits diff render from context UI, having the bar be a small component (`<ExpandBar bar={vm} onClick={…} />`) tightens the boundary.

## Sources

- `/workspace/web/src/expandContext.ts` (full, 156 lines).
- `/workspace/web/src/components/DiffView.tsx:614-735` — `ExpandBar`, `ContextLinesBlock` rendering.
- `/workspace/web/src/view.ts:73-87, 268-312` — `ExpandBarViewModel`, expand-bar derivation in `buildDiffViewModel`.
- `/workspace/web/src/types.ts:23-30, 282-284` — `Hunk.expandAbove`/`expandBelow`, `expandLevelAbove`/`expandLevelBelow`.
- `/workspace/web/src/state.ts:504-510, 549-566` — `SET_EXPAND_LEVEL`, `HYDRATE_FILE`.
- `/workspace/web/src/components/ReviewWorkspace.tsx:319-352, 1959-1962` — lazy-hydration hook-up.
- `/workspace/web/src/persist.ts:73-84` — confirms expand state is **not** persisted.
- `/workspace/docs/features/context-expansion.md`.
- Commits: `ca608a1`, `0846c92`.
