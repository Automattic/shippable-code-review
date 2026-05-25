# Click-through Definitions

## 1. Product reasoning & priority

A reviewer staring at a 600-line diff cannot evaluate whether `validateOrder(...)` is being called correctly without knowing what `validateOrder` actually does. Cmd+clicking an identifier and seeing the definition — either by jumping inside the diff or by peeking at the unchanged file — is the most basic affordance an IDE-grade review tool needs. Without it, reviewers either paste the symbol into their editor (defeating the "tool that accompanies you" pitch in `IDEA.md`) or rubber-stamp the call site. The architecture also has positive externalities: the same per-language `LanguageModule` shape powers the LSP-resolved code graph (`docs/plans/lsp-code-graph.md`), and the dispatcher tier model (`docs/plans/plan-symbols.md`) is what unlocks GitHub PR review without a local clone.

Suggested priority: **must-have** — review-by-keyboard-only is hollow if every symbol is a dead-end click.

## 2. Acceptance criteria for a rebuild

- Highlighted Shiki tokens carry `data-symbol` + `data-token-col` attributes; a delegated click on the line text reads them plus the line's source line number and calls `onSymbolClick({ symbol, file, language, line, col })` (`web/src/components/DiffView.tsx:1085-1126`).
- The dispatcher resolves in this order (`web/src/components/ReviewWorkspace.tsx:1472-1568`):
  1. **In-diff symbol index.** If the symbol is defined by a hunk in the same changeset (`buildSymbolIndex` from `web/src/symbols.ts:5`), `SET_CURSOR` to that hunk. No server, no LSP.
  2. **Server LSP** via `POST /api/definition`. Returns one of `{ status: "ok", definitions[] }`, `{ status: "unsupported", reason }`, or `{ status: "error", error }`.
  3. **Peek panel** otherwise — `DefinitionPeekState` carries `loading | results | unsupported | error | idle`.
- Capability discovery via `GET /api/definition/capabilities`, called once on mount in `ReviewWorkspace.tsx:890`. Response shape: `{ languages: DefinitionLanguageCapability[], requiresWorktree: true, anyAvailable }` (`web/src/definitionTypes.ts:67`). Each language entry: `{ id, languageIds, available, resolver, source, reason?, recommendedSetup[] }`.
- Capability fallback rules:
  - No worktree on the changeset and no `SHIPPABLE_WORKSPACE_ROOT` → "Load the diff from a local worktree…" (`ReviewWorkspace.tsx:1480`).
  - Language has no module → "No language module handles `<lang>` yet. Supported: …" (`ReviewWorkspace.tsx:1489`).
  - Language has a module but the LSP binary wasn't discovered → `reason` from `unavailableReason()` ("No PHP language server discovered. Try one of: …") (`server/src/lspClient.ts:99`).
  - Programming-language files outside the supported set show a `def: …` chip; non-programming files (markdown / json / yaml) show nothing (`web/src/definitionTypes.ts:88-107`).
- Workspace root must be absolute, must not contain `..`, must exist, must be a git checkout — validated in `server/src/definitions.ts:157-178`.
- Files accessed via the LSP must be inside the workspace root — `assertInsideRoot` (`definitions.ts:181`).
- LSP server lifecycle: spawn once per `(workspaceRoot, languageModule)`, cache in `clientCache` (`server/src/lspClient.ts:45`). `initialize` is awaited before any request; `textDocument/didOpen` is idempotent per URI; the same client is shared between definition lookup and the code-graph endpoint.
- Response normalisation: handle both `Location` (`{ uri, range }`) and `LocationLink` (`{ targetUri, targetSelectionRange }`) shapes (`lspClient.ts:380`); compute a workspace-relative path; read a small preview (±2 lines) for the peek panel (`definitions.ts:225`).

## 3. Existing architecture & system design

### Data model

- `DefinitionRequest { file, language, line, col, workspaceRoot? }` — `web/src/definitionTypes.ts:9`. Sent from frontend.
- `DefinitionResponse = { status: "ok", definitions: DefinitionLocation[] } | { status: "unsupported", reason } | { status: "error", error }` — `definitionTypes.ts:29`.
- `DefinitionLocation { uri, file, workspaceRelativePath, line, col, endLine, endCol, preview, resolver }` — `definitionTypes.ts:17`.
- `DefinitionCapabilities { languages, requiresWorktree: true, anyAvailable }` — `definitionTypes.ts:67`. Always reports `requiresWorktree: true` — explicit signal that no browser-only path exists.
- `DefinitionLanguageCapability { id, languageIds, available, resolver, source, reason?, recommendedSetup[] }` — `definitionTypes.ts:56`. `source` is one of `configured | path | node_modules | vendor | bundled`.
- `LanguageModule { id, languageIds, extensions, lspLanguageIdByExtension, discover(), recommendedSetup }` — `server/src/languages/types.ts:20`.
- `LspClient` — `server/src/lspClient.ts:112`. Holds `proc`, `pending` map (id → resolver), `openedDocuments` set, `capabilities` (`documentSymbolProvider` / `referencesProvider` / `definitionProvider`).
- `SymbolIndex = Map<symbol, Cursor>` — `web/src/symbols.ts:3`. Built once per changeset; the in-diff Tier-0 floor.

### Current architecture decisions

- **Server-hosted LSP, not browser-hosted.** Real LSPs need `rootUri` pointing at a filesystem; the browser has no filesystem. The frontend posts to `POST /api/definition` and never speaks LSP directly (`docs/concepts/lsp.md:22-26`).
- **Per-language module shape.** Each module declares extensions, LSP language ids per extension, a discovery probe, and recommendedSetup. Adding a language is supposed to be one new file in `server/src/languages/` (`docs/concepts/lsp.md:26`).
- **TS via `typescript-language-server`** (`server/src/languages/typescript.ts`). Discovery probes `SHIPPABLE_TYPESCRIPT_LSP` then `PATH` then `node_modules/.bin`.
- **PHP via `intelephense` then `phpactor`** (`server/src/languages/php.ts`). Discovery probes `SHIPPABLE_PHP_LSP` (with basename-based args inference) then `intelephense` on `PATH` / `node_modules/.bin` then `phpactor` on `PATH` / `vendor/bin`.
- **Shared `LspClient`** is the only thing that speaks JSON-RPC framing. It supports `definition`, `documentSymbol`, `references`, `closeDocument`, `dispose`, `capability(name)`. `references` filters trivial self-references client-side because some servers ignore `includeDeclaration: false` (`lspClient.ts:210`). The client multiplexes — the `pending` map plus stable id allocation lets N concurrent requests run in flight (validated by `lspClient.test.ts` per `docs/plans/lsp-code-graph.md:174`).
- **Capability discovery is per-call.** `getDefinitionCapabilities` calls `module.discover()` synchronously on every `/api/definition/capabilities` request (`server/src/definitions.ts:34`) — fine because `findExecutable` does only `fs.statSync` / `fs.accessSync` (`server/src/languages/discovery.ts:77`). No long-lived "watch PATH for new binaries" loop.
- **Workspace root resolution.** Comes from `request.workspaceRoot` first, falls back to `process.env.SHIPPABLE_WORKSPACE_ROOT` (`definitions.ts:157`). The frontend passes the worktree path from the changeset's `worktreeSource` (`ReviewWorkspace.tsx:880-882`).
- **In-diff floor.** `buildSymbolIndex` pre-walks every hunk's `definesSymbols` and seats it on the first line containing the name (`symbols.ts:5-26`). The dispatcher checks this first — so a click on `compare_tokens` jumps to the line in the same diff without ever touching the LSP.

### LSP request flow

A click that misses the in-diff index walks this path:

1. `DiffLineText.activateSymbol` reads `data-symbol` + `data-token-col` from the closest `[data-symbol]` ancestor, computes `line = sourceLine - 1` (zero-indexed for LSP) and calls `onSymbolClick` (`DiffView.tsx:1098-1112`).
2. `ReviewWorkspace.handleSymbolClick` checks `SymbolIndex` first. Miss → checks `currentWorkspaceRoot`, then `definitionCapability`, then `canUseServerDefinitions`. Each gate has a distinct unsupported message (`ReviewWorkspace.tsx:1480-1518`).
3. `fetchDefinition` POSTs `{ file, language, line, col, workspaceRoot }` to `/api/definition`. The body is JSON; the route handler in `server/src/index.ts:342-364` parses, calls `resolveDefinition`, and surfaces `200` for `ok`/`unsupported` and `502` for `error`.
4. `resolveDefinition` (`server/src/definitions.ts:66`) validates the request, picks a language module (by `request.language` if provided, else by file extension), resolves and validates the workspace root, ensures the file exists and is inside the root.
5. `getLspClient(workspaceRoot, module)` returns the cached client or creates one — `LspClient.create` spawns the process, sends `initialize`, waits for the capabilities response, sends `initialized`. The promise is cached so concurrent callers collapse; failure drops the cache slot so the next call retries (`lspClient.ts:53-74`).
6. `client.definition(...)` sends `textDocument/didOpen` (idempotent per URI), then `textDocument/definition` with `{ uri: file:// , position: { line, character } }`. The pending map (`lspClient.ts:114`) resolves the matching response by id.
7. `normalizeLocation` (`definitions.ts:192`) collapses `Location` / `LocationLink` into `DefinitionLocation`, converts URIs to absolute paths, computes the workspace-relative version, and reads the ±2-line preview from disk.
8. On the way back, the dispatcher tries to resolve each returned definition to an in-diff `Cursor` via `resolveDefinitionToCursor`. If any hit, jump. Otherwise show the peek panel with all candidates.

### How it evolved

- `docs/concepts/lsp.md` is the canonical "how a click resolves" doc — the JSON-RPC dance, why the LSP indexes the project, why we host it server-side.
- `docs/lsp-setup.md` is the user-facing install table — per-language one-line installs, env-var overrides, the `def: …` chip semantics.
- `docs/plans/plan-symbols.md` is the architecture plan in full. The status block at the top is honest: "partially implemented first slice" — Tier 1a on disk only, JS/TS + PHP. The deferred path (memory-only, browser resolvers, `GitHubWorkspace`, tree-sitter Tier 2, grep Tier 3) is laid out in detail so v0.1.0 doesn't paint itself into a corner.
- `docs/plans/lsp-setup-script.md` describes the planned `npm run setup:lsp` that walks the same `recommendedSetup` data and one-shots every language install.
- `docs/plans/lsp-php.md` documents PHP as the second-language case study. Tier 1a shipped; Tier 1b (bundled inside the sidecar) is the open follow-up — gated on the intelephense licensing question.
- `docs/plans/lsp-code-graph.md` is the second consumer of the same `LanguageModule` plumbing. It pulled `LspClient` out of `definitions.ts` and added `documentSymbol` / `references` (`docs/plans/lsp-code-graph.md:173`). It also added the per-file LRU keyed on `(workspaceRoot, ref, language, file, contentHash)` with workspace-fingerprint invalidation.

### State machine for the peek panel

`DefinitionPeekState` (`ReviewWorkspace.tsx:301`) is a tagged union: `idle | loading | results | unsupported | error`. The `scopeKey` on each state is `${cs.id}:${file.id}:${currentWorkspaceRoot ?? ""}` (`ReviewWorkspace.tsx:883`) — the panel auto-dismisses when scope changes (different file, different changeset, different worktree). The dispatcher does not race two requests; on click it overwrites the state synchronously. Tests for each branch live in `ReviewWorkspace.test.tsx:261-740`.

### Gaps

- **Worktree is a hard requirement.** `requiresWorktree: true` is baked into the capability response. Pasted / URL / file-upload changesets cannot click-through, even though the symbol index already provides Tier-0 in-diff jumps. The peek panel shows "Load the diff from a local worktree…" instead.
- **No Tier 2 (tree-sitter) or Tier 3 (grep) on the server.** The chain is `in-diff index → LSP → nothing`. Plan-symbols Step 6 / Step 2 specify Tier 2 / Tier 3 but they're not built. Result: a click on a Go or Rust symbol with no Go/Rust LSP shows "no language module handles go."
- **No browser-hosted resolver.** Plan-symbols Step 5 (TS via `@typescript/vfs`, then PHP via `@php-wasm`) is not implemented. This means GitHub PR review without a server-side clone has zero click-through, and the runner's PHP worker (already loaded) is not reused for analysis.
- **Languages.** TS + JS + PHP only. Python (pyright), Go (gopls), Rust (rust-analyzer), Ruby — all gaps.
- **No "find references" / hover / rename.** Plan-symbols explicit non-goal for v1 — but the `LspClient` already implements `references`, so the cost to expose a "who calls this?" peek is small.
- **`memory-only` mode.** The whole deployment matrix bottom row (no clone on disk) is deferred. Plan-symbols carries the contract (`materialization: "memory-only"`) but no resolver runs there. For PR review under tight security posture this is a hard blocker — see `IDEA.md` ("review code easily locally, regardless of your remote").
- **Capability discovery is one-shot.** Mounted once in `ReviewWorkspace.tsx:890`. If the user installs intelephense mid-session there's no refresh button — they have to restart the app.
- **No `GET /api/file` endpoint.** Plan-symbols' `BrowserLocalWorkspace` would need it; today the frontend never reads files outside the diff.
- **Trust model.** The server spawns whatever binary the user pointed `SHIPPABLE_*_LSP` at — fine, matches VS Code's stance, but plan-symbols flags this is "worth being explicit about" (`docs/plans/plan-symbols.md:411`). No UI confirmation step today.

## 4. Rebuild opportunities

### Worktree dependency is real but soft

`requiresWorktree: true` is correct as a server posture today (the LSP needs `rootUri` on disk) but oversells the constraint to the frontend. There are three signals here that the UI conflates:

- **No workspace root available at all.** Pasted / URL diff. The chip should read "in-diff only" and the SymbolIndex still works.
- **Workspace root available but the file isn't in it.** Stale clone, sibling worktree, file deleted on disk. The current check (`assertInsideRoot` in `definitions.ts:181`) returns "requested file escapes workspace root" — meaningful to a dev, confusing to a reviewer.
- **Workspace root available, file there, but no LSP installed.** Today's recommendedSetup is shown verbatim — fine but unstructured.

A rebuild should separate these three. The chip could carry sub-state ("def: TS LSP" vs "def: in-diff only" vs "def: file not in worktree") instead of a binary available/unavailable.

### Data unification

- **The `LanguageModule` is already the unification.** The same module table powers definition lookup *and* code-graph edge resolution (`docs/plans/lsp-code-graph.md` "Capability gating"). When Python / Go land, they extend both features in one motion. Don't fragment this.
- **`SymbolIndex` (in-diff) vs LSP `documentSymbol` (worktree-aware).** Today they're two parallel paths — `web/src/symbols.ts` walks `hunk.definesSymbols` (which itself is regex-derived during diff parse); the LSP path is invoked only when the in-diff lookup misses. They could converge: the LSP's `documentSymbol` response *is* a superset of the in-diff data, and `web/src/codeGraph.ts`'s regex resolver already overlaps. The boring move is to use LSP `documentSymbol` to populate `SymbolIndex` when a worktree is mounted, leaving the regex path as the no-worktree fallback. Symbol metadata stops being computed twice.
- **Capability flag pattern unification.** `DefinitionCapabilities.requiresWorktree` (`definitionTypes.ts:69`) is the same shape the AGENTS.md "workspace mode" gate uses (`materialization`, `readPosture`). Code-runner could declare a similar capability ("PHP runtime available: yes/no, JS sandbox: yes/no") so the UI hides affordances cleanly across both features via one consistent mechanism.
- **Definition responses → Interactions for "I jumped here."** Not for v1, but: every jump is a reviewer signal ("the reviewer wanted to know what `validateOrder` does"). Logged as low-noise `Interaction`s with `authorRole: user`, intent `comment`, they feed the agent context channel — agents can see *what the reviewer cared about*, not just what they wrote. The runner verdict has the same shape; both could share a `verifiedBy` body schema on an Interaction.

### Better architecture

- **Build Tier 0 in-diff jumps everywhere.** The `SymbolIndex` lookup at `ReviewWorkspace.tsx:1473-1478` already runs without a worktree. The `def: …` chip should advertise this even when the LSP is unavailable — "in-diff only" is a real, useful, non-fake precision level. Today the chip silently disappears on pasted diffs.
- **Implement Tier 3 (grep) as the always-answers floor** (Plan-symbols Step 2). It's ~50 lines. Cheap. Lets a click on any symbol — Go, Python, Lisp — produce *something* with `precision: "fuzzy"` and a peek showing all candidates. Honest about being fuzzy; never silently broken.
- **Move capability discovery to a long-lived watcher** with a `POST /api/definition/refresh` poke. Today re-discovery requires a server restart. The cost is one `fs.watch` per `recommendedSetup` install location.
- **Reuse `LspClient` for hover.** The `textDocument/hover` flow is the same plumbing — `initialize` + `didOpen` already done; one new method. A peek-on-hover affordance is the highest-leverage follow-on for the smallest code addition.
- **Boring: ship the bundled LSPs.** `docs/plans/lsp-php.md` "Tier 1b" — `bun build --compile` already produces a sidecar binary, intelephense is a single JS file, phpactor is a phar. Confirm the licence, drop them next to the sidecar, the existing `findExecutable` discovery chain ("bundled" source) already covers the case (`server/src/languages/discovery.ts:65`).
- **Sketch the `GET /api/file` endpoint** even before the browser resolvers land — the peek panel currently has a `preview` blob baked into the definition response (`server/src/definitions.ts:225`); a richer "show me the surrounding 200 lines" affordance would need it, and it's the same endpoint plan-symbols would re-use for `BrowserLocalWorkspace`.
- **Push the workspace-relative path everywhere the frontend has it.** Today `currentWorkspaceRoot` is computed locally in `ReviewWorkspace.tsx:880-882`; the same value would naturally power "open in editor" intent and runner-worktree-context (see code-runner gaps). One source of truth instead of three.
- **Move the chip's "anyAvailable" check from boolean to per-file.** The current `def: TS LSP` chip is per-language but global; a file whose extension isn't covered just shows the wrong chip or nothing. The capabilities response should be evaluated against the *current file* — same data, smarter rendering. `findCapabilityForLanguage` is already in place (`definitionTypes.ts:74`) but the chip doesn't consume it that way.
- **Add per-changeset capability seeding so the chip doesn't flash.** Today the chip is empty until `fetchDefinitionCapabilities` resolves (`ReviewWorkspace.tsx:890-910`). The same data could be seeded by the worktree-load endpoint when the path is selected — the server already knows which LSP modules apply.

## Sources

- `web/src/definitionTypes.ts` — wire contracts (`DefinitionRequest`, `DefinitionResponse`, capability shapes, `findCapabilityForLanguage`, `isProgrammingLanguage`).
- `web/src/definitionNav.ts` — client wrappers for the two endpoints.
- `web/src/symbols.ts` — in-diff symbol index (Tier 0).
- `web/src/components/DiffView.tsx:1085-1126` — token-level click handler reading `data-symbol` / `data-token-col`.
- `web/src/components/ReviewWorkspace.tsx:880-910, 1472-1569` — capability fetch + dispatcher + peek state machine.
- `server/src/index.ts:2, 93-96, 332-364` — endpoint wiring.
- `server/src/definitions.ts` — capability discovery, workspace-root validation, request resolution, location normalisation, preview generation.
- `server/src/lspClient.ts` — JSON-RPC framing, lifecycle, `definition` / `documentSymbol` / `references`, capability advertisement, location normalisation.
- `server/src/languages/index.ts` — language registry helpers.
- `server/src/languages/typescript.ts` — TS module.
- `server/src/languages/php.ts` — PHP module with env-based phpactor/intelephense args inference.
- `server/src/languages/types.ts` — `LanguageModule` shape.
- `server/src/languages/discovery.ts` — `findExecutable`, `classifyProjectBin`.
- `docs/concepts/lsp.md` — protocol explainer, tier table, "what we do *not* do."
- `docs/lsp-setup.md` — install table, env var overrides, chip semantics.
- `docs/plans/plan-symbols.md` — full architecture plan, dispatcher, deployment matrix, deferred memory-only path.
- `docs/plans/lsp-php.md` — Tier 1b (bundled) plan.
- `docs/plans/lsp-setup-script.md` — planned `npm run setup:lsp`.
- `docs/plans/lsp-code-graph.md` — second consumer of `LspClient`; how `documentSymbol` / `references` landed.
- `docs/features/click-through-definitions.md` — user-facing description.
