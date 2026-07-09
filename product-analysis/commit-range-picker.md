# Commit Range Picker

## 1. Product reasoning & priority

A worktree is not a single state — it's a branch with N commits since divergence, plus an optionally dirty working tree. The default LoadModal click loads "everything since base + uncommitted + untracked" (`branchChangeset`) which is the right answer for a fresh review session but the wrong answer for "let me look at just the last three commits" or "skip the merge commit and review what came in last." The range picker exists to narrow that default: pick a `from` SHA, optionally a `to` SHA (default HEAD), optionally include uncommitted edits when `to === HEAD`. It also doubles as a recovery surface when the default load returns an empty diff (branch at parity with base, picked merge commit, etc.) — `useWorktreeLoader` auto-opens the picker on `EmptyDiffError` so the user doesn't stare at a "nothing to show" message.

Suggested priority: **must-have** for the worktree-centric flow — without it, repositioning a stale review requires re-loading the whole branch and the empty-diff recovery has no UI. **Nice-to-have** in isolation: the same problem can be solved with a CLI and a `git diff` URL upload, but the friction would be high enough to discourage the agent-watching loop the product is built around.

## 2. Acceptance criteria for a rebuild

- The picker opens from two surfaces: per-worktree-row "pick range…" button in LoadModal, and the topbar `⇄ range` button while a worktree changeset is loaded.
- The picker fetches recent commits via `POST /api/worktrees/commits` (default 50, capped at 500 server-side).
- A plain click on a commit row sets `from`; a shift-click sets `to`. The currently selected `from` and `to` rows are visually marked; rows between them get an "in-range" tint.
- The `include uncommitted changes` checkbox is enabled only when `to === "HEAD"`; switching `to` to a non-HEAD ref auto-clears the checkbox.
- A per-row "just this" button loads exactly that commit as `kind: "ref"` (single-commit review) and bypasses the from/to flow entirely.
- The `cancel` button closes without dispatching anything.
- On `apply`, the picker dispatches `kind: "range"` with `fromRef`, `toRef`, and `includeDirty`; the resulting `ChangeSet` carries `worktreeSource.range = { fromRef, toRef, includeDirty }`.
- The topbar picker prefills `from` / `to` / `includeDirty` from the active changeset's `worktreeSource.range` (re-slice without re-paste).
- Range loads use a deterministic id (`wt-range-<from7>-<sha7>[-d]` per `web/src/worktreeChangeset.ts:120-126`) so two reviews of the same slice land on the same `ReviewState` entry.
- The picker survives `EmptyDiffError`: when the default load fails empty, the row's picker opens automatically with the empty-summary copy and a soft "pick a range below to compare commits" message.

## 3. Existing architecture & system design

### Data model

- `LoadOpts` (`web/src/worktreeChangeset.ts:82-85`) — the discriminated union the picker produces: `{ kind: "range"; fromRef; toRef; includeDirty }` or `{ kind: "ref"; ref }` or `{ kind: "dirty" }`.
- `CommitInfo` (`web/src/worktreeChangeset.ts:62-69`) — `{ sha, shortSha, subject, author, date, parents }`. The list the picker renders.
- `WorktreeSource.range` (`web/src/types.ts:491-500`) — `{ fromRef, toRef, includeDirty }`, stamped on the `ChangeSet` so re-opening the topbar picker can prefill. `includeDirty` is only honoured server-side when `toRef === "HEAD"`.
- `RangeCommit` (`server/src/worktrees.ts:78-89`) — what the *server* attaches to `ChangesetResult.commits[]` for range loads: `{ sha, shortSha, subject, body, author, date, parents, files }`. Drives the per-commit plan diagram.

### Current architecture decisions

- **Range vs single-commit vs dirty are three discrete paths.** `LoadOpts` is the discriminator on the client; the server's `handleWorktreesChangeset` (`server/src/index.ts:546-557`) has a four-way routing precedence: `range > dirty > single-ref > branch`. The branch view is the default when none of the optional fields are set.
- **Three server functions, one endpoint.** `rangeChangeset` (`server/src/worktrees.ts:766-897`) drives ranges; `dirtyChangesetFor` drives `kind: "dirty"`; `changesetFor` drives `kind: "ref"`; `branchChangeset` drives the default. All four return the same `ChangesetResult` shape, including `state` (live-reload baseline), `parentSha` (display label), and `commits[]` (per-commit plan breakdown, when applicable).
- **Empty diff is a typed error.** `EmptyDiffError` (`web/src/worktreeChangeset.ts:25-32`) carries a human-readable `summary` that picker calls render directly. `useWorktreeLoader.loadFromWorktree` catches it and stashes it in `wtEmpty`, which `LoadModal` reads to auto-open the picker for that row (`LoadModal.tsx:109-119, 318-323`).
- **`includeDirty` is double-gated.** The picker disables the checkbox when `to !== HEAD`; the server's `rangeChangeset` only applies dirty content when `toRef === "HEAD"` and the tree is actually dirty (`worktrees.ts:809-829`). Defence in depth.
- **The id mangling for range loads.** Range loads compute `wt-range-<from7>-<toSha7>[-d]` because `toRef === "HEAD"` would otherwise produce the literal string `wt-range-<from>-HEAD` and lose persistence identity across HEAD movement (`worktreeChangeset.ts:120-126`).
- **`just this` shortcut routes around the from/to fields.** It dispatches `kind: "ref"` directly. That hits `changesetFor` server-side (which uses `git show <sha>` rather than `git diff <base>..<sha>`) — *not* the same as a range with `from === to`. Single-commit-as-show vs single-commit-as-diff-base-to-tip *is* a meaningful semantic distinction for merge commits (a merge's `git show` is the combined-with-second-parent view by default; the range form has no opinion).

### How it evolved

Per `docs/plans/worktrees.md:31`, the picker shipped as slice (b) of the worktrees plan: "Per-worktree commit picker. ✅ Shipped." The original ingest path (slice a) was HEAD-only. The decision to give a picker rather than expose `git log --grep` style filtering was deliberate — the picker is "pick a range," not "find the commit that mentions X." `docs/features/commit-range-picker.md` is the user-facing summary.

### Gaps

- **No paging.** Default limit is 50 (server cap 500). Long-lived branches with 200+ commits since divergence force the user back to the CLI to find an older SHA.
- **No commit-grouping.** Merge commits aren't visually distinguished from regular commits; a merge that brings in 30 commits looks like a single row.
- **No search / filter.** Commit subject or author search would be cheap.
- **`to !== HEAD` + dirty is silent.** When the user has dirty edits and picks a non-HEAD `to`, the dirty checkbox grays out with a tooltip but the picker doesn't say "FYI you've got uncommitted edits this slice won't include."
- **The picker has no "from = merge-base" shortcut.** Common case in real workflows; "from this branch's base" is two clicks plus knowing the base SHA.
- **No keyboard navigation in the picker.** Arrow keys / Enter to set from / Shift+Enter to set to would be cheap.
- **GitHub PR loads have no range picker.** Reviewing "just the last commit of a PR" requires either an external `.diff` URL or loading the worktree the PR maps to. The PR ingest path is HEAD-only by design — see `github-pr-ingest.md` § Gaps.

### How it differs from the worktree HEAD-vs-working-tree shape

The default `branchChangeset` returns the *cumulative* branch view: committed-since-base + uncommitted-tracked + untracked. Live-reload's dirty-only refresh (`dirtyChangesetFor`) returns just the uncommitted-tracked + untracked piece, with a synthetic `dirty:<dirtyHash>` SHA. The range picker covers a third axis — arbitrary `from..to` slices — and `includeDirty` is what bridges range mode back into the "and also working tree" world. So three orthogonal axes:

| Selection | sha label | Diff body |
|-----------|-----------|-----------|
| LoadModal default | real HEAD sha | base..HEAD + dirty + untracked |
| live-reload dirty=true | `dirty:<hash>` | HEAD..working-tree + untracked |
| RangePicker `from..to`, to=HEAD, includeDirty | `dirty:<hash>` when actually dirty, else real HEAD | from^..HEAD + dirty + untracked |
| RangePicker `from..to`, to≠HEAD | real `to` sha | from^..to |
| "just this" | real sha | git show (merge-aware) |

That table is what the rebuild has to preserve.

## 4. Rebuild opportunities

### Data unification

`LoadOpts` is already a clean discriminated union — three variants, no `null` fields. The `Range` variant could honestly absorb the other two:

```ts
type LoadOpts = {
  fromRef: string;        // "" / undefined means "from base" (branch default)
  toRef: string | "HEAD" | "WORKING_TREE";
  includeDirty: boolean;  // ignored unless toRef ∈ {HEAD, WORKING_TREE}
};
```

That re-frames `kind: "dirty"` as "to = WORKING_TREE" and `kind: "ref"` as "from = sha, to = sha." Server-side, the four functions (`branchChangeset`, `dirtyChangesetFor`, `changesetFor`, `rangeChangeset`) could collapse to one with a clear precedence: each axis (`from`, `to`, `includeDirty`) has a default; the function reads them all. The only true semantic outlier is "just this" → `git show` (merge-aware combined diff) vs `git diff <sha>^..<sha>` (first-parent diff). Probably worth keeping `just this` as a distinct `kind: "show"` to preserve that semantic.

### Better architecture

- **Lift "empty + recovery picker" into the load surface itself.** The pattern in `useWorktreeLoader.loadFromWorktree` — catch `EmptyDiffError`, surface a soft message, open the picker — is exactly the empty-state recovery the URL/file/paste paths lack. If `useLoadSurface()` (the cross-cutting refactor noted in `_group7-unification-notes.md`) lands, the picker becomes its recovery handler for any ingest path that has a notion of "slice."
- **Show the per-commit plan inline.** The server already populates `ChangesetResult.commits[]` (newest-first, capped at 50) for range loads. The picker UI today is "list of all commits in HEAD-ward order"; merging in "files touched" + "body" (already present in `RangeCommit`) would make the picker a richer pre-load preview without a separate API call.
- **Add a "from base" shortcut.** The server already resolves `@{upstream}` / `origin/main` / `origin/master` / `main` / `master` in `resolveBaseRef`. Surfacing that resolved base SHA in the picker as a one-click "from base" option would close the most common workflow gap.
- **Keyboard navigation.** Same model as the existing diff cursor: `j/k` to move row, Enter to set from, Shift+Enter to set to, Esc to close.
- **Persist last-used picker state per worktree path.** Today `WorktreeSource.range` is stamped on the loaded `ChangeSet`, so reopening the topbar picker prefills correctly while the changeset is loaded. Re-opening the LoadModal picker on the same row gets *no* prefill. localStorage keyed by `worktreePath` would close the gap.

## Sources

- `/workspace/web/src/components/RangePicker.tsx:1-218`
- `/workspace/web/src/worktreeChangeset.ts:62-164`
- `/workspace/web/src/useWorktreeLoader.ts:110-144`
- `/workspace/web/src/components/LoadModal.tsx:309-348`
- `/workspace/web/src/components/ReviewWorkspace.tsx:1647-1810`
- `/workspace/web/src/types.ts:491-500`
- `/workspace/server/src/index.ts:500-568`
- `/workspace/server/src/worktrees.ts:340-421, 569-643, 650-685, 766-897`
- `/workspace/docs/plans/worktrees.md:31`
- `/workspace/docs/features/commit-range-picker.md`
