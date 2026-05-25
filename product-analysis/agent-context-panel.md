# Agent context panel

## 1. Product reasoning & priority

The agent-context panel answers a question that no other PR-review surface answers: *what was the agent trying to do*. When a human reviewer opens a diff produced by Claude (or any coding agent), the highest-leverage context is not "what did the diff change" — that's what the diff itself shows — it's the prompt, the follow-ups, the agent's plan, and the tool calls that led to the diff. Surfacing that context turns review from "decode the artifact" into "audit the trajectory." The panel also hosts the agent → reviewer back-channel (delivered queue, agent-started threads, MCP install affordance) so the loop closes inside the same view: reviewer writes comments, agent fetches them, agent posts replies and fresh top-level comments, reviewer sees them inline. The whole loop lives in the same `interactions` model the rest of the app uses — there's no second store, no second wire.

Suggested priority: **must-have** for the worktree/desktop deployment shapes where the reviewer is reviewing their own (or their teammate's) agent-driven work; the panel is what makes Shippable interesting versus a generic diff viewer. **nice-to-have** in the no-disk / GitHub-PR-only deployment shape (the panel hides entirely there). The whole feature is gated by capability — never disabled-rendered — so the "must" vs "nice" choice is mostly about whether to ship the disk path.

## 2. Acceptance criteria for a rebuild

- Panel renders only when the active changeset has `worktreeSource`. URL ingest / paste / file upload changesets see no panel at all (not disabled — absent).
- The panel auto-matches the worktree path to a Claude Code session by scanning `~/.claude/projects/<encoded-path>/*.jsonl` for entries whose `cwd === worktreePath`. Sessions whose cwd never matches the worktree are excluded.
- Multiple matching sessions surface a `<select>` picker; the default is the session with the most recent `lastEventAt`. The user can pin a different session; the pin lives in React state, not persisted.
- The panel slices a session's transcript by commit boundary: events with timestamps in `(prev-commit-author-date, this-commit-author-date]` on the worktree's branch. Events outside the window are filtered out; events with `cwd !== worktreePath` are filtered out.
- The slice carries: `task` (original user prompt), `followUps[]`, `todos[]` (last `TodoWrite` state), `filesTouched[]` (deduped path list from tool calls), `messages[]` (user/assistant turns), `tokensIn`, `tokensOut`, `durationMs`, `model`.
- Symbol links: backtick-quoted spans in messages that exact-match a symbol defined in the current ChangeSet become click-throughs into the diff. Backtick-quoted spans that *don't* match stay as plain `<code>` (no broken links). Bare identifiers never link.
- Delivered list (newest-first, max 200 entries) shows what the agent has fetched from the queue; entries beyond 200 are dropped server-side and the UI suffixes "(showing last 200)" when at cap.
- "Agent is watching" indicator shows when the server has seen a `shippable_watch_review_comments` poll within `WATCH_TTL_MS` (90s). Polled, approximate; SSE follow-up makes it exact.
- Agent-started threads (top-level Interactions whose first entry has `authorRole: "agent"`) surface as a "Comments (N)" rollup in the panel, newest-first, with anchor + intent + age + body excerpt.
- MCP install affordance renders when the server doesn't detect a `shippable` entry in `~/.claude/settings.json` (or `.local.json`) under `mcpServers`. Detection: `GET /api/worktrees/mcp-status` returns `{installed, installCommand}`. Authoritative install command comes from the server's path resolver (local-build line when `mcp-server/dist/index.js` exists, npx fallback otherwise). Dismiss flag persists in `localStorage["shippable.mcpInstallDismissed"]`.
- Three magic-phrase copy chips: `check shippable`, `report back to shippable`, `watch shippable`.
- Polling cycle: `GET /api/agent/delivered` + `GET /api/agent/replies` run in parallel every `POLL_INTERVAL_MS` (2000ms) while the panel is mounted and tab visible. On visibility change → pause/resume with a catch-up poll on resume. Errors freeze the panel state at last-known until a successful poll.
- Enqueue/unenqueue is part of the *interactions* surface, not a separate queue endpoint: `POST /api/interactions/enqueue` updates `worktree_path` + `agent_queue_status` on an existing interaction row.
- The delivered pip on each user-authored Interaction reads from the polled delivered list (id lookup) — the same data both drives the macro Delivered (N) block and the per-thread `✓ delivered` glyph.

## 3. Existing architecture & system design

### Data model

- `AgentContextSlice` (`web/src/types.ts:443-457`) — the panel's payload. Fetched on demand; not part of `ReviewState`.
- `AgentSessionRef` (`web/src/types.ts:413-421`) — one row per matched Claude Code session.
- `AgentMessage`, `AgentToolCallSummary`, `AgentTodoItem` — per-turn / per-call / per-todo shapes.
- `DeliveredInteraction` (`web/src/types.ts:819-840`) — wire shape of a fetched-by-the-agent interaction; mirrors `server/src/agent-queue.ts:109-112`. Drives the Delivered block and the `✓ delivered` pip lookup.
- Agent-authored entries land in `state.interactions` (regular Interaction shape) via `MERGE_AGENT_REPLIES`. There is no separate `agentComments` store.

### Current architecture decisions

- **State lives outside `ReviewState`.** `Inspector` accepts an optional `AgentContextProps` bundle (`Inspector.tsx:25-77`); the parent (`ReviewWorkspace.tsx`) holds the slice/candidates/loading/error/delivered/watching state as plain `useState` + a fetch effect. Rationale documented in `docs/concepts/agent-context.md` ("transient, async-fetched, per-changeset — we deliberately don't persist it"). The state lifecycle follows the active changeset's `worktreeSource`.
- **Server reads Claude Code's local JSONL transcripts.** `server/src/agent-context.ts` is the parser: `listSessionsForWorktree` (`:114-166`) scans `~/.claude/projects/`, matches by cwd, returns `SessionRef[]`; `agentContextForCommit` (`:229-337`) takes a session file + worktree + optional commit sha and produces a slice. Both functions stream the JSONL line by line (`streamJsonl`, `:377-389`) and silently skip malformed entries (torn writes at file tail are normal).
- **Commit-boundary slice uses git twice.** `commitTimeWindow` (`agent-context.ts:344-375`) runs `git log -1 --format=%H%x09%aI%x09%P` for `sha` and its first parent to get the inclusive-exclusive time window. The slice then filters by epoch ms comparison (string compare is wrong — git uses `-03:00`, JSONL uses `Z`).
- **Polling pulls two endpoints in parallel.** `useDeliveredPolling` (`web/src/useDeliveredPolling.ts`) ticks every `POLL_INTERVAL_MS = 2000` while the document is visible. Each tick runs `Promise.allSettled([fetchDelivered, fetchAgentReplies])` so one failing endpoint doesn't blank the other. Tab visibility → pause/resume; on resume the catch-up tick runs immediately. Failed fetches freeze state and flip `error: true`; the panel banner reads `lastSuccessfulPollAt` to render "last checked X min ago."
- **Enqueue and unenqueue ride the interactions table.** `agent-queue.ts:194-203` and `interaction-store.ts:146-189` show the model: `enqueueToWorktree(id, worktreePath)` sets `worktree_path` + `agent_queue_status='pending'` on the existing row; `unenqueueFromWorktree(id)` clears them. `pullAndAck(worktreePath)` is a transaction that drains pending → delivered atomically. The DB row IS the queue entry; there is no separate queue table.
- **Watch marker is in-memory.** `WATCH_TTL_MS = 90_000` (`agent-queue.ts:416`), `watchPolls = new Map<string, number>()` — last-watch-poll timestamp per worktree. Server restart legitimately clears it ("nothing is watching anymore" is the right answer). `markWatchPoll`/`isWatching` are the seams.
- **Agent → reviewer post-back lives at `POST /api/agent/replies`** (`server/src/index.ts:178-187`). The reducer side (`mergeAgentInteractions` in `web/src/state.ts:1166-1300`) resolves polled entries: reply-shaped via `parentId` → existing Interaction `id` → threadKey; top-level shaped via `(file, lines)` resolved against the active changeset → `user:`/`block:` threadKey, or `agent-detached:<id>` synthetic key when unresolvable.
- **Agent-started threads aggregate via a direct walk.** `agentStartedThreads(state.interactions)` (`ReviewWorkspace.tsx:2389-2402`) iterates the store, picks threads whose `list[0].authorRole === "agent"`, sorts newest-first by `head.createdAt`. The rollup is rendered in `AgentContextSection`'s `AgentStartedThreadsBlock` (`AgentContextSection.tsx:204-233`).
- **Symbol-link tokenizer is custom** (`AgentContextSection.tsx:462-525`): backtick-only, no bare identifier matching. Distinct from `RichText`'s behavior (which links bare identifiers — right for AI plan output, wrong here). The comment in source calls out the rationale.
- **MCP install affordance is server-driven.** `GET /api/worktrees/mcp-status` (`server/src/mcp-status.ts`) reads the user's Claude Code settings file for an `mcpServers.shippable` entry and resolves the right `install` command line.

### How it evolved

The panel itself has not been through the typed-Interactions migration — it never had a competing data shape. What evolved is **how the panel surfaces interaction data**:

- **The free-form "send to agent" composer was removed** by the agent-reply work (`docs/features/agent-context-panel.md:20`, quoting: "The earlier 'Send to agent' composer was removed by the agent-reply work — see `docs/sdd/agent-reply-support/spec.md`. Reviewer → agent freeform messaging now flows out-of-band into the user-agent chat. Comment-anchored replies (line / block / reply-to-AI etc.) and the new agent → reviewer back-channel cover the structured flow.").
- **`AgentReply.outcome` collapsed into `Interaction.intent`.** The plan's prior shape was `AgentReply { outcome: "addressed" | "declined" | "noted" }` nested under a parent `Reply.agentReplies`. The unification mapped the three outcomes to the new response intents one-to-one (`addressed` → `accept`, `declined` → `reject`, `noted` → `ack`) and lifted the entries to top-level Interactions with `authorRole: "agent"`. From `typed-review-interactions.md`: "The `AgentReply.outcome` mapping is now lossless — `addressed`/`declined`/`noted` had no clean home in a 5-intent set, but accept/reject/ack restores the 1-1 correspondence." `mergeAgentInteractions` (`state.ts:1166-1300`) is the implementation.
- **`agentReplies` nesting on Replies is gone.** Agent responses are now sibling Interactions on the parent thread. The seam recovers parent linkage via the `parentId` field on the wire and the `threadKeyByParentId` lookup at merge time (`state.ts:1185-1206`).
- **The MCP install path expanded.** Originally a single `claude mcp add` chip; now `installCommand` is server-authoritative so the chip works for local-build installs even before `@shippable/mcp-server` ships to npm. The Tauri build wraps the affordance in a multi-client modal (`onMcpSetUp` callback).
- **Watch mode is a recent addition.** `shippable_watch_review_comments` lets the agent poll in a loop; the "Agent is watching" indicator in the panel reads the server's TTL marker via the same `/api/agent/replies` poll.

### Gaps

- **Two parallel direct walks of `state.interactions`.** `agentStartedThreads` (`ReviewWorkspace.tsx:2389-2402`) and `buildCommentCounts` / `buildCommentStops` all read the store directly rather than through `selectInteractions`. The seam would do this for them.
- **No SSE / push.** The polling cycle is the only update channel. 2s is fine for delivered/replies; it's wasteful for low-activity sessions and laggy for high-activity ones. The Watch indicator is approximate-by-design — SSE follow-up was acknowledged in the spec but not implemented.
- **In-memory watch marker is correct but invisible.** A user restarting the server while an agent is mid-watch sees the indicator go dark; the agent's next pull re-marks. No surface confirms this; in user-test sessions the missing indicator can look like a bug.
- **The slice fetcher path is best-effort.** `agent-context.ts` calls out unfinished hardening: "cap per-session file size, stream rather than buffer for very long transcripts, debounced cache keyed by file mtime, honest cost/usage extraction" (`:14-18`). For prototype scale this is fine; for any real session it'll need bounded reads.
- **Session-pin not persisted.** A reviewer who picks a non-default session and reloads the page loses the pin. Acceptable for prototype; long sessions where the user wants to keep referring to one specific transcript will want this.
- **The `agentReplies` polled wire shape** (`server/src/agent-queue.ts:323-348` `AgentReplyWireItem`) duplicates fields that already live in `Interaction` — `parentId`/`file`/`lines` could be unified under one envelope. Two shapes flowing in opposite directions through one polling cycle is friction.
- **`AgentContextSection` is the only consumer of the symbol-tokenizer.** The duplicate code (`tokenizeBackticks` at `:504-525` vs the RichText path elsewhere) could share, with a flag for "no bare-identifier matches."

## 4. Rebuild opportunities

### Data unification

- **Route `agentStartedThreads` through `selectInteractions().threads`** — filter to `threads[].interactions[0].authorRole === "agent"`. Today it's a parallel walk; with the seam it's a one-line filter on the existing thread list.
- **Unify the `AgentReplyWireItem` polled shape with `Interaction`.** The poller already converts: `mergeAgentInteractions` translates polled entries into Interactions. The wire could ship `Interaction[]` directly (using `parentId` to discriminate reply vs top-level) and the merge becomes a much shorter call.
- **Move the MCP-dismiss flag** from `localStorage` to the server's settings table (already exists, `schema.ts:43-58`). One persistence surface; one cleanup. Today it sits next to other client-only flags in localStorage.
- **`DeliveredInteraction` is a thin wrapper around `Interaction`** (`web/src/types.ts:819-840`). Drop the wrapper: the only field it adds is `deliveredAt`, which today mirrors `createdAt` server-side (`agent-queue.ts:198-203`, comment: "the channel no longer stamps a distinct delivery time"). Remove `DeliveredInteraction` entirely; consumers read `agentQueueStatus === "delivered"` off the Interaction itself.

### Better architecture

- **Promote the polling cycle to one fetcher that returns a single envelope** `{ delivered: Interaction[], watching: boolean, agentStartedThreads: ThreadSummary[] }`. Today three concepts (delivered list, agent replies poll, agent-started rollup) ride on two endpoints and a client-side scan; one endpoint + the seam can deliver all three.
- **SSE for both delivered and agent-replies.** The 2s polling cadence and TTL-based watch marker are both proxies for "real-time, but we don't have a push channel." The spec calls this out as the follow-up; doing it now would let the Watch indicator and the agent-started Comments block update inside a few hundred ms.
- **Make the panel a `ThreadSummary` consumer alongside the other surfaces.** The agent-started Comments block, the Delivered block, the live `currentResponse` rollup all want the same shape: `{ threadKey, currentAsk, currentResponse, interactions }`. Routing the panel through `selectInteractions` would let it show "12 open requests · 3 accepted by agent · 1 rejected" with no new code.
- **Drop the `cs.id`-as-`originSha` fallback at the wire layer.** Today (`anchor.ts:151-153`) paste/upload loads stamp a non-sha into the originSha field; the panel never sees these (no worktree, no panel) so it's not currently a panel bug, but if file-level commenting ever lights up in the no-worktree case the panel-side renderers (`formatLoc` in `AgentContextSection.tsx:273-275`) need to handle the absence gracefully.
- **Bound the JSONL streaming and cache by mtime.** Per the source comment, a long session can produce a multi-MB transcript that the panel buffers; the fetch effect runs on every changeset switch. A simple in-memory cache keyed by `(filePath, mtime)` would eliminate the redundant reads.

## Sources

- `/workspace/web/src/components/AgentContextSection.tsx` (full file; lines 1-744)
- `/workspace/web/src/components/Inspector.tsx:25-77` (AgentContextProps), `:289-308` (mount)
- `/workspace/web/src/agentContextClient.ts` (full file; thin client)
- `/workspace/web/src/useDeliveredPolling.ts:1-170` (polling cycle)
- `/workspace/web/src/state.ts:1166-1300` (mergeAgentInteractions), `:47-74` (PolledAgentReply)
- `/workspace/web/src/components/ReviewWorkspace.tsx:2389-2402` (agentStartedThreads direct walk), `:1333` (passing to props)
- `/workspace/web/src/types.ts:443-457` (AgentContextSlice), `:819-840` (DeliveredInteraction)
- `/workspace/server/src/agent-context.ts` (full file; JSONL parser + commit slicer)
- `/workspace/server/src/agent-queue.ts:32-499` (queue, wire envelope, watch marker, post-back endpoints)
- `/workspace/server/src/db/interaction-store.ts:134-310` (DB-side queue ops)
- `/workspace/server/src/index.ts:147-187` (interaction + agent endpoints)
- `/workspace/docs/features/agent-context-panel.md` (current feature doc)
- `/workspace/docs/plans/typed-review-interactions.md` § Naming (agent/ai role split), § Mapping (AgentReply.outcome → intents)
