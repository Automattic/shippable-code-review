# Fetch All Interactions — Requirements

## Goal
Give the review agent one endpoint to fetch its worktree's interactions by
status — unread (and drain), delivered, or all — replacing the single-purpose
`pull`. Today the agent can only consume new work via the draining pull; it
cannot re-read context it has already received.

## Requirements
1. New endpoint `POST /api/agent/interactions`, body `{ worktreePath, status }`,
   where `status` ∈ `unread | delivered | all` and is **required** — there is
   no default, because the default would be either a mutating behavior
   (`unread`) or one that degrades the agent's drain workflow (`all`).
2. Status behavior:
   - `status=unread` → pending rows **and acks them** (drains pending →
     delivered — today's `/api/agent/pull` behavior).
   - `status=delivered` → delivered rows, read-only (no side effect).
   - `status=all` → pending + delivered rows, read-only (no side effect).
     *(Later widened to include agent-authored rows — see spec.md
     "Update — 2026-05-21".)*
   - All results sorted `created_at, id`.
3. Response is `{ payload: <reviewer-feedback XML>, ids: string[] }` for every
   status value — the same shape `/api/agent/pull` returns today. Reuse
   `formatPayload` server-side.
4. Validation (at the HTTP boundary): `worktreePath` required → 400; path must
   pass `assertGitDir` → 400; a missing or invalid `status` value → 400.
5. `POST /api/agent/pull` is removed. Its sole caller — the MCP handler — is
   updated in the same change. No back-compat shim (per AGENTS.md).
6. The MCP tool `shippable_check_review_comments` gains a **required** `status`
   parameter (`unread | delivered | all`) and calls the new endpoint. Every
   invocation states intent; bare `check_review_comments()` calls must now pass
   `status`.

## Constraints
- The merged endpoint stays `POST` because `status=unread` mutates state; a GET
  that sometimes mutates is not acceptable.
- The XML envelope (`formatPayload`) is the agent-facing contract — keep it.
- `npm run build`, `npm run lint`, `npm run typecheck` (server) must pass;
  vitest coverage for the touched store/endpoint/MCP code.

## Out of Scope
- Folding `GET /api/agent/delivered` into the merged endpoint. It is untouched —
  the reviewer-side web UI (`useDeliveredPolling`, `agentContextClient`) keeps
  polling it. Different consumer, separate change.
- Reviewer-side / web UI changes.
- Non-XML response formats (raw JSON `Interaction[]`).

## Open Questions
None.

## Related Code / Patterns Found
- `server/src/index.ts` — `handleAgentPull` (~1040–1084) and `handleAgentDelivered`
  (~1086–1114) route handlers; route table at ~140–177. `handleAgentPull` becomes
  the status-branching `handleAgentInteractions`.
- `server/src/agent-queue.ts` — `pullAndAck`, `listDelivered`, `formatPayload`,
  `toWire`. Needs read-only wrappers for "list pending" and "list all" alongside
  the existing draining `pullAndAck`.
- `server/src/db/interaction-store.ts` — `pullAndAck` (drains pending → delivered)
  and `listDelivered`. Needs new read functions for pending (read-only, no ack)
  and all-for-worktree; candidate to generalize as `listByQueueStatus`.
- `mcp-server/src/handler.ts` — `handleCheckReviewComments` and `PullResponse`;
  the request URL and body gain `status`.
- `mcp-server/src/index.ts` — `shippable_check_review_comments` tool registration;
  the zod `inputSchema` gains a `status` field.
- Tests: `server/src/index.test.ts`, `server/src/db/interaction-store.test.ts`,
  `server/src/db/interaction-endpoints.test.ts`, `mcp-server/src/handler.test.ts`.
- Docs to refresh: `docs/concepts/agent-context.md`, `docs/plans/api-review.md`.
