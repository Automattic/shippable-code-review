# Spec: Inline Interactions

## Goal
Add an optional "inline mode" for the review workspace that renders interaction
threads directly within the diff — line-anchored threads beneath their code
line, hunk-level threads in the hunk header — as a mutually-exclusive
alternative to the side `Inspector` panel. The reviewer reads AI notes,
comments, and replies without their eyes leaving the code, and the choice
persists across sessions.

## Requirements Summary
- A persisted toggle switches the workspace between **panel mode** (today's
  `Inspector`) and **inline mode**. Never both at once.
- Inline mode renders **line-anchored interactions** (per-line AI notes, user
  comment threads) beneath their anchored code line.
- **Hunk-level interactions** (AI hunk summary, teammate verdict) render in the
  **hunk header** of the cursor's hunk.
- Threads are **collapsed by default**; the existing `line__ai` gutter glyph
  stays. The cursor's thread **auto-expands**; clicking a collapsed glyph moves
  the cursor there. **One thread expanded at a time** — the cursor's.
- **Composing is inline**: the reply/comment composer renders within the
  expanded thread at the cursor line.
- Full behavioural parity with the panel: ack/unack, agent queued/delivered
  pips, enqueue-retry, detached threads, draft persistence.
- `web/` build, lint, and tests must pass. No changes to the interaction data
  model, persistence shape, or agent queue.

## Chosen Approach
**A — Relocate the Inspector view-model.**

`buildInspectorViewModel` (`web/src/view.ts`) already produces a fully
**cursor-scoped** thread view-model: the AI-note rows, user-comment rows, hunk
summary, teammate verdict, detached threads, and per-thread draft state for
exactly the line/hunk the cursor sits on. That is precisely the data inline
mode needs, and its cursor-scoping maps 1:1 onto the "expand on cursor, one
thread at a time" requirement — no new expansion state is introduced.

The Inspector's render body is extracted into a shared, presentation-only
component, `InlineThreadStack`, that takes an `InspectorViewModel` plus the
existing interaction callbacks. `Inspector` becomes a thin panel wrapper around
it. In inline mode, `ReviewWorkspace` routes the *same* `InspectorViewModel` it
builds today down to the `DiffView` that contains the cursor; that `DiffView`
mounts the line-anchored portion beneath the cursor line and the hunk-level
portion inside the cursor hunk's header.

Because both modes consume one view-model built one way, parity is structural —
there is no second projection to drift out of sync.

### Alternatives Considered
- **B — Per-line payloads in the diff view-model.** Extend
  `DiffLineViewModel`/`HunkViewModel` so every line carries its thread payload.
  Rejected: duplicates the projection `buildInspectorViewModel` already does
  (parity risk), bloats a view-model rebuilt on every composer keystroke, and
  builds multi-expand capability that v1 explicitly excludes.
- **C — Floating overlay.** Render thread content as a popover over the cursor
  line. Rejected: not true inline rendering, contradicts the "beneath the code
  line" requirement, and overlay-over-scrolling-diff repositioning is fragile.

## Technical Details

### Architecture
Three layers change; the data model does not.

1. **State + persistence.** `ReviewWorkspace` gains an
   `interactionViewMode: "panel" | "inline"` state, initialised from and
   written to `localStorage` via helpers mirroring `getStoredThemeId` /
   `persistThemeId` in `tokens.ts` (key `shippable:interaction-view-mode`).
   This replaces the role of the un-persisted `showInspector` boolean for the
   mode dimension; `showInspector`'s hide/show semantics fold into
   `interactionViewMode === "panel"`.

2. **Shared render body.** The Inspector's body markup — AI-note cards,
   user-comment threads, hunk summary, teammate verdict, detached threads, and
   the new-comment CTA — is lifted into `InlineThreadStack`, a
   presentation-only component taking `InspectorViewModel` + callbacks.
   `Inspector` keeps its panel chrome (header, location label, comment-nav
   prev/next) and renders `InlineThreadStack` for the body. `ReplyThread`,
   `DetachedThreadCard`, `AgentContextSection`, `CodeText`, `RichText` are
   reused unchanged.

3. **Diff hosting.** `DiffView` accepts an optional `inlineThreads` prop
   carrying the cursor's `InspectorViewModel` + callbacks. When present, it
   renders:
   - the line-anchored rows of `InlineThreadStack` in a variable-height region
     immediately beneath the cursor line (`DiffLineViewModel.isCursor`);
   - the hunk-level rows (AI summary, teammate verdict) inside the header of
     the cursor's hunk (`HunkViewModel.isCurrent`).
   Non-cursor hunks render their existing header badges only.

### Data Flow
`ReviewState` → `selectIngestSignals` / `selectInteractions` →
`buildInspectorViewModel` (already called once in `ReviewWorkspace`) →
- **panel mode:** `<Inspector>` (unchanged path);
- **inline mode:** passed as `inlineThreads` to the cursor file's `<DiffView>`,
  which hands it to `<InlineThreadStack>` mounted at the cursor line / hunk
  header.

Only the cursor file's `DiffView` receives `inlineThreads`; the cursor's
`changesetId`/`fileId` already identify it. No per-line thread data is plumbed
through the diff view-model.

### Cursor & scroll behaviour
- An expanded inline thread changes the cursor line's rendered height. The
  existing cursor scroll-into-view (`cursorRef`) must run *after* the inline
  region mounts/measures so `n`/`N` navigation lands correctly.
- Moving the cursor collapses the previous inline region and expands the new
  one — a direct consequence of routing a cursor-scoped VM, not a separate
  collapse step.
- Clicking a collapsed `line__ai` glyph dispatches `SET_CURSOR` to that line
  (and, for hunk-level chips, into that hunk), which expands it.

### Toggle UI
- A control in `SettingsModal` switches `interactionViewMode`.
- A topbar action (alongside the existing `inspector` action in
  `TopbarActions`) toggles the same state; its label reflects the current mode.
- The `i` keybind continues to toggle — in inline mode it flips back to panel
  mode and vice versa, keeping one muscle-memory key for "where do interactions
  live."

### Key Components
| Component | Responsibility |
|-----------|----------------|
| `InlineThreadStack` (new) | Presentation-only render of an `InspectorViewModel` body: AI-note cards, user-comment threads, hunk summary, teammate verdict, detached threads, composer. Hosted by both `Inspector` and `DiffView`. |
| `Inspector` (modified) | Panel chrome only; delegates body to `InlineThreadStack`. |
| `DiffView` (modified) | Accepts `inlineThreads`; mounts line-anchored rows beneath the cursor line and hunk-level rows in the cursor hunk header. |
| `ReviewWorkspace` (modified) | Owns `interactionViewMode` state + persistence; routes the `InspectorViewModel` to panel or diff; wires toggle controls and the `i` keybind. |
| `SettingsModal` (modified) | Hosts the mode toggle control. |

### File Changes
| File | Change Type | Description |
|------|-------------|-------------|
| `web/src/components/InlineThreadStack.tsx` | new | Shared, presentation-only interaction-thread body extracted from `Inspector`. |
| `web/src/components/InlineThreadStack.css` | new | Inline-context styling (variable-height region under a diff line; hunk-header block). |
| `web/src/components/Inspector.tsx` | modify | Delegate body rendering to `InlineThreadStack`; keep panel chrome. |
| `web/src/components/DiffView.tsx` | modify | New `inlineThreads` prop; render inline rows under cursor line and in cursor hunk header. |
| `web/src/components/DiffView.css` | modify | Layout for the inline thread region within a hunk body / header. |
| `web/src/components/ReviewWorkspace.tsx` | modify | `interactionViewMode` state + persistence; route VM; wire toggle + keybind; retire `showInspector`'s mode role. |
| `web/src/components/SettingsModal.tsx` | modify | Add the panel/inline mode toggle control. |
| `web/src/components/TopbarActions.tsx` | modify | Topbar toggle reflecting current mode. |
| `web/src/interactionViewMode.ts` | new | `getStoredInteractionViewMode` / `persistInteractionViewMode` localStorage helpers (mirrors `tokens.ts` theme helpers). |
| `web/src/components/Inspector.test.tsx` | modify | Cover the `Inspector` → `InlineThreadStack` split. |
| `web/src/components/DiffView.test.tsx` | modify | Cover inline rendering under the cursor line and hunk header. |
| `web/src/components/InlineThreadStack.test.tsx` | new | Cover the shared body in isolation. |

## Out of Scope
- **Independent multi-expand** — keeping several inline threads open at once.
  v1 is cursor-driven single-expand; multi-expand is additive later.
- Removing the `Inspector` panel — it remains as the other half of the toggle.
- Changes to the interaction data model, persistence shape, or agent queue.
- New interaction types or anchoring targets.
- Expanded hunk-level threads on non-cursor hunks (those show header badges
  only until the cursor enters the hunk).

## Open Questions Resolved
- **Toggle placement** — `SettingsModal` *and* a topbar action, with the `i`
  keybind retained as the fast toggle.
- **Mode persistence** — yes; `localStorage` key `shippable:interaction-view-mode`,
  same pattern as the theme preference.
- **Manual expand of non-cursor threads** — not in v1. Single-expand is
  cursor-driven; clicking a collapsed glyph moves the cursor (which expands the
  target). Multi-expand is explicitly out of scope.
- **Hunk-header block default state** — the hunk-level block belongs to the
  cursor's hunk and follows the same collapsed-until-cursor rule; non-cursor
  hunks keep today's header badges.
