# Plan diagram

## 1. Product reasoning & priority

The plan diagram is the visual translation of the structure map: a Mermaid
flowchart of files in the diff, edges between them where one defines a symbol
the other references, and dimmed context nodes for unchanged repo files the
diff reaches into. It tries to answer "what's the blast radius?" at a glance,
something the file list and entry-point ranking can't show — a long flat list
hides the dependency shape. It's currently a click-to-generate disclosure
inside the plan overlay, not an always-on view
(`web/src/components/ReviewPlanView.tsx:573-577, 638-643`), which keeps it
honest about its supporting role.

Suggested priority: **nice-to-have.** Useful, especially on multi-file PRs that
add a new module, but the rule-based map + entry points already cover the
must-have orientation. Worth keeping for reviews where the topology matters;
not worth blocking 0.1.0 on.

## 2. Acceptance criteria for a rebuild

- A diagram is built from a `ReviewPlan` plus an optional `CodeGraph` via
  `buildPlanDiagram(plan, graph?, options?)`
  (`web/src/planDiagram.ts:74-186`). Without a `graph` it falls back to
  edges derived from the structure map's symbol references
  (`planDiagram.ts:198-231`).
- Every node is a file from the plan; every edge has a `kind` (`imports`,
  `references`, `tests`, `uses-hook`, `uses-type`)
  (`planDiagram.ts:301-313`).
- Nodes carry `role: "changed" | "context"` (`planDiagram.ts:22-25`).
  Context nodes are dimmed in the SVG.
- Entry-point nodes get a thicker stroke (`planDiagram.ts:356-368`).
- Markdown files (`.md`, `.mdx`) are excluded by default; a toggle folds them
  back in (`planDiagram.ts:57-72, 83-86`).
- The rendered Mermaid is valid vanilla `flowchart` (no `defaultRenderer: elk`)
  so it round-trips through mermaid.live (`planDiagram.ts:280-283`).
- Each node has a `click <id> call __shippableDiagramClick("<path>") "<tip>"`
  directive; clicks dispatch through `onNavigate({ kind: "file", path })`
  (`web/src/components/PlanDiagramView.tsx:239-252, 69-72`).
- The Mermaid source is copyable
  (`PlanDiagramView.tsx:155` — `CopyButton`).
- Server-resolved edges come from `POST /api/code-graph` with per-file LRU and
  per-workspace invalidation on worktree state drift
  (`server/src/codeGraph.ts:155-204`).
- The `/api/code-graph` endpoint accepts `{ workspaceRoot, ref, scope: "diff"
  | "repo", files }` and returns `{ graph, sources }` listing per-language
  resolver — `"lsp" | "regex"` (`server/src/codeGraph.ts:63-73, 211-266`).
- Diff-scope graphs cap context nodes at 25, ranked by incoming-edge count
  (`server/src/codeGraph.ts:44-46, 650-666`).
- LSP unavailable for a language → fall through to regex per file, no error
  (`server/src/codeGraph.ts:333-352`).

## 3. Existing architecture & system design

### Data model

- `PlanDiagram = { scope, mermaid, nodes: PlanDiagramNode[], edges:
  PlanDiagramEdge[], markdownCount }` (`web/src/planDiagram.ts:47-55`).
- `PlanDiagramNode` carries `id`, `fileId`, `path`, `status`, `isTest`,
  `isEntryPoint`, `role`, `pathRole`, `fileRole`, optional `shape`,
  optional `symbols`, optional `fanIn`, plus `column` / `row` for layout
  (`planDiagram.ts:12-37`).
- `CodeGraph = { scope: "diff" | "repo", nodes: CodeGraphNode[], edges:
  CodeGraphEdge[] }` (in `web/src/types.ts`). Edge `kind` is one of
  `imports | references | tests | uses-hook | uses-type`.
- `SymbolShape` is a per-file tally (`classes`, `interfaces`, `methods`,
  `properties`, `functions`, `types`, `enums`, `constants`, `variables`,
  `modules`, `namespaces`) computed from LSP `documentSymbol` results
  (`server/src/codeGraph.ts:103-143`).
- `FileRole` is a path-floor + LSP-shape classifier output
  (`web/src/fileRole.ts`); 14 roles, each with a colour/style mapping in
  `planDiagram.ts:284-299`.

### Current architecture decisions

- **Server-resolved graph, client fallback.** `POST /api/code-graph` uses real
  LSP `documentSymbol` + `references` per file
  (`server/src/codeGraph.ts:354-394`); per-language capability gating falls
  through to the regex builder (`buildRepoCodeGraph` in
  `web/src/codeGraph.ts`) when no LSP is on `PATH`
  (`server/src/codeGraph.ts:333-352`).
- **Per-file LRU + workspace invalidation.** Cache keyed on `(workspaceRoot,
  ref, language, file, contentHash)`, capped at 2000 entries
  (`server/src/codeGraph.ts:40-46, 155-209`). Worktree fingerprint drift
  invalidates via `invalidateCodeGraphForWorkspace`
  (`docs/plans/lsp-code-graph.md:170-181`).
- **Context nodes capped at 25.** Diff-scope graphs surface unchanged repo
  files referenced by changed files as `role: "context"` nodes; the cap is
  ranked by incoming-edge count to prefer the most-called neighbours
  (`server/src/codeGraph.ts:44-46, 650-666`).
- **Worktree warm-up.** `warmCodeGraph` fires on worktree mount so
  intelephense's initial index lands during "worktree opening…" rather than
  first-render (`docs/plans/lsp-code-graph.md:177`).
- **Demo stays regex-only.** `web/src/components/Demo.tsx` intercepts
  `/api/code-graph` and serves a regex-built graph; the demo route never
  hits the server (`docs/plans/lsp-code-graph.md:177`).
- **Mermaid is presentation only.** The renderer hand-rolls the SVG-injection
  + click-handler binding (`PlanDiagramView.tsx:79-101`). Mermaid is loaded
  via `ensureMermaidReadyForTrustedDiagram` (a lazy gate). Tooltips are
  truncated to one line because Mermaid renders them as SVG `title`
  (`PlanDiagramView.tsx:9-29`).
- **Static "Diagram tabs".** Class / State / Sequence / ER tabs render as
  disabled placeholders (`PlanDiagramView.tsx:183-237`) with explanatory
  tooltips for what each would require.

### How it evolved

The diagram started as a Mermaid emit from the structure map's symbol
references — pure-client, no server (the fallback path at
`planDiagram.ts:198-231` is what's left of that).

The first real iteration added an LSP path: `docs/plans/plan-symbols.md` lays
out a multi-tier resolver chain (user LSP → bundled LSP → tree-sitter → grep)
with a per-language registry. Most of that plan is about the click-through
*definition* navigation; the diagram is a downstream consumer of the same
infrastructure.

`docs/plans/lsp-code-graph.md` is the iteration that actually ships LSP edges
to the diagram. The status line at the top of that doc — "shipped (Tier 1a,
discovery-on-PATH)" — pegs the implementation: PHP via intelephense (preferred)
or phpactor, JS/TS via `typescript-language-server`, with regex fallback per
file. Notable iteration moves recorded in `lsp-code-graph.md:170-189`:

- Originally the plan said `parseDiff` would become async; it stayed sync
  because four of six callers don't have a worktree (the deviation note in
  "What landed").
- Originally cross-boundary edges were dropped to keep the graph "diff only";
  the iteration kept them and added the 25-node context cap with
  incoming-edge ranking. This is the change that lets the diagram show
  blast radius into unchanged repo files.
- Originally `documentSymbol` was the bulk RPC; `workspace/symbol` was
  considered and rejected as inconsistently supported.

### Gaps

- **Tabs are inert.** Class / State / Sequence / ER are placeholders; none of
  the data needed (method/field shapes per class, control flow, call traces,
  schema parses) is collected today.
- **Diff-scope only, by default.** The `scope: "repo"` path exists and
  populates from `git show` (`server/src/codeGraph.ts:723-754`) but no UI
  surfaces it — there is no "show whole repo around this diff" toggle.
- **No browser-hosted resolver.** `docs/plans/plan-symbols.md` § "memory-only
  PHP analysis" outlines `php-wasm` + `nikic/php-parser` as the deferred
  path for security-constrained deployments. Today the diagram simply hides
  when no workspace is on disk.
- **Phpactor parity is untested in CI.** The E2E suite runs against
  intelephense only (`lsp-code-graph.md:185-187`).
- **`didClose` is plumbed but unused.** Documents accumulate per workspace
  client until `dispose()`; memory pressure on large repos is on the
  follow-ups list (`lsp-code-graph.md:188`).
- **Mermaid tooltip is one line.** Description + shape tally is truncated by
  SVG `title` semantics (`PlanDiagramView.tsx:9-13`). Reviewers can't see
  the full role description without a hand-rolled tooltip layer.

## 4. Rebuild opportunities

### Data unification

- `CodeGraphNode.fileRole` (LSP-shape-classified) and
  `StructureMapFile.isTest` overlap. The plan-diagram path re-classifies
  in the renderer when the source graph predates server enrichment
  (`planDiagram.ts:140-142`). A single `FileFacts` shape (role, isTest,
  added, removed, shape, symbols) would let plan + diagram + entry-point
  picker read one type.
- Edges in `CodeGraph` and `Symbol.referencedIn` in `StructureMap` carry the
  same information at different granularity. Today `buildPlanDiagram` falls
  back from one to the other (`planDiagram.ts:82-86`). Promoting symbol
  references to first-class edges in `StructureMap` would let the diagram
  always read from one source.
- `CodeGraph` and the symbol graph behind guide suggestions
  (`docs/concepts/symbol-graph-and-entry-points.md`) are functionally the
  same graph at different layers (one from LSP, one from `definesSymbols` /
  `referencesSymbols`). Reusing the LSP-derived graph to drive guides
  (instead of the regex backfill in `web/src/plan.ts:80-100`) would lift
  cross-language guide accuracy for free.

### Better architecture

- **Move the FileRole / SymbolShape classifier to the server.** Today the
  renderer can re-run `classifyFileRole` because the source graph might be
  pre-enrichment (`planDiagram.ts:140-142`). Once the server always emits
  enriched nodes, the renderer drops the fallback and the dual code path
  goes away.
- **Promote diagram tabs to real features one at a time.** Class diagram
  needs the per-symbol field/method tally — already partially in
  `SymbolShape`. The lift is one server prompt change.
- **Make scope a first-class plan parameter.** `scope: "diff" | "repo"` is on
  the request but not exposed in the UI; a "show repo" toggle in the
  diagram header would surface what's already implemented.
- **Cache the rendered SVG too.** Mermaid render is currently per-toggle
  (`PlanDiagramView.tsx:79-101`); the SVG would be cacheable on the same
  `(plan, graph, includeMarkdown)` key.
- **Tooltip overlay.** Replace the SVG-`title` constraint with a small
  positioned div bound to the same Mermaid click directive parsing path
  (`PlanDiagramView.tsx:239-252`).

## Sources

- `/workspace/docs/concepts/symbol-graph-and-entry-points.md`
- `/workspace/docs/plans/plan-symbols.md` (lines 1-100, 304-356) —
  multi-tier resolver chain
- `/workspace/docs/plans/lsp-code-graph.md` (status + "What landed" at
  lines 170-189)
- `/workspace/web/src/planDiagram.ts:12-55, 74-186, 198-231, 280-379`
- `/workspace/web/src/components/PlanDiagramView.tsx:1-295`
- `/workspace/web/src/components/ReviewPlanView.tsx:62-70, 537-602,
  605-694` — overlay wiring of the diagram disclosure
- `/workspace/server/src/codeGraph.ts:40-46, 103-153, 155-209, 211-266,
  308-394, 470-532, 559-666, 723-754`
- `/workspace/server/src/index.ts:99-101` — `POST /api/code-graph` handler
- `/workspace/docs/architecture.md:19` — endpoint summary
