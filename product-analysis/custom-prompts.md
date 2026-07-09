# Custom prompts

## 1. Product reasoning & priority

Custom prompts are the user-authored counterpart to the shipped library — same schema, same templating, same picker, just stored in the browser and editable in-app. Two product purposes ride on top. First, they're the escape valve when the shipped four prompts don't fit a reviewer's workflow ("review this Gutenberg block," "check WordPress hook ordering," anything domain-specific) — which `IDEA.md`'s "micro-skills" framing actively asks for. Second, **forking** a library prompt into a user prompt is how the product handles "I want the same prompt but with my tweak" without making the user maintain a markdown file on disk — the user override transparently shadows the library entry, so existing call sites keep working.

**Suggested priority: nice-to-have.** The picker and the library deliver most of the value alone; custom prompts are a power-user feature. Important to keep the seam clean (validation, schema, editor UX) so we can graduate it to team-shared later, but cutting the editor for a milestone is survivable — the library covers the 80% case.

## 2. Acceptance criteria for a rebuild

- A "+ new" affordance in the picker opens an editor for authoring a prompt from scratch.
- Editing a user prompt opens the same editor pre-populated; saving updates in place (id is immutable across edits).
- Editing a library prompt opens the editor in **fork mode** — the saved result is a *user* prompt with the same id, which transparently overrides the library version in the picker list.
- Save validates: `id` matches `^[a-z0-9][a-z0-9-]*$`, `name`/`description`/`body` are non-empty, every arg has a valid identifier name (`^[a-zA-Z_][a-zA-Z0-9_]*$`) and no duplicate arg names. Invalid drafts surface an **inline error** in the editor, not a silent failure or a native `alert()`.
- The id of a new prompt is derived from the name via `slugify` and shown in the editor as a read-only preview, so the user can see what they're committing to before saving.
- The editor renders a live preview of the rendered template against the current auto-fill context, with `<argname>` placeholders when an auto value isn't available.
- Delete on a user prompt is a two-step inline confirm (no native `confirm()`), matching the rest of the app's modal etiquette (`AGENTS.md` Tauri/Wry constraints: `window.confirm()` does not work in Wry).
- Forking a library prompt is non-destructive — the library prompt remains on disk. The user copy can be deleted to reveal the library prompt again.
- A user prompt with an invalid frontmatter shape in localStorage (e.g. an old format) is filtered out on load, not surfaced as a crash.
- Auto-fill hint options (`selection`, `file`, `changeset.title`, `changeset.diff`) are picked from a dropdown — no free-text — so the resolver in `resolveAuto` can stay closed.

## 3. Existing architecture & system design

### Data model

- **`Prompt`** (`web/src/promptStore.ts:11-18`) — same shape for both sources, distinguished by `source: "library" | "user"`.
- **`PromptDraft = Omit<Prompt, "source">`** (`web/src/promptStore.ts:22`) is what the editor produces and what `saveUserPrompt` accepts.
- **`PromptArg`** (`web/src/promptStore.ts:4-9`) — `{ name, required, auto?, description? }`.
- **Persistence shape**: an array of `PromptDraft` JSON-encoded under localStorage key `shippable.prompts.user` (`web/src/promptStore.ts:20`). Loading uses `isValidPrompt` to drop malformed entries (`web/src/promptStore.ts:123-133`).

### Current architecture decisions

- **Storage is localStorage, scoped to the browser.** `loadUser()` / `persistUser()` / `saveUserPrompt()` / `deleteUserPrompt()` all read and write `localStorage["shippable.prompts.user"]` (`web/src/promptStore.ts:56-88`). No server round-trip; nothing syncs across machines or browsers.
- **Validation lives in `validateDraft`** (`web/src/promptStore.ts:100-117`) and is called from `saveUserPrompt`. Throws on first failure; the editor catches and renders the message inline (`web/src/components/PromptEditor.tsx:112-118`).
- **The editor is a single screen** (`web/src/components/PromptEditor.tsx:33-287`) with name, description, args (add/remove rows with `name`, `auto:` dropdown, `required` checkbox), body textarea, live preview, optional delete (when editing an existing user prompt).
- **Fork vs edit vs new** is derived from `initial` + `initial.source`: `null` → new; `"library"` → fork (banner reads "forking… saving creates a user copy that overrides it"); `"user"` → edit-in-place. The id is locked when editing, taken from the library when forking, slugified from name otherwise (`web/src/components/PromptEditor.tsx:53-64`).
- **Picker integration**: `PromptPicker`'s `view` state has three kinds — `list | form | editor` (`web/src/components/PromptPicker.tsx:15-19`). The list shows "edit" on user prompts and "fork" on library ones, both routing to the same `PromptEditor` (`web/src/components/PromptPicker.tsx:229-238`).
- **Override semantics**: `listPrompts()` builds a `Map<id, Prompt>`, inserts library first, then user — user wins on collision (`web/src/promptStore.ts:30-33`). This is what makes forking transparent: same id = override.
- **No `/api/library/refresh`-equivalent for user prompts** — they're in localStorage and refresh-on-reload is implicit.

### How it evolved

- `docs/concepts/prompt-system.md` describes the unified picker model with `source` distinguishing shipped vs user prompts — implementation matches.
- No dedicated plan document for custom prompts. They've grown alongside the library: same picker, same templating engine, same auto-fill resolver.
- The delete pattern explicitly references `ReplyThread`'s inline two-step confirm (`web/src/components/PromptEditor.tsx:47-49`) — a deliberate copy of an established pattern, not a one-off.
- The `slugifyId` helper (`web/src/promptStore.ts:90-98`) caps at 60 chars and falls back to `"prompt"` on empty input — a small but careful piece of guardrail engineering.

### Gaps

- **No cross-machine sync.** localStorage is per-browser-profile. A user who switches between desktop and laptop loses their custom prompts; a team can't pool theirs.
- **No prompt-level sharing.** No "export this prompt as markdown" or "import from URL." If a teammate writes a great `php-security-review` they can only describe it in chat, then the recipient retypes it.
- **No prompt versioning or audit.** Editing a user prompt overwrites in place; there's no history. If a prompt run produced unexpected output yesterday, you can't easily go back to "what was the prompt body when that ran."
- **No conflict signal on fork.** Once a user has forked a library prompt, library updates to the same id are silently shadowed. The picker doesn't mark "this prompt has a newer library version" or offer "re-fork from library."
- **Validation is one-shot, server-side rules don't apply.** The server's frontmatter schema (`server/src/prompts.ts:7-20`) and the client's `validateDraft` are similar but separate. A user prompt that would fail server-side parsing (e.g. malformed YAML if it were saved to disk) is accepted because the client never serialises to YAML.
- **No scoping or tagging.** Same gap as library: every user prompt appears for every diff, regardless of language or repo.
- **No way for a hosted deploy to "ship" team-level prompts.** Library is per-server; user is per-browser. There's no per-team or per-organisation layer in between.
- **Editing the picker filter doesn't survive a re-render of the editor.** Minor UX wart — closing the editor returns to the unfiltered list (`web/src/components/PromptPicker.tsx:128-131`).

## 4. Rebuild opportunities

### Data unification

- **One prompt store, not two.** Today there are two storage layers — `library` (server disk) and `user` (localStorage) — merged client-side by `listPrompts()` (`web/src/promptStore.ts:27-34`). A rebuild could put both behind a single server-side `prompts` table with a `source` column, the merge happening server-side, the client GETting a flat list. That kills `loadUser()` + the localStorage round-trip + the dual `isValidPrompt`/`FrontmatterSchema` validation, and gives custom prompts persistence for free.
- **`Prompt` and the `Interaction.runRecipe` field already describe the same shape.** `runRecipe: { source: string; inputs: Record<string, string> }` (`web/src/types.ts:613`) is essentially "a prompt + the args it ran with." A unified view would say: a `Prompt` is the *definition*, a `runRecipe` on an `Interaction` is the *invocation* — and both could share a `promptId` link.
- **User prompts and persisted user comments live in different worlds for no good reason.** A user comment is an `Interaction` with `authorRole: "user"` in the server DB; a user prompt is a JSON blob in localStorage. Both are "things the user wrote that the AI later consumes." Co-locating them simplifies the persistence story (one boot path, one DB-down fail mode) and makes "share prompt with teammate" the same gesture as "share comment with teammate."

### Better architecture

- **Move user prompts to the server-owned SQLite DB.** Same DB that hosts interactions (`docs/architecture.md:43`). A new `prompts` table with `(id, source, name, description, args_json, body, updated_at)` would give custom prompts persistence, multi-window propagation, and a path to team-level prompts without inventing a new sync layer. localStorage stays as a write-through cache so the editor is still snappy and offline-safe.
- **Make the editor schema-driven.** The arg-row UI hard-codes `AUTO_OPTIONS` (`web/src/components/PromptEditor.tsx:16-22`); when the explain-with-context plan ships, this list grows. Driving it from a single declared schema (probably co-located with `resolveAuto`) keeps editor and resolver in sync.
- **Add an export-to-markdown path.** The custom prompt is conceptually a library prompt that lives in a different place; serialising it to the exact same `---\nname: …\n---\nbody` format the server parses would let "share this prompt" be a copy-paste markdown blob, and let teams promote a user prompt to the library by dropping a file.
- **Surface fork conflicts.** When loading prompts, the merge step (`web/src/promptStore.ts:30-33`) already sees which ids exist in both sources. The picker could badge user-shadowed library prompts so the reviewer knows a library update is being suppressed.
- **Capability flags for prompts.** A custom prompt that requires `auto: changeset.diff` should be hidden in a memory-only mode where the diff isn't materialised — the auto resolver already knows what's available, so the picker can filter to "runnable prompts for this context" instead of letting the user pick something that will fail.

## Sources

- `docs/concepts/prompt-system.md` — unified picker model, `source` distinction.
- `docs/concepts/prompt-library.md` — library/user separation as a product concept.
- `docs/plans/explain-with-context.md:39-48` — planned extension of `auto:` hint set; touches the editor's dropdown.
- `docs/architecture.md:38-44` — persistence boundary (server DB for interactions, localStorage for progress).
- `web/src/promptStore.ts:4-22, 56-117, 119-133` — user-prompt persistence, validation, isValid filter.
- `web/src/promptStore.ts:90-98` — `slugifyId`.
- `web/src/components/PromptEditor.tsx:1-287` — full editor: fork/edit/new logic, two-step delete, live preview.
- `web/src/components/PromptPicker.tsx:15-145, 200-247` — view-state machine; edit vs fork affordance.
- `server/src/prompts.ts:7-77` — server-side schema, for parity comparison with client validation.
- `AGENTS.md` — Tauri/Wry constraints requiring in-app modals (informs the two-step delete pattern).
