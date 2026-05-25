# Block comments

## 1. Product reasoning & priority

A reviewer often wants to flag *a region* rather than a line: "this whole `if/else` cluster has the wrong invariant," "these three test cases all share the same brittle setup." A line-only commenting model forces them to either pick the least-bad single line (and bury the rest of the intent in prose) or write the same comment three times. Block comments make the unit of attention match the unit of code — and since Shippable's anchoring model travels with the comment, a block comment also expresses *what the comment is about* in a form the agent can read structurally on the wire (`target="block"`, `lines="72-79"`). It's a small primitive with disproportionate effect on the quality of typed-intent feedback.

Suggested priority: **must-have**. The block target is one of three values in the `InteractionTarget` union and is already part of every wire-level contract (agent payload, GitHub round-trip when sentinels land, view-model projections). Removing it would simplify a few hundred lines but would force every "this region is wrong" comment back into prose, undoing one of the cleaner wins of the typed-Interactions plan.

## 2. Acceptance criteria for a rebuild

- Selecting a contiguous range of lines inside *one* hunk (Shift+Arrow keys, mouse drag, or context-menu "Select & comment") establishes a `LineSelection { hunkId, anchor, head }` in `ReviewState`.
- Pressing `c` (or picking "Comment" from the line context menu) with a live multi-line selection mints a fresh `block:<hunkId>:<lo>-<hi>:<id>` thread key and opens the composer. `lo`/`hi` are pre-sorted (`lo <= hi`); the trailing `id` segment keeps two block comments on the same range from collapsing.
- Pressing `c` with no selection (or a collapsed one) mints a `user:<hunkId>:<lineIdx>:<id>` line thread instead.
- Submitting writes an `Interaction { target: "block", intent: <ask>, threadKey: "block:..." }` to the store. The reducer rejects any block-keyed Interaction whose intent is a response (`isValidInteractionPair`).
- A block thread visible in the diff highlights its full range (anchor → head) when the user lands on it; the inline thread card renders beneath the `hi` line, and clicking the card re-selects the range (`onJumpToBlock`).
- Block threads are reachable from the n/N comment walk in file → hunk → `lo` order; the cursor lands on the block's `lo` line.
- Block comments survive a worktree reload: the re-anchor pass treats `block:` keys uniformly with `user:` keys, finds the new anchor (using `lo` as the anchor line), preserves the original span size clamped to the new hunk, and re-keys via `rekey()`.
- A block thread whose anchor can't be found in the new diff lands in `state.detachedInteractions` with its original threadKey, surfaced under "Detached" in the inspector.
- The wire envelope emits `lines="<lo+1>-<hi+1>"` (1-based, matching GitHub's convention) for block interactions; the agent receives structured range data without prose parsing.
- The context menu offers Comment / Run prompt / Reply / Mark read on a range; "Reply to AI" is disabled when the range covers more than one line (AI notes are per-line).

## 3. Existing architecture & system design

### Data model

- `LineSelection` (`web/src/types.ts:249-254`) — `{ hunkId, anchor, head, charRange? }`. Captures the keyboard/mouse selection.
- `Interaction.target = "block"` (`web/src/types.ts:558`, `:590`) — the unified primitive's topology axis.
- ThreadKey grammar (`types.ts:685-692`): `block:<hunkId>:<lo>-<hi>:<id>` where `id` is a six-character base36 mint (`mintCommentId`, `:695-697`). The `lastIndexOf`-based parser in `parseReplyKey` (`:725-805`) handles PR csIds that contain colons.

### Current architecture decisions

- **One threadKey shape, one parser.** The block grammar lives next to the line/user/userFile/blockFile/note/teammate/hunkSummary keys in `types.ts`. `parseReplyKey` is the single source of truth (`anchor.ts:134` comment calls this out explicitly).
- **Composer entry point is centralized in `newCommentKey()`** (`web/src/components/ReviewWorkspace.tsx:654-668`): it inspects `state.selection` and returns a `blockCommentKey()` when the selection is live and spans more than one line on the cursor's hunk, otherwise a `userCommentKey()`. Two consumers — keyboard `c` (`runAction("START_COMMENT")` at `:765-767`) and the line context menu "Comment" item (`:2237`) — both go through it.
- **The line context menu is one component for all line/range gestures.** `LineContextMenu.tsx` (entire file) is presentation-only — items + shortcut + enabled + onSelect. `ReviewWorkspace.tsx:2208-2274` builds the items, computing `range = sel?.{lo,hi} ?? {lo: ctx.lineIdx, hi: ctx.lineIdx}` (line `:2210-2217`) so range-aware items (Mark read, Run prompt, Comment) get the right scope, and `replyEnabled` is gated to single-line selections (`:2226-2230`).
- **The selection sub-system is uniform across keyboard and mouse.** `DiffView.tsx:230-340` handles native browser text selection, multi-line drag → `onLineSelectRange`, right-click → `onLineContextMenu`. Keyboard Shift+Arrow flows through the reducer's `MOVE_LINE` action with `extend: true`. Both paths produce the same `LineSelection` shape.
- **Inline rendering anchors block threads to `hi`** (`web/src/view.ts:1366-1371`) — the cursor-line render uses `(r.rangeHiLineIdx ?? r.lineIdx) === vm.cursorLineIdx`, and the projection in `buildLineThreadsProjection` keys block rows on `parsed.hi` (`view.ts:1368`). The user clicks the block card → `onJumpToBlock(cursor, selection)` re-selects the range (`InlineThreadStack.tsx:346-354`).
- **`onJumpToBlock` is a separate prop from `onJump`** so plain line threads can be jumped to with a collapsed cursor while block threads restore their selection. The Inspector wires both (`Inspector.tsx`).
- **Re-anchoring is part of the unified path.** `reloadChangeset` (`state.ts:809-869`) treats block keys identically to user keys; the only difference is the anchor line — for block parsing the `lo` line is used (`state.ts:831-832`). Span size is preserved by `rekey()` (`state.ts:860`) which reads `parsed.hi - parsed.lo` and clamps to the new hunk's length.
- **Wire envelope** (`server/src/agent-queue.ts:478-499`): when `c.lines` is set the attribute renders. The block wire shape is `target="block"` + `lines="72-79"`. Validity rule (`agent-queue.ts:75-81`) rejects any reply-target block payload; on the web side `isValidInteractionPair` (`types.ts:651-657`) is the matching seam.

### How it evolved

Before the typed-Interactions unification, the wire vocabulary was:

```
Comment.kind ∈ "line" | "block" | "reply-to-ai-note" | "reply-to-teammate" | "reply-to-hunk-summary"
```

— the five-value enum mixing topology (line/block) with parent-discriminator (reply-to-X). The plan (`docs/plans/typed-review-interactions.md` § Naming) walks through the collapse:

> "The five reply variants are also redundant: the existing `threadKey` prefix (`note:` / `hunkSummary:` / `teammate:` / `user:` / `block:`) already encodes parent provenance, and an interaction's `authorRole` (`user` / `ai` / `agent`) further discriminates author category."

After the migration, block keeps its identity (it's not a reply *to* anything — it anchors fresh on code), and the `target` axis is now the three-value union `"line" | "block" | "reply"`. Validity (`isValidInteractionPair`) was added at the same time to make "block + ack" a reducer-rejected category error rather than a renderable nonsense Interaction.

The other surfaces that changed:
- Composer entry point used to inspect `Reply.kind`; now it inspects `state.selection` and mints the right threadKey directly.
- Inline rendering used to read `comment.kind === "block"`; now it reads `parsed.kind === "block"` from `parseReplyKey`.
- The `block:<hunkId>:<lo>-<hi>` key picked up a trailing `:<id>` segment (`types.ts:685-692`) so two block threads on the same range stay distinct. The parser's `lastIndexOf`-based split is the explicit nod to PR csIds carrying colons (`types.ts:756-773`).

### Gaps

- The composer offers no intent picker yet — `START_COMMENT` opens a body-only textbox and defaults to `intent: "comment"` (see Slice 2 status in `typed-review-interactions.md:534` — "Composer intent picker — ❌ not shipped"). Block comments inherit this: the `target="block"` is correct but the intent is always `comment`. A reviewer wanting to mark a range as a `blocker` has to edit prose, not pick.
- The wire envelope's `lines` attribute is rendered from `payload.anchorLineNo` for single-line interactions or `payload.lines` for agent-started ones (`agent-queue.ts:131-142`). Block interactions written by the user store their range *only* in the threadKey; there's no `lines: "lo-hi"` in payload. The server-side wire projection currently emits the `lo` as a single number for block interactions enqueued from a user reviewer — verify in slice 5 / wire tests.
- `onJumpToBlock` lives as a separate prop on six components (Inspector, InlineThreadStack, InlineLineThreads, UserThreadCard, ...) — minor surface bloat that a single `onJump(cursor, { selection? })` could collapse.
- The context menu's "Reply to AI" branch (`ReviewWorkspace.tsx:2226-2230`) hardcodes the AI-only ack/reply flow; once response intents land more broadly (Slice 3) the menu should grow accept/reject/ack items rather than the single "Reply to AI" shortcut.

## 4. Rebuild opportunities

### Data unification

- **`charRange` lives on `LineSelection` but only the line-comment flow reads it.** The text-selection sub-range is captured by the diff (`DiffView.tsx`), travels through the reducer, and never propagates to the Interaction's payload. Either ship it through to the wire ("the reviewer flagged columns 12-37 of line 84") or drop it from `LineSelection` — today it's half-wired.
- **No more `comment.kind` shadows.** A search of the web codebase confirms the legacy `Comment.kind: "block"` is fully gone — `block` only appears as a `target` value or as a `block:` threadKey prefix. The migration is clean here.
- **The wire's block payload should include `lines: "<lo+1>-<hi+1>"` in `payload_json`** at enqueue time rather than reconstructing it from the threadKey. The server's `wireLines` (`agent-queue.ts:136-142`) currently falls back to `anchorLineNo` (single number) for reviewer-authored interactions; agent-started block interactions store `lines` directly. The asymmetry is a slice-5 follow-up.

### Better architecture

- **Anchor `lo`/`hi` in payload, not only in the threadKey.** Today the *only* place the range lives for a reviewer-authored block Interaction is the parsed threadKey. The Interaction shape carries `anchorLineNo` (single number) but no `anchorLineNoHi`. This forces every consumer (wire projection, inline rendering, re-anchor) to parse the key to recover the range. Storing the range on the Interaction would let the threadKey become a pure id (the `:<id>` suffix already moves it that way).
- **Collapse `onJump`/`onJumpToBlock` into one navigation primitive.** A `JumpTarget = Cursor & { selection?: LineSelection }` would let one prop and one handler cover both cases. The block-aware callers would carry `selection`; line callers wouldn't.
- **Route the n/N walk through `selectInteractions().threads`** instead of `buildCommentStops`'s direct `Object.entries(interactions)` scan (`state.ts:1031-1076`). The seam already produces threads in file → hunk → line order; the walk would inherit `currentAsk`/`currentResponse` for free, enabling "skip resolved threads" without a second scan.
- **Hoist the `LineContextMenu` items into a per-target predicate set** so menu construction can share code with the (still-to-build) composer intent picker. Both surfaces answer the same question: "given this target + state, which intents/actions are valid?"

## Sources

- `/workspace/web/src/types.ts:249-254` (LineSelection), `:558` (InteractionTarget), `:685-697` (block key helpers), `:725-805` (parseReplyKey)
- `/workspace/web/src/components/LineContextMenu.tsx` (full file)
- `/workspace/web/src/components/ReviewWorkspace.tsx:654-668` (newCommentKey), `:2208-2274` (context menu items)
- `/workspace/web/src/components/DiffView.tsx:230-340` (selection + context-menu plumbing)
- `/workspace/web/src/components/InlineThreadStack.tsx:339-374` (block-aware row click → onJumpToBlock)
- `/workspace/web/src/view.ts:1366-1383` (block row anchored to `hi`), `:1338-1372` (per-line projection)
- `/workspace/web/src/state.ts:809-869` (reloadChangeset re-anchor), `:1031-1076` (buildCommentStops)
- `/workspace/server/src/agent-queue.ts:75-81` (validity), `:131-176` (wire projection), `:478-499` (renderInteraction)
- `/workspace/docs/plans/typed-review-interactions.md` § Naming, § Validity, § Slices (status snapshot)
- `/workspace/docs/features/block-comments.md` (current feature doc)
