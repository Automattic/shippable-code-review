# Inline Interactions — Hide Inspector Threads When Inline Is On

Follow-up to the decoupled-toggles work (`decouple-and-comment-rail.md`).

## Problem

The Inspector panel and inline comments are independent toggles — both can be
on at once. When they are, the same interaction threads render **twice**: in
the Inspector's body *and* inline in the diff. The Inspector's value with
inline comments on is its *non-thread* content (agent context, PR data,
current location); the duplicated threads are noise.

## Goal

When `inlineComments` is on, the Inspector hides its interaction-thread body
and keeps everything else.

## Design

When `inlineComments` is enabled:

- The Inspector **hides its thread body** — the `InlineThreadStack`
  (`sections="all"`) render covering AI notes, user comment threads, the hunk
  summary, the teammate verdict, and detached threads. All of that is shown
  inline in the diff, so the panel copy is redundant.
- In its place, the Inspector renders a short placeholder line — e.g.
  *"Comments are shown inline in the diff."* — so the panel does not look
  confusingly empty.
- The Inspector **keeps** all non-thread content: the header (panel label,
  comment-navigation `‹ n ›`, viewing-as, key hints), the agent-context
  section, the PR pill / PR-conversation disclosure, and the current-location
  code-line card.

When `inlineComments` is off, the Inspector is unchanged — it renders the full
`InlineThreadStack` body as today.

The header's comment-navigation stays in both states: `n` / `N` still move the
cursor between comment-bearing lines; with inline comments on, the comment
then shows inline at the cursor.

## Implementation

- `ReviewWorkspace.tsx` already owns the `inlineComments` boolean. Pass it to
  `<Inspector>` as a prop (e.g. `interactionsShownInline: boolean`).
- `Inspector.tsx` renders either `<InlineThreadStack sections="all" … />`
  (when `interactionsShownInline` is false) or the placeholder `<div>` (when
  true), in the same slot. The chrome around it is unconditional.
- The panel-only `currentNoteRef` scroll-into-view effect becomes inert when
  the body is hidden (no note cards to scroll to) — no special handling
  needed; the ref simply never attaches.

## Testing

- **Unit:** with `interactionsShownInline` true, the Inspector renders the
  placeholder and NOT the thread body (no AI-note / comment-thread cards); the
  header, agent-context, and location chrome still render. With it false, the
  full thread body renders as before.
- **E2e (journey 6):** with the Inspector open and inline comments toggled on
  (`Shift+I`), the Inspector no longer shows the comment threads (they appear
  inline only); toggling inline comments off restores them in the panel.

## Out of Scope

- Changes to inline rendering, the decoupled toggles, the comment column, the
  threading model, or `hideNonActiveComments`.
- Hiding only a subset of thread sections — the whole `InlineThreadStack` body
  is hidden, since the inline render duplicates all of it.

## Open Questions Resolved

- **Placeholder vs nothing** — a short placeholder line, so the panel does not
  look blank.
- **Scope** — the entire `InlineThreadStack` body (all five thread sections),
  not a subset.
