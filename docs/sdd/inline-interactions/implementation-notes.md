# Implementation Notes — Inline Interactions

All 11 plan tasks were implemented and individually reviewed (spec-compliance +
code-quality) with a final holistic review. `web/` build, lint, and the full
594-test suite pass. The feature is additive and behind a default-`panel`
toggle; panel mode is unchanged.

## Deviations from Spec

### Extra `SettingsModal` call site — `Welcome.tsx`
- **Spec said**: the `SettingsModal` view-mode control was wired only through
  `ReviewWorkspace` (the spec's File Changes table listed `SettingsModal.tsx`
  and `ReviewWorkspace.tsx`).
- **Implementation does**: making the new `SettingsModal` props required
  surfaced a second call site — `Welcome.tsx` also renders `<SettingsModal>`.
  `Welcome.tsx` was wired with its own `interactionViewMode` state backed by
  `getStoredInteractionViewMode` / `persistInteractionViewMode`.
- **Reason**: required props (no optional-prop shim, per AGENTS.md) forced the
  second caller to be handled. Reading/writing the same `localStorage` key
  keeps the preference consistent between the welcome screen and the workspace.
- **Impact**: the view-mode control is also reachable from the welcome
  screen's settings; behaviour is consistent (same persisted key).

### `keymap.ts` and `CommandPalette.test.tsx` changed — not in the spec's file list
- **Spec said**: File Changes did not list `keymap.ts` or `CommandPalette.test.tsx`.
- **Implementation does**: the command-palette entry's label was reworded
  ("toggle AI inspector" → "toggle inline interactions"), and the internal
  action id `TOGGLE_INSPECTOR` was renamed to `TOGGLE_INTERACTION_VIEW_MODE`
  (it toggles the view mode, not inspector visibility). `CommandPalette.test.tsx`
  was updated for the label.
- **Reason**: stale user-facing copy and a now-misleading internal identifier.
  AGENTS.md: "change the thing and update its callers."
- **Impact**: clearer copy; internal-only id rename, no behaviour change.

### `docs/architecture.md` updated — paper trail not in the plan
- **Spec said**: the plan had no documentation task.
- **Implementation does**: `docs/architecture.md` gained a short
  "Thread rendering — panel vs inline" subsection plus an `InlineThreadStack`
  entry, per AGENTS.md's paper-trail expectation. No `docs/concepts/` doc
  cleanly owns interaction *rendering*, so none was edited.
- **Impact**: future readers find the new component and render path from the
  canonical architecture map.

### `Inspector.test.tsx` not modified
- **Spec said**: File Changes listed `Inspector.test.tsx` as "modify — cover
  the `Inspector` → `InlineThreadStack` split."
- **Implementation does**: `Inspector.test.tsx` was left unchanged. The
  extracted body is covered by the new `InlineThreadStack.test.tsx`, and
  `Inspector`'s existing tests still pass through the delegation.
- **Reason**: the extraction is a pure refactor; the existing `Inspector`
  tests exercise chrome only and needed no re-pointing. No coverage was lost.
- **Impact**: none — spec/implementation drift only.

### `InlineThreadStack.css` shipped as a near-empty placeholder
- **Spec said**: File Changes described `InlineThreadStack.css` as
  "Inline-context styling."
- **Implementation does**: the body sections reuse shared `inspector__*`
  classes that also style panel chrome, so those rules stayed in
  `Inspector.css`; `InlineThreadStack.css` is a documented placeholder /
  explicit CSS entry point. Inline-context layout lives in `DiffView.css`
  (`.line-inline-threads`, `.hunk__inline-threads`).
- **Reason**: splitting the shared classes out cleanly was not possible
  without forking styling between the panel and inline hosts.
- **Impact**: none functional.

### "Interactions hidden entirely" state removed
- **Spec said**: the spec defined the toggle as panel ↔ inline, mutually
  exclusive (this was the intended design).
- **Implementation does**: the pre-feature `showInspector === false` state —
  which hid review interactions entirely — no longer exists. Interactions are
  always shown, in one place or the other.
- **Reason**: direct consequence of the spec's two-mode toggle.
- **Impact**: a behaviour change from before the feature: users can no longer
  hide interactions completely. Intended, recorded here for the record.

## Notes

- **Single `DiffView`.** The spec's data-flow wording implied routing the
  view-model to "the `DiffView` whose file contains the cursor" among several.
  `ReviewWorkspace` in fact renders exactly one `DiffView` (the focused file),
  so Task 6's routing was simpler than the spec implied — no per-file lookup.

- **Known limitation — sticky-header overlap.** `.hunk__inline-threads` is not
  sticky; the `position: sticky` hunk header scrolls over and covers it as the
  user scrolls within the current hunk. Acceptable for the prototype;
  documented in a `DiffView.css` comment. Revisit if disruptive.

- **Cursor re-scroll.** A single long-lived `ResizeObserver` per `DiffView`
  keeps the cursor line in view when inline regions resize (composer opens,
  replies arrive). An earlier implementation collected nodes into a `Set` with
  a separately-keyed effect; review caught that newly-mounted regions could go
  unobserved, and it was reworked to observe/unobserve directly from the
  callback ref.

- **`Demo.tsx`** retains its own pre-existing `setShowInspector` show/hide
  behaviour for the screen-catalog harness; it is not aligned with
  `ReviewWorkspace`'s panel/inline mode. Pre-existing, out of scope.

- **E2e coverage.** A "Journey 6 — inline interactions" Playwright block
  (`web/e2e/journey-6-cross-cutting.spec.ts`) covers, in a real browser:
  the `i` toggle moving threads from the panel into the diff, the inline
  reply composer, persistence across reload, and the Settings-modal control.
  The full Playwright suite (58 tests) and the 594 vitest tests pass.

- **Visual QA still advisable.** Automated coverage is in place, but a manual
  eyeball of the *look* — theme robustness of the inline regions and the
  documented sticky-header overlap — was not done in the implementation
  environment and is worth a quick check.
