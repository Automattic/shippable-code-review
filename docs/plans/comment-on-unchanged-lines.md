# Comment on unchanged lines — design

**Status:** brainstormed 2026-05-20. Implementation plan pending.

## Problem

While reviewing a changeset, a reviewer may want to leave a comment on a line that wasn't part of the diff — to point at a related concern, ask about prior behaviour, or anchor a discussion on context the change depends on. Today this is impossible outside the narrow case of context lines that happen to sit inside a hunk's standard 3-line window. Specifically:

- **Hunk-internal context lines** (the 3-line window included in `hunk.lines[]`) are already clickable and use `user:${hunkId}:${lineIdx}` keys.
- **Expand-above / expand-below blocks** revealed via the expand bar are rendered by `ContextLinesBlock` (`web/src/components/DiffView.tsx:743`). No mouse handlers, no cursor, no comment path.
- **Full-file view** (`FullFileView`, same file) renders `file.fullContent` as a flat sequence. Same gap.

This design adds the ability to comment on any visible unchanged line — in expand blocks and in the full-file view — with keyboard parity to the diff view.

## Scope

In scope:
- User line comments and user block comments on unchanged lines.
- Keyboard navigation (`j`/`k`) and the comment shortcut (`c`) working on unchanged lines in both hunk mode (revealed expand blocks) and full-file view.
- Click-to-comment on unchanged lines in those same surfaces.
- Live-reload re-anchoring for the new key shapes.

Explicitly out of scope:
- AI annotations on unchanged lines. AI notes are fixture-seeded today and the live pipeline is a separate feature; that design picks its own shape later. Nothing here precludes it.
- Hunk summaries / teammate verdicts on unchanged regions. Those mean "verdict on a change".
- Read coverage on unchanged lines. Cursor passing through an unchanged line does not mark anything read; coverage is progress through changes.
- File / changeset sign-off behaviour. Unchanged.
- Cross-region selection (mixing a real-hunk line and an unchanged line in one block selection). Single-region selection only, like today.
- A `Hunk` → `Range` type rename. Tracked as a separate follow-up; this design avoids introducing new hunk-shaped abstractions so it doesn't worsen the misnomer.

## Addressing model

We commit on **file:line** keys for line comments, not on hunk-relative keys.

| Line kind | Comment key | Notes |
|---|---|---|
| `add` (in a real hunk) | `user:${hunkId}:${lineIdx}` | Unchanged from today. |
| `del` (in a real hunk) | `user:${hunkId}:${lineIdx}` | No `newNo` exists, so hunk-relative is the only option. |
| `context` inside `hunk.lines[]` | `userFile:${fileId}:${newNo}` | **Routed to the file key**, not the hunk key, so the same line has the same thread in hunk view and full-file view. The legacy `user:${hunkId}:${lineIdx}` keys on context lines remain readable for back-compat. |
| `context` in an expand block | `userFile:${fileId}:${newNo}` | New behaviour. |
| `context` in full-file view (outside any hunk) | `userFile:${fileId}:${newNo}` | New behaviour. |

Block comments follow the same split:

| Selection | Block key |
|---|---|
| All lines inside one real hunk | `block:${hunkId}:${lo}-${hi}` (unchanged) |
| All lines in the unchanged region | `blockFile:${fileId}:${loNewNo}-${hiNewNo}` (new) |
| Mixed | Not supported in v1 |

### Why `newNo` and not `oldNo`

Unchanged lines have both. We pick `newNo` because:
- It matches what the reviewer is looking at (the post-change file).
- `file.fullContent` and the expand-block builder already index by `newNo`.
- Added lines have no `oldNo`; using `newNo` keeps the new-file keys uniform for added + unchanged.

Deleted lines are the exception — no `newNo`, so they stay hunk-relative.

## Type changes

### `parseReplyKey` (`web/src/types.ts`)

Two new branches:

```ts
type ParsedReplyKey =
  | { kind: "note"; hunkId: string; lineIdx: number }
  | { kind: "user"; hunkId: string; lineIdx: number }
  | { kind: "block"; hunkId: string; lo: number; hi: number; lineIdx: number }
  | { kind: "userFile"; fileId: string; newNo: number; lineIdx: 0 }   // NEW
  | { kind: "blockFile"; fileId: string; lo: number; hi: number; lineIdx: 0 } // NEW
  | { kind: "hunkSummary"; hunkId: string; lineIdx: 0 }
  | { kind: "teammate"; hunkId: string; lineIdx: 0 };
```

`fileId` may contain `:` (PR `csIds` are `pr:host:owner:repo:N`, and file ids embed cs ids). Parsing strategy mirrors the existing approach: split by the first `:` to peel off the prefix, then `lastIndexOf(':')` to peel off the trailing `newNo` (or `lo-hi`) suffix.

Two new helpers:

```ts
function userFileCommentKey(fileId: string, newNo: number): string {
  return `userFile:${fileId}:${newNo}`;
}
function blockFileCommentKey(fileId: string, lo: number, hi: number): string {
  return `blockFile:${fileId}:${lo}-${hi}`;
}
```

`firstTargetForKey` returns `"line"` for `userFile:` and `"block"` for `blockFile:`.

### `Cursor` (`web/src/types.ts`)

Discriminated union; the existing shape becomes one of two variants:

```ts
type Cursor =
  | { changesetId: string; fileId: string; hunkId: string; lineIdx: number }
  | { changesetId: string; fileId: string; hunkId: null; newNo: number };
```

A `isHunkLineCursor(c)` type guard lets call sites narrow. We add it next to the type so the compiler can flag every site that has to think about file-line mode.

Persistence (`web/src/persist.ts`) bumps the snapshot version. The loader normalises legacy cursors to the hunk-line variant (the only shape they could have been).

## Behaviour changes

### Rendering & click wiring (`web/src/components/DiffView.tsx`)

Today only `<div className="hunk__body">` receives `lineMouseHandlers`. We extend mouse handling to the two other surfaces:

- `ContextLinesBlock` becomes interactive: each line carries a `data-newno` attribute and a click handler that dispatches `SET_CURSOR` with the file-line variant followed by the existing comment open path.
- `FullFileView` becomes interactive in the same way. Lines whose `newNo` falls inside a real hunk's `[newStart, newStart + newCount - 1]` window still route to that hunk's `(hunkId, lineIdx)` — the look-up uses `file.hunks` indexed by `newNo`.

The cursor highlight CSS (`line--cursor`) applies in both surfaces; same render path, same class.

`hasUserComment` indicator on a line:
- Inside `hunk.lines[]` with `kind ∈ {add, del}`: check `replies[user:${hunkId}:${lineIdx}]`.
- Otherwise (context lines anywhere): check `replies[userFile:${fileId}:${newNo}]`. Also tolerate legacy `user:${hunkId}:${lineIdx}` for hunk-internal context lines so old comments still display.

### Keyboard navigation (`web/src/state.ts`)

`MOVE_DOWN` / `MOVE_UP` are extended to support file-line cursors:

- **Full-file view** (`fileFullyExpanded === true`): `j` / `k` step through the visible sequence in `file.fullContent`. The reducer maps each step's `newNo` to either `(hunkId, lineIdx)` (if the line is inside a real hunk) or `(null, newNo)` (otherwise). No file-line cursor is ever produced for a position that has a hunk-line equivalent — that keeps thread-key resolution unambiguous.
- **Hunk mode with revealed expand blocks**: `j` from the last hunk-line steps into the first revealed line of the expand-below block (file-line cursor); subsequent `j`s walk the block; the next `j` after the last revealed line either lands on the next hunk (or its revealed expand-above block, if any) or moves to the next file.
- **Collapsed expand blocks are skipped** by `j` / `k`. When the next surface is an expand bar at level 0, line-by-line navigation continues to the next hunk. Revealing a block via the expand bar does not change the cursor.
- **`]` / `[` (next / prev hunk)** is unchanged: hunk-hop semantics, never lands on a file-line cursor.

`SET_CURSOR` (dispatched by clicks) accepts either cursor variant.

`START_COMMENT` reads the cursor variant and constructs the right key:
- Hunk-line on `add`/`del`: `user:${hunkId}:${lineIdx}` (unchanged).
- Hunk-line on `context`: `userFile:${fileId}:${newNo}` (rerouted; same line, one thread).
- File-line: `userFile:${fileId}:${newNo}`.

Block selection follows the same split for `blockFile:`.

### Live-reload re-anchoring (`web/src/state.ts`)

The existing anchor pass walks every thread on reload and re-attaches by snippet match. We add the two new key kinds to the pass:

- `userFile:${fileId}:${newNo}` → look for the same `anchorContext` snippet in the new file's post-change content. On match, rewrite the key with the new `newNo`. On miss, the thread enters the Detached group, same as today.
- `blockFile:${fileId}:${lo}-${hi}` → re-anchor the head `lo` line via snippet match; clamp the span size to the new file's bounds.

`anchorContext` and `anchorHash` are sourced from `file.postChangeText`, which the worktree-changeset endpoint already returns. No new wire fields needed.

## Persistence migration

- Comment threads: additive. Old keys (`user:`, `block:`, `note:`, `hunkSummary:`, `teammate:`) keep their semantics. New keys (`userFile:`, `blockFile:`) appear alongside without conflict.
- Cursor shape: bump `snapshot.version`. Loader treats the absence of `hunkId === null` as a legacy hunk-line cursor.
- No new server-side persistence; this is web-state only.

## What does NOT change

- The diff parser and the unified-diff `Hunk` type. Real hunks still come from `parseDiff.ts` exactly as they do today.
- AI note ingestion path (`selectIngestSignals`). The `note:` / `hunkSummary:` / `teammate:` projections are untouched.
- File / changeset sign-off.
- Block comment behaviour inside a single real hunk.
- Wire format for `/api/interactions` and the AI plan endpoint. New keys are opaque strings; the wire already passes thread keys verbatim.

## Tests

Per `docs/plans/test-strategy.md`:

**Unit (key helpers, `web/src/types.test.ts`):**
- `userFileCommentKey` / `blockFileCommentKey` round-trip through `parseReplyKey`.
- `parseReplyKey` handles `fileId` strings that contain `:` (PR-shaped file ids).
- `firstTargetForKey` returns `"line"` / `"block"` for the new prefixes.

**Reducer (`web/src/state.test.ts`):**
- `START_COMMENT` with a file-line cursor produces a `userFile:` key.
- `START_COMMENT` with a hunk-line cursor on a `context` line also produces a `userFile:` key (rerouting verified).
- `START_COMMENT` with a hunk-line cursor on `add` / `del` still produces `user:` (unchanged).
- Replies append correctly to `userFile:` threads.
- `MOVE_DOWN` / `MOVE_UP` cross between hunk-line and file-line cursor modes both in full-file view and in hunk mode with revealed expand blocks.
- `SET_CURSOR` from a click on an unchanged line lands a file-line cursor with the right `newNo`.
- Reload re-anchoring: a `userFile:` thread on a shifted unchanged line ends up keyed by the new `newNo`; on a deleted line it moves to Detached.

**Integration (`web/src/App.test.tsx` tier — real reducer, real view builder):**
- Clicking an expand-block line opens the composer with a `userFile:` key.
- Clicking an unchanged line in `FullFileView` opens the same composer.
- A thread written in hunk view is visible at the same line in full-file view (and vice versa) — one thread per line.
- Commenting on a deleted line still uses `user:${hunkId}:${lineIdx}`.
- Keyboard `j`/`k`/`c` walks into a revealed expand block, lands the cursor, and opens the composer.

**Gallery (`web/src/gallery.tsx` fixture):**
- A new fixture state showing an unchanged-line comment in both hunk mode and full-file mode, plus a `blockFile:` example.

No mocks of the diff parser, view builder, or anchor machinery, per the project's testing principles.

## Risks and mitigations

- **Cursor blast radius.** ~30 call sites read `cursor.hunkId` / `cursor.lineIdx`. The `isHunkLineCursor` guard plus a compiler pass after the type change makes coverage mechanical; every miss is a type error. Worth confirming with a green typecheck before merging.
- **Persistence migration of in-flight reviewers.** The cursor-shape bump is the only risky touch. The loader's legacy-cursor normaliser is a one-liner but warrants its own reducer test.
- **Snippet-match drift on re-anchor.** Already a known shape for existing threads; new key shapes ride on the same machinery.

## Follow-ups (not part of this work)

- `Hunk` → `Range` (or similar) type rename. Track in `docs/plans/` as its own design. Three tiers of effort were scoped (types only / types + persisted keys / everything including wire). Ship this feature first; pick a tier later.
- Cross-region block selection (mixing real-hunk and unchanged lines in one block). Defer until there's a demand signal.
- AI annotations on unchanged lines. Decided alongside the live AI-notes pipeline, not here.
