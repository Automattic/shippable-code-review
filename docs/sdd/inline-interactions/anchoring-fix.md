# Inline Interactions — Cursor-Line Anchoring Fix

Follow-up to the inline-interactions feature (`spec.md`, `plan.md`,
`implementation-notes.md` in this folder). Addresses testing feedback.

## Problem

Inline mode reuses the `Inspector`'s **hunk-scoped** view-model and renders the
whole stack beneath the cursor line: every AI note and every comment thread in
the hunk, plus "AI concerns in this hunk" / "Your comments" section headers,
counts, and "No AI notes" / "No user comments" empty-state boxes.

Consequences reported from testing:
1. A comment thread (and its empty-state box) renders even when the cursor's
   line has no comments.
2. Comments for lines *other than* the focused line show up under the cursor
   line, because the render is hunk-scoped, not line-scoped.

## Goal

In inline mode, the box beneath the cursor line shows only what belongs to
**that one line**, with no hunk-level chrome, and nothing at all when the line
has no interactions.

## Behaviour

### Line-anchored interactions (the cursor line's box)
- Render only the AI note(s) anchored to the cursor line and the user comment
  thread(s) on the cursor line — as **bare cards**, with no "AI concerns" /
  "Your comments" section headers, no counts, no "next note" jump button.
- A **block comment** (multi-line range) renders while the cursor is anywhere
  **within its line range**, not only on its anchor line.
- A slim **"+ comment on this line"** button is always present under the
  cursor line — a real focusable `<button>`, so keyboard cursor-navigation
  (arrows, `n`/`N`) surfaces it on every line. Pressing `c` opens the inline
  draft composer as today.
- If the cursor line has no AI notes and no comments, the box contains **only**
  that slim button — no empty placeholders, no headers, no counts.
- This applies to **AI notes as well as comments** — both have the hunk-scoped
  bug today.

### Hunk-level interactions (AI summary, teammate verdict)
- Currently rendered in the hunk **header** (`.hunk__inline-threads`).
- Move them to render **below the hunk body**, shown when the cursor is on a
  line within that hunk (already the case — `inlineThreads` only reaches the
  cursor's hunk).
- This also removes the documented sticky-header-overlap limitation (the
  header is `position: sticky`; a block below the body is not covered).

### Detached threads
- Detached threads (comments whose anchored line no longer exists in the diff)
  have no line to anchor to.
- Render them in a block at the **bottom of the diff**, after the last hunk,
  whenever the file has detached threads in inline mode. Not cursor-gated — it
  has no line and does not move.

### Unchanged
- Panel mode (`Inspector`) is untouched — it keeps the full hunk-scoped view
  with section headers.
- The cursor-driven, one-line-at-a-time model (only the cursor line's box is
  shown) is unchanged — this fix only narrows the *scope* of that box from the
  hunk to the line.

## Implementation Approach

The inline per-line box (bare, cursor-line-scoped) has diverged enough from the
panel (hunk-scoped, section headers, counts) that flagging both behaviours onto
`InlineThreadStack` would make one component do two unrelated jobs.

- **New `InlineLineThreads` component** — renders the cursor line's bare AI-note
  and comment cards plus the slim "+ comment" button. Reuses the existing leaf
  cards (`NoteCard`, `UserThreadCard`, `ReplyThread`). It may live alongside
  those cards in `InlineThreadStack.tsx` to avoid export churn, or be its own
  file with the cards exported — whichever keeps the panel (`Inspector`) path
  untouched and safe.
- `DiffView` swaps its line-anchored render from
  `<InlineThreadStack sections="line-anchored">` to `<InlineLineThreads>`.
- The `"line-anchored"` value of `InlineThreadStack`'s `sections` prop becomes
  unused once `DiffView` no longer uses it; remove it. The panel keeps `"all"`;
  the hunk-level render keeps `"hunk-level"`.
- **Hunk-level position**: move the `.hunk__inline-threads` block in `DiffView`
  from after the hunk header to after the hunk body. Update / simplify the
  related CSS (drop the sticky-overlap caveat comment).
- **Detached block**: `DiffView` renders a detached-threads block after the
  last hunk when `inlineThreads` is present and `vm.detachedThreads` is
  non-empty, reusing `DetachedThreadCard`.

### Data
No data-model or view-model changes. The `InspectorViewModel` already carries
everything `InlineLineThreads` needs:
- `aiNoteRows` / `userCommentRows`, each with `lineIdx` (and `rangeHiLineIdx`
  for block comments) — filter to the cursor line.
- `showNewCommentCta`, `currentLineCommentKey`, `currentLineNo`,
  `showDraftStub`, `draftStubRow` — already current-line-scoped; drive the
  "+ comment" button and the inline draft composer.
- `detachedThreads` — drive the bottom-of-diff block.

The cursor line index is `state.cursor.lineIdx`, already available where
`DiffView` mounts the inline render.

## Filtering rules
- **AI note**: include when `row.lineIdx === cursorLineIdx`.
- **User comment**: include when
  `cursorLineIdx >= row.lineIdx && cursorLineIdx <= (row.rangeHiLineIdx ?? row.lineIdx)`.
- **"+ comment" button / draft composer**: use the VM's existing
  current-line CTA / draft-stub fields as-is.

## Testing
- Update `InlineThreadStack` / `DiffView` unit tests:
  - cursor line with an AI note → only that note renders, no headers;
  - cursor line with no interactions → only the "+ comment" button renders,
    no empty placeholders;
  - block comment renders while the cursor is within its range;
  - hunk-level threads render below the hunk body, not in the header;
  - detached threads render in a block at the bottom of the diff.
- Update the journey-6 e2e block: a non-noted cursor line shows only the
  "+ comment" button (no thread); add coverage for the hunk-level position and
  the detached block as needed.

## Out of Scope
- Panel-mode (`Inspector`) behaviour — unchanged.
- Option 2 ("every line with comments shows its own thread, all visible") and
  hover-to-reveal — considered during brainstorming, not chosen for this fix.
- Data-model, persistence, or agent-queue changes.
