# Implementation Plan: Fetch All Interactions

Based on: docs/sdd/fetch-all-interactions/spec.md

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> **Status:** All 7 tasks complete. See `implementation-notes.md` for deviations.

## Tasks

### Task 1: Replace `listDelivered` with `listByQueueStatus` in the store
- **Files**: `server/src/db/interaction-store.ts`, `server/src/db/interaction-store.test.ts`
- **Do**:
  1. Write failing tests in `interaction-store.test.ts`: `listByQueueStatus(wt, ["delivered"])` returns only delivered rows; `listByQueueStatus(wt, ["pending", "delivered"])` returns both; both sorted `created_at, id`; the call does **not** change any `agent_queue_status` (no ack side effect).
  2. Verify the tests fail.
  3. Replace `listDelivered` with `listByQueueStatus(worktreePath: string, statuses: AgentQueueStatus[]): StoredInteraction[]` — read-only `SELECT * FROM interactions WHERE worktree_path = ? AND agent_queue_status IN (<placeholders>) ORDER BY created_at, id`, building one `?` placeholder per status.
  4. Verify the tests pass.
  5. Commit: `feat(server): add listByQueueStatus, replacing listDelivered`
- **Verify**: new tests pass; `npm run typecheck` (server) clean — `listDelivered` no longer referenced from the store.
- **Depends on**: none

### Task 2: Repoint agent-queue wrappers
- **Files**: `server/src/agent-queue.ts`
- **Do**:
  1. Update the import from `./db/interaction-store.ts`: drop `listDelivered as storeListDelivered`, add `listByQueueStatus as storeListByQueueStatus`.
  2. Keep the exported `listDelivered(worktreePath)` wrapper (web UI depends on its `DeliveredInteraction` shape with `deliveredAt`) — repoint its body to `storeListByQueueStatus(worktreePath, ["delivered"])`.
  3. Add `readInteractions(worktreePath: string, statuses: AgentQueueStatus[]): Interaction[]` — `storeListByQueueStatus(...).map(toWire)`.
  4. Verify: `npm run typecheck` (server) clean.
  5. Commit: `feat(server): add readInteractions wrapper for status reads`
- **Verify**: `npm run typecheck` (server) passes; `listDelivered` still returns `DeliveredInteraction[]`.
- **Depends on**: Task 1

### Task 3: Add `handleAgentInteractions` handler
- **Files**: `server/src/index.ts`, `server/src/index.test.ts`
- **Do**:
  1. Write failing tests in `index.test.ts` against a real `createApp()` for `POST /api/agent/interactions`: `status=unread` returns pending and marks them delivered (drain); `status=delivered` returns delivered, read-only; `status=all` returns pending + delivered, read-only; missing `status` → 400; invalid `status` → 400; missing `worktreePath` → 400; non-git path → 400.
  2. Verify the tests fail.
  3. Replace `handleAgentPull` with `handleAgentInteractions`: read `{ worktreePath, status }` from the body; validate `worktreePath` and `status` (∈ `unread|delivered|all`) → 400; `assertGitDir` → 400; branch `unread` → `agentQueue.pullAndAck`, `delivered` → `agentQueue.readInteractions(wt, ["delivered"])`, `all` → `agentQueue.readInteractions(wt, ["pending","delivered"])`.
  4. Extract the earliest-`commitSha` reduce into an `earliestCommitSha(interactions)` helper; use it in all three branches before `formatPayload`. Respond `{ payload, ids }`.
  5. Verify the tests pass.
  6. Commit: `feat(server): add status-driven handleAgentInteractions handler`
- **Verify**: new endpoint tests pass; vitest green.
- **Depends on**: Task 2

### Task 4: Wire the route, remove `/api/agent/pull`
- **Files**: `server/src/index.ts`, `server/src/index.test.ts`
- **Do**:
  1. In the route table, add `POST /api/agent/interactions` → `handleAgentInteractions`; remove the `POST /api/agent/pull` route.
  2. Remove the obsolete `/api/agent/pull` tests from `index.test.ts`.
  3. Verify the full server suite.
  4. Commit: `refactor(server): drop /api/agent/pull in favour of /api/agent/interactions`
- **Verify**: `npm run test` and `npm run typecheck` (server) pass; no `/api/agent/pull` references remain in `server/`.
- **Depends on**: Task 3

### Task 5: Update the MCP handler
- **Files**: `mcp-server/src/handler.ts`, `mcp-server/src/handler.test.ts`
- **Do**:
  1. Write failing tests in `handler.test.ts`: `handleCheckReviewComments` posts to `/api/agent/interactions` with `{ worktreePath, status }` in the body for each status value (assert URL and body via the mock `fetchFn`).
  2. Verify the tests fail.
  3. Add `status` to the `handleCheckReviewComments` input type; change the URL to `/api/agent/interactions`; include `status` in the POST body.
  4. Verify the tests pass.
  5. Commit: `feat(mcp): point check_review_comments at /api/agent/interactions`
- **Verify**: MCP suite green; no `/api/agent/pull` reference remains in `mcp-server/`.
- **Depends on**: Task 4

### Task 6: Add `status` to the MCP tool schema
- **Files**: `mcp-server/src/index.ts`
- **Do**:
  1. Add a required `status` field to the `shippable_check_review_comments` zod `inputSchema` — an enum of `unread | delivered | all` with a description (e.g. "unread: new comments, marks them read; delivered: previously seen; all: everything").
  2. Thread `status` from the tool callback into the `handleCheckReviewComments` call.
  3. Verify: `mcp-server` build/typecheck clean.
  4. Commit: `feat(mcp): require status on shippable_check_review_comments`
- **Verify**: `mcp-server` builds; the tool schema exposes a required `status`.
- **Depends on**: Task 5

### Task 7: Update docs
- **Files**: `docs/concepts/agent-context.md`, `docs/plans/api-review.md`
- **Do**:
  1. In `agent-context.md`, document `POST /api/agent/interactions` with the three `status` values and the `unread`-drains semantics; note `status` is required.
  2. In `api-review.md`, replace `/api/agent/pull` references with `/api/agent/interactions`.
  3. Verify: no stale `/api/agent/pull` mention remains in either file.
  4. Commit: `docs: document /api/agent/interactions`
- **Verify**: both docs describe the merged endpoint accurately.
- **Depends on**: Task 4, Task 6
