# Group 4 — cross-cutting unification notes

- **One anchor type.** `EvidenceRef` (`web/src/types.ts`) carries
  `file | hunk | symbol | description`. `Interaction.anchor*`
  (`types.ts:597-604`) carries a near-duplicate set on user comments.
  `GuideSuggestion` carries a hunk+symbol pair. Diagram click payloads use
  `{ kind: "file", path }` (also `EvidenceRef`). One `Anchor` type would
  collapse four shapes; `Reference.tsx` already renders every `EvidenceRef`
  kind and would be the canonical renderer.

- **Claim / guide / AI Interaction are the same shape with one field
  swapped.** Plan claim = `{ text, evidence }`. Guide = same + a target
  cursor. AI Interaction = same + `id`, `threadKey`, `authorRole: "ai"`,
  `intent`, optional `runRecipe`. A unified `AnnotatedClaim` lets the inbox
  view list plan claims, AI notes, and unresolved guides in one stream —
  the `selectInteractions` seam is already shaped for it.

- **Dismissals are interactions in disguise.** `state.dismissedGuides:
  Set<string>` (localStorage) is structurally an `Interaction { intent:
  "ack" }` against a `guide:<id>` thread-key. typed-review-interactions
  already walked this path for `state.ackedNotes`; guides are the next
  parallel `Set` to fold in.

- **Graphs are all one graph at different granularities.**
  `StructureMap.symbols[].referencedIn` (regex, diff-only).
  `cs.graph: CodeGraph` (server-resolved LSP, with context nodes).
  `Hunk.referencesSymbols` / `Hunk.definesSymbols` (per-hunk regex, what
  guides read today). The diagram already reads `cs.graph` with structure-map
  fallback. Pulling guides onto `cs.graph` would lift non-JS accuracy for
  free; pulling `StructureMap` onto `cs.graph` would give the rule-based
  plan LSP edges.

- **Concrete cleanup that helps all four.** `buildPlanDiagram` re-runs
  `classifyFileRole` because legacy graphs may predate server enrichment
  (`planDiagram.ts:140-142`). The server always emits enriched nodes today,
  so the renderer fallback can go. Same pattern for guides: read `cs.graph`
  first, fall back to per-hunk fields, then drop the fallback a release later.

- **`runRecipe` is an anchor too.** AI notes carry `runRecipe: { source,
  inputs }` to hand a snippet to the runner; this is "this note refers to
  executable code in the diff." A unified anchor with an optional verifier
  slot would let plan claims and guides also be verifiable in place when
  the runner can take their language.
