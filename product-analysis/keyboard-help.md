# Keyboard help

## 1. Product reasoning & priority

Shippable is built for keyboard-first review — the whole "stay engaged, move deliberately" framing depends on the reviewer not reaching for the mouse. The keyboard-help overlay is the recovery surface for that contract. It exists to answer "I forgot which key does X, and I don't want to break flow to search for it." The overlay also doubles as a learning surface for first-time users: the legend at the bottom explains the AI-glyph alphabet (`! ? i ✓ "`), which the diff view depends on. A contextual top section makes the overlay double-task: when there's an active selection, it shows selection-relevant keys first; when the cursor is on an AI-noted line, it shows the note-management keys; otherwise it shows app-level actions.

**Priority: must-have, in the form of a help-overlay + a single shortcut registry.** Without a keymap registry the project has no source of truth for what shortcuts exist — every component would invent its own listener. The overlay UI itself is small; the registry is the load-bearing part.

## 2. Acceptance criteria for a rebuild

- Single source of truth for shortcuts lives at `web/src/keymap.ts` as `KEYMAP: KeyEntry[]`. Each entry carries `key, shift?, meta?, ctrl?, label, group, action, when?, palette?`.
- `KEYMAP` is iterated by both the dispatcher (`ReviewWorkspace.tsx:957-964` — first match wins) and the help overlay (`HelpOverlay.tsx:50-69` — collapse by `(action, label)`).
- `KEYMAP.find` order matters: shift-extend arrow variants must precede plain arrow entries so `Shift+ArrowDown` doesn't fall through to plain "next line." See `keymap.ts:78-85`. Likewise, `n`/`N` for next-comment must sit **after** the guide-dismiss `n` so the guide entry's `when: "hasSuggestion"` predicate gets first shot (`keymap.ts:109-117`).
- Entries with `when` are only fired when the named predicate is true at dispatch time. Predicates are evaluated in `ReviewWorkspace.tsx:620-628` (`palettePredicates`): `hasSuggestion`, `lineHasAiNote`, `hasSelection`, `hasPlan`, `hasPicker`, `hasCommandPalette`, `hasChangesetToken`.
- `?` toggles the overlay. While the overlay is open, only `?` and `Escape` are accepted (`ReviewWorkspace.tsx:936`).
- The overlay renders as a modal dialog: `role="dialog" aria-modal="true" aria-labelledby="help-title"`. Clicking outside the box closes it; clicking inside does not (`HelpOverlay.tsx:93-100`).
- An optional `context` prop seeds a "right now" section above the main table: a title + rows of `{ chord, label }` + an optional hint paragraph. When `context.rows.length === 0` the section is skipped entirely.
- The "right now" copy is chosen by `buildHelpContext` (`ReviewWorkspace.tsx:2663-2737`) from four mutually exclusive states: (a) selection active, (b) AI note on cursor line, unacked, (c) current file fully read but not signed off, (d) default "app-level actions" fallback.
- The main table groups entries by `KeyGroup` in the order: `navigation`, `review`, `guide`, `ui`. `testing` is rendered as a separate trailing table, with a one-off row documenting `?cs=<id>` (URL-param to load a fixture by id).
- A gutter-glyph legend table appears between the main table and the testing table, documenting `! ? i ✓ "` and tying them to the relevant key (`a` toggles the ack `✓`).
- Two free-text hints follow: one points at `⌘k`/`⌃k` for the command palette; one explains the read-mark / `⇧m` separation.
- Chord rendering: `chordLabel(key, mods)` produces strings like `⇧j`, `⌘k`, `Esc`, `↑`. Multiple chords aliased to the same action are joined with `/` and each segment is wrapped in `<kbd>` (`HelpOverlay.tsx:33-69, 73-80`).
- Aliased rows merge by `(action, label)` — `j`/`ArrowDown` collapse to one row `j/↓`. (`HelpOverlay.tsx:50-69`.)
- `Esc` always closes the overlay. (Documented at the foot: "Esc to close." — `HelpOverlay.tsx:187-189`.)

## 3. Existing architecture & system design

### Data model

- `KeyEntry` — the shortcut record. Fields: `key`, `shift?`, `meta?`, `ctrl?`, `label`, `group`, `action`, `when?`, `palette?` (`keymap.ts:58-74`).
- `ActionId` — exhaustive string union of dispatchable actions (`keymap.ts:9-45`). 38 entries today.
- `ContextPredicate` — names of runtime gates (`keymap.ts:47-54`).
- `KeyGroup` — five groups (`keymap.ts:56`).
- `HelpContextSection { title; rows: { chord; label }[]; hint? }` (`HelpOverlay.tsx:3-13`).

### Current architecture decisions

- **`KEYMAP` is iterated, not indexed.** Lookup is `KEYMAP.find(km => key/shift/meta/ctrl match && (when ? predicates[when] : true))` (`ReviewWorkspace.tsx:957-964`). First match wins, so entry order encodes priority.
- **Predicate naming is by string, not closure.** `KEYMAP` is a pure data table — entries reference predicates by name (`when: "hasSuggestion"`) — and the consumer resolves them. Lets `keymap.ts` stay free of React/state imports.
- **Dispatcher and overlay share the table.** No duplicate "list of keys" in the help overlay; it walks the same `KEYMAP` via `groupRows(group)` (`HelpOverlay.tsx:50-69`).
- **The shift convention is opinionated.** `J` (shift+j) is registered with `key: "J", shift: true`, not `key: "j", shift: true`. The "uppercase letter implies shift" approach was rejected (commit `94f3813`, "render shift-J / shift-K with the ⇧ glyph") — every shift entry now uses the explicit modifier flag so the help table reads consistently (`⇧j` next to `⇧m`).
- **Browser-native focus is preserved.** `Tab` is left alone for accessibility; file navigation moved to `]/[` (commit `878cb86`). The cycle-sample-changeset keys use `{`/`}` instead.
- **`palette: "global"`** is a flag for the command palette, not the help overlay. Marks entries that the palette can surface as app-level commands.
- **The overlay is rendered conditionally on `showHelp`** in `ReviewWorkspace.tsx:2298-2312`. The overlay is mounted/unmounted, not toggled via CSS — its own keydown handling is moot since the parent's listener gates on `showHelp` (`ReviewWorkspace.tsx:936`).
- **Two free-text hint paragraphs at the bottom are hard-coded markup** (`HelpOverlay.tsx:179-186`). They reference specific chords (`⌘k`, `⇧m`) that also live in the registry — duplication that drifts if the registry changes.

### How it evolved

- `622cd38` (`feat: improve keybinding discoverability`) set up the original overlay + registry-driven help table.
- `c3ff938` added the gutter-glyph legend.
- `1c88882` added the visible close button + Esc hint.
- `037201a` made the overlay accessible: `role="dialog"`, labelledby.
- `94f3813` rationalized the shift convention to `⇧X` everywhere.
- `3bd5eff` fixed duplicate React keys in chord rendering.
- `f1a1f24` added the `hasChangesetToken` predicate.
- `b3f632d` added the `palette: "global"` flag.
- `13f67e2` added `f` to toggle the sidebar.
- `572aa83` / `a1f16be` renamed the `i`-key action and reframed it.
- `b626733` added `n`/`N` for next/previous comment.
- The contextual "right now" section is the most recent layer — `buildHelpContext` lives in `ReviewWorkspace.tsx:2663-2737`. It's a runtime-built section, not part of `KEYMAP`.

### Gaps

- **`KEYMAP.find` is O(N) per keystroke.** 40-ish entries, fine in practice, but a `Map` keyed on a chord-string + predicate-evaluation pass would be O(1).
- **Predicates are wired by name string.** A typo in `when: "hasSuggestio"` would silently never fire; there's no compile-time check that every `ContextPredicate` is implemented in `palettePredicates`. Vice-versa: an unused predicate stays compiled.
- **Two free-text help hints duplicate registry knowledge** (`HelpOverlay.tsx:179-186`). If the keybinding changes, the hint rots.
- **Contextual section logic lives in `ReviewWorkspace.tsx`, not in `keymap.ts`.** Four `if`-cascades, each mentioning specific chords as literal strings. Drift risk identical to the hint problem.
- **No way to discover a key from the action.** `KEYMAP` is keyed by chord; if you have an `ActionId` (say, you want to render "press X to do Y" in a banner), you walk the array. A `keysFor(action: ActionId): string[]` helper doesn't exist.
- **No "this entry is disabled because…" surfacing.** When a `when: "hasSuggestion"` entry doesn't fire, the user has no signal as to why. The help overlay shows it as available; pressing it silently no-ops.
- **Dispatcher tests are thin.** The single `HelpOverlay.test.tsx` checks contextual rendering but not the predicate-gate behaviour or the priority ordering. A regression in entry order (the `n` next-comment vs. `n` dismiss-guide ordering is fragile) would slip.
- **No `⌘?` / `⇧?` variant** — the `?` key on US English requires shift, so the actual keystroke is `Shift+/`. The entry is `{ key: "?", … }` with no `shift` flag, meaning the browser fires `key === "?"` regardless. Works in practice but reads as a footgun.
- **`?cs=<id>` documented as a "testing" row** but isn't a keybinding — it's a URL param. Putting it in the same table as keystrokes blurs the contract.

## 4. Rebuild opportunities

### Data unification

- **`HelpContextSection.rows: { chord; label }[]`** is structurally identical to what `groupRows` produces. Reuse one row type across both consumers.
- **`buildHelpContext`'s rows could come from KEYMAP.** Today the contextual section hard-codes chord strings. If `KEYMAP` entries carried a `whyTag` or the contextual builder pulled rows by `action` lookup, the chords would stay in sync automatically.
- **Move the gutter-glyph legend onto the AI-note projection.** `AiNoteSeverity` already enumerates `info | question | warning`, and `aiGlyph` is computed in `view.ts`. The legend in `HelpOverlay.tsx:139-163` hard-codes the mapping a second time. One shared `severityGlyph(severity)` + an `ackedGlyph` constant removes the dup.
- **`palette: "global"` is an enum-of-one.** Either expand it (palette categories: `"global" | "diff" | "review" | "testing"`) or drop it and use the existing `group` field.

### Better architecture

- **Replace `KEYMAP.find` with a precomputed index.** Build once: `chordIndex: Map<chordString, KeyEntry[]>`. Dispatch becomes "find the first entry whose `when` is satisfied." Wins on perf only marginally but reads clearer.
- **Bind predicates at compile time, not by string.** `KEYMAP` could carry `when?: (ctx: PredicateContext) => boolean`. `ContextPredicate` becomes a TS union of context-bools and `KEYMAP` references named closures. No magic strings.
- **`keysForAction(action): { primary: string; aliases: string[] }`** — let callers (status bar hint, contextual help, command palette) ask "what's the key for X?" instead of hard-coding it. The status bar's `DEFAULT_HINT` (`view.ts:617`) and `buildHelpContext`'s row-strings are the obvious consumers.
- **Move `buildHelpContext` into `keymap.ts`** (or a new `helpContext.ts`). Today it lives in the orchestrator alongside ~2700 lines of other concerns. As a small pure function it has no business there.
- **Treat the contextual section as a *filter* over KEYMAP rather than a hand-curated list.** Each entry could carry a `contexts: ContextPredicate[]` field; the contextual section asks "which entries are valid right now?" and shows the top few.
- **Add tests for entry order.** Snapshot a few priority pairings (`Shift+ArrowDown` vs `ArrowDown`, `n` with vs without `hasSuggestion`) so a future reorder is caught.

## Sources

- `/workspace/web/src/keymap.ts` (full, 146 lines).
- `/workspace/web/src/components/HelpOverlay.tsx` (full, 193 lines).
- `/workspace/web/src/components/HelpOverlay.test.tsx` (full, 30 lines).
- `/workspace/web/src/components/ReviewWorkspace.tsx:616-628, 670-851, 929-993, 2298-2312, 2663-2737` — predicate evaluation, action dispatch, key handler, overlay mount, contextual section builder.
- `/workspace/web/src/components/Demo.tsx:1514` — second consumer of `KEYMAP.find` (demo route).
- `/workspace/web/src/view.ts:617` — `DEFAULT_HINT` duplicates the registry's chord strings.
- `/workspace/docs/features/keyboard-help.md`.
- Commits: `622cd38`, `c3ff938`, `1c88882`, `037201a`, `94f3813`, `3bd5eff`, `f1a1f24`, `b3f632d`, `13f67e2`, `572aa83`, `a1f16be`, `b626733`, `878cb86`.
