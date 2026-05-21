# Implementation Plan: Comment Threading & Visibility

Based on: docs/sdd/inline-interactions/comment-threading.md

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task, with per-task spec + code-quality review.

## Status

All 6 tasks complete (commits `686aaed`…`65c8eed`, plus review fixups).
Executed via subagent-driven development with per-task spec + code-quality
review and a final holistic review. `web/` build, lint, the 640-test vitest
suite, and the 64-test Playwright e2e suite all pass. Final review: ready to
merge.

**Goal:** Make each user comment its own thread (two-level threading: comment →
flat replies), and add a default-off "hide non-active comments" setting that
restricts inline mode to the cursor line.

**Tech stack:** React + Vite + TypeScript (`web/`), vitest unit tests,
Playwright e2e. Run `npm` from `/workspace/web/`.

The plan has two phases. **Part 1** (Tasks 1–3) is the threading model and is
independently shippable. **Part 2** (Tasks 4–6) builds the visibility setting
on top.

## Key facts for the implementer

- Thread keys live in `web/src/types.ts`: `userCommentKey`, `blockCommentKey`,
  `parseReplyKey` (+ `ParsedReplyKey`). Hunk ids can contain `:`
  (`pr:host:owner:repo:N`), so `parseReplyKey` strips trailing segments with
  `lastIndexOf`.
- Today `userCommentKey(hunk, line)` returns ONE key per line — every comment
  on a line collapses into it. `block:` keys are already prefix-scanned in
  `view.ts`.
- `state.ts` `rekey()` (~line 727) re-keys an interaction when its anchor
  relocates on reload. `view.ts` `buildInspectorViewModel` builds
  `userCommentRows` (~line 992) and the "+ comment" CTA fields (`curKey`,
  `showNewCommentCta`, `showDraftStub`, `draftStubRow`, `currentLineCommentKey`).
- Comment creation: `ReviewWorkspace.tsx` (~line 576) and `Demo.tsx` (~1564)
  pick the thread key for a new comment from the cursor; `onSubmitReply` sets
  `target: isFirst ? firstTargetForKey(key) : replyTarget()`.
- `ReplyThread.tsx` renders a thread's interactions flat; its doc comment notes
  user-authored thread heads are kept and shown as "the first reply in the
  thread view".
- A persisted-preference pattern exists in `web/src/interactionViewMode.ts`
  (`getStored…` / `persist…`, localStorage, `typeof window` guard).

---

## Part 1 — Two-level comment threading

### Task 1: Per-comment thread keys + view-model projection
- **Files**: `web/src/types.ts`, `web/src/state.ts`, `web/src/view.ts`,
  `web/src/components/ReviewWorkspace.tsx`, `web/src/components/Demo.tsx`,
  fixtures (`web/src/fixtures/cs-42-preferences.ts`, `cs-91-agent-flow.ts`,
  `fixtures/cs-99-verify-features.ts`, `web/src/gallery-fixtures.ts`), and the
  matching `*.test.ts` files for `types.ts` and `view.ts`.
- **Why one task**: changing `userCommentKey` / `blockCommentKey` to require a
  unique id forces every caller in one commit (AGENTS.md: change the thing and
  update its callers together). `view.ts` looks threads up *by line*, which is
  impossible once keys carry an id — so the view-model builder must be
  rewritten as a prefix-scan in the same change.
- **Do**:
  1. Write failing tests:
     - `types.test.ts` (or the existing thread-key test file): `userCommentKey("h", 4, "abc")`
       → `"user:h:4:abc"`; `blockCommentKey("h", 3, 7, "abc")` →
       `"block:h:3-7:abc"`; `parseReplyKey("user:h:4:abc")` →
       `{ kind:"user", hunkId:"h", lineIdx:4, id:"abc" }`;
       `parseReplyKey("block:pr:gh:o:r:9:3-7:abc")` →
       `{ kind:"block", hunkId:"pr:gh:o:r:9", lo:3, hi:7, lineIdx:3, id:"abc" }`;
       `mintCommentId()` returns distinct values on successive calls.
     - `view.test.ts`: `buildInspectorViewModel` with TWO `user:` threads on
       the same line (different ids) yields TWO `userCommentRows` for that
       line; a `block:` thread still yields one block row.
  2. Verify they fail.
  3. `types.ts`:
     - `userCommentKey(hunkId: string, lineIdx: number, id: string)` →
       `` `user:${hunkId}:${lineIdx}:${id}` ``.
     - `blockCommentKey(hunkId: string, lo: number, hi: number, id: string)` →
       `` `block:${hunkId}:${lo}-${hi}:${id}` ``.
     - Add `mintCommentId(): string` — `Math.random().toString(36).slice(2, 8)`
       (same entropy style as `newReviewerInteractionId`; no timestamp needed).
     - `ParsedReplyKey`: add `id: string` to the `user` and `block` variants.
     - `parseReplyKey`: for `user`, `rest` is `hunkId:lineIdx:id` — strip the
       last `:`-segment as `id`, the next as `lineIdx`, remainder is `hunkId`.
       For `block`, `rest` is `hunkId:lo-hi:id` — strip the last segment as
       `id`, the next as the `lo-hi` range, remainder is `hunkId`. `null` on
       malformed keys.
  4. `state.ts` `rekey()` (~727): `case "user"` →
     `userCommentKey(newHunkId, newLineIdx, parsed.id)`; `case "block"` →
     `blockCommentKey(newHunkId, newLineIdx, newHi, parsed.id)` — preserve the
     id from `parsed`. At `state.ts` ~1055 (anchor-located comment key): read
     the surrounding code — if it re-keys an existing thread, carry that
     thread's id; if it genuinely creates a thread, `mintCommentId()`.
  5. `view.ts` — rewrite the `userCommentRows` builder (~992–1047): instead of
     `userCommentKey(hunk.id, i)` per line, prefix-scan `replies` (and
     `draftingKey`) for every key that `parseReplyKey`s to
     `{ kind:"user", hunkId: hunk.id }`, emit one `UserCommentRowItem` per
     thread (`lineIdx`/`lineNo`/`isCurrent` from the parsed `lineIdx`). Keep
     the existing `block:` scan. Sort by `lineIdx`. For the "+ comment" CTA:
     `currentLineCommentKey` no longer maps to a single key — remove it;
     expose `showNewCommentCta` (true when no new-comment draft is open on the
     cursor line) plus the cursor `hunkId`/`lineIdx`. Detect a "new-comment
     draft" structurally: `draftingKey` parses to
     `{ kind:"user", hunkId: cursorHunk, lineIdx: cursorLine }` with empty
     `replies[draftingKey]` → drives `showDraftStub` / `draftStubRow`. Update
     `InspectorViewModel` / `BuildInspectorViewModelArgs` types; fix the
     `view.ts:328` `userCommentKey(hunk.id, i)` usage the same prefix-scan way.
  6. `ReviewWorkspace.tsx` (~576) and `Demo.tsx` (~1564): the new-comment key
     mints a fresh id — `userCommentKey(hunkId, lineIdx, mintCommentId())` /
     `blockCommentKey(...)`. (Task 2 refines the full "+ comment" flow; here
     just compile + mint unique keys.)
  7. Fixtures (`cs-42`, `cs-91`, `cs-99`, `gallery-fixtures.ts`): pass a
     literal id to each `userCommentKey`/`blockCommentKey` call (e.g. `"c1"`);
     the `threadKey` field inside each interaction must equal its map key.
  8. `npm run test`, `npm run build`, `npm run lint` pass.
  9. Commit: `feat(web): per-comment thread keys and view-model projection`
- **Verify**: two comments on a line → two rows; `parseReplyKey` round-trips
  the new shape; build/lint/test green.
- **Depends on**: none

### Task 2: "+ comment" mints a thread; "+ reply" stays a reply
- **Files**: `web/src/components/ReviewWorkspace.tsx`,
  `web/src/components/InlineLineThreads.tsx`,
  `web/src/components/InlineThreadStack.tsx`,
  `web/src/components/Demo.tsx`, and their tests.
- **Do**:
  1. Write failing tests: clicking "+ comment" on the cursor line opens a
     draft composer keyed to a freshly-minted `user:` thread key; submitting
     it creates a NEW thread; a second "+ comment" yields a second thread, not
     a reply into the first.
  2. Verify they fail.
  3. The "+ comment" button currently calls
     `onStartDraft(vm.currentLineCommentKey)` (`InlineLineThreads.tsx` ~78,
     `InlineThreadStack.tsx` ~288) — but `currentLineCommentKey` was removed in
     Task 1. Replace it with a dedicated callback `onStartNewComment()`
     threaded from `ReviewWorkspace`. `ReviewWorkspace`'s handler mints
     `userCommentKey(cursorHunk, cursorLine, mintCommentId())` — or
     `blockCommentKey(...)` when a multi-line selection is active (mirror the
     existing block/line branch at `ReviewWorkspace.tsx` ~574) — and calls
     `setDraftingKey(thatKey)`. The `c` keybind's `START_COMMENT` case in
     `ReviewWorkspace.tsx` and `Demo.tsx` mints the same way.
  4. Confirm the per-comment thread card's composer button stays "+ reply" —
     for a per-comment `user:` thread it is now genuinely a reply, so no label
     change in `ReplyThread.tsx` is needed; verify it reads "+ reply".
  5. Verify tests pass; `npm run test`, `npm run build`, `npm run lint` pass.
  6. Commit: `feat(web): + comment mints a new thread per click`
- **Verify**: two clicks of "+ comment" → two distinct threads; "+ reply"
  inside a card appends to that card's thread.
- **Depends on**: Task 1

### Task 3: Render comment threads two-level (head as comment, replies nested)
- **Files**: `web/src/components/ReplyThread.tsx`,
  `web/src/components/ReplyThread.css`, `web/src/components/ReplyThread.test.tsx`.
- **Do**:
  1. Write failing tests: for a `user:` thread with a head + 2 replies,
     `ReplyThread` renders the head distinctly (not as a row under a
     "replies (N)" label) and the 2 replies nested beneath it; the
     "replies (N)" count is 2, not 3.
  2. Verify they fail.
  3. In `ReplyThread.tsx`, `rows` currently includes the user-authored head as
     the first `.reply`. Split it: render the thread head (the interaction
     whose `target` is `line`/`block`) as the comment, then the
     `target: "reply"` entries nested beneath it (a nested `<ul>` or an indent
     class). "replies (N)" counts only the reply entries. For
     `note:`/`teammate:` threads the head is ingest-sourced and already
     skipped — that path is unchanged (the surrounding card shows the note).
  4. Add minimal `ReplyThread.css` for the reply indent. Keep "+ reply" as the
     thread composer button.
  5. Verify tests pass; `npm run test`, `npm run build`, `npm run lint` pass.
  6. Commit: `feat(web): render comment threads two-level`
- **Verify**: head reads as the comment; replies nest beneath; count correct.
- **Depends on**: Task 2

---

## Part 2 — Render-all-comments inline + the setting

### Task 4: Persisted "hide non-active comments" preference
- **Files**: `web/src/commentVisibility.ts` (new),
  `web/src/commentVisibility.test.ts` (new).
- **Do**:
  1. Write failing tests: `getStoredHideNonActiveComments()` returns `false`
     (default) on empty/garbage storage and round-trips `true` after
     `persistHideNonActiveComments(true)`.
  2. Verify they fail.
  3. Create `commentVisibility.ts` with `DEFAULT_HIDE_NON_ACTIVE_COMMENTS = false`,
     storage key `"shippable:hide-non-active-comments"`,
     `getStoredHideNonActiveComments()`, `persistHideNonActiveComments(value)`
     — mirror the structure of `getStoredInteractionViewMode` /
     `persistInteractionViewMode` in `interactionViewMode.ts` (localStorage,
     `typeof window` guard, try/catch).
  4. Verify tests pass; `npm run test`, `npm run build`, `npm run lint` pass.
  5. Commit: `feat(web): persist the hide-non-active-comments preference`
- **Verify**: round-trip + default fallback.
- **Depends on**: none (may run in parallel with Part 1)

### Task 5: Render every line's threads inline; gate on the setting
- **Files**: `web/src/view.ts`, `web/src/components/DiffView.tsx`,
  `web/src/components/ReviewWorkspace.tsx`, and their tests.
- **Do**:
  1. Write failing tests: in inline mode with `hideNonActiveComments` false,
     `DiffView` renders an inline thread block under EACH line that has
     AI-note or user-comment threads (not just the cursor line); with the
     setting true, only the cursor line's block renders.
  2. Verify they fail.
  3. Add a per-line thread projection to `view.ts` — a pure selector that,
     given the hunk + `state.interactions` + ingest signals, returns for each
     `(hunkId, lineIdx)` the AI-note and user-comment threads anchored there
     (build on `selectInteractions` / `selectIngestSignals`). Give it its own
     exported type.
  4. In `DiffView.tsx`, the inline line-anchored render currently mounts
     `InlineLineThreads` only beneath the cursor line. Change it: when the
     per-line projection is supplied, mount an inline block under every line
     that has threads. The cursor line's block still carries the "+ comment"
     CTA + draft composer (from the cursor-scoped `InspectorViewModel`); other
     lines render their threads with per-comment "+ reply" working. Keep the
     `InlineThreadsRegion` pointer-isolation wrapper per block and the
     `ResizeObserver` cursor-scroll behaviour.
  5. In `ReviewWorkspace.tsx`, own `hideNonActiveComments` state (initialised
     from `getStoredHideNonActiveComments`); when true, pass only the cursor
     line's entry to `DiffView` (collapsing to today's behaviour); when false,
     pass the full per-line projection.
  6. Verify tests pass; `npm run test`, `npm run build`, `npm run lint` pass.
  7. Commit: `feat(web): render all line threads inline, gated by the setting`
- **Verify**: setting off → every line's threads; on → cursor line only;
  hunk-level + detached blocks unaffected.
- **Depends on**: Task 3, Task 4

### Task 6: Settings control + e2e coverage
- **Files**: `web/src/components/SettingsModal.tsx`,
  `web/src/components/ReviewWorkspace.tsx`, `web/src/components/Welcome.tsx`,
  `web/src/components/SettingsModal.test.tsx`,
  `web/e2e/journey-6-cross-cutting.spec.ts`.
- **Do**:
  1. Write failing tests: `SettingsModal` shows a "hide non-active comments"
     toggle reflecting the current value and calling the change handler.
  2. Verify they fail.
  3. Add the toggle to `SettingsModal` next to the interaction-view-mode
     control. `SettingsModal` gains required props
     `hideNonActiveComments: boolean` + `onChangeHideNonActiveComments: (v: boolean) => void`.
     `ReviewWorkspace` passes its state + a setter that also calls
     `persistHideNonActiveComments`; `Welcome.tsx` (the other `SettingsModal`
     caller) wires it via `getStoredHideNonActiveComments` /
     `persistHideNonActiveComments`, exactly as it already does for the
     interaction view mode.
  4. Add e2e tests to the journey-6 "inline interactions" block: two comments
     on one line render as two separate cards; a reply nests under its own
     comment (not after all comments); toggling "hide non-active comments"
     flips all-visible vs cursor-only.
  5. `npm run test`, `npm run build`, `npm run lint` pass; run
     `npm run test:e2e` (install `server/` deps once if `tsx` is missing) and
     confirm the journey-6 suite passes.
  6. Commit: `feat(web): hide-non-active-comments setting control + e2e`
- **Verify**: the setting flips behaviour end-to-end; e2e green.
- **Depends on**: Task 5

## Self-review notes
- Spec Part 1 (per-comment keys, view-model, affordances, two-level render)
  → Tasks 1–3. Spec Part 2 (setting, render-all, gating) → Tasks 4–6.
- AI-note / teammate / hunk-summary threads keep their keys; only `user:` /
  `block:` keys gain the id, and only `ReplyThread`'s head/reply split
  (Task 3) changes — ingest-headed threads stay on their existing skipped-head
  path.
- Fixtures and `Demo.tsx` are updated in Task 1 so the build never breaks on
  the signature change.
- Panel mode (`Inspector`) is not restructured: it renders per-comment cards
  as a consequence of Task 1's view-model change, and the visibility setting
  governs inline mode only.
