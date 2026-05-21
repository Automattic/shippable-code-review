# Spec: Fetch All Interactions

> **Update — 2026-05-21.** A later fix changed `status=all` and the pull
> envelope; the original behavior below is preserved for history. See
> [§ Update — 2026-05-21](#update--2026-05-21) at the end of this file.

## Goal
Replace the single-purpose `POST /api/agent/pull` with one status-driven
endpoint, `POST /api/agent/interactions`, that lets the review agent fetch its
worktree's interactions as `unread` (and drain them), `delivered`, or `all`.
The MCP tool `shippable_check_review_comments` gains a matching `status`
parameter so the agent can re-read context it already received instead of only
consuming new work.

## Requirements Summary
- New `POST /api/agent/interactions`, body `{ worktreePath, status }`,
  `status` ∈ `unread | delivered | all`, **required** (no default).
- `unread` → pending rows **and acks them** (drain — today's `pull`).
  `delivered` → delivered rows, read-only. `all` → pending + delivered,
  read-only. All sorted `created_at, id`.
- Response `{ payload: <reviewer-feedback XML>, ids: string[] }` for every
  status; reuse `formatPayload`.
- Validation at the HTTP edge: `worktreePath` required → 400; path must pass
  `assertGitDir` → 400; missing or invalid `status` → 400.
- `POST /api/agent/pull` removed; its only caller (MCP handler) updated in the
  same change — no back-compat shim.
- MCP `shippable_check_review_comments` gains a required `status`; every
  invocation states intent.
- `GET /api/agent/delivered` (reviewer-side web UI) is out of scope and stays.

## Chosen Approach
**Generalized `listByQueueStatus` in the store.**

The store gains `listByQueueStatus(worktreePath, statuses: AgentQueueStatus[])`
— a read-only query (no ack) that returns rows whose `agent_queue_status` is in
the given set, sorted `created_at, id`. It **replaces** `listDelivered`, whose
behavior is now `listByQueueStatus(wt, ["delivered"])`.

The draining read stays separate: `pullAndAck` is unchanged. The new endpoint
handler branches on `status`:

- `unread` → `pullAndAck(worktreePath)` (drains pending → delivered)
- `delivered` → `listByQueueStatus(worktreePath, ["delivered"])`
- `all` → `listByQueueStatus(worktreePath, ["pending", "delivered"])`

This keeps the mutate path (`pullAndAck`) and the read path (`listByQueueStatus`)
as distinct functions — the read/consume fork lives in the handler's `switch`,
visible, not hidden behind a parameter. Replacing `listDelivered` with the
parameterized read gives one read surface for both `delivered` and `all`
without a drain-capable mega-function.

### Alternatives Considered
- **Reuse + one new query** — keep `pullAndAck` and `listDelivered` as-is, add a
  single `listAllInteractions` only for `all`. Least churn, but leaves two
  near-identical read functions (`listDelivered` + `listAllInteractions`) that
  `listByQueueStatus` unifies cleanly.
- **Single drain-capable fn** — one `getWorktreeInteractions(wt, status)` that
  conditionally acks. Most consolidated handler, but hides the mutate/read fork
  behind a string — the exact conflation removed from `pull`. Rejected.

## Technical Details

### Architecture
The `interactions` table doubles as a reviewer↔agent channel. Enqueued review
interactions carry a `worktree_path` and an `agent_queue_status` of `pending`
or `delivered`; agent-authored rows have `agent_queue_status = NULL`. So
`status=all` (`pending` + `delivered`) is exactly the set of enqueued review
interactions for a worktree — agent-authored rows are naturally excluded.

> **Superseded.** Excluding agent-authored rows stranded the agent's own
> prior comments — and the parents of replies — from `status=all`. See
> [§ Update — 2026-05-21](#update--2026-05-21).

The HTTP handler replaces `handleAgentPull`. It validates at the boundary
(`worktreePath`, `assertGitDir`, `status`), branches to the store, then formats
the result with the existing `formatPayload` envelope. `handleAgentDelivered`
stays but switches its store call from `listDelivered` to `listByQueueStatus`.

### Data Flow
1. Agent invokes MCP `shippable_check_review_comments({ status })`.
2. MCP handler POSTs `/api/agent/interactions` with `{ worktreePath, status }`.
3. Server validates (`status` required), branches: `unread` → `pullAndAck`;
   `delivered`/`all` → `listByQueueStatus`.
4. Result (`Interaction[]`) → `formatPayload(interactions, commitSha)` → XML.
5. Response `{ payload, ids }` returns to the MCP handler, which passes the
   `payload` text to the agent (today's behavior, unchanged).

`commitSha` is derived from the earliest interaction in the result, as
`handleAgentPull` does today — extract that reduce into a small shared helper so
all three branches use it.

### Key Components
- **`listByQueueStatus(worktreePath, statuses)`** — new read-only store query;
  replaces `listDelivered`. Builds an `IN (?, …)` clause from the statuses array.
- **`handleAgentInteractions`** — replaces `handleAgentPull`; status-branching
  handler with boundary validation.
- **`agentQueue` wrapper** — `listByQueueStatus` wrapper applying `toWire`,
  replacing the `listDelivered` wrapper; `pullAndAck` wrapper unchanged.
- **MCP `status` parameter** — added as a **required** field to the
  `shippable_check_review_comments` zod `inputSchema` and threaded through
  `handleCheckReviewComments` into the request body; request URL changes from
  `/api/agent/pull` to `/api/agent/interactions`.

### File Changes
| File | Change Type | Description |
|------|-------------|-------------|
| `server/src/db/interaction-store.ts` | modify | Replace `listDelivered` with `listByQueueStatus(worktreePath, statuses)`; read-only, `IN (…)` query, sorted `created_at, id`. |
| `server/src/agent-queue.ts` | modify | Replace the `listDelivered` wrapper with a `listByQueueStatus` wrapper (`toWire` map). |
| `server/src/index.ts` | modify | Replace `handleAgentPull` with `handleAgentInteractions` (status branch + validation); route `POST /api/agent/interactions`, drop `POST /api/agent/pull`; point `handleAgentDelivered` at `listByQueueStatus(wt, ["delivered"])`; extract `earliestCommitSha` helper. |
| `mcp-server/src/handler.ts` | modify | `handleCheckReviewComments` accepts `status`, posts to `/api/agent/interactions` with `{ worktreePath, status }`. |
| `mcp-server/src/index.ts` | modify | Add `status` as a required field to the `shippable_check_review_comments` zod `inputSchema`; thread it into the handler call. |
| `server/src/index.test.ts` | modify | Cover the new endpoint: each status, missing/invalid `status` → 400, drain semantics of `unread`. |
| `server/src/db/interaction-store.test.ts` | modify | Cover `listByQueueStatus` for `["delivered"]`, `["pending","delivered"]`, and that it does not ack. |
| `server/src/db/interaction-endpoints.test.ts` | modify | Adjust any `listDelivered`/pull references. |
| `mcp-server/src/handler.test.ts` | modify | Cover the `status` param and the new endpoint URL. |
| `docs/concepts/agent-context.md` | modify | Document the merged endpoint and status values. |
| `docs/plans/api-review.md` | modify | Reflect `/api/agent/pull` → `/api/agent/interactions`. |

## Out of Scope
- Folding `GET /api/agent/delivered` into the merged endpoint — the reviewer-side
  web UI keeps polling it.
- Reviewer-side / web UI changes.
- Non-XML response formats.

## Open Questions Resolved
- **Where does `status` live?** — Iterated from `pull` → a new GET → ultimately a
  *merged* `POST /api/agent/interactions` that subsumes `pull`. `status=unread`
  makes the ack/drain an explicit, named behavior rather than a hidden side
  effect.
- **HTTP method?** — `POST`, because `status=unread` mutates; a GET that
  sometimes mutates was rejected.
- **Default `status`?** — None; `status` is required on both the endpoint and
  the MCP tool. A `unread` default would make a mutating drain the implicit
  behavior; an `all` default would make a bare call never drain, costing the
  agent its "new since last check" signal. Requiring it avoids both.
- **Output format?** — XML `{ payload, ids }` for all statuses, so the MCP tool
  passes it straight through with no JSON→XML formatting glue.
- **`/api/agent/delivered` fate?** — Left as-is; different consumer (web UI).
- **Store layering?** — Generalized `listByQueueStatus` replacing `listDelivered`,
  with `pullAndAck` kept separate for the draining `unread` path.

## Update — 2026-05-21

Two changes to the behavior specified above, from testing the pull end to end.

**`status=all` includes agent-authored rows.** The original `all` queried
`["pending","delivered"]`, so agent-authored rows (`agent_queue_status = NULL`)
were excluded — which also meant a reviewer's reply could come back without the
agent comment it answered. `all` now returns *every* interaction for the
worktree regardless of queue status, via a new store query
`listAllForWorktree(worktreePath)` (`SELECT … WHERE worktree_path = ?`) wrapped
as `agentQueue.readAllInteractions`. `unread` and `delivered` are unchanged.

**Replies carry their parent, and the pull pulls parents in.** Two halves:

- `toWire` now projects `payload.parentId`, and `renderInteraction` emits a
  `parentId="…"` attribute, so a reply `<interaction>` links to the comment it
  answers. Reviewer replies to an agent comment now record that `parentId`
  too — the web composer stamps it from the thread head, and
  `/api/interactions` stores it (added to the `PAYLOAD_FIELDS` allowlist).
- `agentQueue.withReferencedParents` runs on every pull (`unread`, `delivered`,
  `all`): for any reply whose parent isn't already in the result, it appends
  that parent read-only, walking the chain for reply-to-a-reply. The `ids`
  array still reports only the resolved/drained interactions — parents are
  context, not deliveries.

This realizes the parent-context intent from `docs/sdd/agent-comments/`
(requirement 14) in the current `<interaction>` wire format. Canonical
behavior now lives in `docs/concepts/agent-context.md`.
