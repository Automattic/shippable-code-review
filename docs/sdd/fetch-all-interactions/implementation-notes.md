# Implementation Notes — Fetch All Interactions

## Deviations from Spec

### Route wiring landed in T3, not T4
- **Spec/plan said**: Task 3 adds the `handleAgentInteractions` handler; Task 4
  wires the `POST /api/agent/interactions` route.
- **Implementation does**: Task 3 added the handler **and** wired the route, so
  the new endpoint tests could pass within Task 3 (TDD requires the test to go
  green in the same task that introduces the behavior). Task 4 then only
  removed the old `/api/agent/pull` handler, route, and tests.
- **Reason**: A handler with no route is unreachable — its tests cannot pass.
  Splitting them left Task 3 unverifiable.
- **Impact**: None functional. Only the commit boundary moved; the two commits
  are still distinct ("add endpoint" / "drop pull").

### Old pull test coverage migrated rather than dropped
- **Spec/plan said**: Task 4 — "remove the obsolete `/api/agent/pull` tests."
- **Implementation does**: The old `POST /api/agent/pull` `describe` block had
  two assertions with no equivalent in the new block — a `commit="deadbeef"`
  provenance check and a concurrency "first wins" drain test. Both were
  migrated into the `POST /api/agent/interactions` block (the `status=unread`
  test now asserts `commit="deadbeef"`; a new "concurrent unread read" test
  covers first-wins) instead of being deleted outright.
- **Reason**: Dropping the block verbatim would have lost real coverage.
- **Impact**: Coverage preserved; net test count slightly higher than a literal
  "delete" would give.

### e2e spec missed by the plan
- **Spec/plan said**: nothing — `web/e2e/journey-2-worktree.spec.ts` surfaced in
  the endpoint-consumer grep during brainstorm but no task covered it.
- **Implementation does**: the e2e spec's agent-worker stand-in called
  `POST /api/agent/pull`; it was updated to `POST /api/agent/interactions` with
  `status: "unread"` (the destructive claim it relies on).
- **Reason**: plan gap — only `server/`, `mcp-server/`, and `docs/` consumers
  were assigned tasks; the e2e consumer was overlooked.
- **Impact**: caught when the full e2e suite was run after the fact. All 54
  e2e tests pass with the correction.

## Notes
- `server/src/db/interaction-endpoints.test.ts` was listed in the spec's file
  table as possibly needing `listDelivered`/pull reference adjustments. It had
  none — no change was required.
- `agentQueue.listDelivered` (the agent-queue wrapper, with its `deliveredAt`
  field) was deliberately kept and repointed to `listByQueueStatus`, because
  `GET /api/agent/delivered` and the reviewer-side web UI still depend on it.
  Only the store-level `listDelivered` was renamed.
- Verification at completion: server `tsc --noEmit` clean + 418 tests pass;
  mcp-server `tsc --noEmit` clean + 32 tests pass; mcp-server build clean;
  full Playwright e2e suite 54/54 pass.
