# Group 3 — cross-cutting unification notes

The big move (one `Interaction` primitive, one store, one wire) is largely done. What remains is leftover code that still bypasses the seam, plus a few legacy names that didn't follow the rename. Roughly ordered by leverage.

## Leftover dangling code

- **`selectInteractions` is essentially unused in production.** Only `interactions.test.ts` calls it. Every cross-thread consumer reads `state.interactions` directly — `buildCommentCounts` (`web/src/view.ts:466-495`), `buildCommentStops` (`web/src/state.ts:1031-1076`), `agentStartedThreads` (`web/src/components/ReviewWorkspace.tsx:2389-2402`), and the rollup in `AgentContextSection`. The seam was built; consumers weren't migrated.
- **`TOGGLE_ACK` is its own reducer action** (`web/src/state.ts:427-460`), separate from `ADD_INTERACTION`. The wrapper `useInteractionSync` then re-runs the reducer to recover the new Interaction (`useInteractionSync.ts:32-43, 82-88`). Slice 3's "ack as a normal Interaction" is half-done — it's *modeled* as one, but dispatched through a separate action.
- **`ackedNotesToInteractions`** (`web/src/state.ts:1626-1655`) survives as a fixture-seeding bridge for `Demo.tsx` and `gallery-fixtures.ts`. The runtime store no longer carries `state.ackedNotes`; this is the last reference to the concept.
- **Legacy "Reply" vocabulary in three load-bearing modules**: `buildReplyAnchor`/`ReplyAnchorFields` (`anchor.ts`), `parseReplyKey` (`types.ts:725`), `lineNoteReplyKey`/`hunkSummaryReplyKey`/`teammateReplyKey` (`types.ts:662-670`). They operate on Interactions; the names trail the migration.
- **`DeliveredInteraction` is a redundant shape** (`types.ts:819-840`, `agent-queue.ts:109-112`). Its only field beyond Interaction — `deliveredAt` — mirrors `createdAt` (the channel no longer stamps a distinct time). Consumers could read `agentQueueStatus === "delivered"` directly.
- **`AgentReplyWireItem`** (`server/src/agent-queue.ts:323-348`) is a polled wire shape that converts back to `Interaction` at merge time (`state.ts:1166-1300`). Two shapes for one concept, flowing in one direction.
- **`view-model` `teammateReview` field** (`view.ts:102-106`) — a render-only mirror of the projected `TeammateSignal`. Fine as a view-model, but worth noting that the same data lives in three shapes now: store Interaction → ingest signal → view-model field.

## Parallel UI rendering paths

- **Two hosts for the same thread body.** `InlineThreadStack` (panel-mode) and `InlineLineThreads` (inline-mode) share the same `InspectorViewModel` but render its sections via slightly different component subsets. `NoteCard`/`UserThreadCard` are exported from `InlineThreadStack.tsx` and reused; the section chrome differs. Structural parity is the contract, but the two-host arrangement is the kind of place where a section starts rendering in one host and not the other.
- **Composer is one component, but mounted at every thread.** `ReplyThread.Composer` is the textarea; the parent owns `draftingKey` / `draftBodies`. Once the intent picker lands (Slice 2 ❌), the picker needs to live in the composer, not duplicated per host.

## Remaining inconsistencies

- **`r` and `a` keybindings are AI-only** (`keymap.ts:101-103`, `when: "lineHasAiNote"`). The plan generalizes them to "focused thread" — today only AI-note lines reach the handlers.
- **The composer intent picker hasn't shipped** (Slice 2 ❌). Every authored Interaction defaults to `intent: "comment"`. The typed model is in place; the user surface is not.
- **GitHub round-trip (sentinels + glyphs) hasn't shipped** (Slice 6 ❌). Push/pull is plain-comment-only; intent survives only within Shippable's own store.
- **`ackedNotesRevision` / `interactionsRevision` memo invalidation** — the architecture doc references these counters; the actual selector caches on `state` identity since selectors are called eagerly per render. If `selectInteractions` becomes a hot path (when consumers migrate), the memo plumbing the plan describes will need to land.
- **Block range data lives only in the threadKey.** Reviewer-authored block Interactions don't store `lo`/`hi` on the Interaction; the wire's `lines` attribute is reconstructed from the parsed key. Agent-authored block Interactions *do* carry `lines` in payload. Asymmetric.
