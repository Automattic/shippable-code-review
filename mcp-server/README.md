# @shippable/mcp-server

A TypeScript MCP server that exposes three tools over stdio for the Shippable review loop:

- `shippable_check_review_comments` — pulls pending reviewer feedback from the local Shippable server (one-shot).
- `shippable_watch_review_comments` — watch mode: blocks and polls until reviewer comments arrive or a timeout fires, so the agent picks up feedback live in a loop after a single prompt.
- `shippable_post_review_comment` — posts either a reply to a delivered reviewer interaction or a fresh top-level interaction anchored to the diff, so the reviewer can see what the agent did or noticed.

All three tools talk to the local Shippable server over `127.0.0.1`.

## Magic phrases

Three phrases trigger the round-trip explicitly when prompt drift suppresses the implicit triggers in the tool descriptions:

- **`check shippable`** — pull pending reviewer interactions once.
- **`watch shippable`** — enter watch mode: pick up reviewer comments live, looping until interrupted.
- **`report back to shippable`** — post replies (or fresh interactions) for what the agent just looked at.

The descriptions were tuned for prompt drift on adjacent phrasings ("pull review comments", "any reviewer feedback", "let shippable know what you did"). If the agent doesn't pick them up, fall back to the literal phrases.

## Tools

### `shippable_check_review_comments`

Input: `{ worktreePath?: string }` — defaults to the agent's `cwd()`.

Returns the formatted reviewer-feedback envelope, or `"No pending comments."` when the queue is empty. The envelope is a `<reviewer-feedback>` element with one `<interaction id="…" target="…" intent="…" author="…" authorRole="…" file="…" lines="…">…</interaction>` child per pending entry. Capture the `id` attribute — the pending queue is drained on read, so this is the only chance to read it.

### `shippable_watch_review_comments`

Input: `{ worktreePath?: string, timeoutSeconds?: number }` — `worktreePath` defaults to the agent's `cwd()`; `timeoutSeconds` defaults to `60` and is clamped to `1–300`.

Watch mode is a **loop**. The tool drains anything already pending, then keeps polling `POST /api/agent/interactions` with `status: "unread"` (every 2s) until reviewer comments arrive or `timeoutSeconds` elapses — it always returns:

- **Comments arrived** — the same `<reviewer-feedback>` envelope `shippable_check_review_comments` returns, followed by an in-band hint to address them, post each result back via `shippable_post_review_comment`, and call `shippable_watch_review_comments` again.
- **Timed out idle** — a short "no comments yet" message plus a hint to call the tool again to keep watching.

Either way the agent calls the tool again, so live review costs the reviewer just one kickoff prompt (`watch shippable`). The reviewer ends watch mode by interrupting the agent. A short `timeoutSeconds` is costless — the agent re-loops — and keeps each call under MCP-client tool-call duration caps. A server error returns a structured error result and exits the loop rather than spinning on a dead server.

### `shippable_post_review_comment`

One tool, two input shapes. Exactly one shape per call:

**Reply mode** — thread under a delivered reviewer interaction:

- `parentInteractionId: string` — the id of the reviewer interaction this reply answers (the `id` attribute on the `<interaction>` element returned by `shippable_check_review_comments`).
- `intent: 'ack' | 'accept' | 'reject'` — what happened:
  - `accept` — you agreed and acted on it (or will).
  - `reject` — you disagree and won't.
  - `ack` — you saw it but no commitment either way.
- `replyText: string` — see below.
- `worktreePath?: string` — defaults to the agent's `cwd()`.

**Top-level mode** — leave a fresh interaction anchored to the diff:

- `target: 'line' | 'block'` — `line` for a single line, `block` for a range.
- `file: string` — repo-relative path the interaction is about.
- `lines: string` — `"42"` for a single line or `"40-58"` for a range.
- `intent: 'comment' | 'question' | 'request' | 'blocker'` — the asks vocabulary (see `docs/plans/typed-review-interactions.md`).
- `replyText: string` — see below.
- `worktreePath?: string` — defaults to the agent's `cwd()`.

Shared:

- `replyText: string` — free-form prose. Plain text or Markdown; no XML/HTML wrapping needed. Named `replyText` rather than `body` because some model serializers conflate `body` with HTML's `<body>` element and emit `</body>` close tags into the field value. The HTTP wire field on the local Shippable server stays `body` — the rename is contained to the MCP boundary because that's where the serializer problem bites.

Returns the assigned id on success.

## Install

### Claude Code

This package isn't published to npm yet, so the primary install line uses the
local build:

```
claude mcp add shippable -- node /absolute/path/to/mcp-server/dist/index.js
```

Build first (`npm install && npm run build` in `mcp-server/`), then drop the
absolute path to `dist/index.js` into the command above. The Shippable web
panel surfaces this exact line as a click-to-copy chip with the path
pre-filled — server-side resolver picks it up automatically.

Once published — deferred until §7 of `docs/plans/share-review-comments-tasks.md`
— the npx form will work and become the recommended install:

```
# (once @shippable/mcp-server is on npm)
claude mcp add shippable -- npx -y @shippable/mcp-server
```

### Codex CLI

```
# (once published)
codex mcp add shippable -- npx -y @shippable/mcp-server
```

(TODO: verify against current Codex CLI — the exact subcommand has shifted across versions.) Until then, swap the `npx` form for the absolute-path local-build line above.

### Cursor / Cline / Claude Desktop / OpenCode

Add to the harness's MCP config JSON. Until the package is on npm, point at
the absolute path to your local `dist/index.js`:

```json
{
  "mcpServers": {
    "shippable": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"]
    }
  }
}
```

After the npm publish lands, the `command` becomes `"npx"` with
`args: ["-y", "@shippable/mcp-server"]`.

## Configuration

Port resolution, in order:

1. `SHIPPABLE_PORT` env — explicit override; wins if set and numeric.
2. The Shippable port-discovery file written by the desktop sidecar (see `docs/concepts/desktop-shell-and-sidecar.md` for paths and semantics). The MCP reads it, health-checks the listed port, and uses it on success; stale files fall through.
3. `3001` — default. Matches the bare `server/` dev port.

So the common cases just work: run the DMG and the MCP discovers it; run `npm run server` and the MCP hits 3001; set `SHIPPABLE_PORT` to force either.

The MCP connects only to `127.0.0.1` — no LAN exposure.

## Local development

Not yet published; build locally and use the absolute-path install line above.

```
npm install
npm run build      # tsc → dist/
npm test           # vitest
npm run typecheck  # tsc --noEmit
```
