# Group 5 — prompts: cross-cutting unification notes

## The biggest open question

**Should prompt-run results just be `Interaction`s with `authorRole: "ai"`?** Strong yes by shape; the blockers are small.

- The data already lines up: `Interaction.body` ≈ `PromptRunView.text`, `authorRole: "ai"` is in the union (`web/src/types.ts:576`), `Interaction.runRecipe = { source, inputs }` is already designed to record a prompt invocation (`web/src/types.ts:613`), and the static AI-annotation pipeline already emits Interactions on the same primitive (`docs/architecture.md:62-67`).
- What blocks it today:
  1. **Streaming state.** `Interaction` has no `status` field; today a run is `streaming → done|error`. Either add a transient client-only `status` (similar to `enqueueError`, `web/src/types.ts:631-635`) or upsert only when the stream completes and buffer partials in a separate live channel keyed by interaction id.
  2. **No anchor today.** Prompt runs aren't tied to a hunk/line — the panel renders by prompt name only. The picker already knows the selection (`AutoFillContext.selectionInfo`, `web/src/promptStore.ts:159-171`); commit it to the result and the anchor problem disappears.
  3. **The runs panel is its own surface.** `PromptRunsPanel` is the only place runs appear; folding into Interactions implies rendering them through the existing thread infrastructure (`InlineThreadStack`, `docs/architecture.md:189-201`). That's a UX rework, not a data one.

Net: it's a roughly two-week refactor with a clear payoff — persistence, reply, agent hand-off, detached-window propagation, all free.

## Other cross-cutting opportunities

- **Two prompt stores → one.** `library` (server disk, `server/src/library.ts`) + `user` (localStorage, `web/src/promptStore.ts:20`) merge in the client (`listPrompts`, `web/src/promptStore.ts:27-34`). Moving user prompts into the same server SQLite as interactions gives them persistence, multi-window propagation, and a path to team-shared prompts without inventing a new sync layer.
- **`Prompt` (definition) and `runRecipe` (invocation) are two halves of the same concept.** A unified rebuild should link them by id: `runRecipe.source = promptId` so re-running, telemetry, and "this AI output was produced by this prompt at this version" are all one lookup.
- **Validation lives twice.** `server/src/prompts.ts:7-20` (zod, for disk-backed library) and `web/src/promptStore.ts:100-117` (hand-rolled, for localStorage user prompts) check overlapping but not identical rules. Collapse into a shared schema once user prompts move server-side.
- **`/api/review` is prompt-blind.** It accepts pre-rendered text (`server/src/review.ts:11-14`). Making it `{ promptId, args }`-aware gives per-prompt telemetry, server-side policy (model choice, max tokens, system prompt), and removes the "render template in JS, hope it matches what the server expects" coupling. The client-side renderer becomes a preview helper.
