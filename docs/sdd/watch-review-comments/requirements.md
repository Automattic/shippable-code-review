# Watch Review Comments — Requirements

## Goal

Let an agent pick up reviewer comments **automatically as they are authored**, without the reviewer re-typing `check shippable` for every batch. Today the reviewer→agent channel is one-shot pull (`shippable_check_review_comments` drains the queue once per prompt). This feature adds a *watch mode*: the reviewer prompts once, the agent enters a loop, and from then on every comment authored in Shippable is delivered within seconds — the live-review workflow the roadmap calls "send feedback to a live session, to steer the session live" (`docs/ROADMAP.md`).

The reference is Agentation (`agentation-mcp` 1.2.0): a `watch_annotations` tool the agent calls in a loop — drain-what's-pending, then block until more arrives or a timeout fires, then return a batch. The agent loops `watch → act → post back → watch`.

## Requirements

1. **New MCP tool `shippable_watch_review_comments`** in `mcp-server/`, alongside the existing `shippable_check_review_comments` (one-shot) and `shippable_post_review_comment` (post-back) — all three coexist.
2. **Watch behavior:** the tool returns the `<reviewer-feedback>` envelope as soon as comments are pending, or a "nothing yet" result after a timeout. First action is an immediate drain (comments authored before watch started are delivered right away).
3. **Polling transport (v0):** the tool runs a poll loop *inside the `mcp-server/` shim* — it calls the existing, unchanged `POST /api/agent/pull` every ~2s up to the timeout. No structural `server/` changes for the core mechanism. (Event-driven SSE is an explicit follow-up, not v0.)
4. **Self-sustaining loop:** every tool result ends with an in-band next-step hint instructing the agent to act on the comments, post back via `shippable_post_review_comment`, and call `shippable_watch_review_comments` again — so the loop survives the tool description fading from the model's focus. Mirrors the `auto-reply-hint` pattern.
5. **Inputs:** `worktreePath?` (defaults to the agent's `cwd`, same as the other tools) and `timeoutSeconds?` (default 60, clamped 1–300).
6. **"Agent is watching" indicator:** the reviewer sees in the agent-context panel whether an agent is currently watching, so they know their comments are landing live and they need not prompt. Driven by the watch tool tagging its pull requests; the panel reads it from the agent-status poll it already runs.
7. **Onboarding:** the agent-context panel gains a third click-to-copy magic-phrase chip — `watch shippable` — alongside `check shippable` and `report back to shippable`, with a one-line explanation of live mode.
8. **Graceful failure:** server-unreachable returns a structured error result (the handler never throws); the agent can retry. Interrupting the agent (Esc) ends the loop — re-prompting `watch shippable` resumes it.

## Constraints

- **One kickoff prompt is unavoidable and accepted.** Nothing in MCP can wake a fully idle agent; the agent must already be running the watch loop. The feature eliminates the *repeated* prompt, not the first one.
- **The agent is occupied while watching.** A watch tool call in flight blocks the agent; a user message typed during it is queued and delivered when the call returns (≤ `timeoutSeconds`). `timeoutSeconds` defaults to a conservative 60s — short enough to bound that wait and to stay under MCP-client tool-call duration caps; the agent re-calls anyway, so a short timeout is costless.
- **`mcp-server/` stays a thin shim.** Loop/timeout logic lives in the shim only because v0 has no `server/` event channel; the SSE follow-up moves the wait to `server/`. The HTTP endpoint (`/api/agent/pull`) remains the contract.
- **Localhost-only**, no token auth — consistent with the existing agent-queue transport.
- Reuses the existing in-memory per-worktree queue and `<reviewer-feedback>` payload formatter unchanged. The in-memory restart-drops-queue limitation is inherited, not addressed here.

## Out of Scope

- **SSE / event-driven transport** — the primary follow-up. Replaces the poll loop with `GET /api/agent/events`; instant delivery, no poll chatter, and opens the door to a push-based web UI. The watch tool's contract to the agent is unchanged, so it is a clean drop-in.
- True zero-prompt delivery to an idle agent (Channels, stdin injection) — already rejected in `docs/plans/share-review-comments.md`.
- A Claude-Code-specific hook to auto-enter watch mode — considered and declined; CC-only, more install machinery.
- Explicit batch-window tuning, watcher-*count* (vs. a boolean), idle auto-stop heuristics — revisit only if real use surfaces them.
- Changes to the post-back tool (`shippable_post_review_comment`) or the agent→reviewer threading.
- Multi-tab sync, durable/SQLite queue — pre-existing limitations, untouched.

## Open Questions

- **Watching-indicator TTL.** With polling, "watching" is necessarily approximate — the server marks `lastWatchPollAt` on each watch pull and treats the agent as watching for some TTL after. The TTL must outlast the agent's between-comments work phase (when it is acting, not polling) yet clear reasonably fast after a real stop. sdd-spec to pin a value (~90s suggested) and note SSE makes it exact.
- **Which agent-status endpoint carries `watching`.** The panel polls `GET /api/agent/replies` while a worktree is loaded; that is the natural carrier. sdd-spec to confirm against the current endpoint set.

## Related Code / Patterns Found

- `mcp-server/src/index.ts` — registers `shippable_check_review_comments` and `shippable_post_review_comment`; the new tool registers here with a description tuned for "watch shippable" / "address my comments as I review" / "live review".
- `mcp-server/src/handler.ts` — `handleCheckReviewComments` is the template for the new `handleWatchReviewComments`: `HandlerDeps` injection (`fetchFn`, `port`, `cwd`), `resolvePort`, `resolveWorktreePath`, `errorResult`. The watch handler additionally needs an injectable sleep/clock for deterministic tests.
- `mcp-server/src/handler.test.ts` — mocked-`fetch` test pattern to extend for the loop handler.
- `server/src/index.ts` — `POST /api/agent/pull` (reused unchanged) and the `/api/agent/*` router; `GET /api/agent/replies` is the candidate carrier for the `watching` flag.
- `server/src/agent-queue.ts` — per-worktree in-memory queue + `<reviewer-feedback>` formatter; the `lastWatchPollAt` timestamp lives in the same per-worktree record.
- `web/src/components/AgentContextSection.tsx` — magic-phrase chips and the agent-status poll; hosts the new `watch shippable` chip and the "Agent is watching" indicator.
- `web/src/agentContextClient.ts` — agent-status client functions; surfaces the `watching` flag to the panel.
- `docs/plans/share-review-comments.md` — the parent pull/post-back design; "Push to idle session" follow-up is the lineage of this feature. Update its follow-up list.
- `docs/concepts/agent-context.md` § Two-way — describes the channel; gains the watch-mode paragraph.
- `docs/sdd/auto-reply-hint/spec.md` — the in-band next-step-hint pattern that requirement 4 reuses.
- `docs/sdd/agent-comments/spec.md`, `docs/sdd/agent-reply-support/spec.md` — sibling specs in this feature family; spec format reference.
