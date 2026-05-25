# Prompt results

## 1. Product reasoning & priority

Prompt results are the output side of the library: when a reviewer picks `Security review this hunk` and hits run, the streaming Claude response lands in the **Prompt runs panel** in the sidebar — one collapsible row per run, with status (`streaming` / `done` / `error`), preview line, and full body. It's the visible payoff of the whole prompt system; without it, the picker would be a generator that throws its output into the void. Two product principles live here. First, **the result must feel live** — `IDEA.md`'s "stay present and engaged" pressure means seeing tokens stream as they arrive matters more than a polished final-state UI. Second, **the result is ephemeral by design today** — runs disappear on reload, are not handed back to any other surface, and can be cancelled mid-stream. That's a deliberate prototype choice; the question for the rebuild is whether it should stay that way.

**Suggested priority: must-have, but the *current* persistence story is a drop-it candidate.** The panel itself is essential — without it the AI loop has no output surface. The "evaporates on reload, can't be replied to, can't be handed to the runner" behaviour is what should be rethought.

## 2. Acceptance criteria for a rebuild

- Submitting a prompt from the picker spawns a new run with a unique id and `status: "streaming"`, prepended to the runs list (newest first), and closes the picker.
- The run row shows the prompt name, a live status badge (`streaming…` / `done` / `error`), and a preview line that reflects the most recent non-empty line of output as tokens arrive.
- Streaming tokens append to the run's text in order; partial UTF-8 boundaries don't garble (the decoder uses `{ stream: true }`).
- The user can expand a run to see the full body, or collapse it back to the preview.
- The user can dismiss a run with `×`; an in-flight run is **aborted** (the `AbortController` fires, the stream socket closes server-side via `res.on("close", …)`).
- An error mid-stream surfaces inline in the expanded body with a `CopyButton`, not as a global toast. The status flips to `error` and the abort controller is cleaned up.
- The panel is hidden when there are zero runs (no empty chrome).
- Server-side, the `/api/review` endpoint streams SSE-shaped messages (`data: <json>\n\n`) with `type: "text" | "done" | "error"`; the client tolerates a trailing message without the blank-line terminator (flush at end of stream).
- The endpoint is rate-limited per IP (default 30/60s) and returns `429` with `Retry-After`. The client surfaces the server's `error` field rather than the raw body.
- The endpoint refuses to start without an Anthropic credential (`503 anthropic_key_missing`); the client surfaces that as a real error message.
- Aborts originating from the *client* (`signal.aborted`) are not reported as errors — they're a no-op terminal state.
- A reload of the page **today** drops all in-progress and completed runs; a rebuild should at minimum preserve completed runs for the active changeset until the user dismisses them.

## 3. Existing architecture & system design

### Data model

- **`PromptRunView`** (`web/src/components/PromptRunsPanel.tsx:7-13`):
  ```ts
  { id; promptName; text; status: "streaming" | "done" | "error"; error? }
  ```
  This is the *view* shape; there is no separate `PromptRun` domain type. The runs array lives in `useState<PromptRunView[]>` in `ReviewWorkspace` (`web/src/components/ReviewWorkspace.tsx:295`).
- **`RunEvent`** (`web/src/promptRun.ts:14-17`) — the SSE wire event: `text | done | error`. The same shape is emitted by the server (`server/src/review.ts:21-28`, `ClientEvent`).
- **`RunOptions` / `RunHandlers`** (`web/src/promptRun.ts:19-29`) — the streaming-runner API: `{ text, system?, signal }` in, `{ onText, onDone, onError }` out. Pure callback shape, no state of its own — the caller (workspace) owns the state.
- **No persistence type.** Runs are not in `ReviewState`, not in `persist.ts`, not in `Interaction[]`.

### Current architecture decisions

- **Runs are pure component state.** `useState<PromptRunView[]>` in `ReviewWorkspace` + a `runControllersRef: Map<id, AbortController>` for cancellation (`web/src/components/ReviewWorkspace.tsx:295, 305`).
- **Lifecycle** (`web/src/components/ReviewWorkspace.tsx:1011-1042`):
  1. `startPromptRun(prompt, rendered)` mints id, registers an `AbortController`, prepends a `streaming` row, closes the picker, calls `runPrompt({ text: rendered, signal })`.
  2. `onText` appends; `onDone` flips to `done` and clears the controller; `onError` flips to `error` and clears the controller.
  3. `closePromptRun(id)` aborts the controller, deletes from the map, removes the row.
- **`runPrompt`** (`web/src/promptRun.ts:31-91`) is a one-shot async function: POST `/api/review` with `{ text, system? }`, parse SSE frames, dispatch to handlers. Errors on bad HTTP status, no response body, JSON-parse failure (silently skipped per line — keeps a malformed event from killing the stream).
- **Server side** (`server/src/review.ts:30-132`): validates `text` (min 1), defaults `model: claude-sonnet-4-6`, opens an Anthropic streaming `messages.stream`, fans `content_block_delta` → `{ type: "text" }`, emits `done` with `stop_reason` + usage, emits `error` on exception. Crucially, listens on `res` (the response socket), not `req`, for client disconnect — a comment explains why (`server/src/review.ts:60-66`).
- **No per-changeset scoping.** The runs array is held by `ReviewWorkspace`, which is keyed by the active changeset, so loading a different changeset re-mounts the workspace and the runs array starts empty. Switching changesets effectively wipes runs.
- **Detach bridge propagation.** When the sidebar is detached into its own window, `SidebarSnapshot` (`web/src/detachBridge.ts:35-43`) includes `runs: PromptRunView[]` — the child window is a pure read of parent state, and `close-run` actions round-trip back through `SidebarAction` (`web/src/detachBridge.ts:48`).
- **No reply, no hand-off.** The runs panel renders text and a copy affordance; there is no "reply to this output," no "send this output to the runner," no "save this output as a comment." Per `IDEA.md`'s "easily integrate insight from agent interactions during review," this is a known gap, not a designed terminal state.

### How it evolved

- `docs/concepts/prompt-library.md` and `docs/concepts/prompt-system.md` describe the *input* side (definitions, args, auto-fill) but say nothing about results — the output side has grown organically as "whatever the streaming endpoint produces."
- `docs/plans/test-strategy.md:111` flags `PromptRunsPanel` + the `promptRun` machine as an untested integration tier — recognised gap.
- `docs/plans/test-strategy.md:128` calls out that the state machine is only reachable through a mounted component; the right move is "extract a pure reducer." That's a tell that the run lifecycle should be a typed state machine, not a hand-rolled `setRuns(prev => prev.map(...))` chain.
- The `Interaction`-based unification (`docs/plans/typed-review-interactions.md`, summarised in `docs/architecture.md:45-103`) consolidated *every* author signal — user, AI, teammate, agent — into one store. Prompt runs were left out of that unification.

### Gaps

- **Not persisted.** Runs evaporate on reload, on changeset switch, on browser quit. The reviewer cannot come back tomorrow and see what the AI said yesterday.
- **Not addressable.** No anchoring to a hunk, line, or selection — the panel knows the *prompt name* but not the *target*. Two `Security review this hunk` runs against different files look identical in the list.
- **Not repliable.** No way to ask Claude a follow-up about the same run. To follow up, the user has to copy the relevant text and start a new run with hand-crafted context.
- **Not handable.** AI annotations on lines have a verifier hook that hands a snippet to the runner (`docs/architecture.md:9, 234`). Prompt results have no equivalent — even when the result includes a code snippet, the user has to copy/paste.
- **No telemetry / stats per result.** The server logs request totals and token counts (`server/src/review.ts:115-119`) but the client never reports back which prompt produced which run. Connecting "users abandoned this run" to "this prompt is too long" is not possible.
- **The `system` parameter is supported on the wire but never set by the client.** `runPrompt` accepts `system` (`web/src/promptRun.ts:25-27`), as does `/api/review` (`server/src/review.ts:13`), but no caller passes it. Either delete the path or use it.
- **No structured output.** Streamed text is rendered as plain text in a `<div>` (`web/src/components/PromptRunsPanel.tsx:122`); no markdown, no syntax highlight on code blocks the prompt would obviously produce. Plain-text rendering of structured AI output undersells the result.

## 4. Rebuild opportunities

### Data unification

- **A prompt-run result is an `Interaction` with `authorRole: "ai"`.** This is the sharp question for the rebuild. Look at the shape:
  - `Interaction.body` ≈ `PromptRunView.text` (the streamed text).
  - `Interaction.author` ≈ `PromptRunView.promptName` (or model name).
  - `Interaction.authorRole = "ai"` is already in the union (`web/src/types.ts:576`).
  - `Interaction.runRecipe = { source, inputs }` is already designed to record the prompt invocation that produced an AI output (`web/src/types.ts:613`).
  - `Interaction.target ∈ {"line", "block"}` matches the picker's hunk / line-selection context (`web/src/promptStore.ts:204-218`).
  - The streaming/in-progress state would need either a `status` field on `Interaction` (small extension) or the wire envelope could carry "AI is still streaming this id" until a final `done` event upserts the final body.
- **The static AI annotation pipeline already produces `Interaction`s with `authorRole: "ai"` at ingest** (`docs/architecture.md:62-67`). The only meaningful difference between that pipeline and a prompt run is *when* it fires (ingest vs on-demand). Treating prompt runs as on-demand AI Interactions collapses one panel + one store into the existing thread infrastructure: replies become free (the existing composer), persistence becomes free (server SQLite), detached-window propagation becomes free, agent hand-off becomes free.
- **What blocks it today**: (a) streaming partial-text into an `Interaction.body` requires either a status flag or a separate live channel that upserts on completion — both small additions, not redesigns. (b) The "anchor" question — today a prompt run isn't anchored to a hunk/line at all, it's just "the panel" — solving this means committing the picker's selection state into the result (which the picker already has via `AutoFillContext.selectionInfo`). (c) Nothing else.

### Better architecture

- **Extract a pure reducer for the run state machine.** The test strategy doc flags this explicitly (`docs/plans/test-strategy.md:128`). A reducer with `START | TEXT | DONE | ERROR | CANCEL` actions makes the runs panel testable and decouples it from `ReviewWorkspace`'s 2000-line component.
- **Persist completed runs to the same store as Interactions.** Even before the full unification, simply upserting a `done`/`error` run as an `Interaction` row (with a temporary "ai-output" target or the existing `block` target seeded from the picker selection) gives reload-survival and changeset-switch persistence at the cost of one POST per run.
- **Render markdown.** AI prompt output is markdown 95% of the time; the panel rendering as plain text is undermines the result. The codebase already has `MarkdownView` / `RichText` (referenced in `docs/architecture.md:238`) — wire it in.
- **Use the `system` channel or remove it.** If we plan to make per-prompt policy serverside (see `prompt-library.md`), the system prompt is the right place to lock down "cite lines, refuse to speculate" rules. Either claim that ground or close the dead seam.
- **Anchor runs to selection.** When `startPromptRun` is called, the picker already has `AutoFillContext.selectionInfo` describing the hunk/line range used. Attaching that to the `PromptRunView` (or, in a unified world, to the `Interaction`) means the panel can show "Security review — file.ts, lines 72-79" instead of just the prompt name — a small change with a large legibility win.

## Sources

- `docs/architecture.md:45-103, 234` — Interactions unification (which prompt runs were left out of); runner verifier hook.
- `docs/plans/typed-review-interactions.md` — the precedent for unifying author signals.
- `docs/plans/test-strategy.md:111, 128` — flagged untested + "extract pure reducer" recommendation.
- `web/src/promptRun.ts:1-113` — streaming SSE client, abort handling, error surfacing.
- `web/src/components/PromptRunsPanel.tsx:1-143` — runs panel: rows, status, expand/collapse, dismiss, preview.
- `web/src/components/ReviewWorkspace.tsx:295, 305, 1011-1042` — run state ownership, abort controllers, lifecycle.
- `web/src/detachBridge.ts:35-49` — SidebarSnapshot includes `runs`; close-run round-trip.
- `web/src/types.ts:576, 587, 613` — `InteractionAuthorRole`, `Interaction`, `runRecipe`.
- `server/src/review.ts:7-132` — server SSE endpoint, abort semantics, model default.
- `server/src/index.ts:282-298, 301-330` — per-IP rate limit on `/api/review`.
- `IDEA.md` — "stay present and engaged," "easily integrate insight from agent interactions."
