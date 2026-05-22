# Symbol Graph And Entry Points

## What it is
The repo’s way of turning changed code into a lightweight dependency map.

## What it does
- Collects symbol definitions and references from hunks.
- Derives extra edges from local imports / requires when real diffs do not ship explicit symbol metadata.
- Builds a structure map that connects defining files to referencing files.
- Uses that graph to pick starting points for review.
- Falls back to tests or biggest-change files when the symbol graph is weak.
- In worktree-backed mode, can be supplemented by a repo-scoped graph from the on-disk checkout so diagrams are not limited to changed files only.
- Cross-file edges in non-JS languages (PHP today, gopls / pyright / rust-analyzer next) come from real LSP `documentSymbol` + `references` lookups via `POST /api/code-graph`, with per-language capability gating that falls back to the regex builder when no LSP is on `PATH`. See `docs/plans/lsp-code-graph.md`.

## Downstream consumers
- **Review plan entry points** — `intent`/`map`/`entryPoints` are built from this graph. See [Review Plan Model](./review-plan-model.md).
- **Guide suggestions** — the in-diff "jump to definition" nudge is a thin projection over `referencesSymbols` / `definesSymbols` on each hunk. See [Guide Suggestions Model](./guide-suggestions.md).
