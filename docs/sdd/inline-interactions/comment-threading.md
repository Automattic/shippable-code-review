# Inline Interactions — Comment Threading & Visibility

Follow-up to the inline-interactions feature and its anchoring fix
(`spec.md`, `anchoring-fix.md` in this folder). Addresses testing feedback on
how comments thread and how many render at once.

## Problem

Two issues, from testing both panel and inline modes:

1. **No two-level threading.** `userCommentKey(hunk, line)` returns the *same*
   key for every comment on a line, so a 2nd or 3rd comment is appended into
   the *same* thread as the 1st. `ReplyThread` renders that thread as one flat
   list, so separate top-level comments look like replies to the first one.
   There is no way to reply to a *specific* comment, and the thread-level
   "+ reply" button actually starts a new top-level comment — a mislabel.

2. **All-or-active visibility is not configurable.** The anchoring fix made
   inline mode show only the cursor line's threads. Reviewers want to see
   every comment in context as they scroll, with the cursor-only view
   available as an option.

## Goal

- User comments thread two levels deep: a line has top-level comments; each
  comment has a flat list of replies; you reply to a comment, not to a reply.
- The affordances read correctly: "+ comment" starts a new comment on a line;
  "+ reply" (per comment) adds a reply to that comment.
- Inline mode renders every line's threads by default; a setting restricts it
  to the active line.

---

## Part 1 — Two-level comment threading

### Approach: each comment is its own thread (behavioural unification)

Today only AI-note (`note:`) and teammate (`teammate:`) threads are correctly
single-rooted (a root + flat replies). User comments collapse because all
comments on a line share one key. The fix makes each user comment its own
thread, so a user comment thread becomes the **same primitive** every other
thread already is — no new mechanism, no new `Interaction` field.

### Thread keys

- `userCommentKey` / `blockCommentKey` gain a unique id segment:
  - line comment: `user:<hunkId>:<lineIdx>:<id>`
  - block comment: `block:<hunkId>:<lo>-<hi>:<id>`
- `<id>` is minted when the comment is created (reuse the comment's own
  reviewer-interaction id, or a fresh `r-…` id — the plan picks one).
- Prefixes (`note:` / `hunkSummary:` / `teammate:` / `user:` / `block:`) stay.
  They still encode anchor + provenance; only `user:` / `block:` keys gain the
  trailing id segment. AI-note and teammate keys are unchanged (those are
  inherently one-per-line / one-per-hunk).
- The thread-key parser (`parseThreadKey` in `types.ts`) learns the extra
  segment for `user:` / `block:` keys — anchor info (hunk, line, lo/hi) is
  still recoverable; the id is carried through but does not affect anchoring.

### Thread shape

A thread = one root interaction (`target: "line" | "block"`) + a flat list of
reply interactions (`target: "reply"`). This is unchanged — it is already how
`note:` / `teammate:` threads work. After this change, user comment threads
match it. No `parentInteractionId` field is added; the existing
`threadKey` + `target` mechanism expresses everything.

### Affordances

- **"+ comment on L<n>"** — the cursor-line CTA. Mints a *new* comment thread
  (fresh unique key) each time it is used.
- **"+ reply"** — rendered per comment card; adds a flat reply
  (`target: "reply"`) to *that comment's* thread.
- The current mislabel dissolves structurally: there is no longer a
  thread-level "+ reply" that secretly starts a new comment. Every thread the
  user replies into is a genuine root-plus-replies thread, so `ReplyThread`'s
  "+ reply" is always correct; starting a new comment is the separate
  line-level "+ comment" CTA.

### Scope

User comments only. AI-note, teammate, and hunk-summary threads are already
root-plus-replies and are not restructured.

### Affected code

| Area | Change |
|------|--------|
| `web/src/types.ts` | `userCommentKey` / `blockCommentKey` mint keys with a unique id segment; `parseThreadKey` accepts it. |
| `web/src/state.ts` | Reload anchor-rebuild and the agent `parentId` → threadKey resolution handle the new key shape; per-comment threads survive a reload (the id is part of the persisted `threadKey`). |
| `web/src/view.ts` | `buildInspectorViewModel`'s `userCommentRows` becomes one row per comment thread; the "+ comment" CTA mints a fresh key on click rather than reusing a precomputed per-line key. |
| `web/src/interactions.ts` | `selectInteractions` already groups by `threadKey` — no change beyond producing more threads. |
| `web/src/components/ReplyThread.tsx` + comment cards | Render the comment (thread head) as the card; replies nested flat beneath it; per-card "+ reply". |

---

## Part 2 — Render-all-comments inline + the setting

### The setting

A persisted **"hide non-active comments"** toggle, default **off**, in
`SettingsModal` alongside the panel/inline view-mode control. It governs inline
mode only — panel mode is inherently cursor-scoped, so the setting does not
apply there.

- **Off (default):** inline mode renders *every* line-anchored thread — AI
  notes and user comment threads — beneath its own anchored line, across the
  whole diff.
- **On:** only the cursor/active line's threads render — the behaviour shipped
  by the anchoring fix.

### Behaviour in both states

- The cursor line additionally shows the "+ comment" CTA, and the inline draft
  composer while a draft is open on that line.
- Each rendered comment's "+ reply" works regardless of cursor position — a
  reply composer can open on any line's comment.
- **Hunk-level** threads (AI summary, teammate verdict) and **detached**
  threads are unaffected by the setting — they render as they do today
  (hunk-level below the hunk body; detached at the bottom of the diff).

### Implementation shape

Today `DiffView` feeds `InlineLineThreads` only the cursor's
`InspectorViewModel`, mounted beneath the cursor line. Rendering every line's
threads needs per-line thread data for all lines, not just the cursor's.

- The view-model layer already derives per-line / per-thread projections
  (`selectIngestSignals` produces per-line AI-note lookups; `selectInteractions`
  groups every thread by key). The design adds a **per-line thread projection**
  — for each line, the AI-note and user-comment threads anchored to it — that
  `DiffView` consumes.
- `DiffView` mounts an inline thread block (`InlineLineThreads`, reused) under
  each line that has threads. The **cursor line's** block additionally carries
  the "+ comment" CTA and draft composer (the cursor-scoped
  `InspectorViewModel` still supplies those).
- When the setting is **on**, the per-line projection is filtered to the
  cursor line — collapsing to today's behaviour.
- The existing pointer-isolation wrapper (`InlineThreadsRegion`) and the
  cursor-scroll `ResizeObserver` continue to apply; with multiple inline
  blocks, each block is wrapped the same way.

### Affected code

| Area | Change |
|------|--------|
| `web/src/interactionViewMode.ts` (or a sibling) | Persisted `hideNonActiveComments` preference (get/persist helpers, same pattern as the view-mode preference). |
| `web/src/view.ts` | A per-line thread projection feeding the inline render. |
| `web/src/components/DiffView.tsx` | Mount an inline thread block under every line with threads (or just the cursor line when the setting is on). |
| `web/src/components/ReviewWorkspace.tsx` | Own the `hideNonActiveComments` state; pass it (and the per-line data) to `DiffView`; pass it + a setter to `SettingsModal`. |
| `web/src/components/SettingsModal.tsx` | The "hide non-active comments" control. |

---

## Testing

- **Unit:** the new key scheme (unique-id minting, `parseThreadKey`);
  `userCommentRows` becoming one row per comment thread; the per-line
  projection; the setting gate (all-lines vs cursor-line-only); reload
  preserving per-comment threads.
- **E2e (journey 6):** multiple comments on one line render as separate
  cards; a reply nests under its own comment, not after all comments;
  toggling "hide non-active comments" flips all-visible vs active-only.

## Out of Scope

- Unbounded reply nesting — replies are a flat list under their comment.
- Hover-to-comment on arbitrary lines — "+ comment" stays on the cursor line.
- Reworking the per-kind thread-key prefixes into a uniform identity scheme —
  prefixes stay; only `user:` / `block:` keys gain a unique id.
- Panel-mode (`Inspector`) layout — unchanged apart from per-comment threads
  rendering as separate cards (a consequence of Part 1).
- Changes to AI-note, teammate, hunk-summary, or detached threads beyond what
  Part 1's unified shape already implies.

## Open Questions Resolved

- **Reply depth** — two levels (flat replies under each comment).
- **Data model** — Approach A (comment = its own thread); no new `Interaction`
  field; key prefixes retained.
- **Render-all scope** — all line-anchored threads (AI notes + user comments);
  hunk-level and detached unaffected.
- **"+ comment" placement** — cursor line only, in both setting states.
