# Review State

## What it is
The local state model for an in-progress review session.

## What it does
- Tracks the current cursor position inside the diff tree.
- Separates read progress from explicit sign-off. Cursor/read coverage means
  "I have been here"; file/changeset sign-off means "I am explicitly willing
  to mark this scope reviewed." Those are different signals on purpose.
- Tracks dismissed guide suggestions, expand levels, and block selection.
- Stores every per-author signal — user replies, AI notes, teammate verdicts, agent responses, acks — as `Interaction`s in `state.interactions: Record<threadKey, Interaction[]>`. See `docs/architecture.md § Review interactions`.
- Keeps the current session shaped around one reviewer, one machine, and local persistence.

## Sign-off

Two independent fields carry sign-off: `reviewedFiles: Set<fileId>` and `reviewedChangesets: Record<changesetId, reviewToken[]>`. Behavior, keybindings, the review-token derivation, and what is and isn't in scope are documented in [docs/features/sign-off.md](../features/sign-off.md). They're kept independent on purpose — per-file ticks and "I've read this as a whole" carry different information, and neither cascades into the other.

## Read-state identity across reloads

`readLines` and `reviewedFiles` are keyed by hunk/file ids, and those ids embed the changeset id — which for any view containing uncommitted work embeds the whole-tree dirty hash. Every worktree edit therefore churns *all* ids, including for files the edit didn't touch.

Read marks and reviewed flags follow unchanged content to its new ids by content key (`anchor.ts` `hunkContentKey` / `fileContentKey` — path + line kinds + texts, line numbers excluded). Two paths do this:

- `RELOAD_CHANGESET` (`state.ts reloadChangeset`) re-keys in memory, the same pass that re-anchors interactions. The cursor also follows its hunk, line for line.
- Hydration (`persist.ts loadSession`) re-keys against the persisted content keys — the v8 snapshot stores `hunkKeys`/`fileKeys` alongside `readLines`/`reviewedFiles` for exactly this.

A hunk or file whose content changed matches no key and starts over; that's the intended bar — changed content must be re-read. Sign-off (`reviewedChangesets`) does not participate: its revision-scoped tokens already invalidate on content change by design.

## Reset

"Reset review" (topbar) deletes the server-side interactions for every loaded changeset (`DELETE /api/interactions?changesetId=…`) **and** for every loaded worktree path (`…?worktreePath=…`) **before** clearing the localStorage snapshot and reloading. Both scopes are needed: user comments are changeset-keyed, but agent comments (posted via MCP "post to shippable") are worktree-keyed with a null changeset id and would be resurrected by the delivered-replies poll. Order matters too — comments are re-fetched on every load, so clearing local state alone brings them back. If the server delete fails, nothing is cleared and the modal says so.
