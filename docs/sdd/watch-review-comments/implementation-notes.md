# Implementation Notes — Watch Review Comments

The feature shipped as specified: a new `shippable_watch_review_comments` MCP
tool runs a shim-side poll loop over `POST /api/agent/interactions`, the server
marks watch polls and exposes a `watching` boolean on `GET /api/agent/replies`,
and the panel shows an "Agent is watching" indicator plus a `watch shippable`
chip. Behaviour matches `spec.md`. The deviations below are all about *how* and
*where* the code landed, not *what* it does.

## Deviations from Spec / Plan

### Watch marker is an in-memory Map, not a field on a queue record
- **Spec/plan said**: `server/src/agent-queue.ts` has an in-memory
  per-worktree queue record; add an optional `lastWatchPollAt: number` field
  to it, "lazily creating the record like the rest of the module".
- **Implementation does**: `agent-queue.ts` is now fully SQLite-backed
  (`db/interaction-store.ts`) — there is no in-memory per-worktree record to
  hang a field on. The watch marker is a module-level
  `const watchPolls = new Map<string, number>()`; `markWatchPoll` stamps
  `Date.now()`, `isWatching` reads it against `WATCH_TTL_MS`. `resetForTests`
  clears the map.
- **Reason**: the queue moved to SQLite (the `sqlite-persistence` line of
  work) after this plan was written. The watch marker is a transient 90s
  indicator whose restart-drops behaviour is explicitly accepted by the spec,
  so an ephemeral in-memory Map is the correct, boring fit — persisting it in
  SQLite would be wasted machinery.
- **Impact**: none on behaviour. `markWatchPoll` / `isWatching` /
  `WATCH_TTL_MS` have the exact signatures the plan called for, except
  `isWatching` takes an optional `now` argument (see below).

### `isWatching` gained an optional `now` parameter
- **Plan said**: test the TTL "using the file's existing time-control pattern".
- **Implementation does**: `agent-queue.ts` had no existing time-injection
  seam (`lastPostedMs` is a private module variable with no override).
  `isWatching(worktreePath, now = Date.now())` takes an optional clock so the
  TTL-expiry test is deterministic. Production callers pass nothing.
- **Reason**: smallest seam that keeps production identical and the test
  free of fake timers.
- **Impact**: none — the default makes it a drop-in for the spec's
  `isWatching(worktreePath): boolean`.

### Task 6 and Task 7 touched more files than their Files lists named
- **Plan said**: Task 6 — `web/src/agentContextClient.ts`. Task 7 —
  `web/src/components/AgentContextSection.tsx` (+ test).
- **Implementation does**: threading `watching` from the replies endpoint to
  the panel required, beyond those files:
  - Task 6: `web/src/useDeliveredPolling.ts` (the hook that calls
    `fetchAgentReplies` — its `repliesFetcher` type, a `watching` state
    field, and `DeliveredPollingResult`) and `useDeliveredPolling.test.ts`
    (mock return shapes updated to `{ replies, watching }`).
  - Task 7: `web/src/components/ReviewWorkspace.tsx` (destructure + pass the
    prop), `web/src/components/Inspector.tsx` (`AgentContextProps` mirror
    type + the `<AgentContextSection>` render), and `web/src/components/Demo.tsx`
    (the screen-catalog reel builds an `AgentContextProps` literal).
- **Reason**: the plan's Files lists under-counted the prop/return-type
  plumbing chain. `fetchAgentReplies`'s return type is consumed by the hook,
  whose result flows through `ReviewWorkspace` → `Inspector` →
  `AgentContextSection`; `AgentContextProps` and the `Demo` fixture are
  compile-time mirrors that `tsc -b` requires to stay in sync.
- **Impact**: none on behaviour or design. The data path is exactly the spec's
  "thread it through to the panel". All three packages' tests, lint, and
  builds pass.

### Endpoint changed under the branch — `/api/agent/pull` → `/api/agent/interactions`
- **Spec said**: "v0 transport is polling … over the existing, unchanged
  `POST /api/agent/pull`" — zero `server/` changes for the core mechanism.
- **What happened**: while this branch was in flight, `main` landed
  `fetch-all-interactions` (commit `c3401f3`), which **removed
  `/api/agent/pull`** and replaced it with `POST /api/agent/interactions`,
  body `{ worktreePath, status }`, `status` ∈ `unread | delivered | all`
  (required). `unread` is the draining read — exactly the old `pull`.
- **Implementation does**: rebasing onto that `main`, the watch loop now polls
  `POST /api/agent/interactions` with `{ worktreePath, status: "unread",
  watch: true }`. `unread` is the correct status — watch mode delivers
  (drains) comments to the agent. The server's watch marker moved with the
  handler: `handleAgentPull` → `handleAgentInteractions` still calls
  `markWatchPoll(wtPath)` when `watch === true`. The `watch` field is an
  optional, status-agnostic extra on the same body — orthogonal to `status`.
- **Reason**: forced by the upstream change; `pull` no longer exists.
- **Impact**: none on the watch design — same drain-first poll loop, same
  envelope, same `watching` indicator. Only the URL and one required body
  field (`status: "unread"`) changed. Updated in the rebase: the MCP handler,
  its tests, the server endpoint test, the e2e test, and the prose in
  `mcp-server/README.md` and `docs/concepts/agent-context.md`. The watch
  tool's own input schema is unaffected — `status` is fixed internally to
  `unread`, not exposed to the agent (unlike `shippable_check_review_comments`,
  where `status` is a required argument).

## Notes

- **Verification** (after the rebase onto `main`): server 425 tests +
  `tsc --noEmit`; mcp-server 41 tests + `tsc` build; web 584 tests + `eslint` +
  `vite build` — all green. Playwright e2e: the new watch-indicator test and
  the `journey-2` suite pass. The server e2e suite (`codeGraph.e2e.test.ts`)
  needs a PHP LSP installed and is unrelated to this feature — not run.
- **Commits**: one per task, eight total, plus the SDD tracking commit, an
  e2e-test commit, and one post-rebase adaptation commit for the
  `/api/agent/interactions` migration.
- **Added beyond the plan — e2e coverage.** The plan had no e2e task. A
  separate `test()` was added to `web/e2e/journey-2-worktree.spec.ts` ("watch
  indicator: …") — it stands in for a watching agent by POSTing
  `/api/agent/interactions` (`status: "unread"`, `watch: true`) and asserts
  the panel's "Agent is watching" row appears via the real /api/agent/replies
  poll. It covers the one seam unit/integration tiers cannot: real server flag
  → real browser indicator. Kept as its own test (not folded into the
  pip-lifecycle test) to avoid mixing concerns.
- The `mcp-server/` test helper `makeSequenceFetch` clones each `Response`
  before returning it — a `Response` body reads once, and the watch loop
  re-polls, so without the clone the second poll throws "Body already read".
  Caught by Task 4's tests; worth knowing if more loop tests are added.
- Not done (and correctly out of scope): SSE transport, which would make the
  `watching` indicator exact rather than poll-approximate.
