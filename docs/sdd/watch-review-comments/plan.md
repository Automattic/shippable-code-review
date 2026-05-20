# Implementation Plan: Watch Review Comments

Based on: docs/sdd/watch-review-comments/spec.md

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

Each package owns its own `npm test` (`server/`, `mcp-server/`, `web/`). Run the
relevant suite per task. `npm run build` + `npm run lint` in `web/` must still
pass after Task 7. Tasks 1 and 3 are independent and may run in parallel.

## Tasks

### Task 1: Server queue watch marker
- **Files**: `server/src/agent-queue.ts`, `server/src/agent-queue.test.ts`
- **Do**:
  1. Write failing tests in `agent-queue.test.ts`: `markWatchPoll(path)` then `isWatching(path)` is `true`; `isWatching` is `false` once more than `WATCH_TTL_MS` has elapsed since the mark; `isWatching` is `false` for a never-marked worktree. Use the file's existing time-control pattern (inject/advance, or a `nowFn` seam consistent with the module).
  2. Verify the tests fail.
  3. In `agent-queue.ts`: export `WATCH_TTL_MS = 90_000`; add optional `lastWatchPollAt: number` to the per-worktree queue record; add `markWatchPoll(worktreePath)` (stamps `Date.now()`, lazily creating the record like the rest of the module) and `isWatching(worktreePath): boolean` (`lastWatchPollAt != null && Date.now() - lastWatchPollAt < WATCH_TTL_MS`).
  4. Verify the tests pass; run `npm test` in `server/`.
  5. Commit: `feat(server): track per-worktree agent watch polls`
- **Verify**: new `agent-queue.test.ts` cases pass; no regressions in the server suite.
- **Depends on**: none

### Task 2: Server endpoints honor watch + expose watching
- **Files**: `server/src/index.ts`, `server/src/index.test.ts`
- **Do**:
  1. Write failing integration tests: `POST /api/agent/pull` with `{ worktreePath, watch: true }` followed by `GET /api/agent/replies?worktreePath=…` returns `watching: true`; a pull without `watch` (or `watch: false`) leaves `watching: false`.
  2. Verify the tests fail.
  3. In the `POST /api/agent/pull` handler: after parsing the body, call `agentQueue.markWatchPoll(worktreePath)` when `body.watch === true`. Leave the drain/format path unchanged.
  4. In `handleAgentListReplies`: change the response payload from `{ replies }` to `{ replies, watching: agentQueue.isWatching(wtPath) }`.
  5. Verify the tests pass; run `npm test` and `npm run typecheck` in `server/`.
  6. Commit: `feat(server): surface agent watch state on the replies endpoint`
- **Verify**: new integration tests pass; existing `/api/agent/*` tests unaffected; `typecheck` clean.
- **Depends on**: Task 1

### Task 3: MCP watch handler core
- **Files**: `mcp-server/src/handler.ts`, `mcp-server/src/handler.test.ts`
- **Do**:
  1. Write failing tests for a new `handleWatchReviewComments`, mirroring the mocked-`fetch` style already in `handler.test.ts`, with injected `sleepFn` (no-op spy) and `nowFn` (controllable clock): (a) first pull returns a non-empty `payload` → result text is the envelope followed by `WATCH_DELIVERED_HINT`, `isError` unset; (b) first two pulls empty, third non-empty → handler loops and returns the envelope, `sleepFn` called between pulls; (c) every pull body includes `watch: true`.
  2. Verify the tests fail.
  3. In `handler.ts`: add constants beside `DEFAULT_PORT` — `POLL_INTERVAL_MS = 2000`, `DEFAULT_TIMEOUT_SECONDS = 60`, `MIN_TIMEOUT_SECONDS = 1`, `MAX_TIMEOUT_SECONDS = 300`, `WATCH_DELIVERED_HINT` (address the comments, post each result back via `shippable_post_review_comment`, then call `shippable_watch_review_comments` again to keep watching), `WATCH_IDLE_HINT` (no comments yet — call `shippable_watch_review_comments` again to keep watching; the reviewer ends watch mode by interrupting). Extend `HandlerDeps` with `sleepFn?: (ms: number) => Promise<void>` and `nowFn?: () => number` (production defaults: `setTimeout`-based sleep, `Date.now`).
  4. Implement `handleWatchReviewComments({ worktreePath?, timeoutSeconds? }, deps?)`: resolve port/`worktreePath` via the existing helpers; compute `deadline = nowFn() + timeoutSeconds * 1000`; loop — `POST /api/agent/pull` with `{ worktreePath, watch: true }`, non-empty `payload` → return envelope + `WATCH_DELIVERED_HINT`; at/after deadline → return idle message + `WATCH_IDLE_HINT`; else `await sleepFn(POLL_INTERVAL_MS)` and iterate. Reuse `errorResult` and the `PullResponse` shape. Leave `handleCheckReviewComments` untouched.
  5. Verify the tests pass; run `npm test` in `mcp-server/`.
  6. Commit: `feat(mcp): add watch-review-comments poll loop handler`
- **Verify**: core watch tests pass; existing handler tests unaffected.
- **Depends on**: none

### Task 4: MCP watch handler edge cases
- **Files**: `mcp-server/src/handler.ts`, `mcp-server/src/handler.test.ts`
- **Do**:
  1. Write failing tests: (a) all pulls empty until `nowFn` passes the deadline → returns the idle message + `WATCH_IDLE_HINT`, `isError` unset; (b) `timeoutSeconds` below `MIN_TIMEOUT_SECONDS` and above `MAX_TIMEOUT_SECONDS` are clamped; (c) `worktreePath` absent → resolves to `cwd`, present → wins; (d) `fetchFn` rejection and a non-2xx response each return a structured `errorResult` (`isError: true`) and exit the loop without throwing.
  2. Verify the tests fail.
  3. In `handleWatchReviewComments`: clamp `timeoutSeconds` into `[MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS]` defaulting to `DEFAULT_TIMEOUT_SECONDS`; on a fetch/HTTP/JSON failure return `errorResult` and stop looping (do not spin on a dead server).
  4. Verify the tests pass; run `npm test` in `mcp-server/`.
  5. Commit: `feat(mcp): clamp watch timeout and harden the watch loop`
- **Verify**: all edge-case tests pass; the loop exits on error rather than spinning.
- **Depends on**: Task 3

### Task 5: Register the watch tool
- **Files**: `mcp-server/src/index.ts`
- **Do**:
  1. Add `WATCH_TOOL_DESCRIPTION` — explain that the tool blocks until reviewer comments arrive or it times out, that the agent must **call it again in a loop** after handling each batch, and tune it for prompt drift ("watch shippable", "address my comments as I review", "live review", "keep watching for review comments").
  2. `server.registerTool("shippable_watch_review_comments", { description: WATCH_TOOL_DESCRIPTION, inputSchema: { worktreePath: z.string().optional()..., timeoutSeconds: z.number().optional().describe("Seconds to keep watching before returning; default 60, clamped 1–300.") } }, async (input) => handleWatchReviewComments(input))`.
  3. Verify: `npm run build` (or the package's build) in `mcp-server/` succeeds; the tool list now includes all three tools.
  4. Commit: `feat(mcp): register the shippable_watch_review_comments tool`
- **Verify**: `mcp-server/` builds; three tools registered.
- **Depends on**: Task 4

### Task 6: Web client carries watching
- **Files**: `web/src/agentContextClient.ts`
- **Do**:
  1. Update the replies-fetch function so its return type and parsing include `watching: boolean` from the `GET /api/agent/replies` response; thread it through to callers.
  2. Verify: `npm run typecheck`/`npm run build` in `web/` passes; existing client tests unaffected.
  3. Commit: `feat(web): read agent watching state from the replies endpoint`
- **Verify**: `web/` typechecks and builds; no client-test regressions.
- **Depends on**: Task 2

### Task 7: Web panel indicator and watch chip
- **Files**: `web/src/components/AgentContextSection.tsx`, `web/src/components/AgentContextSection.test.tsx`
- **Do**:
  1. Write failing component tests: the panel shows an "Agent is watching — comments deliver live" indicator when the client reports `watching: true` and hides/dims it when `false`; a `watch shippable` magic-phrase chip renders and copies to clipboard.
  2. Verify the tests fail.
  3. In `AgentContextSection.tsx`: render the watching indicator from the `watching` flag, matching the panel's existing status-row treatment; add a third click-to-copy chip `watch shippable` beside `check shippable` and `report back to shippable`, with a one-line explanation that the agent picks up comments live after one prompt.
  4. Verify the tests pass; run `npm test`, `npm run lint`, and `npm run build` in `web/`.
  5. Commit: `feat(web): show agent-watching indicator and watch-shippable chip`
- **Verify**: component tests pass; `web/` lint and build clean.
- **Depends on**: Task 6

### Task 8: Documentation
- **Files**: `mcp-server/README.md`, `docs/concepts/agent-context.md`, `docs/plans/share-review-comments.md`, `docs/features/agent-context-panel.md`
- **Do**:
  1. `mcp-server/README.md`: document `shippable_watch_review_comments` — the watch loop, `timeoutSeconds`, and the `watch shippable` phrase.
  2. `docs/concepts/agent-context.md`: add a watch-mode paragraph to § Two-way describing the poll-loop tool and the "Agent is watching" indicator.
  3. `docs/plans/share-review-comments.md`: mark the "Push to idle session" follow-up as addressed by watch mode for the active-session case; link `docs/sdd/watch-review-comments/spec.md`.
  4. `docs/features/agent-context-panel.md`: document the watching indicator and the `watch shippable` phrase.
  5. Commit: `docs: document watch-mode auto-sync for review comments`
- **Verify**: each file reflects the shipped behavior; `git grep watch_review_comments` and `watch shippable` resolve to consistent descriptions.
- **Depends on**: Task 5, Task 7
