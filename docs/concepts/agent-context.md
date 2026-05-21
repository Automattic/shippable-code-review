# Agent context

When the reviewer loads a worktree, it shouldn't just show the diff — it should show *who made the diff and why*. If a Claude Code session produced these commits, that session's transcript, todo list, original task, and tool-call trail are already on disk and have most of the answers a reviewer asks: "what was the agent trying to do here?", "did it actually finish what was asked?", "why did it touch this file?".

"Agent context" in Shippable is: the curated, commit-aligned slice of a Claude Code session presented next to the diff that came out of it. The reviewer reads it; the reviewer can also write back into it via the MCP pull channel (`docs/plans/share-review-comments.md` supersedes the file-based half of `docs/plans/worktrees.md` slice (d)). It is a two-way pipe by design, not a one-way log viewer.

## Where it comes from

The local source of truth is the Claude Code CLI's own transcript files:

```
~/.claude/projects/<project-path-hash>/<session-id>.jsonl
```

These are append-only JSONL records — one event per turn (user message, assistant message, tool call, tool result). Each record carries a `cwd` field, which is how we map a transcript back to a worktree on disk. The reviewer UI reads slices on fetch; it does not tail transcript files into a live feed.

We deliberately **do not** ask the agent to write a sidecar metadata file into the worktree. The transcript already exists; duplicating it would mean two sources of truth and a coordination bug waiting to happen. The richer `.claude/worktrees/index.json` registry described in `docs/plans/worktrees.md:93-96` remains a future option — additive, not load-bearing.

## How a worktree maps to a session

The match is fuzzy on purpose. A worktree's path is matched against the `cwd` field of recent transcript files. Three cases:

1. **One match.** Use it. This is the common case.
2. **Multiple matches** (the user ran several Claude Code sessions in the same worktree). Show a session picker — most recent first, with task summary and time range.
3. **No match.** Show the panel in an empty state with "pick a session manually" — don't pretend there's no agent context if the user wants to attach one anyway.

The current manual choice is transient UI state. It overrides auto-match for the active review view, clears when the user loads a different worktree, and a page reload falls back to auto-match.

## Commit-aligned slicing

A live session can have hundreds of turns. Reviewers don't want a chat replay; they want "what did the agent do *for the commit I'm looking at*?".

The reviewer slices the transcript by **commit boundary**: the events between the previous commit's timestamp and the current commit's timestamp on this worktree's branch. That window is the agent context for *this* changeset. When a new commit lands the slice advances; the previous slice doesn't disappear, it becomes browsable history.

This is the small but important conceptual move: the unit of agent context is *a commit*, not *a session*. A session can produce many commits and a reviewer reviews them one at a time.

## What's in a slice

Everything we have, layered for progressive disclosure:

- **Task** — the original user prompt that started the session, plus any follow-up user messages within this slice.
- **Plan / todos** — the agent's todo list state at the end of the slice (Claude Code's `TodoWrite` events are in the transcript).
- **Files touched** — every file path that appears in tool calls within the slice, mapped to the diff hunks that file owns. This is the load-bearing connector between the chat and the diff.
- **Transcript tail** — the last N assistant messages, with collapsible expansion for the full slice.
- **Symbols mentioned** — identifiers in backtick spans that match the loaded ChangeSet's symbol graph become click-throughs into the diff. Hooks into the existing symbol-graph work in `docs/concepts/symbol-graph-and-entry-points.md`.
- **Cost / duration / model** — quick "how expensive was this commit" read.
- **Final summary** — the agent's last assistant message before the commit, if it reads as a summary.

The panel is collapsed-by-default for everything except Task and Files-touched, since those are the two pieces a reviewer almost always wants and the rest is on demand.

## Two-way: feedback back to the agent

The same panel hosts the reverse direction. Two MCP tools wire the loop end-to-end:

1. **Reviewer → agent (pull).** The reviewer authors structured comments (line, block, replies) on the diff; each authoring gesture stages the comment on the local server's queue keyed by `worktreePath`. The agent fetches by calling `shippable_check_review_comments` — typically when prompted with `check shippable` — and the tool returns a `<reviewer-feedback>` envelope wrapping every pending comment. The response also carries a trailing next-step hint in-band so the post-back expectation doesn't rely solely on the tool description, which fades from a model's working focus after the call.
2. **Agent → reviewer (post-back).** `shippable_post_review_comment` accepts two shapes through one schema:
   - *Reply mode* — `parentId` + `outcome ∈ { addressed, declined, noted }`. Threads under the reviewer comment with the matching id; surfaces nested under the original entry in the panel.
   - *Top-level mode* — `file` + `lines`. Posts a fresh, agent-authored comment anchored to the diff. Renders as a new root in the agent-context panel under "Comments"; the reviewer can reply to it via the standard composer, and the resulting `reply-to-agent-comment` kind enqueues for the agent. The pull envelope inlines the parent agent comment's body as a `<parent>` child so the agent has context for its response.

   The fallback magic phrase for both modes is `report back to shippable`.

**Watch mode (live delivery).** The reviewer→agent pull is one-shot by default — `check shippable` per batch. `shippable_watch_review_comments` adds a live mode: the reviewer prompts once (`watch shippable`), the agent enters a `watch → act → post back → watch` loop, and every comment authored afterwards reaches the agent within ~2s. The tool is a poll loop in the `mcp-server/` shim over `POST /api/agent/interactions` with `status: "unread"` (the draining read) — it drains pending comments, then blocks until more arrive or `timeoutSeconds` (default 60, clamped 1–300) elapses, returning either way with an in-band next-step hint so the loop is self-sustaining. So the reviewer can trust their comments are landing live, each watch pull tags itself `watch: true`; the server stamps `lastWatchPollAt` and `GET /api/agent/replies` returns a derived `watching` boolean, which the panel renders as an **"Agent is watching — comments deliver live"** indicator (`WATCH_TTL_MS` = 90s, approximate by nature of polling — a stopped loop clears the indicator within the TTL). Event-driven SSE transport is the designated follow-up; it makes `watching` exact. See `docs/sdd/watch-review-comments/spec.md`.

The free-form composer and the `freeform` `CommentKind` are gone — reply support is comment-anchored only. Pushback or clarification on a `declined` reply flows out-of-band into the user-agent chat, not back through Shippable. File-level (`lines` omitted) top-level comments are not supported in v0 — see `docs/sdd/agent-comments/spec.md`.

See `docs/plans/share-review-comments.md` for the original pull design, `docs/sdd/agent-reply-support/spec.md` for the original post-back half, `docs/sdd/agent-comments/spec.md` for the top-level extension, and `docs/sdd/auto-reply-hint/spec.md` for the in-band hint that reinforces the loop.

**Structured fields on top-level comments.** Top-level mode carries three extra fields so an agent comment is self-explanatory without re-prompting the agent:

- `rationale` — **required** for top-level posts. Why the comment matters. Enforced at the MCP boundary (`mcp-server/`); a top-level call without it is rejected.
- `suggestedFix` — optional. Free-form code or text the reviewer applies by hand (no diff anchoring, no one-click apply).
- `confidence` — optional. `low | medium | high`.

The fields apply to **top-level mode only** — reply-mode posts and pre-existing rows carry none of them and render unchanged. They ride the existing channel: flat keys on `/api/agent/replies`, stored in the `interactions` table's `payload_json` bag (no migration), projected onto the `Interaction`. `AgentRow` renders `confidence` as a chip in the head row and `rationale` / `suggestedFix` as collapsible `<details>` sections, collapsed by default — a glance shows body + intent + chip. See `docs/sdd/structured-comment-fields/spec.md`.

Concretely:

- **Transport:** `POST /api/agent/interactions`, `POST /api/agent/replies`, `GET /api/agent/replies` on the local server ← `mcp-server/` shim ← agent's MCP client. Localhost-only bind; no LAN exposure, no token in v0. One replies endpoint pair covers both reply-shaped (`parentId`) and top-level (`file` + `lines`) post-back entries.
- **Fetch by status:** `POST /api/agent/interactions` takes a required `status` ∈ `unread | delivered | all`. `unread` returns pending interactions and acks them (drains the queue — the historical `pull` behavior); `delivered` re-reads already-acked interactions; `all` returns both. All three return the same `{ payload: <reviewer-feedback XML>, ids }` shape; only `unread` mutates. The MCP tool `shippable_check_review_comments` surfaces `status` as a required argument.
- **Latency model:** comments arrive when the agent calls the tool — typically when the user says `check shippable`. Replies and top-level comments arrive when the agent calls `shippable_post_review_comment`, or when prompted with `report back to shippable`. The reviewer UI polls `/api/agent/replies` every 2s while the active worktree is loaded and the tab is visible; mid-turn delivery is deliberately not in scope, but as soon as the agent posts the reviewer sees it within a poll cycle.
- **Install affordance:** the panel renders the per-harness install line and the three magic phrases (`check shippable`, `watch shippable`, `report back to shippable`) as click-to-copy chips. The server detects a configured `shippable` MCP entry in `~/.claude/settings.json` / `~/.claude/settings.local.json` and collapses the install affordance to a one-line ✓ when present.
- **Threading shape:** one level of nested threading on each axis.
  - For reply-mode entries: each reviewer `Reply` carries an optional `agentReplies: AgentReply[]` array; the merge step keys on `Reply.enqueuedCommentId ↔ parent.commentId` and is idempotent on re-poll.
  - For top-level entries: a new root in the existing `state.interactions` map when the thread head is authored by the agent; the panel's `Comments (N)` rollup is derived from those agent-started threads.
  - Users cannot reply *to* an agent reply within Shippable; pushback flows out-of-band. The threading limitation is intentional — see the specs for forward-compat notes.

Why pull (and now structured post-back) instead of writing to `CLAUDE.md` or a hook: it collapses the explicit "Send" gesture into the user's natural next prompt, covers every MCP-speaking harness with one transport, and aligns with Shippable as a passive workspace rather than a tool that wedges itself into the build loop. The earlier hook-based file inbox at `<worktree>/.shippable/inbox.md` was built once on `worktree-agent-context-panel`, kept as a record, and replaced.

## Refresh model

The slice fetch is keyed on `(worktreePath, commitSha, pinnedSession, refreshTick)`.

- **Manual refresh:** the panel's `↻` button bumps `refreshTick` and re-runs the fetch.
- **Commit-boundary refresh:** when the loaded worktree advances to a new commit through the existing live-reload flow, `commitSha` changes and the agent-context slice is re-fetched for that commit.
- **Reply/delivery polling:** the side channel is separate. Delivered comments and agent post-backs poll every 2s while the active worktree is loaded and the tab is visible.

We deliberately do not file-watch the JSONL transcripts themselves. The reviewer is interested in *commits*, not *agent keystrokes*. Streaming every tool call into the UI would be noisy, and once we have it the temptation to build "live agent feed" creeps the surface area. Commit-boundary refresh keeps the interface aligned with what reviewers actually do.

## What this is not

- **Not a chat client.** No multi-author threads, no reactions, no multi-room. Agent replies surface as a single nested level under the reviewer Reply they answer; pushback / clarification stays in the user-agent chat.
- **Not a session manager.** The Claude Code CLI manages sessions; we read what it writes.
- **Not load-bearing on a sandbox.** It works for any worktree where Claude Code ran with `cwd` inside it — agentic sandbox or hand-driven branch.
- **Not a substitute for reading the diff.** The agent's narrative is one signal. The diff is the source of truth.

## Findings from implementation (frontend wiring)

- **State lives outside `ReviewState`.** The reviewer's `ReviewState` is persisted to localStorage and reflects review work-in-progress; agent context is async-fetched, transient, and per-changeset. Putting it in `ReviewState` would either pollute the persisted snapshot or require a denylist of "don't save these fields." We keep it as plain `useState` at the App level instead.
- **Worktree provenance lives on the ChangeSet itself** (`cs.worktreeSource?: WorktreeSource`), set by `LoadModal` when constructing the cs. *Initial design held it as separate App state and threaded it through `onLoad(cs, source?)`; that broke under page reload (App state was lost while the cs survived in localStorage) and under changeset switching (only one source was tracked at a time).* Stamping it on the cs means the provenance is automatically persisted, automatically per-cs, and survives the same things the cs does. Render gate is just `cs.worktreeSource ?? null`.
- **Inspector takes one `agentContext?: AgentContextProps` bundle**, not a flat list of seven props. Optional — passing `undefined` keeps the section out of the DOM entirely. Means non-worktree-loaded changesets see the original Inspector unchanged.
- **Session-pick state lives in App.** A single `pinnedSessionFilePath` overrides the "most recent matching session" default. It clears when the user loads a different worktree, and it is not persisted across reload.
- **The fetch effect is keyed on `worktreePath + commitSha + pinnedSession + refreshTick`.** Same shape as the existing `usePlan` flow in this codebase — keeps cancellation simple via a `cancelled` flag in the closure.
- **Replies poll separately from the slice fetch.** `useDeliveredPolling` runs against `/api/agent/delivered` and `/api/agent/replies` every 2s while the tab is visible. That poll updates delivery state and merges agent post-backs into `state.interactions`; it does not re-fetch the transcript slice.
- **Sync `setState` stays out of effect bodies.** The repo's lint config (`react-hooks/set-state-in-effect`) forbids it, and `usePlan.ts` shows the right pattern: derive a fetch key, use the adjusting-state-during-render trick (`if (lastKey !== wantedKey) { setLastKey(...); setLoading(true); ... }`) for the sync transitions, and keep the effect body itself pure-async — only `.then()` / `.catch()` / `.finally()` callbacks setState. The `cancelled` flag in the closure closes over the in-flight fetch so a stale result can't overwrite a fresher one.
- **Symbol linking is backtick-only, not bare-identifier.** The existing `RichText` component links bare identifiers too — right call for AI plan output, wrong call for chat content (the agent says "loop" or "cursor" all the time and those would all link). We inline a small backtick-only tokenizer in `AgentContextSection` instead. The false-positive guard ("only link if the symbol is in a file the diff touches") falls out for free because `buildSymbolIndex` only emits symbols defined in the loaded ChangeSet.
- **MCP-install detection is best-effort and informational.** The server reads `~/.claude/settings.json` and `~/.claude/settings.local.json`, looks for a `shippable` entry under `mcpServers` (the canonical Claude Code shape) — and accepts a few permissive variants (`mcp.shippable`, `mcp_servers.shippable`) so we don't false-negative users who configured via a sibling tool. Malformed or missing files return `{ installed: false }` without throwing. Project-level configs are NOT checked — would need to walk the worktree tree, brittle. False negatives surface as a "set up" install affordance at the top of the panel; comment authoring on the diff still works regardless (the affordance is purely a nudge, not a gate). For non-Claude-Code harnesses we have no programmatic detection — the affordance offers an "I installed it" dismiss button persisted per-machine in `localStorage` under `shippable.mcpInstallDismissed`.
- **No automated config writer.** The earlier slice's one-click hook installer (`POST /api/worktrees/install-hook`) was removed alongside the inbox channel. MCP servers don't have a clean unattended-install path on most harnesses; the user copies the install line and runs it. The Findings on the previous mechanism are preserved in the `worktree-agent-context-panel` branch as a record.

## Findings from implementation (server-side reader)

Things that surfaced once the JSONL parser hit real transcripts:

- **Sessions cross cwds.** A single transcript file can have entries with multiple `cwd` values — confirmed in our own dogfood session, which spanned three. Implication: matching uses *any* entry's `cwd`, not the first one's. The fast-path lookup by encoded project-dir name (`/foo/bar` → `-foo-bar`) is a hint, not a substitute for scanning entries.
- **Strict cwd filter for slicing.** When a session crosses cwds, we drop events where `cwd !== worktreePath` from the slice. The right call for the production flow (sessions that start with cwd already in the worktree); it does cost one UX wart in cross-cwd dogfooding, where the original framing message is filtered out and `task` ends up being whatever the user typed *after* the cwd switch. Acceptable.
- **Timestamps need epoch-ms comparison.** Git's `%aI` and Claude Code's JSONL `timestamp` use different ISO 8601 offset conventions (`-03:00` vs `Z`). String compare is wrong. Always parse via `Date.parse` before windowing.
- **`TodoWrite` is the right hook for the plan list.** It's the Claude Code tool name in the transcript. The reviewer's own `TaskCreate` (a Claude Code harness tool, not in transcripts) is a separate thing — empty `todos` in dogfood doesn't mean the extractor is broken.
- **Tool inputs are unstable.** File paths can live in `file_path`, `path`, `filePath`, or `filename` depending on the tool. Defensive lookup over an allowlist of keys is the only sane move.
- **Append-only files have torn tails.** Live JSONL reads can hit a half-written line. The parser silently skips malformed lines; one bad tail-line shouldn't kill the read.

## Open questions tracked here

- **Symbol-link false positives.** Backtick-quoted spans that *happen* to match an unrelated symbol. Mitigation: only link when the symbol is also in a file the diff touches. Revisit if false positives are still annoying.
- **Multi-session-per-commit.** If two Claude Code sessions interleaved on the same worktree, the slice could mix transcripts. v1 picks the most recent session that touched the files in the diff; we record this in the slice metadata so the user can switch.
- **Transcript privacy.** Transcripts can contain pasted secrets. We never upload them; we render in the local app only. Document this prominently in the feature doc.
- **Empty slices.** A commit with no transcript events (e.g., the user committed by hand). The panel should fall back to an explicit empty state rather than a broken-looking blank section.
