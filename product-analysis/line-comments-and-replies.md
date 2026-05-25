# Line comments and replies

## 1. Product reasoning & priority

Threaded discussion is the surface where review actually *happens* — every other primitive (the diff walk, the AI plan, the sign-off gesture) feeds into or out of a thread. The job here is bigger than "leave comments on lines": it's to make every kind of signal a reviewer might emit (a fresh observation, a reply to an AI note, an ack of a teammate's verdict, a response to an agent reply) live as the *same* primitive — one shape, one store, one read seam — so that the inbox, the n/N walk, the agent envelope, and (eventually) the GitHub round-trip all read consistently. The typed-Interactions migration is mostly this feature.

Suggested priority: **must-have**. Strip line comments from a code review tool and you have a diff viewer. The interesting move for a rebuild is *not* whether to ship comments but how aggressively to honor the "one primitive" invariant — the prototype still has small leaks (the legacy `TOGGLE_ACK` action, the un-shipped composer intent picker, the `ackedNotesToInteractions` fixture helper) that the rebuild should close.

## 2. Acceptance criteria for a rebuild

- The composer is the single entry point for every authored Interaction. `c` opens it with `target` derived from current selection (`line` collapsed, `block` multi-line), default intent `comment`. `r` opens it on a focused thread (any thread head — AI note, teammate verdict, hunk summary, user comment, agent reply) and defaults the intent to the thread's `currentAsk`.
- The intent picker is visible above the body. Fresh threads (`target ∈ {line, block}`) expose only the four ask intents (`comment`, `question`, `request`, `blocker`). Replies (`target = "reply"`) expose all eight (four asks + four responses).
- `a` on a focused thread toggles the author's ack: appends `Interaction { intent: "ack", body: "" }` when the author has no current ack, `unack` when they do. The append-only log preserves both events; `selectInteractions().threads[i].currentResponse` derives the live state.
- `Cmd+Enter` submits; `Esc` closes the composer *without* clearing the draft body (drafts survive close/reopen, persisted in localStorage via `drafts` map in the snapshot).
- The reducer (`ADD_INTERACTION`, `TOGGLE_ACK`) rejects any `(target, intent)` pair where `isValidInteractionPair` returns false — a response intent on a `line`/`block` target is a category error.
- A reply lands in `state.interactions[threadKey]` and is mirrored to the server DB via `useInteractionSync` (only when `authorRole === "user"` and `external?.source !== "pr"`).
- Every thread head — AI note, AI hunk summary, teammate verdict, user-started line/block, agent-started top-level — renders through the *same* `InlineThreadStack`/`ReplyThread` components. The Inspector card carries the head's ingest-side chrome (severity glyph, teammate label, ack button); `ReplyThread` renders the replies beneath via the *same* render code regardless of parent provenance.
- Per-author response rollup: `selectInteractions().threads[i].currentResponse` returns the latest non-cancelled response across all authors; `unack` cancels that author's prior `ack` and they drop out of the rollup.
- `currentAsk` derives as the latest ask-intent entry on the thread; `originalAsk` is `interactions[0].intent`. Body-less ask-change replies (`Interaction { intent: "blocker", body: "" }` on a `comment` thread) shift `currentAsk` without changing `originalAsk`.
- Two threads on the same line do not collapse — every fresh `user:` / `block:` key carries a trailing `:<mintCommentId()>` segment.
- The composer's draft is **per-threadKey**, owned by the parent (`draftBodies: Record<string, string>`). Closing one composer does not affect another's draft.
- Deletes are gated to user-authored, non-PR entries (UI), and the reducer removes the threadKey entirely when its last Interaction is deleted (`state.ts:483`).
- Failed enqueues surface as `⚠ retry` pip via `enqueueError: true` on the Interaction (transient client-only flag); successful enqueues flip the persisted `agentQueueStatus` to `pending`/`delivered`.

## 3. Existing architecture & system design

### Data model

- `Interaction` (`web/src/types.ts:587-636`) — the unified primitive: `id`, `threadKey`, `target`, `intent`, `author`, `authorRole`, `body`, `createdAt`, plus optional `anchor*`, `external`, `parentId`, `runRecipe`, agent-only structured fields (`rationale`, `suggestedFix`, `confidence`), and queue state (`agentQueueStatus`, `enqueueError`).
- `state.interactions: Record<threadKey, Interaction[]>` (`web/src/types.ts:281`) — canonical store.
- ThreadKey grammar (`types.ts:659-705`):
  - `note:<hunkId>:<lineIdx>` — AI per-line annotation
  - `hunkSummary:<hunkId>` — AI per-hunk synthesis
  - `teammate:<hunkId>` — teammate verdict head
  - `user:<hunkId>:<lineIdx>:<id>` — user-started line thread
  - `block:<hunkId>:<lo>-<hi>:<id>` — user-started block thread
  - `userFile:<fileId>:<newNo>`, `blockFile:<fileId>:<lo>-<hi>` — file-level threads
- `ThreadSummary` (`interactions.ts:35-47`) — `{ threadKey, currentAsk, originalAsk, currentResponse, interactions }`. Derived at read time.

### Current architecture decisions

- **One store, one seam, one envelope.** `selectInteractions` (`interactions.ts:60-72`) is the only documented read path; it builds `all`, `byIntent`, `byThreadKey`, and `threads` in one walk. `selectIngestSignals` (`interactions.ts:143-181`) reprojects the AI/teammate heads into per-line/per-hunk lookups for the render layer. Wire envelope sits in `server/src/agent-queue.ts:434-499`.
- **Reducer is the validity seam.** `ADD_INTERACTION` (`state.ts:461-473`) rejects invalid `(target, intent)` pairs; `TOGGLE_ACK` (`:427-460`) constructs the next ack/unack Interaction by walking the author's prior responses on the same thread. Both branches preserve append-only — no Interactions are ever mutated in place.
- **Client → server mirror is dispatch-wrapped.** `useInteractionSync` (`web/src/useInteractionSync.ts`) wraps `dispatch` and observes `ADD_INTERACTION` / `TOGGLE_ACK` / `DELETE_INTERACTION` to push them to `/api/interactions`. The hook explicitly distinguishes "user authored locally" from "appeared in state via LOAD_CHANGESET / MERGE_AGENT_REPLIES / MERGE_PR_INTERACTIONS" — only the former mirrors. Failure dispatches `SET_INTERACTION_ENQUEUE_ERROR` (`state.ts:487-501`), surfacing the ⚠ pip.
- **Persistence-tier: server SQLite is the source of truth for interactions.** localStorage v7 (`persist.ts:62-84`) holds review *progress* only (cursor, readLines, reviewedFiles, dismissedGuides, drafts, quiz). The `interactions` table (`server/src/db/schema.ts:16-39`) keys by `id` with `changeset_id` for review rows and `worktree_path` + `agent_queue_status` for the agent-channel rows. Hot columns mirror required Interaction fields; everything else (`anchor*`, `external`, `runRecipe`) rides in `payload_json`.
- **Composer is one component, all threads route through it.** `Composer` inside `web/src/components/ReplyThread.tsx:345-401` is the textarea + submit footer. It is fully controlled by the parent — `draftBody` + `onChange` + `onClose` + `onSubmit`. The parent (`ReviewWorkspace`) owns `draftingKey` (`useState<string | null>`) and `draftBodies` (`Record<string, string>`); only the threadKey identified by `draftingKey` shows its composer.
- **Two render hosts, one body.** `InlineThreadStack` (`InlineThreadStack.tsx`) renders the full thread set for a hunk — AI notes, hunk summary, teammate, user comments, detached. It is hosted in either:
  - **panel** mode by `Inspector` (`Inspector.tsx:346-365`)
  - **inline** mode where `DiffView` mounts `InlineLineThreads` / `InlineDetachedThreads` (`InlineLineThreads.tsx`) at the cursor line and at the diff bottom respectively
  The mode toggles via `i` keybind + `SettingsModal`; both consume the same `InspectorViewModel` (`web/src/view.ts`).
- **Keybindings.** `web/src/keymap.ts:101-107`:
  - `a` → `TOGGLE_ACK` (gated by `when: "lineHasAiNote"`)
  - `r` → `START_REPLY` (gated by `when: "lineHasAiNote"`)
  - `c` → `START_COMMENT` (always)
  - `e` → `RUN_SELECTION`
  - `Shift+M` → `TOGGLE_FILE_REVIEWED`, `Shift+S` → `TOGGLE_CHANGESET_REVIEWED`
  Dispatch lands in `runAction` (`ReviewWorkspace.tsx:760-767`); `START_COMMENT` calls `newCommentKey()` to mint a `user:` or `block:` key based on the live selection.
- **Thread topology in `ReplyThread`** (`ReplyThread.tsx:64-83`): skips the head Interaction when the head is AI-authored or a teammate verdict (the inspector card above the thread already shows the head). Otherwise renders a two-level layout: thread head + nested reply `<ul>`. Agent-authored entries get a dedicated `AgentRow` render (`:256-318`) with intent glyph, confidence chip, rationale/suggested-fix expanders.

### How it evolved

Per `docs/plans/typed-review-interactions.md`, the prior shape was five separate vocabularies projected onto one mental model:

> "Five vocabularies, all describing the same conceptual thing: *what does this interaction express?* This plan generalizes the primitive: every author — humans (you, teammates, PR reviewers), AI (static annotations), and the dialogue agent — emits **review interactions**, each interaction carries an explicit **intent**, and the interactions stack append-only on a shared store. A comment is one intent. Ack is another. Request is the rest of the starter set."

The collapse:

- **`Reply` → `Interaction`.** The umbrella shape gained `intent` and `target` as required fields. `state.replies` became `state.interactions`. The migration story is "no migration; bump `CURRENT_VERSION` and wipe."
- **`AiNote` → `Interaction { authorRole: "ai", target: "line", intent }`.** `AiNote.severity` projects to ask intent: `"info"` → `comment`, `"question"` → `question`, `"warning"` → `request`. The reducer no longer carries `DiffLine.aiNote`; the ingest pipeline emits `Interaction` rows at load time, and `selectIngestSignals` re-projects them per-line for the view-model builder.
- **`hunk.teammateReview` → `Interaction { authorRole: "user", target: "line", threadKey: "teammate:<hunkId>" }`** with verdict mapped: `approve` → `intent: ack`, `comment` → `intent: comment`. The `authorRole: "teammate"` value was *not* kept — the plan explicitly notes "user and teammate *do* collapse" (`typed-review-interactions.md:47`). The teammate provenance lives in the `teammate:` threadKey prefix and the per-Interaction `author` field. The view-model layer (`view.ts:466-495` `buildCommentCounts`, `ReplyThread.tsx:70-74` Inspector-dedupe) reads the teammate-head structurally — `key.startsWith("teammate:") && ix.target !== "reply"` — instead of switching on the old `authorRole === "teammate"`.
- **`state.ackedNotes` → `Interaction { intent: "ack", body: "" }`.** Was a parallel `Set<string>` keyed by `${hunkId}:${lineIdx}` — only valid for AI-note threads. `TOGGLE_ACK` (`state.ts:427-460`) now appends a real Interaction; `selectInteractions().currentResponse` (`interactions.ts:222-240`) rolls up across authors and treats `unack` as cancellation. The `ackedNotesToInteractions` helper in `state.ts:1626-1655` is a **fixture/demo seed bridge** that lifts a `Set<string>` into ack Interactions for test/demo loads — not a runtime carrier.
- **`AgentReply.outcome` → `Interaction { authorRole: "agent", intent }`.** The agent's `outcome` enum (`addressed`/`declined`/`noted`) projected one-to-one onto `accept`/`reject`/`ack`. `MERGE_AGENT_REPLIES` (`state.ts:502`, `mergeAgentInteractions` at `:1166-1300`) is the merge path: polled reply-shaped entries lookup the parent by `parentId` → existing Interaction id → its threadKey; polled top-level entries resolve `(file, lines)` against the active changeset to a `user:`/`block:` key (or land in `detachedInteractions`).
- **Wire envelope.** `<comment kind="...">` → `<interaction target="..." intent="..." ...>` with `author` + `authorRole` + optional `htmlUrl` + optional `parentId` attributes. Lives in `server/src/agent-queue.ts:475-499`; CDATA-wrapped body keeps reviewer prose safe from XML breakage.

### Gaps

- **Slice 2 has not shipped** (`typed-review-interactions.md:534-541`): the composer intent picker is missing. Every newly authored Interaction defaults to `comment`, regardless of `target`. `START_COMMENT` / `START_REPLY` open a body-only textarea; `intent` is plugged at the submit site with the literal `"comment"`.
- **Keybindings are AI-only.** `a` / `r` are still gated by `when: "lineHasAiNote"` (`keymap.ts:102-103`). The plan generalizes `a` to "toggle ack on focused thread" (any thread) and `r` to "reply to focused thread" (any thread head). Today only AI-note lines reach the handlers.
- **`TOGGLE_ACK` is its own action**, separate from `ADD_INTERACTION`. The reducer constructs the ack/unack Interaction inline (`state.ts:441-452`) rather than dispatching through the validated path. `useInteractionSync` then re-runs the reducer to recover the new entry. The plan's slice 3 calls for a single `ADD_INTERACTION { intent: "ack" }` dispatch — incomplete.
- **`ackedNotesToInteractions`** (`state.ts:1626-1655`) still lives in production code, but only `gallery-fixtures.ts` and `Demo.tsx` use it. The plan's slice 3 dropped `state.ackedNotes` from the store and bumped `CURRENT_VERSION`; this helper survives as a fixture-seeding bridge.
- **`selectInteractions` is essentially unused in production code** (only `interactions.test.ts` calls it). Every consumer of cross-thread aggregation today walks `state.interactions` directly: `buildCommentCounts` (`view.ts:466-495`), `buildCommentStops` (`state.ts:1031-1076`), `agentStartedThreads` (`ReviewWorkspace.tsx:2389-2402`). The seam was built; the consumers were not migrated. The inbox view (slice 8) and `currentAsk`/`currentResponse` consumers are still ahead.
- **No `intent`-aware rendering yet.** `ReplyThread.intentGlyph` (`:320-339`) maps every intent to a glyph but the user-authored render in `renderUserRow` doesn't display it; the chip appears only in `AgentRow`. The inspector card header doesn't render `currentAsk`/`originalAsk` — slice 4 is unverified.
- **`reply:` agent-target keys reach the reducer as keys, not as `parentId`-based lookups.** `mergeAgentInteractions` resolves parent → threadKey on poll; the agent's own reply Interactions are stored on the parent's threadKey, so the `parentId` field on the Interaction is informative only (queryable via the agent envelope) — there's no parallel store of agent replies keyed by `parentId`.

## 4. Rebuild opportunities

### Data unification

- **Migrate every cross-thread consumer to `selectInteractions`.** `buildCommentCounts`, `buildCommentStops`, `agentStartedThreads`, and any future inbox/notification surface should call the seam. Today three separate scans of `state.interactions` exist; consolidating them eliminates the "where do I read interactions from?" foot-gun the plan explicitly tried to avoid (§ "One seam.").
- **Drop the `ackedNotesToInteractions` fixture bridge.** The two callers (`Demo.tsx`, `gallery-fixtures.ts`) can author the ack Interactions inline. The helper's `id: "acked:${threadKey}:${user}"` shape leaks demo-only ids into a model that's otherwise random-suffixed (`r-` / `a-` prefixes).
- **Collapse `TOGGLE_ACK` into `ADD_INTERACTION`.** The reducer already has the validity rule and the append-only invariant; the ack-vs-unack decision can move into the dispatcher (or a thin helper) that picks the next intent and emits a normal `ADD_INTERACTION`. The `useInteractionSync` wrapper's "re-run the reducer to diff out the new Interaction" branch (`useInteractionSync.ts:82-88`) goes away in the process.
- **Rename `buildReplyAnchor` → `buildInteractionAnchor`, `parseReplyKey` → `parseThreadKey`.** The "Reply" name survives in three places only (`anchor.ts`, `types.ts:725` parseReplyKey, `view.ts:lineNoteReplyKey`). The latter two are global; the former is local to anchored-comments. All three should follow the rename.

### Better architecture

- **Ship the composer intent picker (Slice 2) before any further response-intent work.** It's the missing link between the typed model and the user. Right now the picker's `intent`/`target` validity rule is enforced at three seams (composer, reducer, wire) but the composer seam has no UI to enforce against.
- **Lift the `r`/`a` gates** off `lineHasAiNote` once the inline thread renderer can focus arbitrary threads (`when: "threadFocused"`). The walk from "focused thread" to "issued action" is a clearer model than "I'm on a line with an AI note."
- **Make `ThreadSummary` the per-thread view-model**, not just a derivation. `InlineThreadStack` consumes a flat list of cards today (AI notes, hunk summary, teammate, user); the view-model could pass `ThreadSummary[]` and let the component decide chrome (head card vs reply list vs ingest chrome) from the structured shape. The current bespoke per-section construction in `buildInspectorViewModel` (`view.ts`) is the largest non-trivial bit of bespoke projection in the codebase.
- **Promote `enqueueError` to a discriminated kind.** Today the ⚠ retry pip and the network-fail seam share one boolean. If retry semantics ever differ for different failure modes (auth, validation, server-down), the boolean has nowhere to grow.

## Sources

- `/workspace/web/src/types.ts:281` (state.interactions), `:587-657` (Interaction, isValidInteractionPair), `:659-705` (threadKey helpers), `:725-805` (parseReplyKey)
- `/workspace/web/src/interactions.ts` (full file; selectInteractions, selectIngestSignals, summariseThread, deriveCurrentResponse)
- `/workspace/web/src/state.ts:427-501` (TOGGLE_ACK / ADD_INTERACTION / DELETE_INTERACTION / SET_INTERACTION_ENQUEUE_ERROR), `:1166-1300` (mergeAgentInteractions), `:1626-1655` (ackedNotesToInteractions)
- `/workspace/web/src/useInteractionSync.ts` (full file)
- `/workspace/web/src/components/ReplyThread.tsx:64-249` (rendering), `:256-318` (AgentRow), `:345-401` (Composer)
- `/workspace/web/src/components/InlineThreadStack.tsx` (panel-mode host), `/workspace/web/src/components/InlineLineThreads.tsx` (inline host)
- `/workspace/web/src/components/ReviewWorkspace.tsx:654-668` (newCommentKey), `:760-767` (START_COMMENT/START_REPLY), `:2389-2402` (agentStartedThreads direct walk)
- `/workspace/web/src/keymap.ts:101-107` (c/r/a bindings)
- `/workspace/web/src/view.ts:466-495` (buildCommentCounts), `:1300-1383` (buildLineThreadsProjection)
- `/workspace/server/src/db/interaction-store.ts:1-310` (DB layer)
- `/workspace/server/src/db/schema.ts:6-58` (table)
- `/workspace/server/src/agent-queue.ts:32-499` (wire shapes + envelope + validity)
- `/workspace/docs/plans/typed-review-interactions.md` (full; § Naming, § Validity, § Workflow, § Slices status snapshot)
- `/workspace/docs/features/line-comments-and-replies.md`
