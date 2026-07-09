# Sign-off

## 1. Product reasoning & priority

Sign-off is the explicit "I'm willing to put my name on this scope reviewed" gesture. It exists because `readLines` already tells the reviewer where the cursor has been — that's a passive coverage signal — and the product principle is that passive reading and explicit verdicts must not collapse into one number. `docs/features/sign-off.md` puts it precisely: "Treating those as the same thing would quietly overstate confidence." The feature serves the longest-session user job: a multi-day review of a large PR where the reviewer needs to tick what they've handled and have it still hold tomorrow.

Suggested priority: **must-have** for the feature, **rebuild the storage** mandatory. The two-axis design (per-file via `Shift+M`, per-changeset via `Shift+S`) is small, well-defended in docs, and easy to keep. What's not OK to preserve in a rebuild is the localStorage-only home: see § 4.

## 2. Acceptance criteria for a rebuild

- `Shift+M` (keymap action `TOGGLE_FILE_REVIEWED`, `keymap.ts:106`) toggles `reviewedFiles` membership for the current cursor file (`state.ts:529`–`530`). It's a Set add/remove — no verdict variants ("approved", "blocked"), no quorum.
- `Shift+S` (keymap action `TOGGLE_CHANGESET_REVIEWED`, `keymap.ts:107`) toggles the current changeset's review token in `reviewedChangesets[changesetId]` (`state.ts:531`–`548`).
- The `Shift+S` binding is gated by the `hasChangesetToken` predicate (`keymap.ts:107`, `ReviewWorkspace.tsx:627`). Paste/upload/stub/fixture changesets do not surface the affordance at all.
- `getChangesetReviewToken` derives the token (`state.ts:1514`–`1524`):
  - worktree-backed: `wt:<sha>:<dirtyHash | ->`,
  - PR-only: `pr:<baseSha>:<headSha>`,
  - everything else: `null`.
- Revision changes don't drop the sign-off — they just navigate it. Prior tokens stay on the list; the current revision reads as signed off iff *its* token is in the list (`state.ts:1532`–`1540`, `state.ts:536`–`547`).
- Explicit unsign-off removes only the current revision's token (not the whole list) — `state.ts:539`–`543`. Other tokens stay; "switching revisions is navigation, not invalidation."
- File-level sign-off is independent of changeset-level: signing the changeset doesn't tick its files and vice versa (`docs/features/sign-off.md:32`–`34`).
- `reviewedFiles` ids that no longer exist in the loaded changesets are dropped on hydrate (`persist.ts:262`). Reloading after a fixture/PR diff change clears stale entries.
- `reviewedChangesets` is keyed by `changesetId` (stable across reloads), not by hunk/file structure; entries for changesets not currently loaded are preserved on load so a future re-open re-reads the sign-off without re-confirmation (`persist.ts:247`–`256`).
- Status bar renders `reviewed N/M` (file count, `StatusBar.tsx:21`) and a conditional `changeset` / `changeset ✓` cell (`StatusBar.tsx:27`); the latter is hidden entirely when the token is null.
- Contextual hint promotes `⇧S` when read coverage is complete and the changeset is not yet signed off; promotes `⇧M` when the current file is fully read and not yet signed off (`view.ts:644`–`652`).
- Diff header shows a "signed off · Shift+M to clear" badge on per-file (`DiffView.tsx:424`).
- No re-confirmation prompt on toggle, no undo affordance beyond pressing the same key again.

## 3. Existing architecture & system design

### Data model

- `ReviewState.reviewedFiles: Set<string>` — `types.ts:269`. Single Set, single key (`fileId`), append/remove semantics.
- `ReviewState.reviewedChangesets: Record<string, string[]>` — `types.ts:271`–`278`. Map from `changesetId` to an array of accumulated review tokens.
- `getChangesetReviewToken(cs)` — `state.ts:1514`. Pure function over `cs.worktreeSource` and `cs.prSource`.
- `isChangesetSignedOff(cs, reviewedChangesets)` — `state.ts:1532`. Pure selector; the StatusBar / `view.ts` use it.

### Current architecture decisions

- **Two independent fields, no roll-up.** `docs/concepts/review-state.md:17` is explicit: per-file ticks and "I've read this as a whole" carry different information, and neither cascades. The reducer leaves the other untouched.
- **Token-keyed, not id-keyed (for changeset sign-off).** Storing a list of tokens per changeset (`Record<csId, token[]>`) means sign-off survives a refresh whose token didn't change, but disappears when the diff actually moved. This is the whole "round-trip back to a prior revision and the tick returns" trick (`docs/features/sign-off.md:29`).
- **Capability via token nullability.** Paste / upload / stub / fixture changesets compute `null` from `getChangesetReviewToken` (`state.ts:1521`); the keymap predicate (`ReviewWorkspace.tsx:627`) and the StatusBar (`StatusBar.tsx:27`) both gate on this. The feature hides itself cleanly without a flag.
- **Stat tracking.** `TOGGLE_FILE_REVIEWED` counts only off→on (`ReviewWorkspace.tsx:734`–`736`); `TOGGLE_CHANGESET_REVIEWED` counts only token-non-null off→on (`ReviewWorkspace.tsx:752`–`756`). Re-marks don't double-count. This is the only piece of progress data that leaves the browser today — and only as an aggregate stat, not as user-identifiable state.
- **Persistence.** Both fields ride in the localStorage `shippable:review:v1` snapshot, `v: 7` (`persist.ts:62`, `persist.ts:73`–`84`). `hasProgress()` (`persist.ts:180`) treats either as a signal that the welcome boot should not appear — i.e. sign-off counts as "real" engagement.

### How it evolved

- The clearest evolution signal is the schema-version trail (`persist.ts:62–70`):
  - **v3 → v4**: interactions removed, moved to SQLite.
  - **v4 → v5**: `reviewedChangesets` *added*. Per-file sign-off pre-existed; the per-changeset axis is newer. The comment is explicit: "revision-scoped changeset sign-off."
- The "token" design (`wt:` and `pr:` prefixes) post-dates worktree live-reload — the requirement that sign-off survive a clean re-poll but break on a real revision move only makes sense once that polling existed. `docs/plans/worktree-live-reload.md` is the home of the surrounding plan; `getChangesetReviewToken` references `docs/concepts/review-state.md § Review tokens` (`state.ts:1508`).
- The quiz slice (`v: 6`, `v: 7`) makes sign-off a *trigger* for comprehension questions — see `dispatchToggleChangesetReviewedWithQuiz` in `ReviewWorkspace.tsx:757`. Sign-off is the moment the reviewer claims confidence; the quiz cashes that claim. This is the only outbound effect of sign-off in the current shape.

### Gaps

- **Sign-off is server-invisible.** `docs/features/sign-off.md:60` calls it out: "Sign-off doesn't cross that boundary today: no server endpoint or agent acts on it." An MCP agent that wanted to refuse work on a file already reviewed has no way to ask.
- **No teammate sign-off.** The shape is single-reviewer. Multi-reviewer would need a server-side store *and* an identity primitive; neither is there today.
- **No write-back to GitHub.** `docs/overview.md:20` notes "No write-back to the host yet" — sign-off doesn't post `APPROVE` upstream. The architecture doc reserves `APPROVE` for an explicit reviewer action (`docs/architecture.md:220`) but doesn't wire it.
- **No verdict variants.** Sign-off is a single bit. There's no "approved with comments" / "approved pending" / "blocked." `docs/features/sign-off.md:42–47` is intentional about this: per-line/per-hunk sign-off is explicitly out of scope while it's not clear they'd be useful.
- **No reason text.** A reviewer signing off can't leave a note tied to the gesture. (They can leave a comment separately, but the linkage isn't modelled.)
- **Cross-changeset memory is out.** "Reviewed in PR #123, don't ask in #124" — explicitly out of scope (`docs/features/sign-off.md:51`).
- **`reviewedChangesets` token list grows forever.** Nothing prunes it. A long-lived worktree that's been re-signed across hundreds of dirty-hash transitions accumulates strings indefinitely. Not a functional bug (the lookup is `Array.includes`) but unbounded.

## 4. Rebuild opportunities

### Data unification

Sign-off is the second-largest piece of state that should arguably be server-owned, after `readLines`. The asymmetry with interactions is sharp and named in `docs/features/sign-off.md:60`: interactions are in SQLite because agents need them; sign-off isn't because nothing crosses that boundary *yet*. The "yet" is the whole question.

What should move to SQLite in a rebuild:
- `reviewed_files (changeset_id, file_id, signed_off_at, signed_off_by)` — one row per `Shift+M` press.
- `reviewed_changesets (changeset_id, review_token, signed_off_at, signed_off_by)` — one row per `Shift+S` press at a given revision. Unsign-off deletes the row, matching the existing "only that token, not the whole list" semantics.

What should stay local (or move to a UI-prefs table if/when that exists):
- Nothing under the sign-off umbrella. Drafts (the keyboard input next to the comment thread) are a separate concern.

A practical knock-on: the SQLite move unblocks the MCP / agent bridge. The architecture's "agents need to ask the human is this reviewed" pathway exists for interactions; making sign-off addressable through the same envelope is a small, boring extension. Cross-changeset memory ("don't re-ask in PR #124 if PR #123 already covered file X") becomes feasible at the cost of an identity primitive — but only after the storage moves.

Other unification candidates in the same neighbourhood:
- `reviewedChangesets` token-list compaction: when SQLite is the home, the "tokens accumulate" gap (§ 3) is trivial — keep only the last N or prune on `signed_off_at` age.
- A `review_sessions` table that ties cursor + readLines + sign-off + drafts together via a `session_id` would let multi-window / cross-machine continuity work the same way as interactions.

### Better architecture

- **Make sign-off a typed event, not a Set.** A row per gesture (`changeset_id, scope (file|changeset), target_id, action (sign|unsign), token?, ts`) gives free audit history and an obvious `latest_state_per_target` view. Matches the "interactions are append-only" shape already used; same rule shop, less special casing.
- **Keep `getChangesetReviewToken` as the canonical token derivation.** It's already a pure function over `ChangeSet`; moving the persistence layer doesn't touch it.
- **Drop `reviewedChangesets: Record<string, string[]>` from `ReviewState`.** Replace with a derived selector that asks the DB / cache "is `(cs.id, token)` signed off?" The reducer's TOGGLE action becomes a thin server call + optimistic local update, same shape as `useInteractionSync` (`web/src/useInteractionSync.ts`).
- **Don't add verdict variants in a rebuild.** "approved/blocked/needs-info" is a different feature (PR-level verdict — `docs/architecture.md:220`); sign-off should remain the local binary. Mixing them grows scope without a clear user job.
- **Decide collaboration scope explicitly.** Per `IDEA.md`, the long-term shape includes teammate collaboration. The token model assumes a single reviewer; turning it multi-reviewer is a name on every row, not a wholesale rethink. Best to design the table that way from day one even if the UI exposes only "self" for v1.
- **Boring SQL beats event sourcing.** Two tables, two upserts, one delete. Don't reach for a journal until the gesture has multiple consumers.
- **Keep the two-axis design.** It costs almost nothing and the docs are clear about why (`docs/features/sign-off.md:32–40`). A rebuild that collapses them would lose information the product principle is explicit about preserving.

## Sources

- `web/src/types.ts:269–278` — `reviewedFiles` and `reviewedChangesets` fields.
- `web/src/state.ts:529–548, 1514–1540` — toggle reducers, `getChangesetReviewToken`, `isChangesetSignedOff`.
- `web/src/persist.ts:62–84, 113–117, 247–256` — schema versioning, snapshot shape, hydrate semantics.
- `web/src/keymap.ts:106–107` — Shift+M / Shift+S bindings + `hasChangesetToken` gate.
- `web/src/components/ReviewWorkspace.tsx:627, 731–759` — predicate evaluation + dispatch (incl. quiz trigger).
- `web/src/components/StatusBar.tsx:21–43` + `web/src/view.ts:535–680` — display.
- `docs/features/sign-off.md` — canonical feature spec (read in full).
- `docs/concepts/review-state.md:17` — "read vs sign-off" principle.
- `docs/architecture.md:42–43, 218–220` — persistence boundary + reserved APPROVE.
- `web/src/components/DiffView.tsx:424` — file-header "signed off" badge.
- `web/src/reviewedChangesets.test.ts:95–375` — behavioural spec (W1–W6, D1–D6) confirming the rules above.
