# Shippable

Local-first review for agent diffs and pull requests. When you're working with agents, dozens of meaningful diffs a day is normal — on your machine, and in the pull requests they land in. Reading them is harder than writing the code ever was. Shippable is the review pass designed to take less out of you, before the work disappears into a skimmed read or another agent run.

This is an early **prototype**. Expect rough edges and fast-changing internals; it's not stable for production yet.

![shippable demo](docs/all.gif)

## Why you might want it

- **Every AI finding ties back to a line.** No floating summaries. A rule-based plan runs first so it still works without an API key; the model's findings get anchored to real symbols and hunks.
- **Reading and approving are different.** Three review states, not two — what you've actually read, what you've signed off, and what you've flagged for another pass. Threads capture a 10-line context window and content hash, so they survive the agent reshuffling its work.
- **A claim you can run is a test.** Highlight a hunk; the in-app sandboxed runner detects input slots and executes it — JavaScript, TypeScript, and PHP today. AI concerns can hand their snippet straight to the runner.
- **Built around git worktrees.** Per-task branches and folders, live-refreshing diffs, agent context inline. Most diff GUIs treat worktrees as an afterthought; we started there.

## What to expect today

Shippable is usable today as a local review desk for agent-written changes. It works best when you are reviewing a git worktree on your machine: open a checkout, get a hunk-anchored review plan, move through the diff with read / signed off / flagged states, and verify JavaScript, TypeScript, or PHP hunks in the in-browser runner.

You can also connect an MCP-speaking coding agent. Agents can leave findings anchored to lines in your diff, and they can pull in the comments you write back during review.

GitHub PRs work, but only as a read-only source. You can paste a PR URL from github.com or GitHub Enterprise and review it in Shippable, but Shippable does not yet post comments, approvals, or change requests back to GitHub.

Current limits:

- Reviews stay on one machine. Read progress is stored in the browser; comments are stored in the local server database. There is no sync, sharing, or team review workflow yet.
- AI features use Claude only. Add an Anthropic key in Settings for AI plan and streaming review; without one, Shippable still runs the rule-based plan.
- The packaged desktop app is macOS-only and unsigned. Linux, Windows, and remote sandbox users should run from source for now.
- This is still a prototype. There is no CI, and the product shape is still changing quickly.

## Run it from source

No DMG on Linux or in a remote sandbox? Run the whole app — web bundle and server — on a single port:

```sh
npm run setup     # install server + web + mcp-server deps (first time)
npm start         # build web + mcp, then serve everything on one port
```

Open `http://localhost:3001`. Set `PORT` to change it (`PORT=8080 npm start`) — it's the only port to forward out of a sandbox, since the API is served on the same origin as the app. Node 22 (`web/.nvmrc`).

For AI plan and streaming review, paste an Anthropic key in Settings on first load; without one you get the rule-based plan. In source mode, Anthropic and GitHub credentials are kept in the local server process, so you will re-enter them after restarting the server.

For active development with hot reload, use the two dev servers in [Developing locally](#developing-locally) instead.

## Desktop build

Download the latest macOS build from GitHub Releases:

→ [**Shippable.dmg**](https://github.com/Automattic/shippable-code-review/releases)

The DMG is unsigned, so the first launch trips Gatekeeper — right-click the .app in Finder → Open → confirm once. Subsequent launches don't prompt. macOS only today; Linux and Windows users should run from source.

**Anthropic API key (optional).** AI plan and streaming review need an Anthropic key; everything else works without one. Paste it in Settings on first launch — in the desktop app, it lives in your login Keychain, not in any config file. Skip the prompt with "Skip — use rule-based only" if you only want the rule-based plan.

**GitHub token (optional).** Loading a PR by URL needs a GitHub PAT, one per host. Shippable will prompt for it the first time you paste a PR URL. Use `repo` scope for private repositories; any valid token works for public PRs. In the desktop app, tokens are stored in Keychain.

## Connect an agent over MCP

The `shippable` MCP server ([`mcp-server/`](./mcp-server/README.md)) wires the review loop to a coding agent both ways.

Build it (if you already ran `npm run setup`, you can skip `npm install`; the build produces `mcp-server/dist/index.js`):

```sh
cd mcp-server && npm install && npm run build
```

Register it with your agent. For Claude Code:

```sh
claude mcp add shippable -- node /absolute/path/to/mcp-server/dist/index.js
```

For Cursor, Cline, Claude Desktop, or OpenCode, add the same command to the harness's MCP config JSON (`command: "node"`, `args: ["/absolute/path/to/mcp-server/dist/index.js"]`). See [`mcp-server/README.md`](./mcp-server/README.md) for the per-harness list and the tool reference.

Then drive the loop with three phrases:

- **`report back to shippable`** — the agent posts its findings as comments anchored to the right lines in your diff.
- **`check shippable`** — the agent pulls the feedback you've written, once.
- **`watch shippable`** — the agent keeps watching for your feedback live until you interrupt it.

The MCP defaults to port 3001 and auto-discovers the desktop app's port, so it works against the DMG or a from-source run with no config. If you run the app on a non-default `PORT`, set `SHIPPABLE_PORT` to the same value.

## Developing locally

Two packages, both required — the web app probes `/api/health` at boot and refuses to load if the server isn't running.

```sh
# terminal 1 — server (http://127.0.0.1:3001)
cd server && npm install && npm run dev

# terminal 2 — web (http://localhost:5173)
cd web && npm install && npm run dev
```

Node 22 (see `web/.nvmrc`). Symbol navigation needs an LSP installed locally — see [`docs/lsp-setup.md`](docs/lsp-setup.md). Building the desktop DMG is covered in [`docs/RELEASE.md`](docs/RELEASE.md).

## More docs

[`docs/overview.md`](docs/overview.md) walks through what the product does today and what it doesn't; [`IDEA.md`](IDEA.md) is the original problem statement.

For everything else — quality checks, code style, architecture, deployment modes, where ideas live — read [`AGENTS.md`](AGENTS.md). The full HTTP surface lives in [`server/src/index.ts`](server/src/index.ts); request/response shapes are typed in [`web/src/types.ts`](web/src/types.ts). The architecture map is in [`docs/architecture.md`](docs/architecture.md).
