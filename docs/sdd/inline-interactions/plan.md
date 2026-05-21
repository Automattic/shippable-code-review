# Implementation Plan: Inline Interactions

Based on: docs/sdd/inline-interactions/spec.md

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## Status

All 11 tasks complete. Implemented via subagent-driven development with
per-task spec + code-quality review and a final holistic review. `web/`
build, lint, and the 594-test suite pass. See `implementation-notes.md` for
deviations and the outstanding interactive browser QA.

## Tasks

### Task 1: Add interaction view-mode persistence helpers
- **Files**: `web/src/interactionViewMode.ts`, `web/src/interactionViewMode.test.ts`
- **Do**:
  1. Write a failing test in `interactionViewMode.test.ts`: `getStoredInteractionViewMode` returns `"panel"` (default) when storage is empty or holds garbage, and round-trips `"inline"` after `persistInteractionViewMode("inline")`.
  2. Verify the test fails.
  3. Create `interactionViewMode.ts`: export `type InteractionViewMode = "panel" | "inline"`, `DEFAULT_INTERACTION_VIEW_MODE = "panel"`, storage key `"shippable:interaction-view-mode"`, `isInteractionViewMode`, `getStoredInteractionViewMode`, `persistInteractionViewMode` — mirror the structure of `getStoredThemeId` / `persistThemeId` in `web/src/tokens.ts` (same try/catch, `typeof window` guard).
  4. Verify the test passes.
  5. Commit: `feat(web): add interaction view-mode persistence helpers`
- **Verify**: `npm run test` passes for the new test; `npm run build` passes.
- **Depends on**: none

### Task 2: Extract InlineThreadStack from the Inspector body
- **Files**: `web/src/components/InlineThreadStack.tsx`, `web/src/components/InlineThreadStack.css`, `web/src/components/InlineThreadStack.test.tsx`, `web/src/components/Inspector.tsx`, `web/src/components/Inspector.test.tsx`
- **Do**:
  1. Write a failing test in `InlineThreadStack.test.tsx`: given a representative `InspectorViewModel` (AI-note row, user-comment row, hunk summary, teammate verdict, detached thread), the component renders each section.
  2. Verify the test fails.
  3. Create `InlineThreadStack.tsx` — a presentation-only component taking the `InspectorViewModel` body fields plus the interaction callbacks (`onToggleAck`, `onStartDraft`, `onCloseDraft`, `onChangeDraft`, `onSubmitReply`, `onJump`, `onJumpToBlock`, retry/delete handlers). Move the AI-note cards, user-comment threads, hunk summary, teammate verdict, detached threads, and new-comment CTA markup out of `Inspector.tsx` into it. Move the corresponding CSS into `InlineThreadStack.css`.
  4. In `Inspector.tsx`, keep the panel chrome (header, location label, comment prev/next nav, agent-context section) and render `<InlineThreadStack>` for the body.
  5. Verify `InlineThreadStack.test.tsx` and the existing `Inspector.test.tsx` pass; update `Inspector.test.tsx` only where assertions moved into the new component.
  6. Commit: `refactor(web): extract InlineThreadStack from Inspector body`
- **Verify**: `npm run test`, `npm run build`, `npm run lint` all pass; Inspector renders identically in panel mode (browser check at `/`).
- **Depends on**: none

### Task 3: Add persisted interactionViewMode state to ReviewWorkspace
- **Files**: `web/src/components/ReviewWorkspace.tsx`
- **Do**:
  1. Write/extend a failing test asserting the workspace renders `<Inspector>` when mode is `"panel"` and omits it when mode is `"inline"`.
  2. Verify it fails.
  3. Add `interactionViewMode` state initialised from `getStoredInteractionViewMode()`; call `persistInteractionViewMode` whenever it changes. Gate the `<Inspector>` render on `interactionViewMode === "panel"`. Fold the existing `showInspector` hide/show concern into this — `panel` mode means the panel is shown; `inline` means it is not. Keep any non-mode use of `showInspector` (e.g. transient collapse) only if one exists; otherwise remove it.
  4. Verify the test passes.
  5. Commit: `feat(web): add persisted interaction view-mode state`
- **Verify**: `npm run test`, `npm run build` pass; panel still appears on load.
- **Depends on**: Task 1

### Task 4: Render inline line-anchored threads in DiffView
- **Files**: `web/src/components/DiffView.tsx`, `web/src/components/DiffView.css`, `web/src/components/DiffView.test.tsx`
- **Do**:
  1. Write a failing test: when `DiffView` receives an `inlineThreads` prop (the cursor's `InspectorViewModel` + callbacks), it renders `InlineThreadStack` line-anchored rows in a region immediately beneath the `isCursor` line, and renders nothing inline when the prop is absent.
  2. Verify it fails.
  3. Add the optional `inlineThreads` prop to `DiffView`. In the `Line` rendering path, after the cursor line (`DiffLineViewModel.isCursor`), render a variable-height region containing the line-anchored portion of `<InlineThreadStack>`. Add `DiffView.css` rules for the region (full-width under the line, indented to the code column).
  4. Verify the test passes.
  5. Commit: `feat(web): render inline line-anchored threads in DiffView`
- **Verify**: `npm run test`, `npm run build`, `npm run lint` pass.
- **Depends on**: Task 2

### Task 5: Render hunk-level threads in the cursor hunk header
- **Files**: `web/src/components/DiffView.tsx`, `web/src/components/DiffView.css`, `web/src/components/DiffView.test.tsx`
- **Do**:
  1. Write a failing test: when `inlineThreads` is present and a hunk is `isCurrent`, that hunk's header renders the AI hunk summary and teammate verdict from the VM; non-current hunks render only their existing badges.
  2. Verify it fails.
  3. In the hunk header render for the `isCurrent` hunk, render the hunk-level rows of `<InlineThreadStack>` (AI summary, teammate verdict) as an expandable block. Add `DiffView.css` for the header block.
  4. Verify the test passes.
  5. Commit: `feat(web): render hunk-level threads in cursor hunk header`
- **Verify**: `npm run test`, `npm run build`, `npm run lint` pass.
- **Depends on**: Task 4

### Task 6: Route the InspectorViewModel to the cursor's DiffView
- **Files**: `web/src/components/ReviewWorkspace.tsx`
- **Do**:
  1. Write a failing test: in `inline` mode, the `DiffView` whose file contains the cursor receives `inlineThreads`; other `DiffView`s and (in `panel` mode) all of them receive `undefined`.
  2. Verify it fails.
  3. In `ReviewWorkspace`, when `interactionViewMode === "inline"`, pass the already-built `buildInspectorViewModel(...)` result plus its callbacks as `inlineThreads` to the `DiffView` matching `state.cursor.changesetId`/`fileId`. In `panel` mode pass `undefined`.
  4. Verify the test passes.
  5. Commit: `feat(web): route interaction view-model into inline DiffView`
- **Verify**: `npm run test`, `npm run build` pass; switching modes shows threads inline vs in the panel (browser check).
- **Depends on**: Task 3, Task 5

### Task 7: Keep cursor scroll-into-view correct across inline reflow
- **Files**: `web/src/components/DiffView.tsx`, `web/src/components/DiffView.test.tsx`
- **Do**:
  1. Write a failing test (or extend an existing cursor-scroll test) asserting the cursor `scrollIntoView` effect re-runs after the inline region under the cursor line mounts/changes height.
  2. Verify it fails.
  3. Adjust the `cursorRef` scroll-into-view effect so it depends on the inline region's presence/size — run it after the inline thread mounts so `n`/`N` navigation lands on the cursor line, not above the expanded region.
  4. Verify the test passes.
  5. Commit: `fix(web): keep cursor in view across inline thread reflow`
- **Verify**: `npm run test`, `npm run build` pass; `n`/`N` navigation in inline mode lands correctly (browser check).
- **Depends on**: Task 6

### Task 8: Move the cursor when a collapsed glyph or hunk header is clicked
- **Files**: `web/src/components/DiffView.tsx`, `web/src/components/DiffView.test.tsx`
- **Do**:
  1. Write a failing test: clicking a collapsed `line__ai` glyph dispatches `SET_CURSOR` to that line; clicking a non-cursor hunk's interaction affordance dispatches `SET_CURSOR` into that hunk.
  2. Verify it fails.
  3. Wire the `line__ai` glyph (and the non-cursor hunk-header interaction affordance) to dispatch `SET_CURSOR` so the target thread expands inline. Reuse the existing cursor-dispatch path used by line clicks.
  4. Verify the test passes.
  5. Commit: `feat(web): expand inline thread on glyph/hunk-header click`
- **Verify**: `npm run test`, `npm run build`, `npm run lint` pass.
- **Depends on**: Task 6

### Task 9: Add the panel/inline toggle to SettingsModal
- **Files**: `web/src/components/SettingsModal.tsx`
- **Do**:
  1. Write a failing test: `SettingsModal` shows a panel/inline control and invokes the change handler with the chosen mode.
  2. Verify it fails.
  3. Add a control to `SettingsModal` bound to `interactionViewMode` (segmented control or toggle, matching the modal's existing controls). Thread the value and change handler from `ReviewWorkspace`.
  4. Verify the test passes.
  5. Commit: `feat(web): add interaction view-mode toggle to settings`
- **Verify**: `npm run test`, `npm run build`, `npm run lint` pass.
- **Depends on**: Task 3

### Task 10: Add topbar toggle and i keybind for view mode
- **Files**: `web/src/components/ReviewWorkspace.tsx`, `web/src/components/TopbarActions.tsx`
- **Do**:
  1. Write a failing test: the topbar action toggles `interactionViewMode`, its label reflects the current mode, and the `i` keybind flips the mode.
  2. Verify it fails.
  3. Replace the existing `inspector` topbar action and `i` keybind so they toggle `interactionViewMode` between `panel` and `inline` (label e.g. "inline interactions" / "panel"). Keep one keybind for "where interactions live."
  4. Verify the test passes.
  5. Commit: `feat(web): toggle interaction view mode from topbar and keybind`
- **Verify**: `npm run test`, `npm run build`, `npm run lint` pass.
- **Depends on**: Task 3

### Task 11: Full verification of both modes
- **Files**: none (verification only)
- **Do**:
  1. Run `npm run build`, `npm run lint`, `npm run test` in `web/` — all pass.
  2. In the browser at `/`: load a fixture changeset; confirm panel mode is unchanged; toggle to inline mode and confirm line-anchored threads expand on cursor, hunk-level threads show in the cursor hunk header, the inline composer submits, ack/unack and agent pips work, and `n`/`N` navigation lands correctly.
  3. Reload the page and confirm the mode persisted.
  4. Spot-check `/gallery.html` and `/demo.html` still render.
  5. Commit any fixups needed: `fix(web): inline interactions verification fixups`
- **Verify**: all quality gates green; both modes work end to end; mode persists across reload.
- **Depends on**: Task 7, Task 8, Task 9, Task 10
