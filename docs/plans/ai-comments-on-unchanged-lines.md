# AI comments on unchanged lines + comments in full-file mode — design

**Status:** planned 2026-07-10. Follows the `fix/next-comment-nav` stopgap.

## Problem

An AI review comment on a line **outside any diff hunk** — e.g. a claude finding
on an unchanged `L2` that the change depends on — is parked in
`detachedInteractions` at ingest and shown only as a "was at L2" detached card.
It never renders inline where it belongs, and (before the nav stopgap) `n`
skipped it entirely.

Root cause (confirmed, evidence-backed):

- `resolveAgentTopLevelAnchor` (`web/src/state.ts:1348`) resolves an agent
  comment's `(file, line)` only if the line is found **inside a hunk's lines**
  (`findLineIdxForLineNo`, `state.ts:1381`).
- When it returns `null` — file in the diff but line outside every hunk —
  `mergeAgentInteractions` parks the comment in `detachedInteractions`
  (`state.ts:1273-1290`). No reload, no file change; it happens at agent-reply
  ingest.

This is the single most valuable kind of AI finding (a latent issue on context
the change touches) and today it's second-class.

Separately, **full-file mode** (`FullFileView`, `DiffView.tsx:771`) is a
read-only source view with no cursor and no comment affordance — it shows *no*
comments at all.

## Goal

1. AI review comments on unchanged lines anchor to their **actual line** and
   render inline, not as detached cards.
2. **Full-file mode shows all comments** — hunk-anchored and unchanged-line
   alike — as the primary surface for reviewing them.

## Scope

In scope:

- Agent/AI **top-level** review comments (`authorRole: "agent"`) on lines
  outside hunks: anchor to file-line, render inline, reply to them, navigate to
  them with `n` / `N`.
- Full-file mode: render every comment (hunk-anchored and file-line) inline,
  with reply.
- Live-reload / re-anchor coverage for the new key shape.

Explicitly out of scope (deferred, not precluded):

- **Hand-typed user** comments on unchanged lines (click-to-comment / `c` on a
  context line). Authoring stays hunk-only for now; this design only *displays
  and replies to* unchanged-line threads and *ingests* AI ones.
- Block comments spanning unchanged regions.
- AI comments whose **file is not in the diff at all** — no line to anchor to;
  they stay detached (already reachable via the nav stopgap only if the file is
  present, so these remain detached cards).
- `Hunk` → `Range` type rename.

## Prior art

The `worktree-comment-on-unchanged-lines` branch (design:
`docs/plans/comment-on-unchanged-lines.md` on that branch) already built the
full version — `userFile:`/`blockFile:` keys, a `Cursor` discriminated union,
interactive expand-block/full-file rendering, persistence v6, re-anchoring. It
is ~1.5 months behind `main` (last commit 2026-05-21).

**Open decision (needs a call before implementation):**

- **Reuse** — rebase/cherry-pick that branch's infrastructure (key helpers +
  parser, `Cursor` union, full-file/expand rendering) and wire only the
  AI-ingest path on top, deferring user authoring. Less new code, but the rebase
  across ~1.5 months of `main` drift is the cost.
- **Rebuild narrow** — implement just the slice below from scratch on current
  `main`. More code, no rebase pain, no unused authoring surfaces.

Recommendation: spend an hour spiking the rebase first; fall back to rebuild if
it fights. Either way the addressing model below is the same.

## Addressing

Reuse the existing design's file-line key for the anchored case:

| Case | Key |
|---|---|
| AI comment, line inside a hunk | `user:${hunkId}:${lineIdx}` (unchanged) |
| AI comment, line outside hunks, file present | `userFile:${fileId}:${newNo}` (new) |
| AI comment, file absent | detached (unchanged) |

`parseReplyKey` / `firstTargetForKey` gain the `userFile` branch (already
implemented on the old branch — lift verbatim). `fileId` can contain `:`
(worktree + PR ids); parse by peeling the prefix then the trailing `newNo`,
mirroring the existing approach.

We key on `newNo` (post-change line) — it matches what the reviewer sees and
`file.fullContent` already indexes by it.

## Ingest change (`web/src/state.ts`)

In `mergeAgentInteractions`, when `resolveAgentTopLevelAnchor` returns `null`
but the file **is** in the changeset and the cited `newNo` exists in
`file.fullContent`, produce a `userFile:${fileId}:${newNo}` interaction instead
of a detached one. Capture `anchorContext` / `anchorLineNo` from
`file.fullContent` so re-anchoring on reload has a snippet to match (same
machinery the detached path already uses).

Fall through to `detachedInteractions` only when the file is absent or the line
can't be located in the full content.

Requires full file content at ingest. Worktree ingest already ships it
(`worktreeChangeset.ts:134`, `fileContents` → `enrichWithFileContent` builds
`file.fullContent`). PR ingest does not fetch full content — for PRs these AI
comments stay detached until a later pass adds file content there.

## Rendering

### Full-file mode (`FullFileView`, `DiffView.tsx:771`)

Today a bare source view. Make each line comment-aware:

- Look up a thread for the line: hunk lines via their `user:`/`note:` keys,
  context lines via `userFile:${fileId}:${newNo}`. Set `hasUserComment` and
  render the inline thread (reuse `InlineThreadStack` line-level sections, the
  same component hunk mode uses).
- This is the surface the user asked for: every comment visible in one place.

### Hunk / diff mode

An unchanged-line AI comment is not visible in compact hunk view. Options,
cheapest first:

1. **v1:** keep it reachable via the nav stopgap (lands on the file, Inspector
   "Detached"/thread list shows it) and rely on full-file mode for inline view.
2. **v2:** auto-reveal the expand-context block containing the commented line so
   it renders inline in hunk mode too (this is the old branch's behaviour).

Ship v1 with the ingest + full-file work; treat v2 as a follow-up.

## Navigation

`buildCommentStops` / `moveToComment` already include file-scoped detached and
now file-line threads via the stopgap. To land the cursor **on the exact
unchanged line in full-file mode**, the `Cursor` needs a file-line variant
(`{ fileId; hunkId: null; newNo }`) — the old branch's discriminated union.

- If reusing the old branch: inherit it.
- If rebuilding: for v1 we can accept "n lands on the file, full-file mode shows
  the thread" (no new cursor type) and add the precise file-line cursor as a
  follow-up. Decide based on how jarring file-level landing feels in testing.

## Persistence

- Threads are additive: `userFile:` keys sit alongside existing keys, no
  conflict. Server storage (`/api/interactions`) passes thread keys verbatim —
  no schema change.
- A `Cursor`-union change (if adopted) bumps the snapshot version; the loader
  normalises legacy cursors to the hunk-line variant. Skip this if v1 defers the
  cursor change.

## Tests

Per `docs/plans/test-strategy.md` (real reducer / view builder, no mocks):

- **Reducer:** `MERGE_AGENT_REPLIES` with an agent comment on an in-hunk line →
  `user:` key (unchanged); on an unchanged line whose `newNo` is in
  `file.fullContent` → `userFile:` key (not detached); on a line absent from
  full content, or a file not in the diff → detached (unchanged).
- **Reducer:** reply appends to a `userFile:` thread.
- **View:** full-file view model marks `hasUserComment` and emits the thread for
  both a hunk line and an unchanged line carrying a `userFile:` thread.
- **Integration (`App.test.tsx` tier):** an AI review whose finding is on an
  unchanged line renders inline in full-file mode; `n` reaches it.
- **Reload:** a `userFile:` AI thread re-anchors by snippet on reload; on a
  deleted line it detaches.

## Risks

- **Cursor blast radius** if the union is adopted (~30 read sites). The old
  branch already paid this down with an `isHunkLineCursor` guard + a green
  typecheck pass; inherit that if reusing.
- **PR parity** — PR ingest lacks full file content, so AI comments on unchanged
  lines stay detached there. Acceptable for v1 (the reported case is a disk
  worktree); note it so it isn't mistaken for a regression.
- **Rebase cost** of the old branch is the main unknown; spike it before
  committing to reuse.

## Follow-ups

- v2 auto-reveal in hunk mode.
- Hand-typed user comments + block comments on unchanged lines (the rest of
  `comment-on-unchanged-lines.md`).
- Full file content for PR ingest so AI-on-unchanged-line works there too.
