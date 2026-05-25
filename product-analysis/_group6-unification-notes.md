# Group 6 — cross-cutting unification notes

Code-runner and click-through-definitions look unrelated. They aren't.

- **Both are tiered, capability-gated, worktree-aware features.** Click-through has an explicit `DefinitionCapabilities.requiresWorktree` flag and a tier story (in-diff index → server LSP → peek). Code-runner has the same shape implicitly (JS/TS sandbox available always, PHP requires WASM cold-load, AI verify needs a `runRecipe`). Modelling them with the same `Capability` shape is the boring move.

- **Both run a `LanguageModule`-style registry.** Click-through has it formally (`server/src/languages/{types,index,typescript,php}.ts`). Code-runner has it informally (a `switch (lang)` in `executeJs` / `executePhp` / `parseInputs`). A `LanguageRunner` interface alongside `LanguageModule`, both in `web/src/languages/<id>.ts`, makes adding Python one file for both features instead of three.

- **Both already have hand-rolled symbol/scope analysis** running in parallel to what the LSP could tell them. `web/src/symbols.ts` (in-diff symbol index) + `web/src/codeGraph.ts` (regex import builder) + `web/src/runner/parseInputs.ts` (regex param/var extractor) all do flavours of the same job. When a worktree is mounted, the LSP's `documentSymbol` is the single source — already shipped per `docs/plans/lsp-code-graph.md`. The regex paths should be the no-worktree fallback, not the default.

- **The runner's PHP worker is the sunk-cost asset for memory-only PHP definitions.** `docs/plans/plan-symbols.md:362` already calls this out — `@php-wasm/web-8-3` is in the bundle for the runner; an analyzer entrypoint over `nikic/php-parser` would give Tier 1c PHP click-through in browser-only / memory-only deployments. Same worker, different request.

- **Runner verdicts and definition jumps are both Interactions waiting to happen.** Today both are local-state-only — `RunResult` in `CodeRunner`'s `useState`, `definitionPeek` in `ReviewWorkspace`. The typed-review-interactions wire envelope (`docs/architecture.md` § Review interactions) is exactly the shape they should produce: runner verifies a claim → `reply-to-ai-note` with `intent: accept/reject` + body; reviewer clicks definition → low-noise context signal feeding the agent channel. One store, one seam, one wire.

- **Both need a `GET /api/file` endpoint.** Click-through's peek panel returns a tiny 5-line preview today (`server/src/definitions.ts:225`); the runner has no way to read worktree files when a snippet imports them. Same endpoint, two consumers — overdue.

- **Capability discovery is one-shot in both.** Click-through fetches caps once on mount; the runner doesn't even probe. A shared `POST /api/capabilities/refresh` + a `fs.watch` on the recommended install locations would let "I just installed pyright" land without restart.

- **The "boring tier" story matters in both.** Click-through has a fully-specced Tier 3 grep floor (`docs/plans/plan-symbols.md`) that always answers. The runner has no equivalent "fuzzy execution" floor and could probably afford "run as Bash via sidecar" or "dry-run via regex" before just refusing. Honesty over silence.
