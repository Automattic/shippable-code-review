# Worktree live reload

When you point Shippable at a worktree, the changeset you see is a snapshot of `HEAD` at the moment you loaded it. If an agent commits five seconds later, or starts editing files without committing, the reviewer doesn't notice. You have to reopen the modal, find the worktree again, and reload — every time. For the "review-while-they-work" loop in `worktrees.md` to feel like an inbox rather than a stale pull, the reviewer has to follow the worktree on its own.

This plan adds **live reload**: while a worktree is loaded, the reviewer watches it for *any change* — new commits and uncommitted edits — and offers to surface them. The user always chooses when to absorb a new state; we don't yank the diff out from under them. On by default, with a clear toggle to turn it off — some users will want a stable view while they work through a review without the floor moving under them.

This folds in two items `worktrees.md` set aside as "deliberately out of scope": real-time file watching, and reviewing uncommitted working-tree changes. It also pairs with slice (c) of that plan — once we have a per-worktree review cursor, "live reload" and "what's new since I last reviewed" become the same loop expressed two ways.

## Goal

What this enables:

- Load a worktree, walk away, come back: the reviewer is showing the latest state — last commit if the tree is clean, or last commit *plus* whatever the agent has been editing since.
- Agent commits or edits while you're scrolling: a non-disruptive notification offers the new state, you click to load it.
- Reviewing dirty, uncommitted work feels normal — that's a primary use case, not a bonus.
- Comments survive the reload. Threads attached to lines that still exist stay inline. Threads whose lines moved or vanished show in a "Detached" pile in the sidebar with enough context to remain meaningful.
- One toggle per worktree, remembered across sessions and ON by default.

What it explicitly does *not* try to do:

- Live cursor / scroll preservation across reload. Best effort: same file if it still exists, otherwise file 0.
- Pushing updates to anyone but the user who loaded the worktree. Single-tab feature.
- Working in deployment modes without a server. Same gating as the parent feature.
- Per-keystroke updates. Polling cadence is the debounce.

## What "the diff" means

The clean default needs a rule that doesn't double-count when the agent commits work that was previously sitting uncommitted. The current `/api/worktrees/changeset` endpoint already returns the cumulative branch view (committed-since-base + uncommitted + untracked) by default — that's what LoadModal asks for. Live reload reuses that path for the clean case and adds a dirty-only path for the working-tree-only refresh.

**Rule:**

- **Clean tree** → cumulative branch view via the existing `branchChangeset` (committed-since-base + tracked uncommitted + untracked). Same as today's load.
- **Dirty tree** → `HEAD..working-tree` via the new `dirty=true` request. Just the uncommitted edits, staged or unstaged, plus untracked.

When an agent finishes their uncommitted edits and commits them, the view transitions cleanly: dirty hash goes away, HEAD advances by one, and the diff we show is `HEAD~1..HEAD` — which is *the same content* the user was just reviewing as uncommitted. No duplication, just a baseline shift.

The dirty-state changeset doesn't have a real commit sha. We synthesize one — `dirty:<dirtyHash>` — so the rest of the review machinery still has a stable id that changes when the underlying state changes.

## Comment anchoring

This is the part that's new versus the rest of the live-reload work. The existing reply keys are positional (`<csId>/<path>#h<n>:<lineIdx>`), which silently mis-attaches as soon as a hunk shifts. To reload without losing review progress, we anchor on **content** instead.

Each `Reply` is extended with:

```ts
{
  // existing fields…
  originSha: string;           // worktree HEAD at write time
  originType: "committed" | "dirty";
  anchorPath: string;
  anchorContext: DiffLine[];   // 10 lines centered on the anchor (≈5 above, anchor, ~4 below)
  anchorHash: string;          // hash of the inner 5 lines (anchor ± 2)
}
```

`anchorContext` is the wide window we keep for **display**. `anchorHash` is the narrow window we use for **matching**. We store both because the wide window is fragile as a match key (any nearby edit breaks it) but useful as an "is this what you commented on?" reminder. Storing the snippet alongside the hash means the unattached-dirty UX can show context without us having to chase the rapidly-mutating dirty diff.

**On reload, for each reply:**

1. Compute the candidate hash from the new diff at `(anchorPath, lineIdx)`. If it matches → keep inline at that location.
2. If not, scan the file's lines for any 5-line window with the same hash. Match → re-anchor (`lineIdx` updates). Cheap; one pass per reply per file.
3. No match → **detached**. Move the reply into a parallel `state.detachedReplies: DetachedReply[]` collection.

The same rule covers committed and dirty origins. The asymmetry is only in what the detached view offers:

- **Committed origin:** show body + `anchorContext` snippet + a "view at `<sha7>`" link that fetches the historical file content (slice (e)). Git is the source of truth; the snippet is just a hint.
- **Dirty origin:** show body + `anchorContext` snippet, captioned "from uncommitted edits at hh:mm." No "view at" link — there's no commit to fetch.

**Dirty → committed transition.** A comment authored against `dirty:<hash>` whose anchor hash matches the now-committed view re-attaches inline as if it had always been a committed comment. The `originSha` stays as it was at write time (the parent at that moment); we don't rewrite it. We're matching on content, not provenance.

## The slices

**(a) MVP — polling + notify banner, both commits and uncommitted.** Client polls `/api/worktrees/state?path=…` every few seconds. Endpoint returns `{ sha, dirty, dirtyHash }` where `dirtyHash` is a digest of `git status --porcelain=v2 -z` (or `null` when clean). If `sha` differs *or* `dirtyHash` differs from what's loaded, render a non-modal banner ("Worktree changed — reload") that the user clicks to refetch. Toggle in the review header turns polling off. *Done when:* you can leave the page open, an agent commits *or* edits, and within ~5 seconds you see the banner. Reload with no anchoring yet — comments still get displaced. The next slice fixes that.

*Why polling first, not push?* Polling is two cheap git calls behind a stateless POST — it survives server restarts, sleep/wake cycles, and `tsx watch` reloads without reconnect plumbing. `fs.watch` on macOS has historically been flaky for nested directories, and chokidar adds a dep we don't need at MVP scale. Slice (f) is the upgrade path once we have evidence polling is too slow or too chatty in real use.

**(b) Per-worktree toggle persistence.** localStorage key keyed by worktree identity (path for now, see open questions). The toggle remembers the last choice across sessions. Default-on for first encounter; respects the saved value after that. *Done when:* turning live reload off on one worktree doesn't affect another; reload sticks.

**(c) Content-anchored comments + detached sidebar.** Add `originSha`, `originType`, `anchorPath`, `anchorContext`, `anchorHash` to `Reply` at write time. New `RELOAD_CHANGESET` reducer action runs the anchoring pass (inline / re-anchor / detach) instead of `LOAD_CHANGESET` resetting the world. Sidebar gains a "Detached" group with per-file subgroups, only visible when non-empty. Each entry shows the body and the snippet; committed entries get a placeholder "view at `<sha7>`" affordance that's wired up in slice (e). *Done when:* you write a comment, the agent edits the file unrelatedly, you reload — your comment is still inline. You write another, the agent edits the line you commented on, you reload — your comment is detached with the original snippet visible.

Implementation notes from the slice (c) landing:
- `RELOAD_CHANGESET` carries `prevChangesetId` because the worktree-loaded changeset id embeds the sha (`wt-<sha12>`); a fresh commit produces a new id, and the reducer needs to know which entry to replace. Slice (a)'s polling will pass the active changeset id alongside the new one.
- Re-anchoring works at the *thread* level — if any `Reply` on a thread carries an `anchorHash`, that hash is what gets matched, and the whole thread moves together. Replies authored before slice (c) (no anchor fields) fall back to hashing the old hunk in place; they degrade gracefully rather than detaching gratuitously.
- Block-comment keys preserve their span size when re-anchored. Concretely: a comment originally on lines 10–15 (`originalSpan = 5`) whose anchor re-matches at line 22 in the new file becomes lines 22–27. The block keeps its length; if 27 falls past the new hunk's end, `hi` is clamped to the last line of the hunk so the range never escapes the diff.
- `hunkSummary` and `teammate` keys anchor at the hunk's first line (lineIdx 0). Re-attaching to the new hunk preserves the thread; rendering only happens if the new diff still has a summary/teammate review at that location.
- The anchor hash is FNV-1a-32 over `${kind[0]}|${text}` per line in the 5-line window, joined by `\n`. Out-of-bounds positions hash as empty strings so windows near the edges of a hunk produce stable values.
- Persisted snapshot bumps to `v: 2` (adds `detachedReplies` and per-reply anchor fields). The forward migration just appends `detachedReplies: []`.
- A `dirty?: boolean` flag landed on `WorktreeSource` ahead of slice (a) so `originType: "dirty"` capture is reachable now. The review topbar carries a debug `dirty` toggle for manual exercise of the dirty caption until polling lands.

**(d) Stop polling when the worktree is gone.** If the server reports the worktree path no longer exists or is no longer a git repo, surface that state once and stop polling. Don't loop on errors. *Done when:* `git worktree remove` while loaded shows a clean "this worktree is gone" state, not failure spam.

**(e) "View at `<sha>`" for outdated committed comments.** New endpoint `POST /api/worktrees/file-at` returning the file's content (or just a slice) at a given sha. Detached committed entries' "view at" link opens an inline panel that renders the historical file around the comment. Dirty entries don't get this affordance. *Done when:* clicking "view at" on an outdated committed comment shows the file as it was at that sha, scrolled to the anchor.

**Inline vs modal — chose inline.** The detached entry already lives in the sidebar with its body and 10-line snippet; "view at" expands directly underneath the entry, sharing the column. Reasons: (1) the snippet and the historical file are the same artifact at two zoom levels, so keeping them adjacent matches the reviewer's mental model; (2) a modal would steal focus from the live diff and force a context-switch every time a reviewer wanted to peek at a stale anchor; (3) the panel is bounded — fixed max-height with internal scroll — so a long file doesn't dominate the sidebar. Trade-off: with several entries open at once the sidebar gets visually busier; the per-entry hide button keeps that controllable, and panels only render for entries the user explicitly opened. Reply state carries an `anchorLineNo` (1-based) captured at write time so the panel scrolls to the original anchor without a server-side line-mapping pass; pre-anchorLineNo replies fall back to rendering from the top.

**(f) Server-pushed updates (optional, deferred).** Replace polling with SSE backed by `fs.watch` (or chokidar if cross-platform consistency matters by then). Worth doing only if (a) is meaningfully insufficient — e.g. reviewers complain about lag, or the request volume becomes a real cost. *Done when:* there's evidence polling is too slow or too chatty in real use.

Slices (a)–(d) are the feature. (e) is the next-most-useful follow-up. (f) is an "if we need it."

### Status (2026-05-07)

- **(a) Polling + banner** — shipped. `POST /api/worktrees/state`, hook, `LiveReloadBar`, reload via the existing changeset endpoint with `dirty=true` honored.
- **(b) Per-worktree toggle persistence** — shipped. `getLiveReloadEnabled` / `setLiveReloadEnabled` in `web/src/persist.ts`, keyed by absolute path, default-on, in its own localStorage key so `clearSession()` doesn't reset it.
- **(c) Content-anchored comments + detached sidebar** — shipped. Reducer + Sidebar UI landed earlier; the worktree-reload code path now dispatches `RELOAD_CHANGESET` instead of `LOAD_CHANGESET` so the anchoring pass runs on the existing replies.
- **(d) Stop polling when the worktree is gone** — shipped. Three-strike error counter in the hook; `onWorktreeGone` fires once.
- **(e) View at `<sha>`** — shipped. `POST /api/worktrees/file-at` (`git show <sha>:<file>`); inline panel under detached committed entries scrolls to `Reply.anchorLineNo`.
- **(f)** — not started.

### Later corrections (2026-06)

When you load a worktree you pick a *view* of its changes — the whole branch, a single commit, a range of commits, or a range plus your uncommitted edits. The SHA range picker (`fromRef..toRef`, optionally `+dirty`) landed the day after this feature and added that range view, which the reload path never knew about. Two bugs followed, both from the same mistake: using "what the worktree looks like right now" as a stand-in for "the view the user chose to review."

**On reload, re-fetch the view the user picked — don't guess it.** The original `reloadWorktree` built its request from `staleNext.dirty` (`dirty: wantDirty`) instead of from what was loaded. That held up while only two views existed (cumulative branch / dirty-only), but a range load reloaded as `git diff HEAD` — dropping every committed change. Reload now reconstructs `LoadOpts` from `cs.worktreeSource` (range → dirty → branch view) and routes through `fetchWorktreeChangeset`, which re-stamps `range`/`dirty` so a second reload doesn't re-break. Reload is not a frozen snapshot: it re-runs the chosen view's query against the *current* worktree, so new commits and edits inside that view's scope do show up — they just land in the same view instead of at a guessed scope. The trap that hid this: a "last commit + uncommitted" range and the cumulative branch view list the *same files*, so silently swapping one for the other isn't visually obvious — only the committed hunks quietly vanish.

**Only nudge "reload" for changes the loaded view would actually show.** `useWorktreeLiveReload` takes `watchSha` / `watchDirty`. A range loaded without "include uncommitted" ignores dirty edits (`watchDirty = range.includeDirty`); a range pinned to a fixed `toRef` ignores new commits (`watchSha = toRef === "HEAD"`). Branch and dirty-only views watch both. Without this, a range that excludes uncommitted work would pop "worktree changed — reload" and then reload nothing, because the re-fetch still excludes that work. Worktree-gone detection stays on regardless.

## Architecture sketch

```
┌─ Reviewer UI (web) ────────────────────────────────────────┐
│  ReviewHeader: live-reload toggle pill                     │
│  Banner ("worktree changed — reload") on stale state       │
│  Sidebar: "Detached" group when non-empty                  │
│  Polling hook owned by the loaded-worktree state           │
└──────────────────────────┬─────────────────────────────────┘
                           │  POST /api/worktrees/state    (cheap probe)
                           │  POST /api/worktrees/changeset  (existing,
                           │       extended to honor dirty=true)
                           │  POST /api/worktrees/file-at    (slice e)
                           ▼
┌─ Local server (server/) ───────────────────────────────────┐
│  New: POST /api/worktrees/state                            │
│       → { sha, dirty, dirtyHash: string|null }             │
│  changesetFor(path, { includeDirty }):                     │
│       clean → git show HEAD                                │
│       dirty → git diff HEAD                                │
│  New (slice e): file-at({ path, sha, file })               │
│       → { content }                                        │
│  Same path validation as the existing endpoints            │
└────────────────────────────────────────────────────────────┘
```

The `state` endpoint exists so the poll is two cheap git calls (`rev-parse HEAD` + `status --porcelain=v2 -z`) rather than re-running `git show`/`git diff` every interval. The expensive `changeset` call only fires when the user clicks reload.

## Deployment-mode matrix

Same as the parent worktrees feature — only modes that already support worktree ingest support live reload. In any mode where the worktree tab is hidden, this toggle never appears.

| Mode                              | Supported? |
|-----------------------------------|------------|
| Browser + local server (dev)      | Yes        |
| Tauri desktop (bundled sidecar)   | Yes        |
| Browser only, no server           | No         |
| Can't-clone-to-disk (memory-only) | No         |

## Open questions

- **Polling cadence.** 5s feels right for an agent-watching loop. With uncommitted edits in the picture, faster (3s) is more tempting. Lean: **3 seconds, hard-coded.** Revisit if request volume is noticeable.

- **Edit debounce.** Agent typing produces a different `dirtyHash` every keystroke. Since the user gates the actual reload via the banner, we don't need to debounce — the banner can update freely until the user clicks. Lean: **no debounce.** The user-click is the debounce.

- **Anchor hash window.** 5 lines (anchor ± 2) is the lean. Narrower (3) is twitchier but rarer to false-match. Wider (7+) shifts more comments to detached for unrelated nearby edits. Lean: **5.**

- **Anchor context window for display.** 10 lines (5 up, 4 down, plus anchor) is the lean — enough to make a snippet self-explanatory without bloating storage. Comments are typically authored against a single line or short range, so 10 lines almost always covers the surrounding scope. Lean: **10.**

- **Storage budget.** A few KB per comment in localStorage. Not a worry at prototype scale, but flag when persisted state hits the localStorage quota (~5MB) — most likely from a long thread on a long-lived worktree. Lean: **don't pre-optimize; surface a warning if persist write fails.**

- **Worktree identity for the toggle key.** Path is what we have. If the worktree gets renamed mid-session the toggle resets. Lean: **start with path; revisit when (c) lands and we need a real identity scheme for cursors anyway.**

- **Toggle-map GC.** The `shippable:liveReload:v1` map accumulates an entry per absolute worktree path the user has ever loaded. There's no cleanup pass. Auto-deleting on `onWorktreeGone` is wrong — that fires after three poll failures (sleep/wake, server restart, network blip) and would silently drop a real preference. Each entry is tiny (~100 bytes); a user accumulating 50K worktree paths to hit the 5MB localStorage quota is not a realistic shape. Lean: **no GC for now; revisit if we ever ship a "manage worktrees" surface, or if a user reports the map filling up.**

- **What about banner UX when the user has the toggle off?** Off means off — no surprise banner. Lean: **stop polling entirely when toggled off.**

- **Cursor preservation on reload.** Best effort. If `cursor.fileId` exists in the new diff, keep the file and pick its first hunk. Otherwise file 0. Don't try to preserve hunk + lineIdx — too fragile, and the user has to scroll a bit anyway when content changes. Lean: **same file if available, else file 0.**

- **Failure surfacing during polling.** Network errors are common (sleep, server restart). Spamming a banner per failure is bad. Lean: **silent retry with a small ceiling (3 consecutive failures), then surface "worktree gone" once and stop. (Slice d.)**

- **Re-anchor performance.** The anchoring pass is O(replies × lines-in-changed-files) in the worst case. For prototype scale (≪100 comments × ≪10K lines) this is fine. If it ever becomes hot, build a single hash → location index per file once per reload and look replies up against it. Lean: **naive scan, optimize when measured.**

- **Merges / detached HEAD / interactive rebases.** A worktree being rewritten under us will produce wild dirty hashes and HEAD jumps. The model should handle it — comments either content-match into the new state or detach. Worth confirming once we test against a real agent loop. No action needed in MVP.

## What's deliberately out of scope (for now)

- Cross-tab coordination (multiple Shippable tabs on the same worktree). One tab polls, the others don't.
- Notifications outside the page (system notifications, sound). Quiet UI updates only.
- Manual re-attach for detached comments ("drag this comment back onto a line"). Detached is a one-way state in this slice.
- Reviewing arbitrary commit ranges that include uncommitted state. Live reload only refreshes the *current* loaded view.
- Moving threads between files. If a file gets renamed, anchored comments will detach; that's acceptable for the prototype.

## Files of interest

- `web/src/App.tsx` — owns the loaded `ChangeSet` + worktree provenance; the polling hook lives at this level so it can swap the changeset.
- `web/src/components/LoadModal.tsx` — already loads worktrees; provenance (path + sha + dirtyHash) needs to flow into the loaded state so the reviewer knows what to poll.
- `web/src/components/Sidebar.tsx` — new "Detached" section.
- `web/src/components/LiveReloadBar.tsx` — new banner component.
- `web/src/useWorktreeLiveReload.ts` — new polling hook.
- `web/src/persist.ts` — extend to remember the live-reload toggle per worktree identity, and to round-trip detached replies.
- `web/src/types.ts` — `WorktreeState`, `WorktreeProvenance`, anchor fields on `Reply`, `DetachedReply`.
- `web/src/state.ts` — new `RELOAD_CHANGESET` action with the anchoring pass; `state.detachedReplies`.
- `web/src/anchor.ts` — new helper: hash a 5-line window, find a matching window in a file, capture the 10-line context at write time.
- `server/src/worktrees.ts` — new `stateFor(path)` (rev-parse + status hash); extend `changesetFor` to handle the dirty case; new `fileAt(path, sha, file)` (slice e).
- `server/src/index.ts` — new `POST /api/worktrees/state`; new `POST /api/worktrees/file-at` (slice e).
- `docs/plans/worktrees.md` — cross-link this plan; the "Real-time file watching" and "Reviewing uncommitted working-tree changes" out-of-scope bullets should point here.
