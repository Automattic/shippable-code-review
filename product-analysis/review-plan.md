# Review plan

## 1. Product reasoning & priority

The review plan is the answer to "where do I start?" — the first screen a
reviewer sees after the diff loads. It carries a headline, 2-5 evidence-backed
intent claims, a structure map, and up to three entry points
(`docs/concepts/review-plan-model.md`). The evidence rule
(`docs/concepts/evidence-model.md`) is the load-bearing product invariant: every
AI-generated claim has to point at a real file, hunk, or symbol; the UI refuses
to render a citation-less claim (`web/src/components/ReviewPlanView.tsx:484`).
This is what differentiates Shippable from a "Claude summarises the PR" widget
— claims aren't prose, they're navigable assertions.

Suggested priority: **must-have.** The plan is the orientation surface; without
it you open a diff with no map and have to scroll. The rule-based fallback
keeps the feature working without an Anthropic key, so the cost of including it
is bounded.

## 2. Acceptance criteria for a rebuild

- A `ReviewPlan` is `{ headline, intent: Claim[], map: StructureMap,
  entryPoints: EntryPoint[] }` with `entryPoints.length <= 3`
  (`web/src/types.ts` / `docs/concepts/review-plan-model.md`).
- Every `Claim` renders only when `claim.evidence.length >= 1`
  (`web/src/components/ReviewPlanView.tsx:484`). The same invariant gates
  entry-point reasons (`ReviewPlanView.tsx:508, 627`).
- `EvidenceRef` is one of four kinds: `description`, `file` (by path), `hunk`
  (by hunkId), `symbol` (by name + definedIn) (`docs/plans/ai-plan.md:94-103`).
- The server validates every evidence ref against the loaded ChangeSet before
  returning; invalid refs are dropped, and claims left with zero refs are
  dropped too (`server/src/plan.ts:308-356`, `assemblePlan`).
- Headline is verbatim `cs.title` — never generated
  (`server/src/plan.ts:378`, `docs/plans/ai-plan.md:14-16`).
- Rule-based plan is the default render path
  (`web/src/PlanProvider.tsx:209-224`); AI plan replaces it once ready.
- AI request is single-shot via `POST /api/plan` with Anthropic's structured
  output (`zodOutputFormat`); SSE-style streaming is *not* used here (that's
  the prompt library / `/api/review`) (`server/src/plan.ts:173-187`).
- One in-session cache slot per `(cs.id, file-shape, commit-shas)`; revisits
  return instantly, reloads refetch (`web/src/PlanProvider.tsx:42-48`).
- Auto-fire on first sight of a ChangeSet when a key is configured; never
  aborted on CS switch (`docs/plans/ai-plan.md:52-58`).
- Regenerate is user-initiated, abort-on-switch
  (`web/src/PlanProvider.tsx:173-195`).
- Errors and `parsed_output: null` flip the cache slot to `status: "fallback"`
  and the overlay reverts to the rule-based map with an error banner
  (`docs/plans/ai-plan.md:107-113`).
- The server never falls back to `process.env.ANTHROPIC_API_KEY` — the key is
  asserted from the in-memory auth-store (`server/src/plan.ts:163-170`).

## 3. Existing architecture & system design

### Data model

In `web/src/types.ts`:

- `ReviewPlan = { headline; intent: Claim[]; map: StructureMap; entryPoints:
  EntryPoint[] }` (around the "ReviewPlan" type definition).
- `Claim = { text; evidence: EvidenceRef[] }`.
- `EvidenceRef = { kind: "description" } | { kind: "file", path } | { kind:
  "hunk", hunkId } | { kind: "symbol", name, definedIn }`.
- `EntryPoint = { fileId; hunkId?; reason: Claim }`.
- `StructureMap = { files: StructureMapFile[]; symbols: StructureMapSymbol[] }`.

Server-side Zod mirror lives in `server/src/plan.ts:20-68` (`EvidenceRefSchema`,
`ClaimSchema`, `EntryPointSchema`, `PlanResponseSchema`).

The structure map is built by `buildStructureMap(cs)` (`web/src/plan.ts:31-119`)
— pure function over the ChangeSet, imported by the server
(`server/src/plan.ts:15`) so both sides agree on the input the model sees.

### Current architecture decisions

- **Headline + map are deterministic, intent + entryPoints are model output.**
  Title verbatim; structure map a pure walk of `definesSymbols` /
  `referencesSymbols` on hunks plus a regex backfill for missed references
  (`web/src/plan.ts:50-100`).
- **Schema-constrained output.** `client.messages.parse()` with
  `zodOutputFormat(PlanResponseSchema)`; no `JSON.parse`, no model output
  outside the schema (`server/src/plan.ts:173-187`).
- **Prompt caching.** The system prompt is `cache_control: { type:
  "ephemeral" }`; the variable parts (structure map + diff) sit after
  (`server/src/plan.ts:176-183`, `docs/plans/ai-plan.md:85-89`).
- **Evidence validation is server-side.** `assemblePlan`
  (`server/src/plan.ts:303-356`) resolves every ref against `fileIds`,
  `filePaths`, `hunkIds`, `symbols`; invalid refs disappear, claims with no
  surviving refs disappear; entry-point `hunkId` is dropped if stale but the
  `fileId` is kept.
- **Truncate to 3.** Schema allows any-length `entryPoints` because the model
  sometimes overshoots; the server truncates to 3 after validation so the
  best-validated 3 survive (`server/src/plan.ts:65-68, 354`).
- **Cache lives client-side, in-session only.** `PlanProvider`
  (`web/src/PlanProvider.tsx:62-236`) holds a `Map<cacheKey, CacheEntry>`
  with two flight types — auto (never aborted) and regenerate (aborted on CS
  switch).
- **Fallback path is the rule-based plan.** `planReview(cs)`
  (`web/src/plan.ts:242-250`) returns the rule-based plan with empty `intent`
  (rule-based intent was removed — `web/src/plan.ts:121-124`); the overlay
  renders `description` instead. On fallback, the overlay banner explains and
  the rule-based map comes back into view
  (`web/src/components/ReviewPlanView.tsx:76-77, 96-104`).
- **Plus comprehension questions.** The same request also returns 2-10
  `Question` records with the same evidence-resolution discipline
  (`server/src/plan.ts:114-153, 357-376`); used by `QuizPanel`.
- **One PlanProvider per workspace.** Both the overlay and the file sidebar's
  priority ranking read from it without prop drilling
  (`docs/plans/ai-plan.md:48-51`).

### How it evolved

The plan started as a rule-only feature. `web/src/plan.ts:121-124` records the
removal of synthesised intent claims — "Defines X" / "Includes test files" —
because they just restated what the file list already showed. Without rule-based
claims the rule-only path renders the description as the answer to "what does
this change do?".

AI plan came in as a separate prototype path
(`docs/plans/ai-plan.md`) with structured output, evidence validation, and an
auto-fire model. The privacy decision used to be a "Send to Claude" click; it
moved to the key-configuration step plus the persistent header chip
("Auto-sending diff to Claude") (`docs/plans/ai-plan.md:109-113`).

The roadmap calls out multi-provider fan-out as the next move
(`docs/plans/ai-plan.md:69-79`): one Zod schema, multiple providers in parallel,
merge step votes claims up by agreement. Not implemented today; the seam is
shaped so the merge has somewhere to go.

### Gaps

- **`generatePlan` is monolithic.** All Anthropic-specific code lives in
  `server/src/plan.ts`; no provider interface yet — multi-provider work in
  `docs/plans/ai-plan.md:69-79` is greenfield.
- **No incremental refresh.** A worktree live-reload invalidates the cache via
  the `(file shape + commit shas)` key flip, but the plan is regenerated from
  scratch every time. There's no diff-of-diff path that updates only the
  claims that touched the changed lines.
- **Evidence kinds are closed.** Four kinds; no `commit`, no `line-range`,
  no `external-ref`. The "intent" claim about a refactor can't cite the
  commit that did it.
- **Rule-based intent is empty.** Without a key the user sees the description
  and the file list; no synthesised "what changed" line. The rule-based intent
  was deliberately removed but nothing replaced it.
- **`assemblePlan` silently drops claims.** No telemetry on drop rate; if the
  model hallucinates fields the user sees a thin plan and doesn't know why.

## 4. Rebuild opportunities

### Data unification

- The plan's `Claim` and the Inspector's AI `Interaction` are the same
  conceptual thing — "AI says X, here's the evidence." A unified
  `AnnotatedClaim` type with `EvidenceRef[]` plus an optional thread head
  would let the inbox view list plan claims alongside per-line AI notes
  without a second model.
- `EvidenceRef` and `Interaction.anchor*` overlap. Both say "this points at
  file + hunk/line." Reusing `EvidenceRef` as the anchor primitive on user
  comments would let "comment on this claim" be a real action.
- Guide suggestions
  (`docs/concepts/guide-suggestions.md`) also produce an
  `(fromHunk, toHunk, symbol)` triple that is structurally an EvidenceRef
  pair. A unified anchor would let claims, guides, and Interactions share
  the same `Reference` renderer.

### Better architecture

- **Provider seam now, providers later.** The refactor in
  `docs/plans/ai-plan.md:69-79` is mostly type work — extract a
  `PlanProvider` interface in `server/src/plan.ts`, move the Anthropic call
  to `providers/anthropic.ts`. Even with one provider, the seam is the right
  shape; multi-provider follows.
- **Drop telemetry on evidence resolution.** A counter for "claim dropped:
  bad hunkId" gives a visible signal when the model gets worse / the
  prompt drifts.
- **Move the plan cache to the server.** In-session client cache is fine for
  prototypes but a hosted backend will want to share plans across reviewers.
  The cache key (`cacheKey` in `PlanProvider.tsx:42-48`) is already
  content-derived and would work as a server cache key.
- **Stream the plan.** Structured output forbids streaming today; once the
  schema supports partials (or a hand-rolled NDJSON envelope is built),
  intent claims could land one at a time so the overlay doesn't wait on the
  full response.

## Sources

- `/workspace/docs/concepts/review-plan-model.md`
- `/workspace/docs/concepts/evidence-model.md`
- `/workspace/docs/plans/ai-plan.md`
- `/workspace/docs/architecture.md` (lines 12-26 — endpoints; 38-49 — model)
- `/workspace/web/src/plan.ts` (rule-based plan + `buildStructureMap`)
- `/workspace/web/src/PlanProvider.tsx:42-236` — cache, auto-fire,
  regenerate, abort
- `/workspace/web/src/usePlan.ts`
- `/workspace/web/src/components/ReviewPlanView.tsx:60-120, 475-495,
  507-510, 625-695` — overlay, evidence invariant, "Where to start"
- `/workspace/server/src/plan.ts:20-70, 173-196, 303-382` — schema,
  Anthropic call, `assemblePlan`
- `/workspace/server/src/index.ts:87-89` — `POST /api/plan` handler
