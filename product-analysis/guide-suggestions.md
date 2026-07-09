# Guide suggestions

## 1. Product reasoning & priority

Guide suggestions are the in-diff nudge: "you're reading code that calls
`foo` — review its definition in `other/file.ts` before moving on?" They're
the smallest concrete realization of the `IDEA.md` line "have AI guide you on
what to review next — short functions should come up for review automatically
when you review something that uses them." The implementation is deliberately
thin: a pure projection over per-hunk symbol metadata + cursor + read-progress
(`web/src/guide.ts`, `docs/concepts/guide-suggestions.md`). One suggestion at a
time, conservative triggers, dismiss-and-don't-show-again as a hard escape.

Suggested priority: **nice-to-have, leaning must-have.** This is the
mechanism that makes the review feel "guided" rather than passive scrolling.
But the implementation today is fragile: it depends on `definesSymbols` /
`referencesSymbols` being right on every hunk, and same-file calls are
deliberately skipped — which means on small diffs the prompt rarely fires.
Worth keeping; worth investing in once the symbol graph is LSP-grade.

## 2. Acceptance criteria for a rebuild

- A suggestion is at most one per render, keyed by
  `${fromHunkId}->${toHunkId}:${symbol}`
  (`docs/concepts/guide-suggestions.md`).
- A suggestion fires only when **all** of these hold
  (`web/src/guide.ts:21-60`):
  1. Cursor hunk has non-empty `referencesSymbols`.
  2. Cursor has reached or passed the first line in that hunk whose text
     contains the symbol (else the top of the hunk).
  3. Another hunk in **a different file** has the symbol in
     `definesSymbols`.
  4. That defining hunk's `hunkCoverage(otherHunk, readLines) <= 0.8`.
  5. The suggestion id is not in `state.dismissedGuides`.
- Accept (`Enter` / `y`) dispatches `SET_CURSOR` to the defining hunk;
  the suggestion is **not** added to `dismissedGuides` (it stops firing once
  coverage crosses 0.8) (`docs/concepts/guide-suggestions.md` § Interactions).
- Dismiss (`Esc` / `n`) dispatches `DISMISS_GUIDE`; the id persists in
  `dismissedGuides`, which lives in the localStorage-backed slice of
  `ReviewState` (`web/src/state.ts:116, 133, 423-425`).
- Same-file definitions are skipped (the prompt would just point at code
  already visible) (`web/src/guide.ts:38`).
- Palette predicate `hasSuggestion` gates `Enter` / `y` / `Esc` / `n` to
  guide-only — those keys do nothing when no prompt is up
  (`web/src/components/ReviewWorkspace.tsx:621`).
- Reason text is pre-tokenized into segments (`text`, `code`, `symbol`,
  `code-symbol`) via the view-model (`web/src/view.ts:744-764`); the
  presenter (`GuidePrompt`) renders segments without needing the live
  `SymbolIndex`.

## 3. Existing architecture & system design

### Data model

`GuideSuggestion` in `web/src/guide.ts:4-13`:

```ts
interface GuideSuggestion {
  id: string;             // ${fromHunkId}->${toHunkId}:${symbol}
  symbol: string;
  fromHunkId: string;
  toFileId: string;
  toHunkId: string;
  toLineIdx: number;      // first line mentioning the symbol, else 0
  reason: string;
}
```

`GuidePromptViewModel` in `web/src/view.ts:688-694`:

- `id`
- `segments: RichSegment[]` — `{ kind: "text" | "code" | "symbol" |
  "code-symbol" }`
- `targetCursor: Cursor` — pre-resolved jump target

Inputs come from two slices:

- **Per-hunk symbol metadata** on `Hunk` — `referencesSymbols`,
  `definesSymbols`, `exportedSymbols` (populated by `parseDiff` + the symbol
  graph; cross-language non-JS edges via the LSP code graph endpoint —
  `docs/concepts/symbol-graph-and-entry-points.md`).
- **Review state** — `cursor`, `readLines`, `dismissedGuides`. All three are
  part of the localStorage-backed slice (`docs/concepts/review-state.md`,
  via `persist.ts`).

### Current architecture decisions

- **No analysis of its own.** `maybeSuggest`
  (`web/src/guide.ts:21-60`) is a pure function over `(cs, state)` that
  looks at the cursor's hunk's `referencesSymbols`, scans other files'
  hunks for the matching `definesSymbols`, checks coverage, and returns
  one suggestion or null. Everything that improves the symbol graph
  improves the suggestion for free.
- **Coverage threshold of 0.8.** `hunkCoverage(otherHunk, state.readLines)
  <= 0.8` — once the reviewer has read ~80% of the defining hunk the
  prompt stops firing without ever being explicitly dismissed
  (`web/src/guide.ts:41`).
- **First-match wins.** The function returns on the first
  `(symbol, defining-hunk)` pair; it does not enumerate alternatives
  (`docs/concepts/guide-suggestions.md` § Trigger conditions).
- **Reason text is prose, tokenized late.** The reason is a sentence
  ("You're reading code that calls X. Review its definition in Y before
  moving on?") that the view-model splits into clickable segments by
  matching against the loaded `SymbolIndex`
  (`web/src/view.ts:701-742`). `RichText`'s identifier-link logic is the
  same logic; the guide tokenizer is a copy with backtick handling and
  symbol fallback so it can render without a live index.
- **Accept does not dismiss.** Jumping to the target is treated as "you're
  about to review it, no need to remember this prompt" — the coverage check
  naturally suppresses it next time
  (`docs/concepts/guide-suggestions.md` § Interactions).
- **Suggestion id has nothing to do with `Interaction.id`.** Guides are an
  ephemeral derivation; the only persistent shape they touch is the
  `dismissedGuides: Set<string>` slice of `ReviewState`.
- **No skill / prompt linkage today.** Despite the AGENTS.md hint about
  contextual skill loaders, guides don't propose prompts or skills — only
  navigation. The "Review this hunk with X prompt" affordance lives in
  `PromptPicker`, separately.

### How it evolved

The guide concept is older than typed-review-interactions; it was always a
projection over the symbol graph. The symbol graph itself went through three
iterations (`docs/concepts/symbol-graph-and-entry-points.md`):

1. **Per-hunk regex on changed files only.** Initial shape; matches
   `referencesSymbols` / `definesSymbols` we set in `parseDiff`. Same-file
   only, JS/TS-friendly, weak elsewhere.
2. **Symbol-backfill in the plan path.** `web/src/plan.ts:80-100` —
   restricts to code files (`isGraphAnalyzablePath`), scans for word-boundary
   matches in add/context lines to populate `referencedIn` when
   `referencesSymbols` is missing. Still regex.
3. **Server-resolved code graph via LSP.** `docs/plans/lsp-code-graph.md`
   ships PHP and JS/TS edges via `documentSymbol` + `references`, with a
   per-file LRU. The same data flows into the diagram; guide suggestions
   *could* read it, but `maybeSuggest` still reads the per-hunk
   `referencesSymbols` / `definesSymbols` fields rather than the
   server-resolved graph. That's the next iteration the docs hint at
   (`docs/concepts/guide-suggestions.md` § "no analysis of its own").

### Gaps

- **Reads per-hunk regex output, not LSP edges.** The LSP code graph endpoint
  produces accurate cross-file edges
  (`server/src/codeGraph.ts:308-394`), but `maybeSuggest` doesn't consume
  them — it walks `referencesSymbols` / `definesSymbols` on hunks
  (`web/src/guide.ts:30-40`). Non-JS guides depend on whatever regex
  populated those fields at parse time.
- **No proposal of prompts or skills.** The "guide" today only knows about
  jumping. The IDEA.md vision ("micro-skills, contextual skill loaders")
  isn't here — there's no path from "you're reviewing a Gutenberg block" to
  "want to run the Gutenberg-review prompt?". A `dismissedGuides`-style
  cousin for prompt suggestions would fit but doesn't exist.
- **One suggestion at a time, no inbox.** The function returns one or null.
  If a hunk references three out-of-file symbols, only one ever surfaces.
  A small list (with the same dismissal model) would let reviewers triage
  before committing.
- **Same-file is hard-coded as ignored.** The rationale ("you can already see
  it") is plausible but wrong for long files; a long-file heuristic
  (distance > N lines, etc.) would catch the gap.
- **Triggers on read-progress, not on intent.** The fire condition is purely
  spatial (cursor position + read coverage). An open `request` Interaction
  on the call site, for example, is invisible to the guide — it doesn't
  cross-reference the interaction store.
- **No telemetry on dismiss vs accept.** Without it there's no signal on
  whether the 0.8 coverage threshold and the "no same-file" rule are right.

## 4. Rebuild opportunities

### Data unification

- The `(fromHunkId, toHunkId, symbol)` triple of a `GuideSuggestion` is
  structurally an EvidenceRef pair: `{ kind: "hunk", hunkId: fromHunkId }`
  and `{ kind: "symbol", name, definedIn }`. Reusing `EvidenceRef[]` as the
  payload would let the guide reason segment, the claim citation, and the
  Interaction anchor all flow through the same `Reference` renderer.
- `dismissedGuides: Set<string>` is conceptually the same shape as
  "AI-note dismissals" pre-typed-review-interactions (the old `ackedNotes`).
  Lifting them to `Interaction { intent: "ack", target: "reply" }` against
  a synthetic `guide:<id>` thread-key family would unify dismissal with the
  acknowledgement seam — same persistence layer, same memo invalidation,
  no separate `Set<string>` slice.
- Guides, plan claims, and AI notes all share an "AI says: here's what to
  look at next" shape. A `Suggestion` interface with `{ anchor:
  EvidenceRef[], reason, action: "navigate" | "run-prompt" | "ack" }` would
  let the inbox view list them together.

### Better architecture

- **Read the LSP code graph.** `maybeSuggest` could query
  `cs.graph?.edges` instead of `referencesSymbols` / `definesSymbols` on
  hunks. Same algorithm, better data, automatic improvement on every new
  language module.
- **Promote skill / prompt suggestions to the same surface.** A guide that
  proposes a prompt is shaped like a navigation guide: anchor + reason +
  action. A `PromptSuggestion` type slotting in next to `GuideSuggestion`
  would extend the surface without doubling the chrome.
- **Move dismissal to the interaction store.** Drop `dismissedGuides`,
  emit a synthetic `Interaction { intent: "ack", threadKey:
  "guide:<id>", authorRole: "user" }`. Loses one persisted slice; gains
  audit history of dismissals.
- **Per-language hooks for "first call site".** The regex
  `hunk.lines.findIndex((l) => l.text.includes(symbol))`
  (`web/src/guide.ts:33`) is best-effort and breaks for methods (`foo.x()`
  finds `x` in any `.x`). An LSP-driven first-reference line would be
  exact.
- **Stop being one-shot.** A list of suggestions per hunk (still capped, say
  3) with one-key cycle through them.

## Sources

- `/workspace/docs/concepts/guide-suggestions.md`
- `/workspace/docs/concepts/symbol-graph-and-entry-points.md`
- `/workspace/docs/concepts/review-state.md` (referenced for
  `dismissedGuides`)
- `/workspace/IDEA.md:25-26, 33` — the original "guide me" framing
- `/workspace/web/src/guide.ts:1-60`
- `/workspace/web/src/state.ts:116, 133, 423-425` — `dismissedGuides`
  slice + `DISMISS_GUIDE` reducer case
- `/workspace/web/src/view.ts:674-764` — `GuidePromptViewModel`
- `/workspace/web/src/components/GuidePrompt.tsx:1-56`
- `/workspace/web/src/components/ReviewWorkspace.tsx:607-628, 778-790,
  1004-1010, 2115` — wire-up of suggestion / palette / GuidePrompt
- `/workspace/web/src/plan.ts:80-100` — regex backfill that populates the
  symbol references guides consume
- `/workspace/server/src/codeGraph.ts:308-394` — LSP-resolved edges
  guides could read but don't yet
