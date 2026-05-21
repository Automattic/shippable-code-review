# Implementation Plan: Right-Side Comment Column

Based on: docs/sdd/inline-interactions/comment-column.md

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task, with per-task spec + code-quality review.

**Goal:** Replace the buggy left-most comment rail with a right-most comment
column carrying a clear `+ comment [c]` text button on the cursor line.

**Tech stack:** React + Vite + TypeScript (`web/`), vitest unit tests,
Playwright e2e. Run `npm` from `/workspace/web/`.

## Key facts for the implementer

- The current left rail (in `DiffView.tsx` / `DiffView.css`): a leading grid
  column. `.hunk__body--rail .line` overrides `grid-template-columns` to
  `22px 40px 14px 16px 1fr`; each line renderer emits a leading
  `<span className="line__rail">` (gated by a `railOn` prop, `railOn = !!inlineThreads`);
  the cursor line's rail cell holds a `line__rail-bubble` `<button>` with a
  `💬` emoji wired to `onStartNewComment`.
- There are THREE diff line renderers under `.hunk__body`, all of which carry
  the rail cell today: `Line`, `ContextLine`, and the full-file line renderer
  inside `FullFileView`. Their containers (`HunkLinesBlock`,
  `ContextLinesBlock`, `FullFileView`) each add `hunk__body--rail` when
  `railOn`.
- The base `.line` grid is `.hunk__body .line { grid-template-columns: 40px 40px 14px 16px 1fr }`
  — old #, new #, AI-glyph, sign, code.
- The delegated `hunk__body` pointer handler disambiguates by element class
  (`.line__text`, `[data-symbol]`, `[data-line-idx]`), not column index.

## Tasks

### Task 1: Replace the left rail with a right-most comment column
- **Files**: `web/src/components/DiffView.tsx`, `web/src/components/DiffView.css`,
  `web/src/components/DiffView.test.tsx`.
- **Do**:
  1. Write failing tests in `DiffView.test.tsx` (replacing the existing
     `line__rail` tests):
     - With inline comments on, every diff line carries a trailing
       `.line__comment` cell; with it off, no `.line__comment` cell.
     - The `+ comment` button (`.line__comment-btn`, accessible name
       "comment on this line") appears in the comment cell of the cursor line
       ONLY; other lines' comment cells are empty.
     - Clicking the button invokes the new-comment handler (`onStartNewComment`).
     - **Grid-alignment test**: with the comment column on, a rendered diff
       `.line` has its children in order `line__old, line__new, line__ai,
       line__sign, line__text, line__comment` — i.e. `.line__text` (code) is
       the 5th child and `.line__comment` trails it. Assert this for a `Line`
       (and ideally a `ContextLine` / full-file line) so a desynchronised grid
       (code displaced) fails the test.
  2. Verify they fail.
  3. `DiffView.tsx`:
     - Rename the `railOn` prop/variable to `commentColOn` everywhere it is
       threaded (`DiffView` → `HunkBlock`/`FullFileView` →
       `HunkLinesBlock`/`ContextLinesBlock` → `Line`/`ContextLine`). It is
       still derived `commentColOn = !!inlineThreads`.
     - In every line renderer (`Line`, `ContextLine`, the full-file line
       renderer), REMOVE the leading `<span className="line__rail">…</span>`
       and instead APPEND a trailing `<span className="line__comment">` cell
       (after `LineText`) when `commentColOn`. For the cursor line in `Line`,
       the comment cell contains a `<button className="line__comment-btn"
       type="button">` whose visible content is the text `+ comment` and a
       `c` shortcut hint (e.g. a trailing `<kbd>c</kbd>`); `aria-label="Comment
       on this line"`, `title="comment on this line (c)"`. Its `onClick`
       calls `e.stopPropagation()` then `onStartNewComment?.()`; add
       `onPointerDown={(e) => e.stopPropagation()}` so the delegated drag
       handler ignores it. Non-cursor lines render an empty
       `<span className="line__comment" />`.
     - Rename the container class `hunk__body--rail` → `hunk__body--comment-col`
       on all three `hunk__body` divs (`HunkLinesBlock`, `ContextLinesBlock`,
       `FullFileView`).
     - Update the grid-contract comment block at the top of `DiffView.tsx` so
       it describes a trailing comment column, not a leading rail.
  4. `DiffView.css`:
     - Remove the `.hunk__body--rail .line` rule and the `.line__rail` /
       `.line__rail-bubble` / `.line__rail-bubble:hover` rules.
     - Add `.hunk__body--comment-col .line { grid-template-columns: 40px 40px 14px 16px 1fr 96px; }`.
     - Add `.line__comment` (the cell — right-aligned, `user-select: none`,
       `cursor: default`, consistent with the other gutter cells) and
       `.line__comment-btn` (the text button — transparent background, small
       font, `cursor: pointer`, theme tokens; style the `<kbd>` hint subtly).
       If `+ comment` + the `c` hint does not fit in `96px`, widen the column
       (update both the grid template and any reference) — keep it tight.
  5. Verify tests pass; `npm run test`, `npm run build`, `npm run lint` pass.
  6. Commit: `feat(web): replace the comment rail with a right-side + comment column`
- **Verify**: comment column present only when inline comments on; `+ comment [c]`
  button on the cursor line only; clicking it starts a comment; the
  grid-alignment test passes for every line renderer; build/lint/test green.
- **Depends on**: none

### Task 2: Update e2e for the comment column
- **Files**: `web/e2e/journey-6-cross-cutting.spec.ts`.
- **Do**:
  1. The journey-6 "inline interactions" block has a test that targets the old
     rail bubble (`.line__rail-bubble`, "the comment rail bubble opens a
     composer on the cursor line"). Update it: with inline comments on
     (`Shift+I`), the cursor line shows the `+ comment` button
     (`.line__comment-btn`, or by accessible name "Comment on this line");
     clicking it opens a comment composer (`getByPlaceholder("Write a reply…")`).
     Grep the file for any other `line__rail` reference and update it.
  2. Run `npm run test`, `npm run build`, `npm run lint`, then
     `npm run test:e2e` (install `server/` deps once if `tsx` is missing) —
     confirm the journey-6 suite passes.
  3. Commit: `test(e2e): cover the right-side + comment column`
- **Verify**: `npm run test:e2e` green for journey-6.
- **Depends on**: Task 1

## Self-review notes
- Spec coverage: remove left rail + add right-most column (Task 1), the
  `+ comment [c]` text button (Task 1), the grid-alignment safeguard test
  (Task 1), e2e (Task 2).
- Naming is consistent: `commentColOn`, `hunk__body--comment-col`,
  `.line__comment`, `.line__comment-btn`.
- Scope: only `DiffView.tsx` / `.css` / `.test.tsx` and the journey-6 e2e.
  The decoupled toggles, threading model, hunk-level / detached rendering, and
  `hideNonActiveComments` are untouched.
