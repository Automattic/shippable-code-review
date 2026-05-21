# Inline Interactions — Decoupled Toggles & Comment Rail

Follow-up to the inline-interactions feature (`spec.md`, `anchoring-fix.md`,
`comment-threading.md` in this folder). Addresses two pieces of testing
feedback.

## Problem

1. **The Inspector and inline comments are conflated.** The original feature
   made them one mutually-exclusive `interactionViewMode: "panel" | "inline"`
   toggled by `i`. But the Inspector carries more than comments (agent
   context, PR data, hunk summaries) — turning on inline comments by hiding
   the Inspector throws that away. The two should be independent.

2. **The "+ comment" affordance reflows the diff.** It renders as a button in
   an inline region beneath the cursor line, so every cursor move adds /
   removes / relocates that region — the whole diff body shifts as you
   navigate line to line.

## Goal

- The `i` key opens/closes the Inspector, as it did before this feature.
  Inline comments become a separate, independently-toggled mode.
- The "+ comment" affordance lives somewhere that does not reflow the diff as
  the cursor moves.

This supersedes the original design's "panel OR inline, mutually exclusive"
decision (`spec.md` § Requirements 1).

---

## Part 1 — Decouple the Inspector and inline comments

### Two independent preferences

The `interactionViewMode` enum is removed. Two independent, persisted booleans
replace it:

| Preference | Controls | Toggled by | Default |
|------------|----------|-----------|---------|
| `showInspector` | the Inspector side panel | the `i` key, the topbar action | shown (`true`) |
| `inlineComments` | inline interaction rendering in the diff | a new `Shift+I` key, the Settings control | off (`false`) |

- They are fully independent — any of the four combinations is valid.
- With both on, a comment appears in the Inspector panel *and* inline in the
  diff. This is accepted: the Inspector also shows agent context and other
  non-comment data, which is the reason for decoupling — a reviewer may want
  the panel open for that while reading comments inline.
- Both preferences persist (localStorage), consistent with the existing
  `commentVisibility.ts` / theme-preference pattern.

### Key / control changes

- **`i`** → toggles `showInspector` only. Reverts to the pre-feature meaning.
- **`Shift+I`** → toggles `inlineComments`. New keybind. Also in the help
  overlay's key sheet.
- **Topbar action** → toggles `showInspector` (the Inspector). It does not
  toggle inline comments.
- **Settings modal** → keeps a control for `inlineComments` (replacing the
  current panel/inline segmented control). The existing
  "hide non-active comments" control stays and remains meaningful only while
  `inlineComments` is on.
- **Command palette** → the single view-mode entry splits into two:
  toggle the Inspector, and toggle inline comments.

### What "inline comments on" gates

`inlineComments` is the single gate for all inline interaction rendering in
`DiffView`: per-line thread blocks, the hunk-level block, the detached-threads
block, and the new comment rail (Part 2). (The toggle is named for comments
but, as today, the inline rendering also covers AI notes — no behaviour change
there beyond the rename.)

### Affected code

| Area | Change |
|------|--------|
| `web/src/interactionViewMode.ts` | Replace the `"panel" \| "inline"` enum module with persisted boolean helpers for `inlineComments` (and a `showInspector` equivalent), or split into two small modules — the plan decides. |
| `web/src/components/ReviewWorkspace.tsx` | Own both booleans; `i` / topbar → `showInspector`; `Shift+I` → `inlineComments`; gate `<Inspector>` on `showInspector` and the inline render on `inlineComments`. |
| `web/src/keymap.ts` | `i` action back to the Inspector; add a `Shift+I` inline-comments action; split the command-palette entry. |
| `web/src/components/SettingsModal.tsx` | The view-mode control becomes an `inlineComments` on/off toggle. |
| `web/src/components/Welcome.tsx` | Update its `SettingsModal` wiring for the new preference shape. |
| `web/src/components/TopbarActions.tsx` / topbar wiring | The action toggles the Inspector. |

---

## Part 2 — "+ comment" in a left-most comment rail

### The rail

The diff line is a CSS grid (`web/src/components/DiffView.css`), today
`grid-template-columns: 40px 40px 14px 16px 1fr` — old #, new #, AI-glyph,
sign, code.

When `inlineComments` is on, the grid gains a **new fixed-width left-most
column** — the comment rail (~22px; wide enough for an icon, unlike the 14px
AI-glyph column). Because the column is present on *every* line whenever inline
comments is on, the diff body never reflows as the cursor moves.

- The **cursor line** shows a **chat-bubble icon** in its rail cell. Every
  other line's rail cell is empty.
- Clicking the bubble starts a comment on the cursor line — it opens the
  inline draft composer beneath that line, exactly as pressing `c` does. The
  bubble's tooltip carries the `c` shortcut hint.
- The `c` keybind is unchanged.
- When `inlineComments` is off, the rail column is absent and the grid is the
  original five-column layout.

### What is removed

The current inline "+ comment" CTA button — `showNewCommentCta` /
`thread__start--cta` rendered inside `InlineLineThreads` beneath the cursor
line — is removed. The rail bubble is its replacement.

The draft *composer* still appears inline beneath the cursor line when a
comment is actually being written (the existing draft-stub path). That reflow
is expected and acceptable — it happens only when the user deliberately starts
a comment, not on every cursor move.

### Affected code

| Area | Change |
|------|--------|
| `web/src/components/DiffView.tsx` / `DiffView.css` | Add the rail column to the `.line` grid when `inlineComments` is on; render the chat-bubble in the cursor line's rail cell; wire its click to start a comment. The delegated line-pointer handler must treat a rail click as the bubble action, not a line-range drag. |
| `web/src/components/InlineLineThreads.tsx` | Remove the "+ comment" CTA button (`showNewCommentCta` path); the draft-stub composer path stays. |
| `web/src/view.ts` | `showNewCommentCta` / related `InspectorViewModel` fields are no longer needed for the inline CTA — the rail uses the cursor position directly. Trim what becomes dead (the panel may still use a CTA — check before removing). |

## Testing

- **Unit:** the two decoupled booleans persist independently; `i` toggles only
  the Inspector, `Shift+I` toggles only inline comments; the Settings control
  drives `inlineComments`; the rail column renders only when `inlineComments`
  is on; the bubble renders on the cursor line only; clicking the bubble and
  pressing `c` both open the draft composer.
- **E2e (journey 6):** `i` shows/hides the Inspector without affecting inline
  comments; `Shift+I` toggles inline comments without affecting the Inspector;
  the comment rail appears with inline comments on; clicking the cursor-line
  bubble starts a comment.

## Out of Scope

- Hover-to-comment on non-cursor lines — the bubble is cursor-line-only.
- Changes to the threading model, the per-line projection, hunk-level /
  detached rendering, or the "hide non-active comments" setting.
- Changes to the Inspector panel's own content.

## Open Questions Resolved

- **Inline-comments toggle location** — its own keybind (`Shift+I`) plus the
  Settings control; not the topbar.
- **Inspector vs inline independence** — fully independent; both-on is allowed.
- **"+ comment" placement** — a chat-bubble icon in a new fixed-width
  left-most rail column, on the cursor line only (no hover affordance).
