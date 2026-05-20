# Sign-off

## What it is
Two independent ways to mark explicit review verdicts in a session: per-file
and per-changeset.

Read progress is separate. Cursor visits and `readLines` answer "what did I
look at?"; sign-off answers "what am I willing to mark reviewed?" Treating
those as the same thing would quietly overstate confidence.

## What it does

### File sign-off — `Shift+M`

- Toggles the current file's entry in `reviewedFiles: Set<fileId>`.
- Surfaces as a row tint and "reviewed" label in the [file sidebar](./file-sidebar.md), and as `reviewed N/M` in the footer.
- Bound to the file's id. When the parent changeset reloads and produces new file ids, the persist layer drops the stale entries.

### Changeset sign-off — `Shift+S`

- Toggles the current revision's entry in `reviewedChangesets: Record<changesetId, reviewToken[]>`.
- Surfaces as `changeset` / `changeset ✓` on the right of the footer. Hidden when the changeset has no stable revision identity.
- Bound to `(changesetId, reviewToken)`. The token is derived from the loaded changeset:
  - Worktree-backed (branch / range / picked / dirty): `wt:<sha>:<dirtyHash | ->`.
  - PR-only: `pr:<baseSha>:<headSha>` — both ends matter; the diff moves when the base moves.
  - Paste / upload / stub / fixture: `null`. No affordance is offered.
- Survives any refresh where the token is unchanged: live-reload while the working tree is clean, PR conversation refresh, session hydration on boot.
- Disappears when the token moves: new commit on the worktree, uncommitted edit, PR base or head moves.
- Returns automatically when the reviewer round-trips back to a previously signed-off revision. No re-confirmation.
- Explicit unsign-off removes only the current revision's token; prior tokens stay. Switching revisions is navigation, not invalidation.

### The two are independent

Signing off the changeset does not mark its files reviewed; marking every file reviewed does not sign off the changeset. The granularity is deliberate — "I ticked these three files" carries different information than "I read the whole thing as a unit," and we keep both signals.

### When each is useful

- **Per-file** is incremental: tick what you've read so it stops crowding your attention. Partial progress, not a verdict — useful in a multi-session review of a large PR, or when one file is independently fine and others need more thought.
- **Per-changeset** is the verdict: one explicit "I'm done with this revision." Hides when the revision moves and returns when you round-trip back. Useful because reviewers approve PRs as wholes, not file by file.
- A small PR collapses both into one act. A large or multi-session review keeps them apart on purpose.

### What we do not sign off yet

- Per-line or per-hunk sign-off is not implemented.
- At those scopes we only track read progress and comment threads.
- That keeps the model simpler while we validate whether finer-grained verdicts
  are actually useful instead of just more state.

## Out of scope

- Cascading file ↔ changeset roll-up.
- Cross-changeset memory ("reviewed in PR #123, don't ask in #124").
- Multi-reviewer / shared sign-off.
- Description, hunk, or symbol sign-off.

## Persistence

Both fields ride in the localStorage snapshot at `v: 5`; `hasProgress()` counts either. See [session persistence](./session-persistence.md).

The server-owned SQLite DB holds shared review data (interactions: comments, replies, acks). Sign-off stays in localStorage because it's local-session UI state — multi-reviewer / shared sign-off is out of scope (see above), so there's nothing else that needs to read it.

## Screenshot
![Sign-off](./assets/workspace-file-reviewed.png)
