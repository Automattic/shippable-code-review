# Shippable

Local-first review for agent diffs and pull requests. When you're working with agents, dozens of meaningful diffs a day is normal — on your machine, and in the pull requests they land in. Reading them is harder than writing the code ever was. Shippable is the review pass designed to take less out of you, before the work disappears into a skimmed read or another agent run.

This is an early **prototype**. The code is throwaway as we work out the shape — don't use it in any production setting yet.

![shippable demo](docs/all.gif)

## Why you might want it

- **Every AI finding ties back to a line.** No floating summaries. A rule-based plan runs first so it still works without an API key; the model's findings get anchored to real symbols and hunks.
- **Reading and approving are different.** Three review states, not two — what you've actually read, what you've signed off, and what you've flagged for another pass. Threads capture a 10-line context window and content hash, so they survive the agent reshuffling its work.
- **A claim you can run is a test.** Highlight a hunk; the in-app sandboxed runner detects input slots and executes it — JavaScript, TypeScript, and PHP today. AI concerns can hand their snippet straight to the runner.
- **Built around git worktrees.** Per-task branches and folders, live-refreshing diffs, agent context inline. Most diff GUIs treat worktrees as an afterthought; we started there.

The longer story, with pictures, is on (tbd)
## Install

Download the latest macOS build:

→ **Shippable.dmg** - pending

The DMG is unsigned, so the first launch trips Gatekeeper — right-click the .app in Finder → Open → confirm once. Subsequent launches don't prompt. macOS only today; Linux and Windows are on the roadmap.

**Anthropic API key (optional).** AI plan and streaming review need an Anthropic key; everything else works without one. Paste it in Settings on first launch — it lives in your login Keychain, not in any config file. Skip the prompt with "Skip — use rule-based only" if you only want the rule-based plan.

**GitHub token (optional).** Loading a PR by URL needs a GitHub PAT, one per host. Shippable will prompt for it the first time you paste a PR URL. Use `repo` scope for private repositories; any valid token works for public PRs. Stored in Keychain on the desktop app, in server memory in dev.

## What you can do with it

- **Open a worktree.** Pick a checkout in the worktree picker and Shippable builds a changeset — at HEAD, a single ref, or across any SHA range. The diff refreshes live as the agent commits.
- **Load a pull request.** Paste an HTTPS PR URL into Load → From URL. Works with github.com and GitHub Enterprise. Read-only today; pushing review conclusions back as PR comments is next on the roadmap.
- **Get a review plan.** Rule-based by default; AI-augmented when you have a key. Every finding is anchored to a hunk you can click.
- **Verify by running.** Select a hunk or a block; the runner builds an input form and executes the snippet in a sandboxed worker. JavaScript, TypeScript, and PHP today.
- **Track three review states.** Lines your cursor passed (faded), explicit sign-offs, and things you've left flagged. State is durable — close the laptop, come back tomorrow, pick up where you left off. Threads re-anchor when the underlying code moves.
- **Connect to agents over MCP.** The `shippable` MCP server (in [`mcp-server/`](./mcp-server/README.md)) wires the loop both ways. Ask your agent to review a worktree and `report back to shippable` — its comments land anchored to the right lines in your diff, ready to read alongside the code. Going the other way, `check shippable` pulls feedback you've written back into the agent's context for another pass. Works with Claude Code, Codex CLI, Cursor, or any MCP-speaking harness.

[`docs/overview.md`](docs/overview.md) walks through what the product does today and what it doesn't; [`IDEA.md`](IDEA.md) is the original problem statement.

## Developing locally

Two packages, both required — the web app probes `/api/health` at boot and refuses to load if the server isn't running.

```sh
# terminal 1 — server (http://127.0.0.1:3001)
cd server && npm install && npm run dev

# terminal 2 — web (http://localhost:5173)
cd web && npm install && npm run dev
```

Node 22 (see `web/.nvmrc`). Symbol navigation needs an LSP installed locally — see [`docs/lsp-setup.md`](docs/lsp-setup.md). Building the desktop DMG is covered in [`docs/RELEASE.md`](docs/RELEASE.md).

For everything else — quality checks, code style, architecture, deployment modes, where ideas live — read [`AGENTS.md`](AGENTS.md). The full HTTP surface lives in [`server/src/index.ts`](server/src/index.ts); request/response shapes are typed in [`web/src/types.ts`](web/src/types.ts). The architecture map is in [`docs/architecture.md`](docs/architecture.md).
