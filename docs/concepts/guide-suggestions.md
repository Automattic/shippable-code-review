# Guide Suggestions Model

## What it is
The mechanism behind the "you're calling a symbol defined elsewhere in this diff — want to jump?" prompt that appears next to the diff. See `web/src/guide.ts` for the implementation.

## What it does
- Watches the cursor and the per-hunk symbol metadata produced by the symbol graph.
- Computes at most one suggestion per render, keyed by `${fromHunkId}->${toHunkId}:${symbol}`.
- Suppresses suggestions whose target the reviewer has already mostly read or explicitly dismissed.
- Hands the suggestion to `GuidePrompt`, which renders it next to the diff with jump/dismiss affordances.

## Inputs
A suggestion is derived from two pieces of state, both already on `ChangeSet` / `ReviewState`:

- **Hunk symbol metadata** — `referencesSymbols` and `definesSymbols` on each hunk. Populated upstream by the symbol graph (see [Symbol Graph And Entry Points](./symbol-graph-and-entry-points.md)). The guide does no analysis of its own; it consumes what's already there.
- **Review progress** — the cursor (`fileId`, `hunkId`, `lineIdx`), `readLines`, and `dismissedGuides`. All three are part of the persisted slice of `ReviewState` (see [Review State](./review-state.md)).

## Trigger conditions
A suggestion is returned only when **all** of these hold:

1. The hunk under the cursor has a non-empty `referencesSymbols`.
2. The cursor has reached or passed the first line in that hunk whose text contains the symbol. If no line matches, the trigger is the top of the hunk. This keeps the nudge from firing before the reviewer has actually seen the call site.
3. Another hunk in **a different file** of the same changeset has the symbol in its `definesSymbols`. Same-file definitions are ignored — they're already visible nearby.
4. That defining hunk is still mostly unread: `hunkCoverage(otherHunk, readLines) <= 0.8`.
5. The suggestion ID (`${fromHunkId}->${toHunkId}:${symbol}`) is not in `dismissedGuides`.

The first matching `(symbol, defining-hunk)` pair wins; the function does not enumerate alternatives.

## Output shape
```ts
interface GuideSuggestion {
  id: string;             // ${fromHunkId}->${toHunkId}:${symbol}
  symbol: string;
  fromHunkId: string;
  toFileId: string;
  toHunkId: string;
  toLineIdx: number;      // first line in target hunk that mentions the symbol, else 0
  reason: string;         // human-readable prompt text
}
```

## Interactions
`GuidePrompt` shows the suggestion with two affordances, both wired through the command/keybinding layer in `ReviewWorkspace.tsx`:

- **Accept** (`Enter` or `y`) — dispatches `SET_CURSOR` to `(toFileId, toHunkId, toLineIdx)`. The suggestion is **not** added to `dismissedGuides`; it will simply stop firing once `hunkCoverage` of the target crosses 0.8.
- **Dismiss** (`Esc` or `n`) — dispatches `DISMISS_GUIDE` with the suggestion ID. The ID is added to `dismissedGuides` and persists across reloads via localStorage.

The palette predicate `hasSuggestion` exposes presence of a suggestion to the keybinding layer so `Enter`/`y`/`Esc`/`n` only bind while a prompt is up.

## Persistence
`dismissedGuides: Set<string>` is part of the localStorage-backed slice of `ReviewState` (alongside `cursor`, `readLines`, `reviewedFiles`, drafts). Dismissals therefore persist per-device, per-changeset; they do not roam with sign-off or interactions, which live elsewhere. See [Local Session Persistence](./local-session-persistence.md).

## Why it's shaped this way
- **No analysis of its own.** Guide suggestions are a thin projection over the symbol graph. Anything that improves cross-file symbol metadata (LSP-backed references, better regex fallback) automatically improves the prompt without touching `guide.ts`.
- **Conservative trigger.** Requiring the cursor to have passed the call site, and the target to be under 80% read, keeps the prompt rare. The nudge is meant to catch reviewers losing the thread, not to be a navigator.
- **Same-file definitions skipped on purpose.** A prompt to jump within the file you're already reading is noise.
