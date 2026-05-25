# AI Inspector

## 1. Product reasoning & priority

The AI Inspector is the surface where AI-authored review signals land next to the
diff: per-line notes, per-hunk summaries, and threaded conversation. It is the
load-bearing answer to "how do I get a second pair of eyes on this code without
spawning a separate chat window?". The current codebase has already collapsed
every author (user, AI, teammate, agent) into one `Interaction` primitive
(`web/src/types.ts:587-636`) read through one seam
(`web/src/interactions.ts:60`); the Inspector is the canonical consumer. With
the optional panel-vs-inline rendering split (`web/src/components/Inspector.tsx`
+ `web/src/components/InlineThreadStack.tsx`), it also doubles as the thread
chrome anywhere a thread shows up.

Suggested priority: **must-have.** The whole product premise from `IDEA.md`
— "AI guides you on what to review next … explainers built-in … coverage-like
markers" — depends on an AI-annotation seam. Without this, the diff is silent
and Shippable is just a fancier `git diff`.

## 2. Acceptance criteria for a rebuild

- Every AI annotation renders as an `Interaction` with `authorRole: "ai"`,
  `target: "line"` for per-line notes and `target: "block"` (via the
  `hunkSummary:` thread-key family) for per-hunk summaries. Free-floating
  `AiNote` objects are not allowed (mirrors `docs/concepts/ai-annotations.md`).
- Each AI interaction carries an ask intent (`comment | question | request |
  blocker`); response intents on code are rejected at the reducer and
  HTTP boundary (`web/src/types.ts:651-657`).
- AI-note bodies follow the seam contract: first paragraph is the summary,
  remaining paragraphs are detail (`web/src/interactions.ts:183-197`).
- Per-line notes are addressable by `noteKey(hunkId, lineIdx)` and reachable
  through `selectIngestSignals(state).aiNoteByLine` — there is no second read
  path from the renderer (architecture.md "One seam" invariant).
- The Inspector renders in both panel and inline modes via a single
  `InlineThreadStack` presentation component (see architecture.md §
  "Thread rendering — panel vs inline").
- An AI note with `runRecipe` shows a `▷ verify` button that hands the recipe
  to the in-browser code runner (`web/src/runner/`). Notes without a recipe
  hide the button (`web/src/components/InlineThreadStack.tsx:509-517`).
- Acknowledging a note is a first-class response Interaction (`intent: "ack"`),
  not a parallel `Set` (the legacy `state.ackedNotes` field is gone in this
  feature's contract — see typed-review-interactions plan §"Migration").
- Persistence: AI interactions are stripped on persist and rebuilt from ingest
  on reload (`docs/concepts/ai-annotations.md`, last bullet).
- The Inspector is detachable (`onDetach`) and survives in a separate window
  driven by the same view-model snapshot.

## 3. Existing architecture & system design

### Data model

Single primitive — `Interaction` in `web/src/types.ts:587-636`. The relevant
fields for the AI inspector path:

- `id: string` (stable; producer-supplied)
- `threadKey: string` — `note:<hunkId>:<lineIdx>` for per-line notes,
  `hunkSummary:<hunkId>` for per-hunk summaries
  (`web/src/types.ts:662-667`).
- `target: "line" | "block" | "reply"` (topology only).
- `intent: AskIntent | ResponseIntent` — AI emits ask intents; replies can be
  responses (`web/src/types.ts:558-569`).
- `authorRole: "user" | "ai" | "agent"` (`web/src/types.ts:576`).
- `runRecipe?: { source: string; inputs: Record<string, string> }`
  (`web/src/types.ts:613`).
- `body: string` — first paragraph = summary, rest = detail.

The view model that the Inspector consumes is `InspectorViewModel` in
`web/src/view.ts` (search "Inspector view model" near `view.ts:766`). Per-line
AI rows are `AiNoteRowItem` (`view.ts:769`).

### Current architecture decisions

- **One store, one seam.** `state.interactions: Record<threadKey,
  Interaction[]>` is canonical; consumers read through
  `selectInteractions(state)` (`web/src/interactions.ts:60`) and the cheaper
  `selectIngestSignals(state)` (`web/src/interactions.ts:143`). The view-model
  builder uses `selectIngestSignals` because rendering AI notes only needs the
  per-line / per-hunk lookups.
- **Server is canonical persistence.** All interactions persist to SQLite via
  `/api/interactions` (`server/src/index.ts:147-161`); the client upserts
  ingest-produced AI interactions on load and re-fetches on changeset switch
  (architecture.md § "Review interactions" → "Server DB is the persistence
  layer").
- **Panel-vs-inline mode** is a presentation-only switch over a single
  `InlineThreadStack`. The Inspector chrome (`Inspector.tsx`) is the panel
  host; in inline mode the `DiffView` hosts the same stack beneath the cursor
  line. Toggled via `interactionViewMode` (panel | inline; persisted —
  architecture.md mentions `web/src/interactionViewMode.ts` but the actual
  visibility orchestration lives in `web/src/inspectorVisibility.ts`).
- **Run hooks land on the Interaction.** Verifier affordances are carried in
  `runRecipe` directly on the AI interaction
  (`web/src/components/InlineThreadStack.tsx:148-151, 509-517`); the
  `onVerifyAiNote` callback hands the recipe to the workspace's runner
  panel (`Inspector.tsx:115-119`).
- **Streaming review (`/api/review`)** is a separate channel — a stream of
  text/done/error events (`server/src/review.ts:20-28`) used by the prompt
  library, not by the static AI note pipeline. They co-exist; the static
  pipeline produces durable `Interaction`s, the streaming endpoint produces
  ephemeral text that lands in `PromptRunsPanel`.

### How it evolved

The legacy shape — pre-typed-review-interactions — had five parallel
vocabularies: `Reply`, `AiNote.severity`, `state.ackedNotes`,
`hunk.teammateReview.verdict`, `AgentReply.outcome`
(`docs/plans/typed-review-interactions.md:8-12`). Each had its own enum, its
own renderer, its own persistence rule. The migration collapsed them onto one
`Interaction` shape with two orthogonal axes (`target`, `intent`), and severity
became an intent mapping (`info → comment`, `question → question`, `warning →
request`; see `typed-review-interactions.md:105-115`). The Inspector dropped
from rendering `AiNote` objects to rendering rows projected from the
`selectIngestSignals` seam. `ackedNotes` became `intent: "ack"` Interactions on
the same thread; toggle-off is `intent: "unack"`
(`typed-review-interactions.md:80-83`).

### Gaps

- AI annotations have no producer pipeline in the current codebase — the
  architecture diagram shows "AI annotation pipeline … per-line + per-hunk, at
  ingest" (`docs/architecture.md` mermaid graph) but there is no server route
  that emits `authorRole: "ai"` interactions today. The seam is ready; the
  ingest is missing.
- `runRecipe` shape is loose (`{ source, inputs }`) — no language hint, no
  schema, no boundary validation. Hand-off to the runner relies on the runner
  recognising what it gets.
- No "AI severity ladder" UI — `intent` maps to severity at the seam
  (`interactions.ts:199-206`) but the Inspector renders all intents
  uniformly through `NoteCard`. Reviewers can't filter "show me only blockers".
- The streaming review and the static AI notes never converge — there is no
  path from a one-shot prompt run to a durable AI Interaction. If the
  reviewer runs `security-review` from the prompt library and Claude flags
  something, the output lives in `PromptRunsPanel` and has to be re-authored
  as a user comment manually.
- Detached threads (anchor no longer matches) are handled
  (`web/src/anchor.ts`), but AI interactions are rebuilt from ingest on reload
  — so an AI note whose anchor drifts simply disappears rather than detaching.

## 4. Rebuild opportunities

### Data unification

- `runRecipe` and `EvidenceRef` could share a hand-off shape. Today a claim
  points at a hunk via `EvidenceRef` and a recipe runs a hunk's snippet via
  `runRecipe`. Both are "this thing refers to a piece of the diff"; a unified
  anchor (file, hunk, optional line range) would let any Interaction be
  verifiable in place if a runner can handle its language.
- AI per-line notes and review-plan claims both produce "an AI says X about
  this code." A claim with no thread head is harder to discuss than an
  Interaction; pulling plan claims onto the Interaction store (with a new
  threadKey family, e.g. `claim:<id>`) would give the reviewer a single inbox.
- The "Inbox view" referenced in architecture.md
  (`byIntent.request · byIntent.blocker`) is already enabled by the seam —
  building it is mostly UI work, not data work.

### Better architecture

- **Make the AI ingest pipeline real.** A new endpoint (`POST
  /api/annotations` or similar) that takes a `ChangeSet`, asks Claude for
  per-line / per-hunk findings against the same `PlanResponseSchema` shape,
  and upserts `Interaction`s with `authorRole: "ai"`. The schema validator
  (`server/src/plan.ts:303-356`) already exists for evidence; reuse it.
- **Bridge streaming review → durable Interaction.** Add a "save as note"
  action on `PromptRunsPanel` outputs that mints an Interaction anchored to
  the prompt's hunk. Today the user has to copy-paste.
- **Tighten the `runRecipe` contract.** A discriminated union
  (`{ kind: "js", source } | { kind: "php", source, inputs }`) lets the
  runner dispatch without sniffing. Today the dispatcher in
  `InlineThreadStack.tsx:148` hands an unknown shape to the parent.
- **Promote intent to a visible chip in `NoteCard`.** Severity is already
  pre-computed in `AiNoteSignal.severity` (`interactions.ts:104-112`) but the
  current card renders only a glyph; an `intent` chip would make
  request/blocker findings filterable without changing the data layer.

## Sources

- `/workspace/IDEA.md`
- `/workspace/docs/overview.md`
- `/workspace/docs/architecture.md` (lines 38-49, 60-110 — Review interactions
  section)
- `/workspace/docs/concepts/ai-annotations.md`
- `/workspace/docs/plans/typed-review-interactions.md` (lines 1-115, 232-238)
- `/workspace/web/src/types.ts:540-636` — Interaction shape
- `/workspace/web/src/types.ts:659-717` — threadKey helpers / `parseReplyKey`
- `/workspace/web/src/interactions.ts:60-181` — the seam
- `/workspace/web/src/components/Inspector.tsx:1-369`
- `/workspace/web/src/components/InlineThreadStack.tsx:60-220, 480-520`
- `/workspace/web/src/components/ReviewWorkspace.tsx:600-640` — wiring
- `/workspace/server/src/review.ts:1-110` — streaming review endpoint
- `/workspace/server/src/index.ts:90-92, 147-161` — `/api/review`,
  `/api/interactions`
