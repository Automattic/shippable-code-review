# Implementation Plan: Inline Interactions — Cursor-Line Anchoring Fix

Based on: docs/sdd/inline-interactions/anchoring-fix.md

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task, with per-task spec + code-quality review.

## Status

All 6 tasks complete (commits `25dd812`…`57c0dd1`, plus review fixups). Executed
via subagent-driven development with per-task spec + code-quality review and a
final holistic review. `web/` build, lint, the 604-test vitest suite, and the
61-test Playwright e2e suite all pass. Final review: ready to merge.

**Goal:** In inline mode, render only the cursor line's own interactions
beneath it (bare cards, no hunk-level chrome), move hunk-level threads below the
hunk body, and render detached threads at the bottom of the diff.

**Tech stack:** React + Vite + TypeScript (`web/`), vitest unit tests,
Playwright e2e. Run `npm` commands from `/workspace/web/`.

## Key facts for the implementer

- The `InspectorViewModel` (`web/src/view.ts`) rows already carry `isCurrent`:
  `AiNoteRowItem.isCurrent` is true for the cursor line; `UserCommentRowItem.isCurrent`
  is true when the cursor is on the line **or within a block-comment range**.
  Filter by `isCurrent` — no manual line-index math, block ranges come free.
- `showNewCommentCta`, `currentLineCommentKey`, `currentLineNo`, `showDraftStub`,
  `draftStubRow`, `detachedThreads` on the VM are already current-line / file
  scoped.
- `DiffView` receives `inlineThreads` (`Omit<InlineThreadStackProps, "sections" | "currentNoteRef">`)
  and renders it only for the cursor's hunk: line-anchored inside
  `InlineThreadsRegion` (`.line-inline-threads`, beneath the cursor line) and
  hunk-level (`.hunk__inline-threads`) currently in the hunk header.
- `NoteCard` and `UserThreadCard` are leaf components in `InlineThreadStack.tsx`;
  `DetachedThreadCard` is its own file. `ReplyThread` is its own file.

## Tasks

### Task 1: Create the `InlineLineThreads` component
- **Files**: create `web/src/components/InlineLineThreads.tsx`,
  `web/src/components/InlineLineThreads.test.tsx`; modify
  `web/src/components/InlineThreadStack.tsx`.
- **Do**:
  1. Write a failing test in `InlineLineThreads.test.tsx`. Build a realistic
     `InspectorViewModel` (reuse the `richViewModel()` style helper from
     `InlineThreadStack.test.tsx`). Cases:
     - a VM with one AI-note row `isCurrent: true` and one `isCurrent: false`
       → only the current note renders; the text "AI concerns in this hunk"
       and "Your comments" headers do NOT appear;
     - a VM with no current notes/comments but `showNewCommentCta: true`
       → only the "+ comment" button renders, no `.inspector__empty`
       placeholder and no headers;
     - a VM with a current block-comment row → it renders.
  2. Verify the test fails.
  3. Create `InlineLineThreads.tsx`. It is presentation-only and takes the
     `DiffView` inline payload shape (`Omit<InlineThreadStackProps, "sections" | "currentNoteRef">`).
     It renders, with NO `inspector__sec` / `inspector__sec-h` section headers,
     no counts, no "next note" jump button:
     - the cursor line's AI notes: `vm.aiNoteRows.filter((r) => r.isCurrent)`
       rendered as `NoteCard`s inside a single `<ul className="notes">` (the
       `<ul>` keeps the `<li>` cards valid HTML — it is not a section header);
     - the cursor line's user comments:
       `vm.userCommentRows.filter((r) => r.isCurrent)` rendered as
       `UserThreadCard`s, plus the `draftStubRow` composer when
       `vm.showDraftStub`, in the same/another `<ul className="notes">`;
     - the slim "+ comment" button when `vm.showNewCommentCta` — reuse the
       existing `thread__start thread__start--cta` button markup from
       `UserCommentsSection` in `InlineThreadStack.tsx` (label "+ comment on
       L{currentLineNo}" / "↻ resume draft", `onClick` →
       `onStartDraft(vm.currentLineCommentKey)`);
     - return `null` when there is genuinely nothing (no current notes, no
       current comments, no draft stub, and no CTA).
     Wire every `NoteCard` / `UserThreadCard` callback exactly as
     `InlineThreadStack`'s line-anchored sections do today (copy the prop
     wiring — `onAck`, `onJump`, `onStartDraft`, `onSubmitReply`,
     `onDeleteReply`, `onRetryReply`, `onVerify`, `draftFor`, etc.).
     To reuse the leaf cards, add `export` to `NoteCard` and `UserThreadCard`
     in `InlineThreadStack.tsx` (no other change to that file in this task).
     If exporting them turns out to risk the panel rendering, instead
     duplicate the minimal card markup into `InlineLineThreads.tsx` — keeping
     `Inspector` untouched takes priority.
  4. Verify the test passes.
  5. Run from `web/`: `npm run test`, `npm run build`, `npm run lint`.
  6. Commit: `feat(web): add InlineLineThreads for cursor-line inline rendering`
- **Verify**: new test passes; build + lint clean; `Inspector.tsx` /
  `InlineThreadStack.tsx` panel rendering unchanged (existing tests still pass).
- **Depends on**: none

### Task 2: Render `InlineLineThreads` in DiffView instead of the hunk-scoped stack
- **Files**: modify `web/src/components/DiffView.tsx`,
  `web/src/components/DiffView.css`, `web/src/components/DiffView.test.tsx`,
  `web/e2e/journey-6-cross-cutting.spec.ts`.
- **Do**:
  1. Update the failing/affected unit tests first. In `DiffView.test.tsx`, the
     line-anchored tests currently assert hunk-scoped content. Change them to
     assert: with `inlineThreads` and the cursor on a noted line,
     `.line-inline-threads` contains the current AI note's `NoteCard` (e.g. by
     a stable card class such as `.ainote` / a note `<li>`) and does NOT
     contain the text "AI concerns in this hunk"; with the cursor on a
     non-noted line, `.line-inline-threads` contains only the "+ comment"
     button.
  2. Verify they fail.
  3. In `DiffView.tsx`, the `InlineThreadsRegion` currently renders
     `<InlineThreadStack {...inlineThreads} sections="line-anchored" />` —
     replace its inner content with `<InlineLineThreads {...inlineThreads} />`.
     Keep the `InlineThreadsRegion` wrapper and its pointer-event
     `stopPropagation` handlers unchanged. Remove the now-unused
     `InlineThreadStack` import if nothing else in the file uses it.
  4. In `DiffView.css`, add `.line-inline-threads:empty { display: none; }` so
     the wrapper collapses when `InlineLineThreads` returns `null`.
  5. In `journey-6-cross-cutting.spec.ts`, update the existing "inline
     interactions" assertions that referenced the removed hunk chrome — the
     test that asserts `region` `toContainText("AI concerns in this hunk")`
     must change (the header is gone). Assert instead that the region shows
     the AI note (a `.notes li` entry) on a noted line.
  6. Verify the unit tests pass; run `npm run test`, `npm run build`,
     `npm run lint`.
  7. Commit: `feat(web): render cursor-line interactions inline via InlineLineThreads`
- **Verify**: unit tests pass; build + lint clean; panel mode unchanged.
- **Depends on**: Task 1

### Task 3: Move hunk-level inline threads below the hunk body
- **Files**: modify `web/src/components/DiffView.tsx`,
  `web/src/components/DiffView.css`, `web/src/components/DiffView.test.tsx`.
- **Do**:
  1. Update the failing test first. In `DiffView.test.tsx`, the hunk-level test
     asserts `.hunk__inline-threads` renders in the hunk header. Change it to
     assert the block renders **after** the hunk body — i.e.
     `.hunk__inline-threads` appears after `.hunk__body` in document order
     within the current `.hunk` section (and is still NOT a descendant of
     `.hunk__body`).
  2. Verify it fails.
  3. In `DiffView.tsx`'s `HunkBlock`, move the `<div className="hunk__inline-threads">`
     block (rendering `<InlineThreadStack {...inlineThreads} sections="hunk-level" />`)
     from its current position right after `<header className="hunk__h">` to
     **after** the `<HunkLinesBlock>` (and after `expandBelow`/`contextBelow`
     if those render — place it as the last child of the `.hunk` section).
  4. In `DiffView.css`, adjust `.hunk__inline-threads` for the new position
     (it now sits below the body, full hunk width) and DELETE the comment that
     documented the sticky-header overlap limitation — the new position is not
     covered by the sticky header.
  5. Verify the test passes; run `npm run test`, `npm run build`, `npm run lint`.
  6. Commit: `feat(web): render hunk-level inline threads below the hunk body`
- **Verify**: test passes; build + lint clean.
- **Depends on**: Task 2

### Task 4: Render detached threads at the bottom of the diff
- **Files**: modify `web/src/components/InlineLineThreads.tsx`,
  `web/src/components/DiffView.tsx`, `web/src/components/DiffView.css`,
  `web/src/components/DiffView.test.tsx`,
  `web/src/components/InlineLineThreads.test.tsx`.
- **Do**:
  1. Write failing tests:
     - in `InlineLineThreads.test.tsx`, a new `InlineDetachedThreads` renders a
       `DetachedThreadCard` for each entry of `vm.detachedThreads` and renders
       `null` when the list is empty;
     - in `DiffView.test.tsx`, with `inlineThreads` whose `vm.detachedThreads`
       is non-empty, a `.diff__detached` block renders after the last `.hunk`
       section; with an empty list, no `.diff__detached` renders.
  2. Verify they fail.
  3. In `InlineLineThreads.tsx`, add and export an `InlineDetachedThreads`
     component: presentation-only, takes the same inline payload, renders
     `vm.detachedThreads` via `DetachedThreadCard` (copy the prop wiring from
     the detached `<section>` in `InlineThreadStack.tsx` — `row`, `symbols`,
     `worktreePath`, `deliveredById`, `isDrafting`, `draftBody`, and the
     callbacks). Returns `null` when `vm.detachedThreads` is empty.
  4. In `DiffView.tsx`, after the `viewModel.hunks.map(...)` of `HunkBlock`s
     (the diff-mode branch), render
     `{inlineThreads && <InlineDetachedThreads {...inlineThreads} />}` wrapped
     in `<div className="diff__detached">`. It is not cursor-gated.
  5. In `DiffView.css`, add minimal `.diff__detached` styling consistent with
     the existing inline-region styling (theme tokens, a top border / heading
     space). The block may carry a short "Detached" label so it reads as
     file-scoped — keep it minimal.
  6. Verify tests pass; run `npm run test`, `npm run build`, `npm run lint`.
  7. Commit: `feat(web): render detached threads at the bottom of the diff`
- **Verify**: tests pass; build + lint clean.
- **Depends on**: Task 2

### Task 5: Remove the now-unused `"line-anchored"` section value
- **Files**: modify `web/src/components/InlineThreadStack.tsx`,
  `web/src/components/InlineThreadStack.test.tsx`.
- **Do**:
  1. Confirm via grep that no file still passes `sections="line-anchored"`
     (Task 2 removed the only caller). The panel uses `"all"`; `DiffView`'s
     hunk-level render uses `"hunk-level"`.
  2. In `InlineThreadStack.tsx`: change `ThreadSections` to `"all" | "hunk-level"`;
     simplify the derived `lineAnchored` to `sections === "all"` (the
     line-anchored sections still render for the panel's `"all"`) and keep
     `hunkLevel` as `sections === "all" || sections === "hunk-level"`.
  3. In `InlineThreadStack.test.tsx`: remove the `sections="line-anchored"`
     test case; keep the `"all"` and `"hunk-level"` cases. Verify `"all"`
     still renders the line-anchored sections (panel parity).
  4. Run `npm run test`, `npm run build`, `npm run lint`.
  5. Commit: `refactor(web): drop unused line-anchored ThreadSections value`
- **Verify**: tests pass; build + lint clean; panel renders unchanged.
- **Depends on**: Task 2

### Task 6: Extend e2e coverage for the new inline behaviour
- **Files**: modify `web/e2e/journey-6-cross-cutting.spec.ts`.
- **Do**:
  1. In the "Journey 6 — inline interactions" describe block, add/extend tests:
     - a non-noted cursor line shows only the "+ comment" affordance and no
       AI-note / comment thread (move the cursor to a line with no
       interactions — e.g. press `i`, do not press `n`, or navigate to a plain
       line — and assert `.line-inline-threads .notes li` has count 0 while a
       "+ comment" button is present);
     - on a noted line, the AI note renders inline with no "AI concerns in
       this hunk" header text;
     - the hunk-level block (`.hunk__inline-threads`) renders after
       `.hunk__body`, not in the header (assert document order / not a
       `.hunk__body` descendant).
     Reuse the existing `beforeEach` (loads `/?cs=42`, dismisses the plan).
  2. Run the e2e suite from `web/`: `npm run test:e2e` (it needs the `server/`
     deps installed — `cd ../server && npm install` once if `tsx` is missing).
     Confirm all journey-6 specs pass.
  3. Commit: `test(e2e): cover cursor-line inline anchoring in journey 6`
- **Verify**: `npm run test:e2e` green for journey-6 (ideally the full suite).
- **Depends on**: Task 3, Task 4, Task 5

## Self-review notes
- Spec coverage: line-anchored cursor-only (Tasks 1-2), bare cards / no headers
  (Task 1), "+ comment" button (Task 1), block-comment range via `isCurrent`
  (Task 1), hunk-level below the body (Task 3), detached at diff bottom
  (Task 4), `"line-anchored"` cleanup (Task 5), tests (every task + Task 6).
- Panel mode (`Inspector`) is never modified — only `NoteCard`/`UserThreadCard`
  gain an `export`. Task 5 keeps the line-anchored sections rendering for
  `sections="all"`.
- `InlineLineThreads` and `InlineDetachedThreads` are presentation-only, return
  `null` when empty; `.line-inline-threads:empty` hides the empty wrapper.
