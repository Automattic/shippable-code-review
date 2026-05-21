# Implementation Plan: Hide Inspector Threads When Inline Is On

Based on: docs/sdd/inline-interactions/hide-inspector-threads.md

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task, with per-task spec + code-quality review.

**Goal:** When inline comments is on, the Inspector hides its (duplicated)
thread body and shows a short placeholder; its non-thread chrome stays.

**Tech stack:** React + Vite + TypeScript (`web/`), vitest unit tests,
Playwright e2e. Run `npm` from `/workspace/web/`.

## Key facts for the implementer

- `Inspector.tsx` renders panel chrome (header, `AgentContextSection`, PR
  pill, `PrConversationSection`, the location/code-line `inspector__sec`
  card) and delegates its **thread body** to a single
  `<InlineThreadStack … sections="all" … />` render. That `InlineThreadStack`
  call is the body to gate.
- `ReviewWorkspace.tsx` owns the `inlineComments` boolean (from
  `getStoredInlineComments`) and already renders `<Inspector>` gated on
  `showInspector`.
- The Inspector's header comment-navigation (`‹ n ›`) is chrome — it stays.

## Tasks

### Task 1: Gate the Inspector thread body on inline-comments
- **Files**: `web/src/components/Inspector.tsx`,
  `web/src/components/ReviewWorkspace.tsx`,
  `web/src/components/Inspector.test.tsx`,
  `web/src/components/ReviewWorkspace.test.tsx`.
- **Do**:
  1. Write failing tests:
     - `Inspector.test.tsx`: with a new prop `interactionsShownInline={true}`,
       the Inspector does NOT render the thread body (no `InlineThreadStack`
       content — assert on a stable thread-body element such as the
       "AI concerns" section header text, or the `.notes` list, being absent)
       and DOES render a placeholder element containing the text
       "Comments are shown inline in the diff." The chrome (the panel header
       — e.g. the `inspector` label / comment-nav — and the location card)
       still renders. With `interactionsShownInline={false}` the full thread
       body renders as before.
     - `ReviewWorkspace.test.tsx`: when `inlineComments` is on, the rendered
       `<Inspector>` receives `interactionsShownInline=true` (assert via
       observable DOM — the placeholder text present and the thread body
       absent while the Inspector is open); when off, the thread body renders.
  2. Verify they fail.
  3. `Inspector.tsx`: add a required prop `interactionsShownInline: boolean`
     to its `Props`. At the `<InlineThreadStack … sections="all" … />` body
     render, branch: when `interactionsShownInline` is false render the
     `InlineThreadStack` as today; when true render instead a placeholder —
     a `<section className="inspector__sec">` (or the existing empty-state
     styling) containing a `<p>` (or `inspector__empty`-styled div) with the
     text `Comments are shown inline in the diff.` Do not change any other
     part of `Inspector.tsx` — header, agent-context, PR, location card all
     render unconditionally as before.
  4. `ReviewWorkspace.tsx`: pass `interactionsShownInline={inlineComments}` to
     the `<Inspector>` render.
  5. Verify tests pass; `npm run test`, `npm run build`, `npm run lint` pass.
  6. Commit: `feat(web): hide inspector thread body when inline comments is on`
- **Verify**: inline on → Inspector shows the placeholder, no thread body,
  chrome intact; inline off → full body; build/lint/test green.
- **Depends on**: none

### Task 2: E2e coverage
- **Files**: `web/e2e/journey-6-cross-cutting.spec.ts`.
- **Do**:
  1. Add a Playwright test to the journey-6 "inline interactions" block: with
     the Inspector open (default) and inline comments off, the Inspector shows
     comment threads; after `Shift+I` (inline comments on) the Inspector no
     longer shows the thread body — assert the placeholder text
     "Comments are shown inline in the diff." is visible inside the Inspector
     (`getByRole("complementary", { name: "inspector" })`) and a thread-body
     element is absent; pressing `Shift+I` again restores the threads in the
     panel. Use reliable role/text selectors, no coordinate clicks or
     arbitrary timeouts; reuse the existing `beforeEach` / helpers.
  2. Run `npm run test`, `npm run build`, `npm run lint`, then
     `npm run test:e2e` (install `server/` deps once if `tsx` is missing) —
     confirm the journey-6 suite passes.
  3. Commit: `test(e2e): cover the inspector hiding threads in inline mode`
- **Verify**: `npm run test:e2e` green for journey-6.
- **Depends on**: Task 1

## Self-review notes
- Spec coverage: hide the thread body + show the placeholder when inline on,
  keep chrome (Task 1); the prop wiring from `ReviewWorkspace` (Task 1); e2e
  (Task 2).
- Naming is consistent: the prop is `interactionsShownInline` throughout.
- Scope: only `Inspector.tsx` / `ReviewWorkspace.tsx` / their tests and the
  journey-6 e2e. Inline rendering, the decoupled toggles, the comment column,
  and the threading model are untouched.
