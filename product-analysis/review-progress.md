# Review progress

## 1. Product reasoning & priority

Review progress is the load-bearing reason this tool exists rather than being a glorified diff viewer. It encodes "where the cursor has been," "what files I've explicitly ticked," "what guide nudges I've already dismissed," and folds that into a status-bar coverage display so a reviewer in a long session can see at a glance what's been touched, what hasn't, and what's left to verdict. Without it Shippable would tell users nothing about their own session, and `IDEA.md` is explicit that "highlight what you already reviewed without needing to be told about it" is one of the core jobs.

Suggested priority: **must-have**. The whole product thesis ("help the reviewer stay present, not let long sessions become LGTM parties") collapses if progress isn't tracked. For a rebuild the open question is *not* whether to ship it but where it lives (local browser vs durable server) — see § 4.

## 2. Acceptance criteria for a rebuild

- Every cursor move (`j`/`k`/`ArrowDown`/`ArrowUp`/`MOVE_HUNK`/`MOVE_FILE`/`MOVE_TO_COMMENT`/`SET_CURSOR`/`SWITCH_CHANGESET`) extends `readLines` for the destination hunk (`state.ts:1155`); arrow-only movement without a click still counts as a visit.
- `MARK_LINES_READ`/`MARK_LINES_UNREAD` (right-click menu) let the reviewer bulk-mark a hunk-local range without moving the cursor (`state.ts:593`–`617`).
- `hunkCoverage`, `fileCoverage`, `changesetCoverage` round-trip a 0–1 ratio with the canonical denominator `hunk.lines.length` (`state.ts:1456`–`1491`). Coverage equals 0 when there are no lines (no NaN).
- A "reviewed N/M" cell renders in the status bar from `reviewedFiles.size` and the active changeset's file count (`StatusBar.tsx:21–26`, `view.ts:594`).
- Status-bar contextual hint promotes `⇧M` when the current file's read fraction is 1 and it isn't yet signed off, and promotes `⇧S` when the whole changeset is read but unsigned (`view.ts:644`–`652`). A rebuild should keep this "what's the most useful key right now" heuristic intact.
- Reload restores cursor file + line + hunk + lineIdx exactly when the persisted ids still exist in the loaded changeset; falls back cleanly to the first hunk-bearing file when they don't (`persist.ts:225`, `persist.ts:324`).
- `readLines` Sets survive a reload: per-hunk arrays in storage, rehydrated into `Set<number>` only for hunk ids that still exist in the current changesets (`persist.ts:234`–`238`).
- `reviewedFiles` Set survives a reload, filtered to file ids still present in the current changesets so a different fixture's stale ids don't poison the new session (`persist.ts:262`).
- `dismissedGuides` survives a reload, used to suppress already-dismissed guide suggestions on the same `${fromHunk}->${toHunk}:${symbol}` id (`guide.ts:42`).
- Hunkless files (binary adds, pure renames) never seat the cursor; the reducer/persist both skip to the first hunk-bearing file (`state.ts:107`, `state.ts:371`, `persist.ts:328`).
- A snapshot whose `v` is anything other than 7 is rejected at load and the store boots empty — explicit "no migration" policy (`persist.ts:62–70`, `persist.ts:277`).
- Save is debounced 300 ms after the last state/drafts change (`App.tsx:213`).
- `hasProgress()` returns true iff the reviewer has done something meaningful: any reviewed file, any reviewed-changeset entry, any hunk with >1 read line, any non-blank draft, or cursor.lineIdx > 0 (`persist.ts:180`–`195`). The welcome boot relies on this signal — anything weaker would resurrect a session no one started.

## 3. Existing architecture & system design

### Data model

- `ReviewState.readLines: Record<hunkId, Set<number>>` — `web/src/types.ts:264`. Auto-populated on every cursor move.
- `ReviewState.reviewedFiles: Set<fileId>` — `web/src/types.ts:269`. Single explicit verdict per file.
- `ReviewState.dismissedGuides: Set<string>` — `web/src/types.ts:279`. Keyed by `${hunk.id}->${otherHunk.id}:${symbol}` (`guide.ts:42`).
- `ReviewState.cursor: { changesetId, fileId, hunkId, lineIdx }` — `web/src/types.ts:206`.
- Coverage helpers `hunkCoverage`, `fileCoverage`, `changesetCoverage`, `reviewedFilesCount` — `web/src/state.ts:1456`–`1501`. Pure functions over `readLines`.

### Current architecture decisions

- **Everything lives in localStorage.** `persist.ts` round-trips the whole progress slice through one key `shippable:review:v1` (`persist.ts:17`). The single-key choice is justified inline: data already namespaces by `hunkId` / `fileId` (which themselves embed the changeset id), so one blob loads everything.
- **Schema version 7, no migrations.** `v: 7` snapshots are accepted; everything else boots empty (`persist.ts:62`). This is a deliberate prototype tradeoff documented in source comments — "the prototype has no users to migrate."
- **Sets serialise as arrays, sorted.** `buildSnapshot` converts `Set<number>` and `Set<string>` to sorted arrays for stable JSON; `loadSession` rebuilds them (`persist.ts:108`–`128`).
- **Validation on load.** Cursor must still resolve to a real `(changeset, file, hunk, lineIdx)` (`persist.ts:310`–`322`). Hunk-keyed maps drop entries whose hunkId no longer exists (`persist.ts:231`–`238`). File ids the same (`persist.ts:262`). This is the "fixtures changed between runs" defence — a stale recent shouldn't crash on `state.readLines[unknown]`.
- **Save trigger.** A single `useEffect` in `App.tsx:212–215` runs `saveSession(state, drafts)` with a 300 ms debounce; every state change cancels and re-schedules.
- **No multi-changeset isolation.** `readLines` is a single map keyed by `hunkId` — `hunkId` already encodes the changeset id (it's `<csId>#<idx>` or similar), so two changesets coexist in one map. Loading a different changeset doesn't clear it.

### How it evolved

- The v3 → v4 → v5 → v6 → v7 trail is summarised at the top of `persist.ts:62–70`: v3→v4 stripped interactions out and moved them to SQLite; v4→v5 added `reviewedChangesets`; v5→v6 added the quiz slice; v6→v7 dropped quiz dice/cooldown. The interactions migration is the load-bearing one for this group — review *progress* explicitly stayed in localStorage.
- `docs/concepts/local-session-persistence.md` confirms the split: "Interactions (comments, replies, acks) live in the server-owned SQLite DB and are fetched per-changeset, not from this snapshot."
- The pushRecent / hunkless-file guard is documented inline (`recents.ts:65–68`, `state.ts:107`): empty changesets used to poison boot, the cursor wouldn't resolve, and rendering crashed.

### Gaps

- No multi-window awareness. Two windows on the same changeset share one localStorage and race each other through the 300 ms debounce — last-write-wins (the duplicate guard in `multiWindow.ts` keeps users from intentionally double-opening, but not from window-restore).
- No way to clear progress without nuking the whole `shippable:review:v1` key (`clearSession` is all-or-nothing — `persist.ts:142`).
- `readLines` keys are global — switching changesets keeps the old hunks' entries in storage. They're harmless (filtered on load) but accumulate indefinitely until `clearSession`.
- Coverage is per-cursor-visit, not per-line-rendered. A line scrolled into view but not visited counts as unread. Fine on the keyboard-driven path; surprising for mouse users.
- "Read" is binary per line. There's no decay / time-on-line / "I think I missed this one" signal.
- No undo. Toggle file reviewed off → on → off loses the in-between intention.
- LocalStorage = no portability. Switching machines means starting over.

## 4. Rebuild opportunities

### Data unification

The thread to pull: **review progress is now the *only* significant piece of session state that doesn't go through SQLite.** The architecture doc (`docs/architecture.md:42`) is explicit about the boundary: "interactions live in a server-owned SQLite database … review progress (cursor, readLines, reviewedFiles, dismissedGuides, drafts) still goes to localStorage via `persist.ts`."

Worth moving to SQLite for a rebuild:
- `reviewedFiles` — keyed by `(changesetId, fileId)`, a candidate for a `reviewed_files` table.
- `reviewedChangesets` — keyed by `(changesetId, reviewToken)`. Trivial schema (`changeset_id TEXT, review_token TEXT, signed_off_at TEXT`). The MCP/agent bridge has no read access to localStorage, so an agent can't ask "did the human sign this off?" today — a real gap if you ever want an agent to gate on reviewer verdict.
- `readLines` — keyed by `(changesetId, hunkId, lineIdx)`. Higher row volume but still small per session.
- `cursor` — single row per `(changesetId, sessionId?)`. Question: should multiple windows on the same diff share a cursor or each keep their own?
- `dismissedGuides` — per-changeset table.

Worth keeping local:
- `drafts` — unposted comment text. Loss-tolerant; only the local reviewer cares.
- Welcome/skip preferences (`shippable:anthropic:skip`).
- `recents.ts` — already deliberately local (`recents.ts:1–12`); it's a "browser history" primitive, not session state.
- `setLiveReloadEnabled` per-worktree toggle (`persist.ts:26–60`) — also local.
- `commentVisibility.ts`, `inspectorVisibility.ts`, `inlineComments.ts`, `tokens.ts` (theme), `useTauriMenu.ts` (zoom) — UI preferences, fine in localStorage.

The asymmetry is sharp: interactions persist server-side because agents need to read/write them. Sign-off and progress are reviewer-private *today*, but the moment a teammate or agent wants to ask "is the reviewer done?" they need durable, addressable storage too.

### Better architecture

- **Bring progress under the same SQLite envelope as interactions.** One DB, one boundary, one health gate. The current split exists because the prototype began as browser-only; the server is now a hard dependency (`docs/architecture.md:8`) so the cost is paid already.
- **Key everything by changeset.** A `review_sessions` table with `(changeset_id PRIMARY KEY, cursor_json, last_active_at, signed_off_revisions JSONB)` would replace the bulk of `persist.ts` and is straight-line server-side code. Sub-entries (`reviewed_files`, `read_lines`) get their own tables with `changeset_id` FK.
- **Snapshot vs. event log.** The localStorage shape is a snapshot. SQLite gives a chance to switch to an append-only event log (`{ts, action, payload}`) cheaply — useful if you ever want resume, undo, or to feed reviewer-trajectory data into the agent context panel. The Interactions table is already shaped this way (one row per author write, no in-place mutations for the queue columns); doing the same for progress would be consistent.
- **Drop the "single blob" pattern.** It made sense when this lived in localStorage; with SQLite, normalised tables let the agent / multi-window / teammate consumers read precisely what they need. The single-blob approach also forces validation on every load — half of `persist.ts` is shape-checking. SQL types do that for free.
- **Keep the rebuild boring.** A `progress_*` table per shape, an upsert per write, a GET per changeset on load. No event sourcing unless you actually use the events. Don't pre-version a schema that has no users.
- **Don't unify drafts.** They're write-once-and-throw-away; keeping them local removes one syncing concern and matches what every other tool (Slack, GitHub) does.

## Sources

- `web/src/persist.ts:1–403` — single-key snapshot, schema, load/save.
- `web/src/state.ts:98–143, 264–280, 593–617, 1456–1501` — initialState, reducer cases that touch progress, coverage helpers.
- `web/src/types.ts:206–302, 256–302` — Cursor and ReviewState.
- `web/src/recents.ts:1–123` — recents LRU (compare/contrast for "what's local-only on purpose").
- `web/src/App.tsx:158–215` — boot/hydration/debounced save.
- `web/src/components/StatusBar.tsx:1–58` + `web/src/view.ts:535–680` — coverage display + contextual hint.
- `web/src/keymap.ts:101–107` — `j`/`k`/`Shift+M`/`Shift+S` bindings.
- `web/src/guide.ts:42` — dismissedGuides key shape.
- `docs/architecture.md:42–43` — the localStorage-vs-SQLite split.
- `docs/concepts/review-state.md` — "read vs sign-off" framing.
- `docs/concepts/local-session-persistence.md` — explicit statement that interactions left this layer.
- `docs/features/review-progress.md` — terse feature summary.
- `server/src/db/schema.ts:1–110`, `server/src/db/interaction-store.ts:1–311` — comparator: how the server already holds session-scoped data.
