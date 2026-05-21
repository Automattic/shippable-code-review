# Implementation Plan: Decoupled Toggles & Comment Rail

Based on: docs/sdd/inline-interactions/decouple-and-comment-rail.md

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task, with per-task spec + code-quality review.

**Goal:** Make the Inspector panel and inline-comment rendering two independent
toggles, and move the "+ comment" affordance into a non-reflowing left-most
comment rail.

**Tech stack:** React + Vite + TypeScript (`web/`), vitest unit tests,
Playwright e2e. Run `npm` from `/workspace/web/`.

Two phases. **Part 1** (Tasks 1–2) decouples the toggles. **Part 2** (Tasks
3–4) is the comment rail. Each phase is independently shippable.

## Key facts for the implementer

- `web/src/interactionViewMode.ts` currently exports `InteractionViewMode`
  (`"panel" | "inline"`), `getStoredInteractionViewMode`,
  `persistInteractionViewMode`, `DEFAULT_INTERACTION_VIEW_MODE`. This module is
  **deleted** by this plan.
- `web/src/commentVisibility.ts` is the reference one-preference-per-file
  pattern (boolean, localStorage, `typeof window` guard, try/catch).
- `ReviewWorkspace.tsx` owns `interactionViewMode` state, a derived
  `inspectorVisible`, `selectInteractionViewMode` / `toggleInteractionViewMode`,
  and `hideNonActiveComments`. It gates `<Inspector>` on `inspectorVisible` and
  passes `inlineThreads` / `lineThreads` to `<DiffView>` when
  `interactionViewMode === "inline"`.
- `keymap.ts` has a `TOGGLE_INTERACTION_VIEW_MODE` action bound to `i`, plus a
  command-palette label.
- The `i` keybind and a topbar action both currently toggle the view mode.
- `SettingsModal.tsx` has a panel/inline segmented control and a
  "hide non-active comments" toggle; `Welcome.tsx` also renders `SettingsModal`
  and wires both preferences.
- `Demo.tsx` has its own `TOGGLE_INTERACTION_VIEW_MODE` keymap case.
- The inline "+ comment" CTA is `InlineLineThreads.tsx`'s `thread__start--cta`
  button, gated by `vm.showNewCommentCta`; clicking it calls `onStartNewComment`.
- `DiffView`'s `.line` is a CSS grid: `grid-template-columns: 40px 40px 14px 16px 1fr`
  (old#, new#, AI-glyph, sign, code). Diff lines render via `Line`,
  `ContextLine`, and the full-file line renderer, all under `.hunk__body`.

---

## Part 1 — Decouple the Inspector and inline comments

### Task 1: Preference modules for `showInspector` and `inlineComments`
- **Files**: create `web/src/inspectorVisibility.ts`,
  `web/src/inspectorVisibility.test.ts`, `web/src/inlineComments.ts`,
  `web/src/inlineComments.test.ts`.
- **Do**:
  1. Write failing tests for each module: the getter returns the default on
     empty/garbage storage and round-trips a written value.
  2. Verify they fail.
  3. Create `inspectorVisibility.ts` — mirror `commentVisibility.ts` exactly:
     `DEFAULT_SHOW_INSPECTOR = true`, storage key `"shippable:show-inspector"`,
     `getStoredShowInspector(): boolean`, `persistShowInspector(value: boolean)`.
  4. Create `inlineComments.ts` likewise: `DEFAULT_INLINE_COMMENTS = false`,
     storage key `"shippable:inline-comments"`, `getStoredInlineComments()`,
     `persistInlineComments(value)`.
  5. Verify tests pass; `npm run test`, `npm run build`, `npm run lint` pass.
  6. Commit: `feat(web): add showInspector and inlineComments preferences`
- **Verify**: both modules round-trip + default; build/lint/test green. (The
  new modules have no consumers yet — that is Task 2.)
- **Depends on**: none

### Task 2: Replace the interactionViewMode enum with the two booleans
- **Files**: `web/src/components/ReviewWorkspace.tsx`, `web/src/keymap.ts`,
  `web/src/components/SettingsModal.tsx`, `web/src/components/Welcome.tsx`,
  `web/src/components/Demo.tsx`, delete `web/src/interactionViewMode.ts` and
  `web/src/interactionViewMode.test.ts`, and update affected component tests.
- **Why one task**: deleting `interactionViewMode.ts` breaks every importer at
  once; the migration must land in one commit to keep the build green.
- **Do**:
  1. Update / extend tests first: `ReviewWorkspace` renders `<Inspector>` when
     `showInspector` is true and not when false; the inline render
     (`.line-inline-threads` / `lineThreads`) appears when `inlineComments` is
     true and not when false; the two are independent (e.g. inspector hidden +
     inline on renders the diff blocks but no panel). Verify they fail.
  2. `ReviewWorkspace.tsx`:
     - Replace the `interactionViewMode` state with two states:
       `showInspector` (init `getStoredShowInspector()`) and `inlineComments`
       (init `getStoredInlineComments()`).
     - Replace `selectInteractionViewMode` / `toggleInteractionViewMode` with
       persisting toggles for each: `toggleShowInspector` (flip + persist via
       `persistShowInspector`) and `toggleInlineComments` (flip + persist via
       `persistInlineComments`), plus a `selectInlineComments(value)` setter
       for the Settings control.
     - `inspectorVisible` → just `showInspector`. Gate `<Inspector>` on it.
     - Gate the inline render — `inlineThreads` / `lineThreads` passed to
       `<DiffView>` — on `inlineComments` (replacing
       `interactionViewMode === "inline"`).
     - The `TOGGLE_INSPECTOR` command case calls `toggleShowInspector`; a new
       `TOGGLE_INLINE_COMMENTS` command case calls `toggleInlineComments`.
     - The topbar action toggles `showInspector` (its `active` reflects
       `showInspector`); it no longer touches inline comments.
     - Pass `inlineComments` + `selectInlineComments` to `<SettingsModal>` in
       place of the old view-mode props; keep `hideNonActiveComments` wiring.
     - Update `buildHelpContext` / help rows: `i` = show/hide the Inspector;
       add `⇧i` = toggle inline comments.
  3. `keymap.ts`: keep an `i` binding whose action toggles the Inspector
     (`TOGGLE_INSPECTOR`); add a `Shift+I` binding → a new
     `TOGGLE_INLINE_COMMENTS` action (add it to the `ActionId` union). Split
     the command-palette entry into two: "toggle the inspector" and
     "toggle inline comments".
  4. `SettingsModal.tsx`: replace the panel/inline segmented control with a
     single `inlineComments` on/off toggle (props
     `inlineComments: boolean` + `onChangeInlineComments: (v: boolean) => void`,
     required; reuse the `modal__btn` styling). Keep the
     "hide non-active comments" control.
  5. `Welcome.tsx`: it renders `<SettingsModal>` — rewire it for the new prop
     shape (local `useState(getStoredInlineComments)` + a set+persist handler,
     same pattern it already uses; the Inspector is not relevant on the
     Welcome screen, so `showInspector` need not be wired there — pass only
     what `SettingsModal` now requires).
  6. `Demo.tsx`: update its `TOGGLE_INTERACTION_VIEW_MODE` keymap case for the
     split (it can toggle a local inline-comments flag, or the Inspector —
     match whatever Demo currently demonstrates; keep Demo compiling and
     coherent).
  7. Delete `web/src/interactionViewMode.ts` + its test. Grep for any
     remaining `interactionViewMode` / `InteractionViewMode` references and
     resolve them.
  8. `npm run test`, `npm run build`, `npm run lint` pass.
  9. Commit: `feat(web): decouple the inspector and inline-comments toggles`
- **Verify**: `i` toggles only the panel; `Shift+I` toggles only inline
  rendering; both states independent; build/lint/test green.
- **Depends on**: Task 1

---

## Part 2 — "+ comment" comment rail

### Task 3: Comment rail replaces the inline "+ comment" CTA
- **Files**: `web/src/components/DiffView.tsx`, `web/src/components/DiffView.css`,
  `web/src/components/InlineLineThreads.tsx`, `web/src/view.ts`, and their tests.
- **Do**:
  1. Write failing tests:
     - `DiffView`: when inline comments is on, every diff line carries a
       left-most rail cell (`.line__rail`); the chat-bubble button appears in
       the rail of the cursor line ONLY; clicking it invokes the
       new-comment handler. When inline comments is off, no rail cell.
     - `InlineLineThreads`: the `thread__start--cta` "+ comment" button is no
       longer rendered.
  2. Verify they fail.
  3. `DiffView.tsx` + `DiffView.css`: add a fixed-width left-most rail column
     to the `.line` grid, present only when inline comments is on. Implement
     it as a leading grid column — gate it with a class on the diff/hunk-body
     container (e.g. `.hunk__body--rail`) that switches
     `grid-template-columns` to `22px 40px 14px 16px 1fr`. EVERY line renderer
     under `.hunk__body` (`Line`, `ContextLine`, and the full-file line
     renderer) must render a leading `<span className="line__rail">` cell when
     the rail is on, so the grid stays aligned. In the cursor line's rail cell
     render a chat-bubble `<button>` (an icon glyph; `title` carries the `c`
     shortcut hint, e.g. "comment on this line (c)"); other lines' rail cells
     are empty. The button's `onClick` calls the new-comment handler — reuse
     `inlineThreads.onStartNewComment` (already plumbed into `DiffView`), and
     `stopPropagation` so the delegated `hunk__body` line-drag handler does not
     treat the rail click as a line-range gesture. A reflow-free alternative
     technique is acceptable if cleaner, as long as it is a fixed-width left
     rail that does not shift the diff body as the cursor moves.
  4. `InlineLineThreads.tsx`: remove the `vm.showNewCommentCta`
     `thread__start--cta` button (the rail bubble replaces it). The draft-stub
     composer path (`showDraftStub` / `draftStubRow`) stays — the composer
     still opens inline beneath the line when a comment is being written.
  5. `view.ts`: `showNewCommentCta` on `InspectorViewModel` is now unused by
     the inline render. Check whether the panel (`InlineThreadStack` /
     `Inspector`) still uses it — if nothing uses it, remove the field and its
     builder logic; if the panel still uses it, leave it. Resolve cleanly.
  6. `npm run test`, `npm run build`, `npm run lint` pass.
  7. Commit: `feat(web): move + comment into a left-most comment rail`
- **Verify**: with inline comments on, the rail shows a cursor-line bubble that
  starts a comment; moving the cursor does not reflow the diff body; the old
  inline CTA button is gone; build/lint/test green.
- **Depends on**: Task 2

### Task 4: E2e coverage
- **Files**: `web/e2e/journey-6-cross-cutting.spec.ts`.
- **Do**:
  1. Add Playwright tests to the journey-6 "inline interactions" block:
     - `i` shows/hides the Inspector and does NOT change inline rendering.
     - `Shift+I` toggles inline comments (the inline thread blocks / rail
       appear/disappear) and does NOT change the Inspector.
     - With inline comments on, the comment rail's cursor-line chat-bubble is
       visible; clicking it opens a comment composer.
     Reuse the existing `beforeEach` (loads `/?cs=42`) and helpers; use
     reliable role/class selectors, no coordinate clicks or timeouts.
  2. Run `npm run test`, `npm run build`, `npm run lint`, and
     `npm run test:e2e` (install `server/` deps once if `tsx` is missing) —
     confirm the journey-6 suite passes.
  3. Commit: `test(e2e): cover decoupled toggles and the comment rail`
- **Verify**: e2e green for journey-6.
- **Depends on**: Task 3

## Self-review notes
- Spec Part 1 (two independent persisted booleans, `i` → Inspector, `Shift+I`
  → inline comments, Settings control, topbar → Inspector, command-palette
  split) → Tasks 1–2. Spec Part 2 (left-most rail column, cursor-line
  chat-bubble, old CTA removed) → Task 3. Testing → every task + Task 4.
- The old `interactionViewMode` enum and module are fully removed in Task 2;
  the build is kept green by migrating all importers in that one commit.
- `hideNonActiveComments` and the threading model are untouched.
- Naming is consistent across tasks: `getStoredShowInspector` /
  `persistShowInspector`, `getStoredInlineComments` / `persistInlineComments`,
  `TOGGLE_INSPECTOR` / `TOGGLE_INLINE_COMMENTS`, `.line__rail` /
  `.hunk__body--rail`.
