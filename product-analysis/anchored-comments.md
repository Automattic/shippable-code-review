# Anchored comments

## 1. Product reasoning & priority

Anchored comments solve a problem unique to a review tool that walks beside a live coding session: between the moment you write a comment and the moment you (or your agent) come back to it, the underlying code can move. An agent commits a fix. You stash uncommitted edits. The hunk shifts by ten lines. In any conventional review tool, the comment then either silently re-anchors to whichever line happens to live at the same line number (false), or detaches with no breadcrumb (also unhelpful). The job here is to keep a reviewer's intent attached to *content*, not to *coordinates* — and when the content really is gone, to keep the comment visible with the original snippet so the reviewer can decide whether it still applies. This is foundational to the "review walks alongside coding" thesis.

Suggested priority: **must-have**. Without it the worktree live-reload story and any agent-in-the-loop flow break: every commit by the agent would shred attached comments. The implementation is small (one short module + one reload path) and the cost of skipping it is paid by the user on every reload.

## 2. Acceptance criteria for a rebuild

- Every reviewer-authored Interaction with a `target` of `line` or `block` captures, at write time: `anchorPath`, `anchorContext` (10 lines around the anchor), `anchorHash` (FNV-1a-32 of the 5 lines centered on the anchor), `anchorLineNo`, `originSha`, and `originType` (`committed` | `dirty`).
- The capture clips at hunk boundaries — windows near the start/end of a hunk still produce stable hashes (missing rows contribute the empty string).
- On `RELOAD_CHANGESET`, every thread is re-anchored as a unit: the *first* interaction on the thread carrying `anchorHash`/`anchorPath` decides where the whole thread lands (one Interaction wandering doesn't tear the thread apart).
- Threads bias toward staying in the same `(hunkIdx, lineIdx)` when the hash still matches (`findAnchorInFile`'s `prefer` argument) — unrelated edits elsewhere don't pull the anchor.
- A thread whose anchor window is no longer found anywhere in the file moves into `state.detachedInteractions` carrying its original threadKey; the inspector still surfaces it under a "Detached" section.
- Block-comment ranges keep their original span size when re-anchored, clamped to the new hunk's line count.
- AI-note (`note:`), hunk-summary (`hunkSummary:`), and teammate (`teammate:`) threads are skipped from re-anchoring — they are re-ingested fresh from `selectIngestSignals` each load. File-level (`userFile:`, `blockFile:`) threads pass through untouched.
- Interactions without `anchorHash` (legacy / pre-anchor) still get a best-effort match by in-place hashing the old hunk at the parsed `lineIdx`.
- PR-imported line comments that don't anchor onto a visible position in the patch land in `detachedInteractions` carrying their original `diff_hunk` snippet as `anchorContext`.
- Re-anchoring is a *pure* reducer step: `reloadChangeset` takes the old + new changesets and yields a new `interactions` map plus an extended `detachedInteractions` array, no I/O.

## 3. Existing architecture & system design

### Data model

The anchor fields live directly on the `Interaction` shape (`web/src/types.ts:587-636`):

```
anchorPath?: string;
anchorHash?: string;
anchorContext?: DiffLine[];
anchorLineNo?: number;
originSha?: string;
originType?: "committed" | "dirty";
```

A thread that fails to re-attach becomes a `DetachedInteraction` (`web/src/types.ts:219-223`) — `{ interaction, threadKey }` — and joins `state.detachedInteractions` (`web/src/types.ts:299`).

### Current architecture decisions

- **One module owns the math.** `web/src/anchor.ts:1-166` holds FNV-1a, `hashAnchorWindow`, `captureAnchorContext`, and `findAnchorInFile` (with its `prefer` bias). All callers go through these.
- **Write-time capture happens through `buildReplyAnchor`** (`anchor.ts:127-165`), called by the reducer when a new user/block thread Interaction is dispatched. The function looks up the parsed reply key, captures the window, and stamps `originSha`/`originType` from the active `worktreeSource` (falling back to the changeset id for paste/upload ingest).
- **Re-anchoring lives in the reducer** (`web/src/state.ts:771-869`, `reloadChangeset`). It runs on `RELOAD_CHANGESET`, walks every threadKey, picks the thread-level `anchorHash`/`anchorPath` from the first qualifying interaction, and uses `findAnchorInFile` with `prefer` set to the old hunk position. On match, the *entire* thread is re-keyed via `rekey()` and merged into the new map. On miss, every Interaction on the thread is appended to `detachedInteractions` with the original threadKey.
- **The store is the canonical surface for anchored data.** `state.interactions` (`types.ts:281`) and `state.detachedInteractions` (`types.ts:299`) are the only stores; ingest pipelines emit Interactions at load time and `selectIngestSignals` (`interactions.ts:143-181`) reprojects them into per-line lookups. There is no second source of truth for "what comment lives on this line".
- **Anchor data persists to the server DB** via the `payload_json` column (`server/src/db/interaction-store.ts:1-110`). The hot columns are `id/threadKey/target/intent/author/authorRole/body/createdAt`; everything anchor-related rides as JSON inside `payload`. A spread on read (`web/src/interactionClient.ts:30-50`) reflates the Interaction.
- **Wire envelope projects from `payload`.** The agent-facing wire (`server/src/agent-queue.ts:131-176`) pulls `file` from `payload.anchorPath` and `lines` from `payload.anchorLineNo`, so anchor data is the source of truth for *where* an enqueued comment claims to live.

### How it evolved

This feature is one of the cleaner cases in the typed-Interactions migration: it was *already* attached to the `Reply` shape and so collapsed straight into `Interaction` without semantic change. The plan calls this out explicitly — "Anchor / detached-replies. `anchor.ts` and the reload pass. These move untouched in the typed-interactions work but they're load-bearing for `external?.source === "pr"` flows the plan exercises" (`docs/plans/typed-review-interactions.md` § Slices, slice 0 bullet 4).

The legacy shape attached anchor fields to a `Reply` whose discriminator was `Comment.kind: "line" | "block" | "reply-to-ai-note" | "reply-to-teammate" | "reply-to-hunk-summary"`. The unification:

- Renamed the discriminator from `kind` to `target` and collapsed reply variants to a single `"reply"` value. The five old `reply-to-*` values are recovered structurally from the `threadKey` prefix (`note:`/`hunkSummary:`/`teammate:`/`user:`/`block:`) and the head Interaction's `authorRole`. See `typed-review-interactions.md` § Naming.
- Moved the anchor capture call from `ADD_REPLY` to `ADD_INTERACTION`; the helper (`buildReplyAnchor`) was not renamed because `parseReplyKey` still owns the threadKey grammar. The anchor module is one of the few places where the old "Reply" name survives — a leftover that should be renamed to `buildInteractionAnchor` / `InteractionAnchorFields` for clarity.
- Detached replies became `DetachedInteraction`; the persisted snapshot dropped to localStorage v3 then v4, where interactions and the detached bucket moved to the server SQLite (`persist.ts:62-70`).

### Gaps

- `anchor.ts` still uses the old vocabulary: `buildReplyAnchor`, `ReplyAnchorFields`, references to "reply" throughout the file header. The function operates on Interactions; the name should follow.
- File-level (`userFile:`, `blockFile:`) threads are deliberately not re-anchored (`state.ts:816-820`) — the comment in source mentions a follow-up plan (`docs/plans/comment-on-unchanged-lines.md`) but the path is unimplemented. A reviewer who comments on an unchanged line and reloads gets pass-through behavior with no anchor verification.
- AI/teammate/hunkSummary threads pass through `reloadChangeset` untouched and are re-projected from the new diff via `selectIngestSignals`. The feature-doc claim that "`hunkSummary` and `teammate` threads re-attach to the new hunk by hashing the hunk's first line" (`docs/features/anchored-comments.md:18`) is **out of date** — that path no longer exists; the new diff just produces new ingest signals and the old ones are dropped on the next render.
- `originSha` falls back to `cs.id` for paste/upload loads (`anchor.ts:151-153`), which is not a real sha. Detached cards reading `originSha` to render "committed at `<sha7>`" silently misrender for non-worktree loads.
- Re-anchoring is hash-only — no token/edit-distance fallback. A single-character change in the 5-line window detaches the thread even when a human would see it's still the same code. Acceptable for v0; calling it out as a known sensitivity.

## 4. Rebuild opportunities

### Data unification

- **Rename `buildReplyAnchor` → `buildInteractionAnchor`** and `ReplyAnchorFields` → `InteractionAnchorFields`. Pure rename, contained in `anchor.ts` plus its handful of callers. Eliminates the last user of the legacy "Reply" vocabulary in the anchored-comments slice.
- **Drop the `userFile`/`blockFile` pass-through branch** (`state.ts:816-820`) once the unchanged-lines plan ships, or document that path as a known gap inside `anchor.ts` instead of `state.ts`. The split-personality "we handle some keys, pass others through" is harder to reason about than "anchored or detached".
- **`originSha` for non-worktree loads should be null** rather than a stuffed `cs.id`. The detached caption can switch on absence; today it lies.

### Better architecture

- **Make `reloadChangeset` consume `selectInteractions` rather than walking `state.interactions` directly.** Today the reducer re-implements thread enumeration (`state.ts:809`) — the seam already has a `threads` array sorted with stable keys. Routing through the seam keeps the "one read path" invariant and lets the thread-summary derivation (`currentAsk`/`currentResponse`) inform anchoring decisions if we ever want to (e.g. resolved threads can detach more aggressively).
- **Lift the FNV-1a window hash into a shared utility** if anchored content ever needs to be addressable on the server side (e.g. for agent-side replays). Today it's web-only.
- **Persistence-tier honesty:** the anchor fields ride in `payload_json` (server/src/db/interaction-store.ts), which is intentional, but means an SQL-side query for "all comments on file X" requires a JSON extract. If anchor lookup becomes a hot path (search, inbox), promote `anchorPath` to a real column. Not needed today.

## Sources

- `/workspace/web/src/anchor.ts` (full file; lines 1-166)
- `/workspace/web/src/state.ts:771-869` (`reloadChangeset` + re-anchoring loop)
- `/workspace/web/src/types.ts:587-636` (Interaction anchor fields), `:219-223` (DetachedInteraction)
- `/workspace/web/src/interactions.ts:60-181` (selectInteractions / selectIngestSignals)
- `/workspace/server/src/github/pr-load.ts:240-326` (PR import → DetachedInteraction)
- `/workspace/server/src/db/interaction-store.ts:1-110` (payload_json storage)
- `/workspace/server/src/agent-queue.ts:131-176` (wire projection from payload)
- `/workspace/docs/plans/typed-review-interactions.md` § Naming, § Migration, § Slices
- `/workspace/docs/features/anchored-comments.md` (current feature doc; stale on hunkSummary re-anchoring)
