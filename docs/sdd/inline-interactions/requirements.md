# Inline Interactions — Requirements

## Goal
Add an optional "inline mode" that renders review interactions directly within
the diff — beneath the code they are anchored to — as an alternative to the
side `Inspector` panel. This lets a reviewer read AI notes, comments, and reply
threads without their eyes leaving the code.

## Requirements
1. A toggle switches the workspace between **inline mode** and the
   **Inspector panel** mode. The two are mutually exclusive — never both at
   once. Today the panel is the only mode.
2. The toggle is reachable from the **Settings modal** and/or the **topbar**
   (final placement decided in the spec). A keybind is desirable, consistent
   with the existing `i` Inspector toggle.
3. The chosen mode **persists across sessions** (unlike the current
   `showInspector`, which is un-persisted `useState(true)`).
4. In inline mode, **line-anchored interactions** — per-line AI notes and user
   comment threads — render inline, beneath their anchored code line.
5. **Hunk-level interactions** — AI hunk summaries and teammate verdicts —
   render as an expandable block attached to the **hunk header**, since they
   have no single line to anchor to.
6. Inline threads are **collapsed by default**: the code line keeps showing the
   existing glyph/badge in the `line__ai` gutter.
7. A thread **auto-expands inline when the cursor lands on its line** — via
   click, or `n`/`N` comment navigation — mirroring how the Inspector follows
   the cursor today.
8. **One thread is expanded at a time** — the cursor's. Clicking a collapsed
   glyph moves the cursor to that line (expanding it) and collapses the
   previously expanded thread.
9. **Composing happens inline**: the reply/comment textarea and submit controls
   render within the expanded thread at the cursor line. Drafting requires no
   panel.
10. Inline mode must preserve full interaction behaviour at parity with the
    panel: AI notes, user comments, reply threads, ack/unack, agent
    queued/delivered pips, and enqueue-retry.

## Constraints
- `web/` quality gates must pass: `npm run build`, `npm run lint`, and
  `npm run test` (this touches view-model and state-adjacent code).
- Reuse the existing interaction model — do not add provenance to
  `InteractionTarget`/`InteractionAuthorRole` (see
  `docs/concepts/ai-annotations.md`).
- Inline rendering must not break the four web entry points
  (`/`, `/gallery.html`, `/demo.html`, `/feature-docs.html`).
- Diff layout: an expanded inline thread changes line layout height; cursor
  scroll-into-view and `n`/`N` navigation must still land correctly.

## Out of Scope
- **Independent multi-expand** — keeping several inline threads open at once
  to compare them. The v1 design is cursor-driven, single-expand. Multi-expand
  is additive and can be layered on later without reworking the base.
- Removing the `Inspector` panel — it remains, as the other half of the toggle.
- Changing the interaction data model, persistence shape, or agent queue.
- New interaction types or new anchoring targets.

## Open Questions
- Final placement of the toggle: Settings modal, topbar, command palette, or a
  combination — and the exact keybind.
- Whether the hunk-header block for hunk-level items is itself collapsed by
  default or always shown.
- Inline-mode interaction with `n`/`N` comment navigation when an expanded
  thread changes scroll offsets mid-jump.

## Related Code / Patterns Found
- `web/src/components/Inspector.tsx` — the current "second panel"; renders the
  cursor thread's content. The behaviour inline mode must reach parity with.
- `web/src/components/ReplyThread.tsx` — self-contained thread + composer
  component; directly reusable as the inline thread renderer.
- `web/src/components/DetachedThreadCard.tsx` — existing thread-card pattern.
- `web/src/components/DiffView.tsx` — `Line` component renders code lines and
  the `line__ai` glyph; needs an expandable region rendered beneath a line, and
  hunk-header treatment for hunk-level items.
- `web/src/view.ts` — `buildInspectorViewModel`, `AiNoteRowItem`,
  `UserCommentRowItem`, `InspectorViewModel`; the view-model layer inline
  rendering should build on.
- `web/src/interactions.ts` — `selectInteractions` and `selectIngestSignals`
  already produce per-line / per-hunk lookups for the render layer.
- `web/src/components/ReviewWorkspace.tsx` — `showInspector` state, the
  `inspector` topbar action, and the `i` keybind; the existing toggle pattern
  to extend (and the place to add persistence).
- `web/src/components/SettingsModal.tsx` — candidate home for the mode toggle.
- `docs/concepts/ai-annotations.md` — the interaction model (thread-key
  families `note:` / `hunkSummary:` / `teammate:`, author roles).
- `docs/concepts/view-model-layer.md` — view-model conventions.
