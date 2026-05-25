# Prompt library

## 1. Product reasoning & priority

The prompt library is the curated, shipped set of review prompts (`explain-this-hunk`, `security-review`, `suggest-tests`, `summarise-for-pr`) that turns Shippable's AI surface from a blank-prompt textbox into a toolbelt. Two product effects fall out of that. First, it lowers the cost of *starting* an AI interaction during a review — `IDEA.md` is explicit that the tool's job is to help a reviewer stay engaged and not get lost, and "pick a labeled task" beats "type a prompt" for that. Second, it gives the team a place to encode opinions about *what* a review prompt should look like (e.g. security-review insists on citing lines, refuses to speculate), so the same shipped prompts can later become the contract a hosted backend or an agent runner enforces.

**Suggested priority: must-have.** Without it, the AI panel is "free-form chat about a diff," which makes Shippable indistinguishable from pasting code into Claude — the library is what makes the AI feature feel native to *review*.

## 2. Acceptance criteria for a rebuild

- Library prompts are loaded from disk on the server side and listed via `GET /api/library/prompts` — never bundled into the JS bundle, so a prompt change is a file edit, not a redeploy.
- Each prompt is a single markdown file with YAML frontmatter; missing or malformed frontmatter logs a warning and skips that prompt (it does not take down the rest of the library).
- A prompt that fails to parse frontmatter shows up in server logs with a clear reason; the picker shows the remaining prompts without error.
- Required frontmatter fields: `name`, `description`. Optional: `args` (list, each with `name`, optional `required`, optional `auto`, optional `description`).
- The `id` is derived from the filename, not the frontmatter — renaming a prompt's display name does not invalidate user customisations or refs.
- The picker lists library prompts merged with user prompts, sorted by display name, with a `user` badge on user-authored ones so the source is never ambiguous.
- A user prompt with the same id as a library prompt overrides the library one (deterministic precedence).
- The library can be sourced from three places in priority order: a remote git repo (`SHIPPABLE_LIBRARY_REPO_URL` + `_REF`), a local path (`SHIPPABLE_LIBRARY_PATH`), or the bundled `library/` directory. Switching source URL triggers a fresh clone, not an attempted in-place update.
- `POST /api/library/refresh` is gated by `SHIPPABLE_ADMIN_TOKEN` (or `SHIPPABLE_DEV_MODE=1` for local) — public callers cannot force a re-clone.
- Library list is cached server-side until refresh, and cached client-side via an in-process promise so opening the picker twice in a session doesn't double-fetch.
- The picker's "fork" affordance on a library prompt copies it into the user-prompt layer with the same id, so the user version transparently overrides the shipped one.
- Templating supports `{{name}}` substitution and `{{#name}}…{{/name}}` conditional blocks (empty value → block omitted). Inverted blocks are out of scope for v1.
- Auto-fill hints (`auto: selection|file|changeset.title|changeset.diff`) are resolved client-side from the cursor/selection context; the server never interprets them.

## 3. Existing architecture & system design

### Data model

- **Server-side `Prompt`** (`server/src/prompts.ts:24-30`):
  ```ts
  type Prompt = { id; name; description; args: PromptArg[]; body }
  ```
  Frontmatter is parsed with `yaml` + validated by zod `FrontmatterSchema` (`server/src/prompts.ts:7-20`). `args` defaults to `[]`. `PromptArg = { name, required?, auto?, description? }`.
- **Wire**: `GET /api/library/prompts → { prompts: Prompt[] }` (no `source` field; the client adds `source: "library"`).
- **Client-side `Prompt`** (`web/src/promptStore.ts:11-18`) adds `source: "library" | "user"`. `PromptDraft = Omit<Prompt, "source">` is what the editor saves.
- **`LibrarySource`** (`server/src/library.ts:16-19`) discriminates `bundled | path | git`. The git variant carries `url` + `ref`.
- **`AutoFillContext`** (`web/src/promptStore.ts:159-171`): `{ changeset: { title, diff }, file: { path }, selection, selectionInfo }`. The picker reads `auto:` hints and pre-fills via `resolveAuto` (`web/src/promptStore.ts:221-238`).

### Current architecture decisions

- **Prompts live on disk** under `library/prompts/` (relative to repo root for `bundled`, configurable for `path`/`git`). They are NOT shipped inside the web bundle. The server is the source of truth.
- **Three source modes** resolved by `resolve()` in `server/src/library.ts:49-98`: env-var driven, lazy, with an inflight promise so concurrent boot requests share one resolution. Git mode clones into `server/var/library/checkout/`, fetches + detaches + hard-resets to `origin/<ref>` (falling back to ref-as-tag/sha).
- **Admin gate**: `POST /api/library/refresh` requires `x-admin-token: $SHIPPABLE_ADMIN_TOKEN` unless `SHIPPABLE_DEV_MODE=1` (`server/src/index.ts:419-434`). The unauthenticated read endpoint (`GET /api/library/prompts`) has no gate — listing is intentionally open.
- **Streaming runs** go through `POST /api/review` (`server/src/review.ts:30-132`), which is a generic "user message → SSE stream of `text|done|error` events" wrapper. The endpoint has no concept of "which prompt this came from" — the template is rendered client-side in `renderTemplate` (`web/src/promptStore.ts:138-153`) and only the final user message goes over the wire. Server logs and per-IP rate limiter (default 30/60s, `server/src/index.ts:282-298`) are the only review-side controls.
- **Library caching**: server `cached` + `inflight` (`server/src/library.ts:21-22`); client `libraryCache: Promise<Prompt[]> | null` (`web/src/promptStore.ts:25`). Both are invalidated by explicit `refresh`/`sync` calls.
- **Picker invocation**: `OPEN_PROMPT_PICKER` action toggles `showPicker` (`web/src/components/ReviewWorkspace.tsx:794-795`), which mounts `PromptPicker`. `PromptPicker` does its own `listPrompts()` on mount (`web/src/components/PromptPicker.tsx:42-53`).

### How it evolved

- `docs/concepts/prompt-library.md` describes "the shipped collection" as conceptually separate from user prompts, picker as the merge point — exactly what the code does today.
- `docs/concepts/prompt-system.md` is the design intent for the unified picker model: `Prompt` definition, `PromptArg`, `AutoFillContext`. Implementation follows it closely.
- `docs/plans/explain-with-context.md` is a live plan to extend the prompt schema with `auto: file.content` / `auto: file.context` hints, plus a static "context gatherer" feeding a richer `AutoFillContext`. The hint resolver in `promptStore.ts:221` is the seam the plan touches.
- The admin-token gate (`SHIPPABLE_ADMIN_TOKEN` / `SHIPPABLE_DEV_MODE=1`) is an explicit choice for hosted deploys: anyone can read prompts, only the operator can rewind the git checkout.

### Gaps

- **No per-prompt versioning or signature.** A library refresh from a moving `main` silently swaps prompt bodies under the user; the user has no way to pin a prompt to a known revision.
- **No prompt visibility scoping.** All library prompts apply to every diff. There's no "only show this prompt for PHP files" or "only for security-tagged PRs," even though `IDEA.md` explicitly wants micro-skills / contextual skill loaders.
- **No telemetry per prompt.** The server logs `/api/review` requests but nothing identifies which library prompt was used — the rendered text alone reaches the server.
- **No way to share library overrides across machines.** A team that wants "our security review prompt" can put it in the git source, but a single user editing their own prompt is localStorage-only (see `custom-prompts.md`).
- **Library-vs-user precedence is silent.** Forking a library prompt creates a user copy with the same id; once the user copy exists, library updates to that id are silently shadowed. The picker doesn't surface "this prompt has a newer library version."
- **No way to disable a library prompt without deleting the file on disk.** Hosted deploys can't curate by user.
- **`/api/review` accepts arbitrary text.** A prompt run and a free-form "send anything to Claude" are indistinguishable server-side. No abuse signal beyond per-IP rate limit.

## 4. Rebuild opportunities

### Data unification

- **Library + user prompts are already one list at the picker.** The right move is to make them one list everywhere downstream: a single `Prompt` table (server-side) with a `source: library | user | team` column, instead of two stores with merge-on-read in the client. That collapses the `loadLibrary()` + `loadUser()` + `byId` merge in `web/src/promptStore.ts:27-34` into a single GET.
- **Prompt runs vs `Interaction`s.** Today a prompt run produces freeform text that lives in `useState<PromptRunView[]>` in `ReviewWorkspace` (`web/src/components/ReviewWorkspace.tsx:295`) and dies on reload. Every AI annotation produced by the static pipeline is already an `Interaction` with `authorRole: "ai"` (`web/src/types.ts:576, 587`). The library run output is *also* AI text about a specific selection — the only structural difference is that the static pipeline runs at ingest and the library runs on demand. A unified primitive ("ai-generated content anchored to a hunk/selection") would let prompt results live in the same store, the same panel-vs-inline rendering, the same reply thread.
- **`AutoFillContext` and the `runRecipe` field on `Interaction`** (`web/src/types.ts:613`) already describe the same idea: "what selection + inputs produced this AI output." Reusing `runRecipe` to persist prompt-run provenance would also enable "re-run this prompt with current selection" as a single click.

### Better architecture

- **Make `/api/review` prompt-aware.** Accept `{ promptId, args }` plus optional `text` override and have the server render the template. Benefits: (a) telemetry per prompt becomes free, (b) prompt updates take effect without the client rebuilding the body, (c) hosted deploys can apply per-prompt policy (model choice, max tokens) without client cooperation, (d) the wire payload is no longer "a giant blob of unverifiable text." The client-side `renderTemplate` becomes a preview-only helper.
- **Promote library source config to a runtime knob.** Today switching from bundled to git requires a server restart + env vars (`server/src/library.ts:53-77`). A hosted deploy would benefit from a `POST /api/library/source` admin endpoint (gated the same way as refresh) so an operator can rotate teams' prompt sources without redeploy.
- **Move prompt-run state to the same persistence layer as interactions.** `state.interactions` is server-DB-backed and survives reload (`docs/architecture.md:43`). Prompt runs are pure in-memory state. If a prompt run becomes an `Interaction` (see § Data unification), it gets persistence, agent-handoff, and detached-window propagation (`web/src/detachBridge.ts:35-43`) for free.
- **Capability flags should describe prompt availability.** The architecture doc says "features that depend on a particular workspace mode should hide themselves cleanly via capability flags rather than render disabled" (`AGENTS.md`, deployment modes section). Library is server-driven and works in all modes today — but a prompt that requires `changeset.diff` could be hidden in a memory-only mode where the diff isn't materialised, instead of failing at run time.

## Sources

- `docs/concepts/prompt-library.md` — what the library is.
- `docs/concepts/prompt-system.md` — `Prompt`/`PromptArg`/`AutoFillContext` design intent.
- `docs/plans/explain-with-context.md` — in-flight extension of the auto-fill hint set.
- `docs/architecture.md:10-17` — placement in the package map; `:43` for persistence boundaries.
- `server/src/library.ts:16-98` — source resolution (bundled/path/git) and caching.
- `server/src/prompts.ts:1-77` — frontmatter parsing + zod schema.
- `server/src/index.ts:102-107, 395-462` — `/api/library/prompts` and `/api/library/refresh` (admin gate).
- `server/src/review.ts:7-132` — streaming review endpoint.
- `web/src/promptStore.ts:11-153, 159-238` — client-side library/user merge, templating, auto-fill.
- `web/src/components/PromptPicker.tsx:1-145` — picker UX, fork/edit affordance, `listPrompts` call.
- `web/src/components/ReviewWorkspace.tsx:280, 794-795, 1011-1042` — picker open state and prompt-run lifecycle.
- `library/prompts/*.md` — the four shipped prompts (explain/security/suggest-tests/summarise).
- `AGENTS.md` — deployment-modes contract and capability-flag stance.
