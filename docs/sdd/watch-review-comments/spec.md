# Spec: Watch Review Comments

## Goal

Give the agent a way to pick up reviewer comments **automatically as they are authored**, instead of the reviewer re-typing `check shippable` for every batch. A new MCP tool `shippable_watch_review_comments` runs a poll loop: the reviewer prompts once (`watch shippable`), the agent enters a `watch → act → post back → watch` loop, and from then on every comment authored in Shippable reaches the agent within seconds. This delivers the live-review workflow the roadmap calls out — "send feedback to a live session, to steer the session live" (`docs/ROADMAP.md`) — and closes the "Push to idle session" follow-up in `docs/plans/share-review-comments.md`.

The mechanism mirrors Agentation's `watch_annotations` (`agentation-mcp` 1.2.0): drain what is pending, then wait for more until a timeout, return a batch, let the agent loop.

## Requirements Summary

- New MCP tool `shippable_watch_review_comments` in `mcp-server/`, coexisting with `shippable_check_review_comments` (one-shot) and `shippable_post_review_comment` (post-back).
- The tool drains pending comments immediately, then keeps watching until either comments arrive or `timeoutSeconds` elapses; it always returns — comments-or-empty — and the agent re-calls.
- v0 transport is **polling inside the `mcp-server/` shim** over the existing, unchanged `POST /api/agent/pull`. SSE is an explicit follow-up, not v0.
- Every tool result ends with an in-band next-step hint so the loop is self-sustaining (mirrors `docs/sdd/auto-reply-hint/spec.md`).
- Inputs: `worktreePath?` (defaults to `cwd`), `timeoutSeconds?` (default 60, clamped 1–300).
- The agent-context panel shows an **"Agent is watching"** indicator and a third magic-phrase chip, `watch shippable`.
- One kickoff prompt is unavoidable and accepted; the feature removes the *repeated* prompt only.

Full detail in `requirements.md`.

## Chosen Approach

**Shim-side poll loop over the existing `/api/agent/pull`, plus a lightweight watch marker for the indicator.**

The watch tool is a loop in the MCP shim. It calls `POST /api/agent/pull` — the endpoint that already drains the per-worktree queue atomically and formats the `<reviewer-feedback>` envelope — every 2 seconds. The instant a pull comes back non-empty, the tool returns that envelope plus a next-step hint. If `timeoutSeconds` elapses with nothing, it returns a short "no comments yet" message plus a keep-watching hint. The agent loops the tool either way.

This was chosen over event-driven transport for v0 because it needs **zero structural `server/` changes** for the core mechanism — `/api/agent/pull` is reused exactly as-is — and keeps the change surface to one new handler in the shim plus its tests. A ~2 second delivery latency is imperceptible to a human reviewer. It is deliberately the boring option (`AGENTS.md`: "prefer simple over clever").

The only `server/` change is for the **"Agent is watching" indicator**, which the reviewer needs in order to trust that comments are landing live. The watch tool tags each of its pulls with `watch: true`; the server stamps `lastWatchPollAt` on the per-worktree queue record; `GET /api/agent/replies` — the poll the panel already runs — returns a derived `watching` boolean. One optional request field, one timestamp, one extra response field.

### Alternatives Considered

- **Server-side long-poll** (`POST /api/agent/watch` held open, in-process waiter resolved by `enqueue()`, batch window + timeout). Event-driven, instant delivery, single round-trip. Rejected for v0: adds held-connection lifecycle and waiter bookkeeping to `server/` for latency a human cannot perceive. Folded into the SSE follow-up instead.
- **SSE event stream** (`GET /api/agent/events`) — this is how Agentation does it (its MCP shim subscribes to an SSE bus on its HTTP/store server; `better-sqlite3` is only the store's persistence, the watch path never polls a DB). The faithful mapping, and it would later let the web UI go push-based and drop its own 2 s polls. Rejected for v0 only — it is the **designated follow-up** (see Out of Scope). Shippable has exactly one consumer of "comment enqueued" today, so SSE's multiplexing earns nothing yet.
- **MCP resource subscriptions** — expose comments as a resource, emit `notifications/resources/updated`. Rejected outright: harnesses do not reliably act on resource-update notifications autonomously, so the loop-and-fix behavior would not happen.
- **Claude Code hook to auto-enter watch mode** — zero-prompt on CC. Rejected: CC-only, more install machinery, and the repo already built and discarded a hook approach (`docs/plans/share-review-comments.md`).
- **Replacing the one-shot `check` tool with watch-only** — rejected; the two are genuinely different modes (quick async grab vs. live babysitting) and both earn their place.

## Technical Details

### Architecture

```
┌─ Agent (Claude Code / Codex / Cursor / …) ───────────────────────┐
│  user prompts once: "watch shippable"                            │
│  loop:  call shippable_watch_review_comments                     │
│         → got comments?  act on them + post back, then call again│
│         → timed out?     call again                              │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼
┌─ MCP server (mcp-server/src/handler.ts) ─────────────────────────┐
│  handleWatchReviewComments  (NEW)                                │
│    deadline = now + timeoutSeconds                               │
│    loop:                                                         │
│      POST /api/agent/pull { worktreePath, watch: true }          │
│      payload non-empty? → return envelope + WATCH_DELIVERED_HINT │
│      now >= deadline?    → return idle msg + WATCH_IDLE_HINT     │
│      else                → sleep(POLL_INTERVAL_MS), repeat       │
│      fetch/HTTP error    → return structured errorResult         │
└───────────────────────────────┬──────────────────────────────────┘
                                │ POST /api/agent/pull  (UNCHANGED contract,
                                │                        + optional `watch` field)
                                ▼
┌─ Local server (server/) ─────────────────────────────────────────┐
│  POST /api/agent/pull  — drains queue, formats envelope           │
│      if body.watch === true → agentQueue.markWatchPoll(path)      │
│  GET  /api/agent/replies — returns { replies, watching }          │
│      watching = agentQueue.isWatching(path)                       │
│  agent-queue.ts — per-worktree record gains `lastWatchPollAt`     │
└───────────────────────────────┬──────────────────────────────────┘
                                │ GET /api/agent/replies?worktreePath=…
                                ▼
┌─ Reviewer UI (web/) ─────────────────────────────────────────────┐
│  AgentContextSection — "Agent is watching" indicator (from        │
│    `watching`); third magic-phrase chip: `watch shippable`        │
└───────────────────────────────────────────────────────────────────┘
```

The reviewer→agent payload path (`/api/agent/pull`, the queue, the formatter) is reused unchanged. The new mechanism is the shim-side loop; the only server-side additions are the `watch` marker and the `watching` flag.

### Data Flow

**Watch loop (delivery):**

1. Agent calls `shippable_watch_review_comments` with optional `worktreePath` / `timeoutSeconds`.
2. The handler computes `deadline = nowFn() + timeoutSeconds·1000` and enters its loop.
3. Each iteration `POST`s `/api/agent/pull` with `{ worktreePath, watch: true }`.
4. **Non-empty payload** → return `{ content: [{ type:"text", text: payload + "\n\n" + WATCH_DELIVERED_HINT }] }`. Loop ends; the agent acts, posts back, and calls the tool again.
5. **Empty payload, before deadline** → `sleep(POLL_INTERVAL_MS)`, iterate.
6. **Empty payload, at/after deadline** → return the idle message + `WATCH_IDLE_HINT`. The agent calls the tool again to keep watching.
7. **Fetch failure or non-2xx** → return `errorResult(...)` (`isError: true`); the loop exits so a dead server does not spin forever. The agent can retry.

Because step 3 runs immediately on the first iteration, comments authored *before* watch started are delivered right away ("drain-first").

**Watching indicator:**

1. Every watch-loop pull carries `watch: true`. `POST /api/agent/pull` calls `agentQueue.markWatchPoll(worktreePath)`, stamping `lastWatchPollAt = Date.now()`.
2. The panel polls `GET /api/agent/replies?worktreePath=…` (already on a ~2 s cadence while a worktree is loaded).
3. The handler adds `watching: agentQueue.isWatching(worktreePath)` to the response, where `isWatching` is `lastWatchPollAt != null && Date.now() - lastWatchPollAt < WATCH_TTL_MS`.
4. The panel renders "Agent is watching — comments deliver live" when `watching` is true.

`WATCH_TTL_MS` is **90 000** (90 s). It must outlast the agent's between-comments work phase — while the agent is acting on a comment it is not polling — yet clear within a reasonable window after a real stop. The poll interval is 2 s, so a watching agent refreshes the stamp far inside the TTL; a stopped loop clears the indicator ≤ 90 s later. The value is approximate by nature of polling; the SSE follow-up makes "watching" exact (an open connection). Pinned here, tunable later.

### Key Components

**`mcp-server/src/handler.ts` — new `handleWatchReviewComments`**

- New constants beside `DEFAULT_PORT`:
  - `POLL_INTERVAL_MS = 2000`
  - `DEFAULT_TIMEOUT_SECONDS = 60`, `MIN_TIMEOUT_SECONDS = 1`, `MAX_TIMEOUT_SECONDS = 300`
  - `WATCH_DELIVERED_HINT` — instructs the agent to address the comments above, post each result back via `shippable_post_review_comment`, then call `shippable_watch_review_comments` again to keep watching.
  - `WATCH_IDLE_HINT` — instructs the agent to call `shippable_watch_review_comments` again to keep watching; mentions that the reviewer ends watch mode by interrupting.
- `HandlerDeps` gains two test seams: `sleepFn?: (ms: number) => Promise<void>` and `nowFn?: () => number`. Production defaults: real `setTimeout`-based sleep and `Date.now`. This keeps the loop deterministic under test without fake timers.
- `handleWatchReviewComments(input: { worktreePath?: string; timeoutSeconds?: number }, deps?)`:
  - Resolves port and `worktreePath` via the existing `resolvePort` / `resolveWorktreePath`.
  - Clamps `timeoutSeconds` into `[MIN, MAX]`, default `DEFAULT_TIMEOUT_SECONDS`.
  - Runs the loop in the Data Flow above. Reuses the `errorResult` helper and the `PullResponse` shape; the pull `POST` body is `{ worktreePath, watch: true }`.
- The existing `handleCheckReviewComments` is untouched (its `/api/agent/pull` body stays `{ worktreePath }` — no `watch` field, so it never marks a watch poll).

**`mcp-server/src/index.ts` — register the tool**

- `registerTool("shippable_watch_review_comments", …)` with input schema `{ worktreePath?: string, timeoutSeconds?: number }`.
- A `WATCH_TOOL_DESCRIPTION` tuned for prompt drift: triggers on "watch shippable", "address my comments as I review", "live review", "keep watching for review comments". The description states plainly that the tool blocks until comments arrive or it times out, and that the agent should **call it again in a loop** after handling each batch.

**`server/src/agent-queue.ts` — watch marker**

- The per-worktree queue record gains an optional `lastWatchPollAt: number`.
- `markWatchPoll(worktreePath: string): void` — stamps `lastWatchPollAt = Date.now()`; creates the record if absent (consistent with how the queue lazily creates per-worktree state).
- `isWatching(worktreePath: string): boolean` — `lastWatchPollAt != null && Date.now() - lastWatchPollAt < WATCH_TTL_MS`.
- `WATCH_TTL_MS = 90_000` exported from this module.

**`server/src/index.ts` — wire the marker and the flag**

- In the `POST /api/agent/pull` handler: after parsing the body, if `body.watch === true`, call `agentQueue.markWatchPoll(worktreePath)`. The drain/format path is otherwise unchanged.
- In `handleAgentListReplies`: change the response from `{ replies }` to `{ replies, watching: agentQueue.isWatching(wtPath) }`.

**`web/src/agentContextClient.ts`**

- The replies-fetch function's return type gains `watching: boolean`; thread it through to the panel.

**`web/src/components/AgentContextSection.tsx`**

- Render an "Agent is watching — comments deliver live" indicator when `watching` is true (dim/neutral when false, or hidden — match the panel's existing status-row treatment).
- Add a third click-to-copy magic-phrase chip, `watch shippable`, beside `check shippable` and `report back to shippable`, with a one-line explanation that the agent picks up comments live after one prompt.

**Tests**

- `mcp-server/src/handler.test.ts` — for `handleWatchReviewComments`, with mocked `fetchFn`, injected `sleepFn` (no-op or counter) and `nowFn` (controllable clock):
  - First pull non-empty → returns envelope + `WATCH_DELIVERED_HINT`; no sleep.
  - First N pulls empty then non-empty → loops, returns the envelope once comments arrive.
  - All pulls empty until `nowFn` passes the deadline → returns the idle message + `WATCH_IDLE_HINT`, `isError` unset.
  - `timeoutSeconds` clamped below `MIN` / above `MAX`.
  - `worktreePath` absent → resolves to `cwd`; present → wins.
  - Each pull body includes `watch: true`.
  - Fetch rejection / non-2xx → structured `errorResult`, loop exits, no throw.
- `server/src/agent-queue.test.ts` — `markWatchPoll` then `isWatching` true; `isWatching` false past `WATCH_TTL_MS` (inject/advance time per the file's existing pattern); `isWatching` false for an unknown worktree.
- `server/src/index.test.ts` — `POST /api/agent/pull` with `watch: true` makes a subsequent `GET /api/agent/replies` return `watching: true`; without it, `watching: false`.
- `web/` component test — panel shows the watching indicator when the client reports `watching: true`; the `watch shippable` chip renders and copies.

### File Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `mcp-server/src/handler.ts` | modify | New `handleWatchReviewComments` + constants (`POLL_INTERVAL_MS`, timeout bounds, `WATCH_DELIVERED_HINT`, `WATCH_IDLE_HINT`); `HandlerDeps` gains `sleepFn` / `nowFn`. |
| `mcp-server/src/index.ts` | modify | Register `shippable_watch_review_comments` with `WATCH_TOOL_DESCRIPTION` and the `{ worktreePath?, timeoutSeconds? }` schema. |
| `mcp-server/src/handler.test.ts` | modify | Loop, timeout, clamp, cwd, `watch`-flag, and error-path tests for the watch handler. |
| `mcp-server/README.md` | modify | Document the watch tool, the loop, and `timeoutSeconds`. |
| `server/src/agent-queue.ts` | modify | `lastWatchPollAt` on the per-worktree record; `markWatchPoll`, `isWatching`, `WATCH_TTL_MS`. |
| `server/src/index.ts` | modify | `POST /api/agent/pull` honors `watch: true` → `markWatchPoll`; `handleAgentListReplies` returns `{ replies, watching }`. |
| `server/src/agent-queue.test.ts` | modify | `markWatchPoll` / `isWatching` / TTL tests. |
| `server/src/index.test.ts` | modify | `watch`-flag → `watching` integration test. |
| `web/src/agentContextClient.ts` | modify | Replies-fetch return type carries `watching`. |
| `web/src/components/AgentContextSection.tsx` | modify | "Agent is watching" indicator; `watch shippable` magic-phrase chip. |
| `web/src/components/AgentContextSection.test.tsx` | modify | Indicator + chip tests. |
| `docs/concepts/agent-context.md` | modify | § Two-way gains a watch-mode paragraph. |
| `docs/plans/share-review-comments.md` | modify | Mark "Push to idle session" follow-up as addressed by watch mode; link this spec. |
| `docs/features/agent-context-panel.md` | modify | Document the watching indicator and the `watch shippable` phrase. |

## Out of Scope

- **SSE / event-driven transport** — the designated follow-up. `GET /api/agent/events`; the watch tool blocks on the stream instead of polling. Instant delivery, no poll chatter, exact `watching` state, and a path to a push-based web UI. The watch tool's contract to the agent is unchanged, so it is a clean drop-in.
- True zero-prompt delivery to a fully idle agent (Channels, stdin injection) — already rejected in `docs/plans/share-review-comments.md`.
- A Claude-Code-specific hook to auto-enter watch mode.
- Explicit batch-window tuning, watcher *count* (vs. boolean), idle auto-stop heuristics.
- Changes to `shippable_post_review_comment` or agent→reviewer threading.
- Durable/SQLite queue, multi-tab sync — pre-existing limitations, untouched. The in-memory restart-drops-queue behavior is inherited.

## Open Questions Resolved

- **Transport for v0** → shim-side poll loop over the unchanged `/api/agent/pull`. SSE explored, deferred to the follow-up; it is the faithful Agentation mapping but its multiplexing earns nothing with a single consumer today.
- **Replace or coexist with `check`** → coexist. One-shot `check` serves async review; `watch` serves live review.
- **Kickoff prompt** → one prompt is unavoidable (MCP cannot wake an idle agent) and accepted; the feature removes the *repeated* prompt.
- **Default `timeoutSeconds`** → 60 s, clamped 1–300. Conservative vs. Agentation's 120 s default, to stay under MCP-client tool-call duration caps; the agent re-loops, so a short timeout is costless.
- **Watching-indicator carrier** → `GET /api/agent/replies` (confirmed `{ replies }` today, polled while a worktree is loaded). Extended to `{ replies, watching }`.
- **Watching-indicator TTL** → `WATCH_TTL_MS = 90 000`. Long enough to survive the agent's between-comments work phase, short enough to clear soon after a real stop. Approximate by nature of polling; SSE makes it exact.
- **Loop self-sustainment** → every tool result carries an in-band next-step hint (`WATCH_DELIVERED_HINT` / `WATCH_IDLE_HINT`), reusing the `auto-reply-hint` pattern, so the loop does not depend on the tool description staying in the model's focus.
- **Transient server error inside the loop** → return a structured `errorResult` and exit the loop rather than spinning on a dead server; the agent retries.