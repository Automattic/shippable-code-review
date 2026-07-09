# Code Runner

## 1. Product reasoning & priority

Shippable's bet is that review tooling should make reviewers *verify* claims rather than skim them. The in-browser runner is the most concrete expression of that bet: when an AI note says "this returns `undefined` for `[]`", the reviewer can press one button to see whether it actually does. It is also the most cost-effective way to honour the evidence principle for behavioural claims — the runner produces direct, repeatable proof rather than another AI paragraph. As a prototype, it differentiates Shippable from copilot-style commenters and IDE diff viewers: nobody else lets you `▷ verify` an AI note in-line.

Suggested priority: **must-have** — without it the product is "another diff viewer with AI comments," which the IDEA explicitly calls insufficient.

## 2. Acceptance criteria for a rebuild

- Detects language from the file path extension (`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs` → JS/TS; `.php`/`.phtml` → PHP) and lets the user override via a header select. Detection resets when the cursor moves to a different file (`CodeRunner.tsx:66-72`).
- Opens via three gestures:
  - `e` over the cursor hunk / block selection → ships the selection to the panel. The handler walks the current hunk's lines (or the selection range), filters out `del`-kind lines, joins the rest (`ReviewWorkspace.tsx:806-822`).
  - Free-runner button on the topbar (`freeOpen` prop, blank source seeded with a starter comment per language, edit mode forced).
  - `▷ verify` button on an AI note → ships the note's `runRecipe.source` and pre-fills `inputs` (`handleVerifyAiNote` at `ReviewWorkspace.tsx:1237`). The button is hidden when `runRecipe` is undefined; the AI note has to opt in.
- Parses the selection into one of three shapes via regex heuristics: `anon-fn`, `named-fn`, or `free` statements (`parseInputs.ts:32`). TS-flavoured regexes allow optional `<T>` generics and `: ReturnType` annotations between `)` and `{` / `=>` (`parseInputs.ts:84-100`).
- Derives input slots: function parameters (with TS type annotations stripped via `[:=][\s\S]*$`), or free identifiers / `$vars` minus keywords / globals (`parseInputs.ts:138`, `parseInputs.ts:202`). Strings and comments are blanked before identifier collection so `"console"` inside a string doesn't pollute the slot set.
- Renders a slot form in guided mode with naming-based placeholders (`placeholderFor` in `parseInputs.ts:47`); allows raw textarea edit in edit mode with `⌘+Enter` to run. Guided mode is the default for selection-driven opens; edit mode is forced for the free runner.
- Executes JS/TS in a sandboxed iframe (`allow-scripts`, no `allow-same-origin` → opaque origin) hosting an inner Worker, with a 2s timeout (`executeJs.ts:154`). TS is transpiled via esbuild-wasm in a separate locked-down worker (`ts-worker.ts`).
- Executes PHP via `@php-wasm/web-8-3` inside a Worker (`php-worker.ts`). Result, stdout/stderr, exit code surface back through ASCII-only markers (`~~RS:RESULT:BEGIN~~` / `END`, `~~RS:VARS:BEGIN~~` / `END`) so PHP's double-quoted string escapes don't corrupt detection (`executePhp.ts:127-132`).
- Worker network is locked down at the JS layer: same-origin only for `fetch` / `XHR`, all `WebSocket` / `EventSource` / sub-`Worker` / `SharedWorker` / `WebTransport` / `WebSocketStream` constructors throw (both workers, top of file). Lockdown is applied *before* any dynamic import so esbuild-wasm and `@php-wasm` fetch their own WASM under the guard.
- A `probe` message on either worker runs the same lockdown tests and reports `BLOCKED | NO_BLOCK` per surface — exposed as `probeWorker()` / `probeTsWorker()` for smokes (`executePhp.ts:69`, `executeJs.ts:108`).
- Iframe-side defense: opaque origin + per-run random token in postMessage so other frames on the page can't inject results (`executeJs.ts:156`, `:179`). The iframe is served from same-origin `/runner-sandbox.html` (page CSP allows it as a child frame) and then re-sandboxed without `allow-same-origin`.
- PHP `phpLiteral` decides whether the user's input is a number, boolean, quoted string, or array-literal — `2` stays an int, `"hi"` stays a string, `[1,2,3]` passes through raw (`executePhp.ts:228-243`).
- Returns `RunResult { ok, logs, result?, error?, vars? }`. The `vars` snapshot lets the panel show post-run values for free-shape inputs (mutation is visible). For function-shaped selections `vars` is omitted — those inputs are arguments, not visible at top level after the call.
- Result is ephemeral — nothing persists. Closing the panel or moving the cursor loses it.
- No emoji or fancy formatting — the panel is small enough to live next to the diff and stay out of the way.

### Hand-off shape from AI notes

The AI annotation pipeline mints an `Interaction` with `authorRole: ai`, `target: line`, ask intent (`question | request | blocker | comment`), and optionally a `runRecipe: { source, inputs }` (`web/src/types.ts:613`). The view layer projects it to `AiNoteRowItem.runRecipe` (`web/src/view.ts:984`). The Inline thread renderer shows a `▷ verify` button only when present; pressing it calls `onVerifyAiNote(row.runRecipe)` (`InlineLineThreads.tsx:87`, `InlineThreadStack.tsx:149`). `ReviewWorkspace.handleVerifyAiNote` bumps `runRequest.tick` and the panel opens with `inputs` pre-filled. Fixtures exercise three shapes: PHP timing-leak (`cs-99-verify-features.ts:490`), TS slugify edge case (`cs-99-verify-features.ts:569`), JS NaN currency (`cs-99-verify-features.ts:650`). The recipe is plain JSON — `source` is the code-to-run, `inputs` is the slot map keyed by parameter name (bare in the inputs object, `$`-prefixed only in the source for PHP).

## 3. Existing architecture & system design

### Data model

- `Lang = "js" | "ts" | "php"` and `RunnerShape = anon-fn | named-fn | free` — `web/src/runner/parseInputs.ts:10`.
- `ParsedSelection { lang, source, shape, slots }` — `parseInputs.ts:17`.
- `RunResult { ok, logs, result?, error?, vars? }` — `web/src/runner/executeJs.ts:22`.
- AI note → runner bridge: `Interaction.runRecipe?: { source, inputs }` — `web/src/types.ts:613`, propagated through `Interaction` → `AiNoteSignal` → `AiNoteRowItem` (`web/src/view.ts:794`, `view.ts:985`).
- Runner mount point: `<CodeRunner currentFilePath freeOpen onFreeClose runRequest />` in `ReviewWorkspace.tsx:2195`. `runRequest` is a `{ tick, source, inputs? }` triple where `tick` is the bump counter that the panel keys its open effect on (`CodeRunner.tsx:97`).

### Current architecture decisions

- **No QuickJS.** JS/TS runs in a sandboxed iframe (`<iframe sandbox="allow-scripts">`, served from `/runner-sandbox.html`) which posts a code blob to an inner `Worker`. Putting execution in a Worker means a `while(true){}` doesn't block the 2s timeout (`executeJs.ts:11-15`).
- **TS transpilation via esbuild-wasm**, in its own dedicated Worker (`ts-worker.ts`), not the executor. Cold start fetches the WASM same-origin once; the worker is cached as a module-level singleton (`executeJs.ts:62-88`).
- **PHP via `@php-wasm/web-8-3`** in a Worker (`php-worker.ts:91`). The package's `loadPHPRuntime` switches over eight PHP versions; importing the version-pinned package directly avoids bundling all of them (`php-worker.ts:88-99`). First run pays ~21MB WASM load; the runtime is module-level cached (`runtimePromise`).
- **Network lockdown lives at the JS layer**, not in CSP headers — `self.fetch` is replaced to reject cross-origin, `XMLHttpRequest.open` is monkey-patched, `WebSocket` / `EventSource` / `Worker` / `SharedWorker` / `WebTransport` / `WebSocketStream` constructors are replaced with throwing stubs (`php-worker.ts:12-76`, `ts-worker.ts:9-55`). The lockdown is applied before any dynamic import so esbuild and php-wasm fetch their own WASM under the guard. The `probe` handler lets smokes verify the lockdown is real.
- **Defense-in-depth on the iframe:** opaque origin (no `allow-same-origin`) + a per-run token in postMessage so other frames on the page can't inject results (`executeJs.ts:156`, `:179`).
- **Inputs are sticky** across runs and selection changes — slot keys that disappear just stop rendering, stale entries are harmless (`CodeRunner.tsx:86-90`).
- **Free runner vs selection-driven** is a single component with branching: free-runner pins panel at `top:56, right:24`; selection panels would otherwise want a DOM anchor, currently also pinned because the keyboard gesture leaves no DOM range (`CodeRunner.tsx:101-108`, `:177-179`).

### How it evolved

`docs/concepts/code-runner-model.md` is terse but captures the conceptual core: detect language from path, classify selection shape, extract slots, hand the UI enough structure for guided inputs. The repo does not yet have a separate plan doc for the runner — its evolution lives in source comments and fixtures (`web/src/fixtures/cs-09-php-helpers.ts:208`, `cs-99-verify-features.ts:18-20`). The verifier-from-AI-notes hook is documented as part of `docs/concepts/ai-annotations.md` (`runRecipe` on `Interaction`) and `docs/plans/typed-review-interactions.md`. The plan-symbols doc references the PHP worker as a sunk-cost asset that could be repurposed for memory-only PHP definition resolution (`docs/plans/plan-symbols.md:362`).

Several design decisions are recoverable only from source comments rather than docs:

- The `parent → iframe → inner Worker` topology for JS/TS (`executeJs.ts:1-15`) is justified explicitly: a Worker means a `while(true){}` doesn't block the iframe's `setTimeout`, so the 2s timeout is real instead of advisory.
- The "PHP worker uses ASCII-only markers" decision (`executePhp.ts:127-132`) is documented in code because PHP double-quoted strings don't interpret JSON's `\u` escapes — anything emitted via `JSON.stringify` of a control-character would arrive as literal text.
- The "skip slot reconcile on source change" choice (`CodeRunner.tsx:86-90`) trades a tiny memory leak (stale entries in the inputs map) for avoiding a cascading `setState` during render. Marked as deliberate.
- The "iframe loaded from same-origin, then sandboxed" trick (`executeJs.ts:160-164`) is needed because page CSP would block a blob-URL iframe; the sandbox attribute is what produces the opaque-origin posture.

### Persistence

There is none. The four pieces of state — `open` (panel visibility), `mode` (guided/edit), `inputs` (slot map), `result` (`RunResult`) — all live in `useState` inside `CodeRunner.tsx:74-78`. They reset on:

- closing the panel (Escape, the `×` button, the parent-driven `freeOpen → false`).
- moving the cursor to a different file (the `trackedFile` reset clears `manualLang` but leaves `open` intact — the panel persists until explicitly closed).
- a page reload (no localStorage, no SQLite, no session token).

The runner is the only major review surface that does not flow into either `persist.ts` (localStorage progress) or the SQLite `interactions` table. Even the prompt-run results have a state machine and panel (`web/src/promptRun.ts` / `PromptRunsPanel`) — runs are first-class. Runner verdicts are not.

### Gaps

- **Languages.** Only JS, TS, PHP. No Python, no Go, no Ruby, no SQL playground. Python in-browser (Pyodide) would round out the bet substantially because most AI-generated review claims touch Python data scripts.
- **Persistence.** `RunResult` lives in `useState` (`CodeRunner.tsx:78`) and disappears the moment the panel closes. Closing kills the only evidence the run produced. There's no audit trail, no "I already ran this and it passed," nothing the AI plan or sidebar coverage rail can read.
- **No flow back into Interactions.** A successful `▷ verify` of an AI note is silently equivalent to no action. The product principle is evidence-over-claims; the runner produces hard evidence and then throws it away. Nothing surfaces "this AI claim was verified" anywhere.
- **Parsing is regex-only.** TS type annotations are stripped with `[:=][\s\S]*$` (`parseInputs.ts:115`) — fine for prototypes, will misfire on conditional types, generics with `extends`, destructured params. PHP slot detection picks up any `$x` including the loop variable inside a `foreach` (`parseInputs.ts:202`), so the slot form sometimes shows fake inputs.
- **No I/O scaffolding.** Free-shape PHP can `echo`; free-shape JS captures the completion value via direct `eval` (`executeJs.ts:140`). There's no concept of mocking imports, stubbing globals, or injecting fixture data — so anything that touches `fs`, `fetch`, `process.env` either fails or returns the locked-down errors.
- **No worktree integration.** The runner has no access to the actual project's `node_modules` or `vendor/`. A snippet that calls `lodash.chunk` just fails. The runner is a sandbox island even when a worktree is mounted.
- **Cold start UX.** PHP first-run is ~21MB of WASM; nothing tells the user "loading PHP runtime" beyond "running…" on the button.

## 4. Rebuild opportunities

### Verify happens at the bottom, not the top

The most interesting feature of the runner is the `▷ verify` button on AI notes — that's where the product principle (evidence over claims) bites hardest. But there is no closing of the loop today:

- The user runs the snippet, sees the result, makes their own mental call about whether the AI's claim was right.
- Nothing tells the AI it was right or wrong.
- Nothing tells the *next* reviewer that this claim has already been verified.
- Nothing tells the PR's GitHub side (per the wire envelope in `docs/architecture.md`) that this thread should bump to `intent: accept` or `reject`.

The architecture for closing the loop already exists (Interactions store + wire envelope) — what's missing is the wiring from `setResult(r)` in `CodeRunner.tsx:166` to `dispatch({ type: "ADD_INTERACTION", ... })`. Cheap; high product leverage.

### Data unification

- **Make verify-runs first-class Interactions.** A successful `▷ verify` should mint an `Interaction` with `target: "reply-to-ai-note"`, `authorRole: "user"` (the reviewer pressed the button), `intent: "accept"` (the claim verified) or `"reject"` (it didn't), and a body carrying the `RunResult`. That seats runner verdicts in the same store as everything else (`web/src/interactions.ts`, `state.interactions`) and feeds:
  - the inbox / per-intent counts (`selectInteractions.byIntent`)
  - the GitHub round-trip envelope (`docs/architecture.md` § wire envelope — runner output becomes a glyph + sentinel)
  - the PR-level verdict logic ("≥1 open blocker without an accept response")
  - the agent channel (an agent that proposed the recipe sees its claim verified or rejected)
- **The runner could read symbols from the same source the def-nav uses.** Today the runner has no access to the worktree; the def-nav code path already mounts a workspace root and the LSP knows where the user's symbols are defined. A snippet that calls `chunk(items, 3)` could ask the LSP "where is `chunk`?", inline that source, then run.
- **Hand-rolled symbol resolvers** in `web/src/symbols.ts` (in-diff symbol index) and the regex-based slot detection in `parseInputs.ts` overlap conceptually with LSP `documentSymbol`. When a worktree is attached, both could call the same LSP through `LspClient.documentSymbol` (already shipped per `docs/plans/lsp-code-graph.md`) instead of running parallel regex heuristics.

### Better architecture

- **Persist runs to SQLite.** The interactions table (`server/src/db/`) already persists everything per `changeset_id`. Add a `runs` table (or shove `RunResult` inside an Interaction's body) keyed on `(changesetId, threadKey, runRecipeHash)`. Then "this AI claim was verified" survives reload, propagates to teammates over GitHub round-trip, and feeds coverage glyphs ("this line has been runner-verified"). Boring: the persistence pattern is already there.
- **Pull `RunResult` into the view-model layer.** Today `CodeRunner.tsx` owns the result locally. Move it to the same memoised `selectInteractions` seam (`docs/architecture.md` § Review interactions) so every consumer — sidebar count, inbox, diff-glyph rail — gets a chance to render "verified" decoration.
- **One worker per language, lazy-loaded.** Today TS transpile + JS execute + PHP execute is three workers. The dispatcher pattern from `docs/plans/plan-symbols.md` ("Dispatcher: where the click goes") is the same shape — a `LanguageRunner` interface with `canRun(file) / run(parsed, inputs) → RunResult`, declared in a `languages/runners/<id>.ts` module, picked the same way the def-nav picks a `DefinitionResolver`. Adding Python becomes one file (`runners/python.ts` → Pyodide worker) instead of a refactor.
- **Stop running TS transpile through a separate worker.** esbuild-wasm has a ~1.2MB cold cost; the runner could either ship Sucrase (~50KB, no WASM, JS-only) for the prototype level of fidelity we need, or call the TS-server LSP that's already running for click-through and ask it to emit the JS. Boring beats clever — Sucrase is the boring choice.
- **Surface worker network probes in the settings panel.** Today `probeWorker()` is test-only (`executePhp.ts:69`, `executeJs.ts:108`). Wire it to the credentials/settings panel as a one-click "verify sandbox" affordance so users can confirm the lockdown is real before pasting in code that touches secrets.
- **Cold-start UX.** Pre-warm the PHP runtime on first `.php` hunk *seen*, not on first `▷ run`. Same trick `useWorktreeLoader.ts:113` uses for `warmCodeGraph` — move the wait to a moment the user expects ("worktree opening...") instead of a click ("why is this so slow?").
- **Replace regex slot detection with an AST pass.** TS regex `[:=][\s\S]*$` for type stripping (`parseInputs.ts:115`) misfires on `Array<{x: number}>`, conditional types, mapped types. esbuild-wasm is already loaded in the same worker — its parser surface is exposed; one pass through `parse({ loader: "ts" })` and the param list is exact. PHP slot detection can call `php_parser` (also already in the worker after the first PHP run).
- **Distinguish "this AI claim verified" from "this AI claim was ack-clicked."** Today both produce no signal. A runner-derived `ack` should carry richer provenance than a manual one — runtime fingerprint, RunResult diff, timestamp — so an agent re-reading the thread later can tell a hands-on verification from a vibe-check ack. The Interaction body schema is the right place.
- **Stop pinning the free runner near the topbar.** The selection-driven open also pins because `anchor:null` (`CodeRunner.tsx:101-108`). A small change: anchor to the cursor line's DOM rect on open. The current "we don't have a live DOM range" justification is true only because the keyboard gesture doesn't compute one — `ReviewWorkspace` already knows the cursor line, it just doesn't pass the rect.
- **Stop bundling all `@php-wasm` version packages.** The runner uses `@php-wasm/web-8-3` directly (`php-worker.ts:91`) precisely to avoid pulling `loadWebRuntime`'s switch over eight PHP versions. Keep that discipline; if PHP 8.4 lands, do the same. Boring beats clever.

## Sources

- `web/src/runner/executeJs.ts` — iframe + Worker sandbox, esbuild-wasm pipeline, runtime contract.
- `web/src/runner/executePhp.ts` — PHP marker protocol, slot binding, stdout parser.
- `web/src/runner/parseInputs.ts` — language detection, shape parsing, slot extraction, placeholder heuristics.
- `web/src/runner/ts-worker.ts` — TS transpile worker + network lockdown.
- `web/src/runner/php-worker.ts` — PHP runtime worker + network lockdown.
- `web/src/components/CodeRunner.tsx` — panel UI, mode toggle, slot form, run dispatch, result rendering.
- `web/src/components/ReviewWorkspace.tsx:274-277, 819-822, 1237-1246, 2195-2200` — `runRequest` state, `e` action, `handleVerifyAiNote`, mount.
- `web/src/types.ts:612-613` — `Interaction.runRecipe`.
- `web/src/view.ts:790-797, 984-986` — `runRecipe` on `AiNoteRowItem`.
- `web/src/fixtures/cs-09-php-helpers.ts:208`, `cs-99-verify-features.ts:18-20, 490, 569, 650` — fixture-shaped recipes.
- `docs/concepts/code-runner-model.md` — terse conceptual doc.
- `docs/concepts/ai-annotations.md` — `runRecipe` field on AI-authored Interactions.
- `docs/plans/typed-review-interactions.md` — Interaction wire envelope (where runner verdicts could plug in).
- `docs/plans/plan-symbols.md:362-401` — sunk-cost PHP worker noted as the basis for memory-only PHP analysis.
