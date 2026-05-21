# Inline Interactions — Right-Side Comment Column

Revises the comment rail from `decouple-and-comment-rail.md`. Addresses
testing feedback on the just-shipped left-most comment rail.

## Problem

The comment rail shipped as a **left-most grid column** (`line__rail`, a
leading `22px` column added to the `.line` grid via `hunk__body--rail`). Three
issues:

1. **Layout bug — code renders in the wrong column.** A leading grid column
   requires every line renderer (`Line`, `ContextLine`, the full-file
   renderer) to emit a rail cell *and* its container to carry the
   `hunk__body--rail` class, in lockstep. When they desynchronise, a line
   emits 6 children into a 5-column grid; CSS grid auto-flow wraps the 6th
   child — the code text — onto the next row at column 1, i.e. under the rail.
2. **The affordance is unclear.** A bare `💬` emoji button gives no hint of
   what it does.
3. **Wrong side.** It should be on the right, not the left.

## Goal

Replace the left-most rail with a **right-most comment column** carrying a
clear `+ comment [c]` text affordance, implemented so the grid cannot
misalign.

## Design

### The column

- **Remove** the left rail entirely: the `line__rail` leading column, the
  `line__rail-bubble` `💬` button, and the `hunk__body--rail` left-column
  grid override.
- Add a **right-most fixed-width column** to the diff line grid. When inline
  comments is on, `.line`'s `grid-template-columns` becomes
  `40px 40px 14px 16px 1fr 96px` (the existing five columns — old #, new #,
  AI-glyph, sign, code — unchanged, plus a trailing `96px` comment column).
  When inline comments is off, the grid is the original five columns.
- Gate the column with a container class (e.g. `hunk__body--comment-col`) on
  the `hunk__body`, exactly as the rail did — but now it adds a *trailing*
  column.

### The affordance

- On the **cursor line**, the comment column's cell holds a `<button>` whose
  visible text is **`+ comment`** with a **`[c]`** shortcut hint (a real text
  button — no emoji). `aria-label` / `title`: "comment on this line".
- Every other line's comment-column cell is empty (the column still reserves
  its `96px` so the diff body never reflows as the cursor moves).
- Clicking the button starts a comment on the cursor line — it calls the same
  new-comment handler the `c` key uses (`onStartNewComment`), and
  `stopPropagation`s so the delegated `hunk__body` drag handler ignores it.
- The `c` keybind is unchanged.

### Grid alignment — the safeguard

The left-rail bug was a desynchronised grid. To prevent recurrence:

- Every line renderer under `.hunk__body` (`Line`, `ContextLine`, the
  full-file line renderer) appends the trailing `<span className="line__comment">`
  cell when the comment column is on — so the child count always matches the
  column count.
- A unit test asserts that, with the comment column on, a rendered diff line
  has its `.line__text` (code) as the expected grid child and the
  `.line__comment` cell trailing it — i.e. the code is not displaced. This
  test pins the alignment for all three renderers.

### Pointer handling

The delegated `hunk__body` pointer handler disambiguates by element class
(`.line__text`, `[data-symbol]`, `[data-line-idx]`), not by column index, so a
trailing column does not affect it. The comment `<button>` keeps its
`onClick` + `onPointerDown` `stopPropagation` so a click on it is never taken
as a line-range drag.

## Affected code

| Area | Change |
|------|--------|
| `web/src/components/DiffView.tsx` | Replace the `line__rail` leading cell + `💬` bubble with a trailing `line__comment` cell in all three line renderers; the cursor line's cell holds the `+ comment [c]` text button. Rename the gate (`railOn` → e.g. `commentColOn`). |
| `web/src/components/DiffView.css` | Replace the `hunk__body--rail` leading-column override and `line__rail*` rules with a trailing-column override (`40px 40px 14px 16px 1fr 96px`) and `line__comment*` rules. |
| `web/src/components/DiffView.test.tsx` | Update the rail tests for the new column + add the grid-alignment test. |

## Testing

- **Unit:** the comment column renders only when inline comments is on; the
  `+ comment [c]` button appears on the cursor line only; clicking it invokes
  the new-comment handler; the grid-alignment test (code text not displaced)
  for each line renderer.
- **E2e (journey 6):** with inline comments on, the right-side `+ comment [c]`
  button is visible on the cursor line and clicking it opens a comment
  composer. Update the existing rail-bubble e2e assertion to the new button.

## Out of Scope

- Hover-to-comment on non-cursor lines — the button stays cursor-line-only.
- Changes to the decoupled toggles, the threading model, hunk-level / detached
  rendering, or `hideNonActiveComments`.

## Open Questions Resolved

- **Side** — right-most column (was left).
- **Affordance** — a `+ comment [c]` text button (was a `💬` emoji).
- **Width trade-off** — the `96px` column shrinks the code area while inline
  comments is on; accepted.
- **Visibility** — cursor line only; the column reserves width on every line
  so cursor moves do not reflow the diff.
