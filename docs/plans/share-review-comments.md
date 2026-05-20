# Sharing review comments with the agent

## Status: shipped (v0)

All five v0 slices landed (see `share-review-comments-tasks.md` for the per-task ledger). `server/src/agent-queue.ts` hosts the per-worktree queue and the agent-reply store; the `/api/agent/{enqueue,pull,unenqueue,replies}` and `/api/agent/{delivered,replies}` endpoints are wired in `server/src/index.ts`. `mcp-server/` is the standalone MCP server exposing `shippable_check_review_comments` and `shippable_post_review_comment` — agent replies thread under the original comment in the panel (see `docs/sdd/agent-reply-support/spec.md` for the original reply-only design, `docs/sdd/agent-comments/spec.md` for the top-level extension that renamed the tool). Open follow-ups (durable queue, multi-channel pip, server-side install verification) are listed at the bottom of this doc.

The remainder of this doc is the original plan.

---

The reviewer already lets you write structured comments on a diff — line comments, block comments, replies to AI notes, replies to teammate notes, replies to hunk summaries. Those comments live in `ReviewState` and never leave the browser. The agent that produced the diff has no idea the reviewer said anything.

This plan closes that loop with a **pull channel**: the reviewer authors comments in Shippable, then asks their agent — Claude Code, Codex, Cursor, any MCP-speaking harness — to check the queue. The agent calls a `shippable_check_review_comments` MCP tool, fetches pending comments, and emits them as `<reviewer-feedback>` for the model to act on.

This is the second pass at the design. The first pass (preserved on the `worktree-agent-context-panel` branch) built a hook-based push channel for Claude Code: *click Send → switch to terminal → type any prompt → hook fires → comments arrive*. That implementation works. We pivoted to pull because pull collapses the "Send" gesture into the user's natural next prompt, covers every MCP-speaking harness with one transport, and aligns with the post-implementation-review framing where Shippable is a passive workspace rather than something inserting itself into the build loop. § Why pull, not push walks through the comparison.

This sits in the slice (d) lane of `docs/plans/worktrees.md` and supersedes the file-based half of that plan.

## Goal

What v0 enables:

- A reviewer authors structured comments on a worktree's diff. Authoring stages them on the local server's queue — there is no separate "Send" gesture.
- The reviewer asks their agent something like `check shippable`. The agent calls the MCP tool, fetches the queue, and reads the `<reviewer-feedback>` envelope as its tool result. The model acts on the comments.
- A small "Delivered (N)" block surfaces what the agent has fetched, with timestamps. Per-thread pips flip from queued (◌) to delivered (✓) when the comment id appears in the delivered list.
- The agent posts back via `shippable_post_review_comment`. Two modes through one tool: *reply* (`parentId` + `outcome`) threads under a reviewer comment, *top-level* (`file` + `lines`) anchors a fresh agent-authored comment to the diff that the reviewer can reply to. See `docs/sdd/agent-reply-support/spec.md` (reply-only design) and `docs/sdd/agent-comments/spec.md` (top-level extension).

> **Free-form composer is gone.** The `freeform` `CommentKind` and the panel's free-form composer were removed by the agent-reply work — reply support is comment-anchored only. Reviewer → agent freeform messaging now flows out-of-band into the user-agent chat, which is consistent with how clarifications already worked.

What v0 explicitly does not try to do:

- **Push to an idle session.** No transport short of Channels or PTY injection delivers when the user isn't at the terminal. Both rejected — see § Approaches considered.
- **Active mid-turn delivery.** Pull means the agent fetches when prompted. Hooks would deliver mid-turn; we considered them and chose not to (§ Why pull, not push).
- **Per-comment fetch control.** The MCP tool returns the full pending queue. If the reviewer wants only a subset, they delete the rest. Drafts stay local — § State.
- ~~**Detection of agent replies.**~~ Superseded — the agent posts structured replies and top-level comments via `shippable_post_review_comment` and they render threaded under the original entry (replies) or as a new root in the panel (top-level). See `docs/sdd/agent-reply-support/spec.md` and `docs/sdd/agent-comments/spec.md`.

## Why pull, not push

Every transport requires the user to come back to their agent and do something. The question is what extra cost that "something" carries:

- **Push via hooks**: review in Shippable → click Send → switch to terminal → type any prompt → hook fires, comments arrive. The Send click is an extra discrete gesture in the Shippable window; the prompt the user types in the terminal afterward was happening anyway.
- **Pull via MCP**: review in Shippable → switch to terminal → type `check shippable` → agent fetches, comments arrive. No extra gesture — the cost is remembering to include a trigger phrase in the prompt the user was going to type anyway.

Pull is strictly one action shorter. It trades the explicit Send click for an onboarding cost (the user has to know the trigger phrase). Three reasons we picked the trade:

1. **Universal harness coverage from day one.** MCP is supported by Claude Code, Codex CLI, Cursor, Cline, Claude Desktop, OpenCode, and any agent built on the Agent SDK. Hooks would need per-harness install logic — different settings shapes, different event names. One MCP server is one install per harness via that harness's standard `mcp add`-style command.

2. **Aligns with the post-implementation-review framing.** Shippable is a workspace where reviewer comments live; the agent fetches on demand. That's strictly humbler than "Shippable injects context into your session" — and matches the v0 positioning: Shippable is the place you go *after* your build loop, not a tool that wedges itself into the loop.

3. **Less UI to maintain.** No Send button, no preview sheet, no `sentToAgentAt` lifecycle, no `MARK_REPLIES_SENT` action, no second polling loop. Authoring a comment posts it to the queue immediately; the queue is the source of truth.

What we lose:

- **Reliability of delivery.** The model has to decide to call the MCP tool when the user's prompt is ambiguous ("any feedback?", "look at my review"). With hooks this didn't matter — anything the user typed fired the hook. We mitigate with a precise tool description and by surfacing the exact magic phrase prominently in the panel.
- **Mid-turn delivery.** Hooks deliver on every `PostToolUse`; while the agent is mid-task, comments arrive seconds later. With pull, the agent only fetches when prompted. Acceptable for the post-implementation-review framing — by then the user has finished their build loop.

## Approaches considered

| Approach | Status | Why decided |
|---|---|---|
| **MCP pull tool** | **Chosen for v0** | One action shorter than push; universal harness support; cleaner positioning; less UI. |
| Hooks (push at next agent activity) | Built once on `worktree-agent-context-panel`, preserved as a record | Adds an explicit Send click that pull doesn't need, and adds Send-button scaffolding (state lifecycle, two polling loops) for that gesture. Claude-Code-only without per-harness install work. The implementation made the cost concrete. |
| Channels plugin (Anthropic) | Ruled out early | Research-preview status, requires Anthropic-side allowlist or `--dangerously-load-development-channels`, requires claude.ai login, default-off for Team/Enterprise. Re-evaluate if Channels GA. |
| PTY / tmux `send-keys` / TIOCSTI | Rejected | Linux gates TIOCSTI behind `CAP_SYS_ADMIN`; tmux requires the user to run `claude` inside tmux; macOS Accessibility-based injection is brittle and steals focus. Not product-grade. |
| IDE-extension input surface | Confirmed unavailable | Investigated VS Code and JetBrains plugins: no programmable input. Internal MCP server is locked to localhost + token + random port. URI handler can pre-fill the prompt box but doesn't auto-submit. |
| Agent SDK `streamInput` | Not applicable | Only works for sessions Shippable spawns. We don't host the agent. Useful only if Shippable ever runs its own AI Inspector. |

## Slices

Each one stands on its own and unblocks the next.

**(1) Queue substrate.** Per-worktree comment queue keyed by `worktreePath`, with atomic pull-and-ack. Endpoints: `POST /api/agent/enqueue`, `POST /api/agent/pull`, `GET /api/agent/delivered`, `POST /api/agent/unenqueue`. `<reviewer-feedback>` payload formatter. Server-side vitest with the sort/sanitize fixture. *Done when:* enqueue → pull round-trips, second pull is empty, sort order matches the spec. (The agent back-channel adds `POST` and `GET /api/agent/comments` to the same substrate — both reply-shaped and top-level agent comments share one store. See `docs/sdd/agent-reply-support/spec.md` and `docs/sdd/agent-comments/spec.md`.)

**(2) Author = enqueue.** Authoring a thread comment in the UI POSTs to `/api/agent/enqueue` immediately; the response includes the server-assigned comment id, which is stored on `Reply.enqueuedCommentId`. Editing a previously-saved Reply re-enqueues with `supersedes` set to the prior id (§ Behavior § Edit & delete). Drafts (textarea state before submit) stay local — the data model has no "Reply pending submission" state. *Done when:* writing 5 comments produces 5 entries in the queue with ids on the local Replies; editing one produces a sixth entry with the right `supersedes` link. (The earlier free-form composer that enqueued a `freeform` comment kind was removed by the agent-reply work — see `docs/sdd/agent-reply-support/spec.md`.)

**(3) MCP server.** A small TypeScript MCP server exposing `shippable_check_review_comments`. Tool input: optional `worktreePath` (otherwise inferred from the agent's `cwd`). Tool output: the `<reviewer-feedback>` envelope from `/api/agent/pull`, or "no pending comments" if empty. Lives in `mcp-server/` (or wherever fits the workspace). *Done when:* `claude mcp add shippable …` succeeds, prompting `check shippable` makes the agent call the tool and emit the envelope.

**(4) Delivered (N) block + pips driven by deliveredIds.** Reuses `/api/agent/delivered`. Pip on each thread renders queued (◌) when `enqueuedCommentId` is set but not yet in `deliveredIds`, delivered (✓) when it is. Polling cadence: 2s while there's a pending id, 5min idle timeout (resets on each delivery). *Done when:* authoring a comment shows ◌; running `check shippable` flips it to ✓.

**(5) Onboarding affordances + doc updates.** Agent-context panel shows the install line and the magic phrase, with copy-to-clipboard. Detection (best-effort): if the harness's MCP config file is parseable from disk and contains the shippable entry, hide the install prompt; otherwise show it unconditionally. Doc updates: `agent-context.md` § Two-way rewritten for pull, `worktrees.md` Findings note, `ROADMAP.md` cross-link.

## Architecture

```
┌─ Reviewer UI (web) ───────────────────────────────────────┐
│   AgentContextSection                                     │
│     └ thread comments (save = enqueue)                    │
│   ReviewState.replies + enqueuedCommentId per comment     │
│   (free-form composer was removed — see                   │
│    docs/sdd/agent-reply-support/spec.md)                  │
└───────────────────────────────┬───────────────────────────┘
                                │  POST /api/agent/enqueue
                                ▼
┌─ Local server (server/) ──────────────────────────────────┐
│   In-memory queue keyed by worktreePath (agent-agnostic)  │
│   Delivered cursor advances on each pull                  │
│   Endpoints (the main contract):                          │
│     POST /api/agent/enqueue    ← reviewer UI              │
│     POST /api/agent/pull       ← MCP server               │
│     GET  /api/agent/delivered  ← reviewer UI (history)    │
│     POST /api/agent/unenqueue  ← reviewer UI (edit/delete)│
└──────────────────────────────────┬────────────────────────┘
                                   │
                                   ▼
                ┌─ MCP server (Node, ~100 LOC) ───────────┐
                │ tool: shippable_check_review_comments   │
                │ inputs: { worktreePath?: string }       │
                │ resolves cwd if absent → POST /pull     │
                │ returns the <reviewer-feedback>         │
                │ envelope as the tool result text.       │
                └─────────────────────────────────────────┘
```

The HTTP endpoint is the main contract. The MCP server is a thin shim. If a future user surfaces real demand for a non-MCP transport (a hook on a CC user's machine because they really want mid-turn delivery, say), they get the same `/api/agent/pull` call with different glue.

**Request shape.** Enqueue carries the `worktreePath` from the active `ChangeSet.worktreeSource` plus the comment payload (`kind`, `body`, optional `file`/`lines`, optional `supersedes`). The server validates `worktreePath` via the existing `assertGitDir` helper before accepting the comment. Pull and delivered take only `worktreePath`. The MCP server resolves `worktreePath` from its own `cwd` if not passed explicitly by the agent.

**Transport security.** The local server binds `127.0.0.1` only — no LAN exposure. v0 has no token auth; localhost-bind is the security boundary. The MCP install line encodes the port the server is running on (`http://127.0.0.1:<port>/mcp` or equivalent) so the MCP server knows where to fetch from. If the user changes `PORT` later they re-run `mcp add` with the new port.

## Format the agent sees

A `<reviewer-feedback>` envelope wrapping one `<comment>` block per item. Markdown body, XML wrapper for unambiguous boundaries.

```
<reviewer-feedback from="shippable" commit="<sha>">
  <comment id="cmt_3f7a91" file="server/src/queue.ts" lines="72-79" kind="block">
    The atomic-ish rename here only avoids torn reads, not concurrent
    writers. If two reviewer sessions enqueue at the same moment we
    still race. Worth a lockfile or a single-writer queue.
  </comment>
  <comment id="cmt_b22c04" file="web/src/state.ts" lines="118" kind="reply-to-ai-note" supersedes="cmt_8a4f2b">
    AI note said this branch was unreachable. It's reachable from the
    keymap handler — see Cmd+Shift+R. The note is wrong; please leave
    the code.
  </comment>
</reviewer-feedback>
```

Per-comment fields: `id` (server-assigned; pass it back as `parentId` to `shippable_post_review_comment` in reply mode), `file` (repo-relative path), `lines` (single line or range), `kind` (`line` | `block` | `reply-to-ai-note` | `reply-to-teammate` | `reply-to-hunk-summary` | `reply-to-agent-comment`). For reply kinds, the body is the original AI/teammate text and the reviewer's reply text — the agent might have no context about the original comment. The `reply-to-agent-comment` kind additionally carries a `parent-id` attribute and a `<parent id="…" file="…" lines="…">…</parent>` child inlining the parent agent comment's body, so the agent can thread a coherent response. (The `freeform` kind was removed by the agent-reply work — see `docs/sdd/agent-reply-support/spec.md`.)

When a comment is the result of an edit on a previously-delivered version, the block carries a `supersedes="<old_id>"` attribute pointing to the prior comment id. § Behavior describes the server-side resolution.

We send file:line refs, not code excerpts. The agent has the codebase open; sending stale snippets is worse than letting it read the file at HEAD. Comments are anchored to the commit sha they were written against (the envelope's `commit` attribute) so the agent can disambiguate if HEAD has moved between author and fetch.

Sort order in the payload: by file path ascending, then by line number ascending (lower bound for ranges).

## Latency model

The agent sees comments only when the user prompts it to fetch.

| Agent state                              | Latency to delivery                    | Why |
|------------------------------------------|----------------------------------------|-----|
| User types `check shippable` (or similar)| seconds (one tool call round-trip)     | Agent calls the MCP tool; tool calls `/api/agent/pull`. |
| Mid-turn, hasn't been asked              | not delivered                          | MCP tools are pull, not push. |
| Idle, no prompt                          | not delivered                          | Same — no clock-driven trigger. |
| Fresh session in a worktree with a queue | not delivered until the user prompts   | No SessionStart equivalent in the pull model. |

This is honest. The UI surfaces the magic phrase ("Tell your agent: `check shippable`") prominently below the comment list; clicking copies it to clipboard. Onboarding teaches the phrase once.

The biggest risk is *prompt drift*: a user types "any feedback?" and the agent doesn't connect it to the shippable tool. Mitigated with a precise tool description and by suggesting the exact phrase. If real users report the agent ignored their request, that's product feedback worth acting on (sharper tool description, or a fallback hook for users who want belt-and-suspenders).

## State

- **Per-comment `enqueuedCommentId: string | null` on `Reply`.** Set when the reviewer authors a comment and the server returns its id. Pips render based on `enqueuedCommentId` plus the polled `deliveredIds` set: queued if the id is set but not yet delivered, delivered once it appears. Persisted in `ReviewState` via the existing localStorage round-trip — survives reload. v0 ships scalar; multi-channel pip generalization (§ Follow-ups) will replace this with a per-channel id map and require a localStorage migration when it lands.
- **Server queue: in-memory.** `Map<worktreePath, { pending: Comment[]; delivered: DeliveredComment[] }>`. Survives the server process; a restart drops unpulled comments. Surfaced explicitly: the panel shows a small "(server in-memory — restart drops queue)" hint.
- **Drafts stay local.** A textarea in mid-edit is not a Reply yet. The data model has no "pending reply not yet enqueued" state. Submit creates the Reply and enqueues atomically.
- **Per-worktree isolation.** Switching worktrees clears the local pip state for the old worktree's pending ids; reloading or returning to that worktree refetches from `/api/agent/delivered`.

The in-memory queue is a v0 limitation. Same SQLite migration candidate listed under 0.1.0 in `docs/ROADMAP.md`. We do not introduce a new persistence mechanism for one queue.

## Behavior

User-facing interactions pinned for v0. Alternatives we considered and the reasoning behind each pick live in the conversation that produced this section.

### Authoring

- **Panel renders only when a worktree is loaded.** With no active `ChangeSet.worktreeSource` (URL-ingest, paste, file upload), the agent-feedback affordances are hidden entirely — no install section, no pips. The user has nothing to share.
- **Submit gesture for thread comments:** Cmd/Ctrl+Enter, or click the existing "send" button. Plain Enter inserts a newline.
- **Submit creates the local Reply and POSTs to enqueue in the same step.** The Reply is added to `ReviewState.replies` immediately with `enqueuedCommentId: null`; the POST runs in parallel. On success, the server-assigned id is patched in. On failure (server unreachable, validation error), the Reply remains without an id and the thread surfaces a "Save again" affordance — re-saving re-runs the POST. No pip appears until the id is set; localhost latency is short enough that a transient "queued in flight" state isn't visually justified.
- **Drafts persist per-worktree** while half-typed. Switching worktrees does not discard a half-typed draft.

### Edit & delete after enqueue

- **Editing a previously-enqueued comment re-enqueues it.** Save POSTs a fresh `/api/agent/enqueue` with the updated body and `supersedes: <previousEnqueuedCommentId>`; `Reply.enqueuedCommentId` updates to the new id; pip resets to ◌. The server resolves supersession before the next pull:
  - If the superseded id is still pending (not yet fetched), it's dropped — the agent never sees the old version.
  - If the superseded id was already delivered, it stays in history and the new comment carries a `supersedes="<old_id>"` attribute so the agent knows it replaces an earlier note.
  - If the superseded id is unknown (e.g. after a server restart), the new comment carries the attribute anyway; defensive.

  Chained edits are tracked one hop at a time — the new comment's `supersedes` always points at the immediate predecessor. Server-side, supersession resolves once per pull: if the immediate predecessor is itself still pending, both versions collapse to the latest before the payload is generated, so the agent only ever sees the most recent version when intermediate edits never reached it.
- **Deleting an enqueued-not-delivered comment also un-enqueues it server-side.** Pip vanishes alongside the local Reply.
- **Deleting an already-delivered comment is local-only.** A tooltip explains: "the agent already saw this; deleting only removes it from your view."
- **No queue-preview affordance.** The thread structure is the source of truth for what the agent will fetch. A "Pending (N) — preview" disclosure was considered and rejected as duplication of the visible thread state, and as a back-door return of the Send-button gesture we explicitly removed.

### Pip semantics

- **No pip** — `enqueuedCommentId` is null. Either the Reply hasn't been enqueued yet (still being composed) or its enqueue POST failed; the absence is the signal. Don't add a third glyph.
- **`◌ queued`** — `enqueuedCommentId` is set but not yet in `deliveredIds`. Tooltip: "Sent to your agent's queue at HH:MM:SS."
- **`✓ delivered`** — id has appeared in `/api/agent/delivered`. Tooltip: "Fetched by your agent at HH:MM:SS."
- **Pip flips with a brief animation.** No toast, no panel-level counter — the Delivered (N) block already shows the macro view.
- **Future generalization:** as additional delivery channels arrive (agent fetch, GitHub PR comment, Linear issue, etc.), the pip becomes channel-aware — tooltip lists each channel that has seen the comment, glyph reflects the most-progressed state. v0 ships agent-only.

### Failure modes

- **Server unreachable mid-session:** pips freeze in their last-known state; a panel-level banner reads "Agent status unavailable — last checked X min ago." No third pip glyph; the banner carries the uncertainty.
- **Server restart drops the queue.** No recovery affordance in v0. The "(server in-memory — restart drops queue)" hint near the panel header is the only signal. Stuck-`◌` pips are a known limitation that the planned SQLite migration retires.
- **Multi-tab is unsupported** — a pre-existing limitation in the codebase, not specific to this feature. localStorage's last-writer-wins behavior applies; we do not add `storage`-event sync as part of this work. Documented for visibility.

### Onboarding & install affordance

- **The agent-context panel surfaces a prominent install section at the top** when no MCP install is detected. The section contains the per-harness install line and the magic phrase, both copy-to-clipboard.
- **Per-harness install line.** A copy-paste box keyed off the detected harness:
  - Claude Code: `claude mcp add shippable …` (final shape lands with slice 3).
  - Codex CLI: `codex mcp add …` equivalent.
  - Cursor / Cline / others: their respective config snippet.

  Default to whichever we detect (CC if `~/.claude/...` exists, else generic).
- **Magic-phrase clipboard contents:** `check shippable`. The MCP tool description is written aggressively to match adjacent phrasings ("check review comments", "shippable feedback", "any reviewer notes"). If real prompt drift surfaces, escalate to a longer copy-paste string before changing the displayed phrase.
- **Detection.** For Claude Code we parse the relevant config; if a shippable entry is present, the section collapses to a small "MCP installed ✓" line. For other harnesses we cannot read the config reliably, so the section shows an **"I installed it"** dismiss button. The dismiss state is persisted in localStorage per-machine (not per-worktree, not per-user-account); switching machines re-prompts. Server-side verification (the panel auto-hides when the server sees a recent MCP pull) is on the follow-up list — useful when a user pulls within minutes, but the manual dismiss is the v0 path because pulls may not happen for hours.
- **No automated `settings.local.json` writer.** The hook-install affordance from the previous design (one-click write) goes away — MCP servers don't have an equivalent unattended-install path on most harnesses; the user copies the command and runs it.

## Open questions

- **Comment in a file that isn't in the loaded diff.** Shouldn't happen — the reviewer can only comment on hunks in the loaded ChangeSet — but if the user pulls a fresh changeset in the same worktree before the agent fetches, the file may have moved. We send the file:line anyway; the agent reads at HEAD.
- **Cross-session disambiguation.** If two agent sessions are open in the same worktree and both run `check shippable`, the first wins; the second sees an empty queue. Acceptable for v0; document.
- **Magic-phrase robustness.** See § Latency model for the prompt-drift mitigation strategy and § Behavior for the escalation path. Tune as real users surface failure cases.

## Follow-ups (out of scope for v0)

- **Belt-and-suspenders hooks.** A user who really wants mid-turn delivery on Claude Code can add a hook that hits `/api/agent/pull` directly. The `worktree-agent-context-panel` branch is the reference implementation. Not v0.
- ~~**Agent-reply detection.**~~ Landed via the post-by-tool flow in `docs/sdd/agent-reply-support/spec.md` and extended in `docs/sdd/agent-comments/spec.md` — the agent calls `shippable_post_review_comment` (reply or top-level mode), no heuristic parsing needed. Reply-shape entries thread under the original comment in the panel; top-level entries surface as new roots under "Agent comments" with their own reply composer.
- **Push to idle session.** Partly addressed: for an *active* session, watch mode (`docs/sdd/watch-review-comments/spec.md`) closes the gap — `shippable_watch_review_comments` runs a poll loop so comments authored after a single `watch shippable` prompt reach the agent live, no re-prompting. A *fully idle* session (user away from the terminal) still needs Channels (when GA) or a sidecar that types into the running CLI's stdin — nothing in MCP can wake an idle agent.
- **Multi-channel pip generalization.** When additional delivery channels arrive (GitHub PR comment, Linear issue, etc.), the pip generalizes from "agent-fetched" to "seen by N channels" with a tooltip listing each. v0 ships agent-only; the data model on `Reply` keeps the door open by storing per-channel ids, not a single `enqueuedCommentId`, when this lands.
- **Server-side install verification for non-CC harnesses.** The server tracks `lastPullAt` per worktree; the panel auto-hides the install affordance when a pull was seen within the last few minutes. Useful when a user pulls quickly after install; the v0 manual "I installed it" dismiss covers the longer-tail case.
- **Durable queue.** SQLite-backed, paired with the broader local-storage migration. Retires the in-memory restart-drops-queue limitation.
- **Per-thread send control.** If a reviewer wants only a subset of their comments fetched, today they'd delete the rest. A "stage / unstage" toggle could be added if real users ask for it.

## Files of interest

- `server/src/agent-queue.ts` — per-worktree queue + payload formatter (slice 1); also hosts the agent-reply store added by the agent-reply spec.
- `server/src/worktree-validation.ts` — `assertGitDir` shared helper.
- `server/src/index.ts` — endpoints `POST /api/agent/enqueue`, `POST /api/agent/pull`, `GET /api/agent/delivered`, `POST /api/agent/unenqueue`. The agent back-channel adds `POST` and `GET /api/agent/comments` to the same router — both reply-shaped and top-level agent comments share one store.
- `mcp-server/` (new) — TypeScript MCP server exposing `shippable_check_review_comments` (slice 3) and `shippable_post_review_comment` (reply or top-level mode through one tool; see `docs/sdd/agent-comments/spec.md`). Standalone npm-publish target so users can install it via the harness's `mcp add`-style command; not a workspace dependency consumed by the existing `web/` or `server/` packages.
- `web/src/types.ts` — extends `Reply` with `enqueuedCommentId: string | null`.
- `web/src/components/AgentContextSection.tsx` — install affordance, magic-phrase copy box, Delivered (N) block.
- `web/src/components/ReplyThread.tsx` — pip rendering driven by `enqueuedCommentId` + `deliveredIds`.
- `docs/concepts/agent-context.md` — § Two-way rewritten for pull.
- `docs/features/agent-context-panel.md` — install + onboarding section.
