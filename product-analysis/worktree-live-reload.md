# Worktree Live Reload

## 1. Product reasoning & priority

A snapshot review is the wrong default for the "review-while-they-work" loop the worktrees plan is built around. If a reviewer opens a worktree, walks away, and an agent commits five seconds later, the reviewer comes back to a stale diff with no warning. Live reload is the difference between Shippable feeling like an inbox you check on (commits land, you choose when to absorb them) and feeling like a pull-style tool you have to manually refresh. It's also the only place dirty-tree review becomes first-class: when the agent is mid-edit and hasn't committed, the reviewer can still see the work as a `HEAD..working-tree` diff.

The piece that makes this hard isn't the polling — it's the comment-anchoring. The first ingest path keyed replies positionally (`<csId>/<path>#h<n>:<lineIdx>`), which silently mis-attaches as soon as a hunk shifts. Live reload introduces content-based anchoring (`anchorHash` over a 5-line window) so replies survive unrelated edits and the ones that can't survive land in a "Detached" pile rather than disappearing.

Suggested priority: **must-have**. Without live reload the worktree ingest is half a feature — you can review the snapshot you loaded, but the agent loop the worktrees plan opens with ("agent commits → reviewer notices → you review → feedback flows back") doesn't close. The plan called this out explicitly in `worktree-live-reload.md:3`: "for the loop to feel like an inbox rather than a stale pull, the reviewer has to follow the worktree on its own."

## 2. Acceptance criteria for a rebuild

- A `LiveReloadBar` renders above the topbar whenever the active `ChangeSet` has `worktreeSource` and a non-null `state` baseline.
- The bar has three visual states: **idle** (watching `<branch>`, with pause/resume), **stale** (drift detected, primary reload action), **gone** (3+ consecutive poll failures, dismiss-only).
- Polling cadence is **3000 ms**, hard-coded in `useWorktreeLiveReload.ts:5`.
- The poll fires `POST /api/worktrees/state` with `{ path }`; the server returns `{ sha, dirty, dirtyHash }`. The poll is two cheap git calls — `rev-parse HEAD` + `status --porcelain=v2 -z`.
- A drift is declared when `sha !== baselineSha || (dirtyHash ?? null) !== baselineDirtyHash`. Either axis triggers; the banner copy distinguishes new-commit / new-edit / cleared-edit (`LiveReloadBar.tsx:98-107`).
- The user clicks **reload** to apply the drift; the diff is never swapped without consent.
- Reload dispatches `RELOAD_CHANGESET` (not `LOAD_CHANGESET`) so the content-anchoring pass runs on existing interactions.
- The polling hook stops after **3 consecutive errors**, fires `onWorktreeGone` once, and does not retry until something resets the hook (e.g., the user dismisses and toggles, or the worktree changes).
- Per-worktree toggle persists by absolute path in `localStorage["shippable:liveReload:v1"]`, defaulting to on; toggle-off stops polling entirely.
- The toggle map lives in its own localStorage key so `clearSession()` doesn't reset preferences (`persist.ts:22-25`).
- Interactions carrying `anchorHash` re-anchor by content: if the new diff has a 5-line window matching the hash, the thread moves to that location; otherwise it moves into `state.detachedInteractions`.
- Detached committed interactions carry an "view at `<sha7>`" affordance backed by `POST /api/worktrees/file-at` that renders the historical file inline under the detached entry (slice (e), shipped).
- Cursor preservation on reload is best-effort: same file if it survives, otherwise file 0.
- Block-comment span size is preserved when re-anchoring: a comment on lines 10–15 that re-anchors at line 22 becomes lines 22–27 (`worktree-live-reload.md:84`).
- A `dirty:<dirtyHash>` synthetic SHA is the changeset id for dirty-tree views; transitions cleanly back to `wt-<realSha>` when an agent commits the same content.

## 3. Existing architecture & system design

### Data model

- `WorktreeState` (`web/src/types.ts` / `server/src/worktrees.ts:63-67`) — `{ sha: string; dirty: boolean; dirtyHash: string | null }`. The polling baseline.
- `WorktreeSource.state` (`web/src/types.ts:501`) — the baseline carried on the active `ChangeSet`. The server stamps this on every changeset response so reload doesn't need a second probe.
- `WorktreeProvenance` (`web/src/types.ts:509-513`) — `{ path, branch, state }`, the polling-baseline shape derived from `worktreeSource` in `App.tsx:338-342`. Null when no worktree is loaded.
- `WorktreeSource.dirty?: boolean` (`web/src/types.ts:490`) — true when the loaded view contains uncommitted edits; comments authored against it tag with `originType: "dirty"`.
- Anchor fields on `Interaction` — `originSha`, `originType: "committed" | "dirty"`, `anchorPath`, `anchorContext: DiffLine[]` (the 10-line display window), `anchorHash` (FNV-1a-32 over `${kind[0]}|${text}` per line in a 5-line window, joined by `\n`).
- `DetachedInteraction` (`web/src/types.ts:219-223`) — `{ interaction: Interaction; threadKey: string }`. The original thread key is preserved so persistence round-trips cleanly.
- localStorage:
  - `shippable:liveReload:v1` (`web/src/persist.ts:26`) — per-worktree-path boolean map. Default-on (`getLiveReloadEnabled` returns `true` for missing keys, `persist.ts:46`).
  - The detached-interactions list rides on the persisted snapshot (`v: 7` in `persist.ts`); it was a forward-only migration from `v: 1` ("just append `detachedReplies: []`").

### Current architecture decisions

- **Poll, don't push.** `worktree-live-reload.md:73-75` is explicit about why: polling is two cheap git calls behind a stateless POST that survives server restarts, sleep/wake cycles, and `tsx watch` reloads. `fs.watch` on macOS is flaky for nested dirs, chokidar adds a dep. Slice (f) is the upgrade path if polling becomes too slow or too chatty.
- **Two endpoints, separated for cost.** `POST /api/worktrees/state` is the cheap probe (rev-parse + status). `POST /api/worktrees/changeset` is the expensive call (full diff + file contents + commit metadata) and only fires when the user clicks reload. `POST /api/worktrees/file-at` (slice e) backs the "view at `<sha>`" detail panel.
- **Reload is `RELOAD_CHANGESET`, not `LOAD_CHANGESET`.** Critically different: `LOAD_CHANGESET` resets state; `RELOAD_CHANGESET` runs the anchoring pass (`web/src/state.ts:771`) that re-anchors existing interactions against the new diff or moves them to `detachedInteractions`. The reducer takes `prevChangesetId` because every worktree changeset id embeds the sha (`wt-<sha12>`), so a fresh commit always produces a new id — the reducer needs to know which entry to replace.
- **Thread-level anchoring.** When a thread has multiple interactions, the *thread's* anchor hash is the first-found hash on any entry; the whole thread moves together (`state.ts:843-846`). Replies authored before anchoring shipped (no hash) fall back to hashing the old hunk in place — graceful degradation.
- **State invalidation feeds the code graph.** `server/src/worktrees.ts:293-315` keeps a `lastFingerprint` map keyed by worktree path. When the poll's `(sha, dirtyHash)` fingerprint drifts, the server fires `invalidateCodeGraphForWorkspace` so the next graph request gets fresh LSP references against the new content. The polling endpoint is the closest thing the server has to a file-watcher tick.
- **Three-strike error counter.** `useWorktreeLiveReload.ts:8-9, 76-82` — silent retry up to 3 consecutive failures, then surface "worktree gone" once and stop. Avoids spamming the banner during sleep/wake or server restarts.
- **Cursor reset is bounded.** The reload reducer keeps the cursor on the same file if it survives the diff, otherwise resets to file 0 (`state.ts:771-781` — exits early on no-files-changed). Hunk + lineIdx are not preserved across reload (too fragile per `worktree-live-reload.md:166`).
- **Toggle key separation.** The live-reload toggle map sits in its own localStorage key (`shippable:liveReload:v1`) rather than the main review snapshot (`shippable:review:v7`). This was deliberate per the plan — toggle preferences outlive any single review and shouldn't get nuked by `clearSession()` (`persist.ts:22-25`).

### How it evolved

`docs/plans/worktree-live-reload.md` is the canonical record. The plan landed in five shipped slices (a)–(e):

- (a) Polling + banner. `POST /api/worktrees/state` + `LiveReloadBar` + reload via the existing changeset endpoint honoring `dirty=true`. Shipped.
- (b) Per-worktree toggle persistence. `getLiveReloadEnabled` / `setLiveReloadEnabled` in `persist.ts`, keyed by absolute path. Shipped.
- (c) Content-anchored comments + detached sidebar. `RELOAD_CHANGESET` action with the anchoring pass; `state.detachedInteractions`. Shipped.
- (d) Stop polling when the worktree is gone. Three-strike counter. Shipped.
- (e) "View at `<sha>`" for outdated committed comments. `POST /api/worktrees/file-at`. Shipped.
- (f) SSE / `fs.watch` push. Not started; explicitly deferred until polling is proven insufficient.

The plan folded in two earlier "out of scope" items from `worktrees.md`: real-time file watching, and reviewing uncommitted edits. Both are now first-class. The synthetic `dirty:<dirtyHash>` SHA was the key trick that made dirty review work with the rest of the review machinery — the rest of the code (ReviewState persistence, navigation, etc.) only needs *a* stable id that changes when the underlying state changes, not necessarily a real git SHA.

### Gaps

- **No push channel.** Slice (f) is unshipped. Polling at 3s is fine at prototype scale; would be wasteful for a hosted multi-tenant deployment.
- **Cross-tab coordination.** Two Shippable tabs on the same worktree both poll independently. Explicitly out of scope per `worktree-live-reload.md:177`.
- **No manual re-attach for detached comments.** Detached is a one-way state; the user can't drag a detached entry back onto a line.
- **No file-rename handling.** When a file gets renamed in a commit, anchored comments on it detach gratuitously rather than following the rename. `worktree-live-reload.md:180` acknowledges this.
- **No banner UX for arbitrary range loads.** The active changeset has to be a default worktree load (or a range that maps cleanly to a stable poll baseline). A range load with `from = <sha>, to = <sha>` will poll, but a new HEAD commit doesn't affect that range so the bar churns.
- **No live-reload for non-worktree ingest paths.** PR ingest has no polling; the conceptual mapping (`MERGE_PR_INTERACTIONS` is the same "merge external state into the open changeset" pattern) exists but the cadence machinery doesn't.
- **No GC on the toggle map.** `worktree-live-reload.md:162` documented the trade-off explicitly: each entry is ~100 bytes; a user accumulating 50K worktree paths is not realistic. Worth revisiting if a "manage worktrees" surface ever ships.

## 4. Rebuild opportunities

### Data unification

Worktree live-reload and PR overlay are conceptually the same primitive: "external state arrived; reconcile against current changeset." The data shape is different (worktree gives back a fresh diff that has to be re-anchored; PR overlay gives back metadata + comments that have to be merged) but the reducer contract is the same:

```ts
type ExternalUpdate =
  | { kind: "reload"; nextChangeset: ChangeSet; prevChangesetId: string }
  | { kind: "overlay"; changesetId: string;
      provenance: PrSource; conversation: PrConversationItem[];
      interactions: Record<string, Interaction[]>; detached: DetachedInteraction[] };
```

Today these are three actions: `RELOAD_CHANGESET`, `MERGE_PR_OVERLAY`, `MERGE_PR_INTERACTIONS`. The first runs the content-anchoring pass; the latter two are pure merges. They could be one `APPLY_EXTERNAL_UPDATE` reducer with the anchoring pass running conditionally on the kind. See `_group7-unification-notes.md` for the broader move.

Anchor fields on `Interaction` are also worth examining. `originType: "committed" | "dirty"` is a two-state field today; both states mean "anchored at write time against a worktree-loaded diff." A PR-sourced comment that becomes outdated is structurally identical (it has `original_line`, `diff_hunk`, `original_commit_id`) but enters via a different code path (`pr-load.ts:248-272`). The cleanest model would be one `Origin` discriminator on every anchored interaction — `{ kind: "worktree" | "pr"; sha: string; ... }` — so the same re-anchoring code can chase a comment across both a worktree reload *and* a PR refresh.

### Better architecture

- **One polling primitive.** A `useExternalSync({ source, interval, onDrift })` hook that handles the poll, error counter, and toggle-gating, called once per source type (worktree, PR). Today only worktree polls; PR is manual-refresh-only because no second instance was needed yet.
- **Move the dirty/clean transition cleanup into the reducer.** Today the `dirty:<hash>` SHA disappearing is a side-effect of the new ChangeSet id replacing the old one. A reducer assertion that "if `originType === 'dirty'` on an interaction and the post-reload thread re-anchors, leave `originSha` alone" is in `worktree-live-reload.md:69` but not surfaced as a test invariant.
- **Anchor-hash collisions.** FNV-1a-32 over a 5-line window is fast and ~good-enough at prototype scale. At repo scale (Gutenberg) a 32-bit hash will collide. Lifting to xxh3-64 (or even SHA-1-truncated-128) when measurements show it's needed is the right deferred move.
- **Server-side fingerprint cache for free.** `lastFingerprint` in `worktrees.ts:293` already exists. Exposing it as a `lastTransitionAt` timestamp would let the UI render "last commit 12 minutes ago" without an extra `git log` round-trip.
- **Detached "view at" panel for PR-sourced detached interactions.** The plumbing exists for worktree-sourced detached interactions (`fileAt` endpoint); the PR equivalent would call GitHub's `GET /repos/.../contents/{path}?ref=<sha>`. Gated on a fresh PAT.

## Sources

- `/workspace/web/src/useWorktreeLiveReload.ts:1-94`
- `/workspace/web/src/components/LiveReloadBar.tsx:1-107`
- `/workspace/web/src/App.tsx:336-450`
- `/workspace/web/src/state.ts:184-187, 420-421, 771-900`
- `/workspace/web/src/persist.ts:22-60`
- `/workspace/web/src/types.ts:480-513, 219-223`
- `/workspace/server/src/worktrees.ts:283-333, 569-643, 999-1013`
- `/workspace/server/src/index.ts:120, 123`
- `/workspace/docs/plans/worktree-live-reload.md`
- `/workspace/docs/features/worktree-live-reload.md`
- `/workspace/docs/concepts/changeset-hierarchy.md:11`
