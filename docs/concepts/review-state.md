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
