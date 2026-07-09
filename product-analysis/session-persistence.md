# Session persistence

## 1. Product reasoning & priority

Session persistence is the plumbing that lets a reviewer close the tab, come back tomorrow, and pick up where they were. For a tool whose explicit value prop is "stay present across long sessions" (`IDEA.md`), losing cursor + read marks + sign-offs on reload would be a near-fatal defect. The job it serves isn't visible — users don't notice persistence working, only its absence. But it's the substrate the whole "remain present and engaged" pillar sits on. `docs/features/session-persistence.md` is terse on purpose: it works, it's local, it's intentionally not a cloud feature yet.

Suggested priority: **must-have**, but the *current implementation* is the right place to deviate in a rebuild. The localStorage-only choice was correct for a prototype; for a clean rebuild, where the server is already a hard dependency and SQLite already holds interactions, keeping progress and sign-off in localStorage looks more like inertia than principle.

## 2. Acceptance criteria for a rebuild

- On first paint, the boot resolver decides: URL `?cs=` wins (fixture or recent), then a real resumable session (peeked snapshot has `hasProgress()` true *and* a known changeset), else welcome (`App.tsx:65–124`).
- "Resumable" requires at least one file with at least one hunk in the persisted changeset (`App.tsx:129–134`, `recents.ts:65–68`). Recents pointing at an empty changeset boot to welcome, not to a crash.
- `loadSession` validates cursor against the loaded changesets and falls back to the first hunk-bearing file if the persisted cursor doesn't resolve (`persist.ts:225, 244`).
- Stale hunk ids in `readLines` are filtered out on load (`persist.ts:236`); stale file ids in `reviewedFiles` are filtered out (`persist.ts:262`); stale draft keys are filtered out (`persist.ts:267, 377–403`). Other changesets' entries that *are* still valid are preserved.
- `reviewedChangesets` entries for changesets *not currently loaded* are kept in storage so a future re-open re-reads sign-off without re-confirmation (`persist.ts:247–256`).
- Save is debounced 300 ms and runs as a `useEffect` cleanup-and-reschedule (`App.tsx:212–215`). Quota and private-mode errors are swallowed (`persist.ts:137`).
- The persisted shape is `v: 7` (`persist.ts:62`); anything else is rejected — no migration path.
- Interactions are *not* in the snapshot: `v3 → v4` removed them (`persist.ts:64–65`). They live in SQLite and are fetched per-changeset on `LOAD_CHANGESET` (`App.tsx:263–281`, `docs/architecture.md:43`).
- `clearSession()` (`persist.ts:142`) removes the single key — all-or-nothing. There is no per-changeset reset.
- Multi-window safety: a duplicate-open of the same changeset is blocked with a toast; the cursor is single-window (`App.tsx:231–234`, `multiWindow.ts`).

## 3. Existing architecture & system design

### Data model

- One localStorage key: `shippable:review:v1` (`persist.ts:17`). One JSON blob per browser profile.
- `PersistedSnapshot` (`persist.ts:73–84`):
  - `v: 7`
  - `cursor` — current Cursor.
  - `readLines: Record<hunkId, number[]>` — Sets serialised as sorted arrays.
  - `reviewedFiles: string[]` — fileIds.
  - `reviewedChangesets: Record<csId, string[]>` — review tokens per changeset.
  - `dismissedGuides: string[]` — guide ids.
  - `drafts: Record<replyKey, string>` — unposted comment bodies.
  - `quiz: QuizState` — comprehension-quiz slice.
- Additional localStorage keys for sibling concerns:
  - `shippable:recents:v1` — recents LRU (`recents.ts:16`).
  - `shippable:liveReload:v1` — per-worktree pause toggles (`persist.ts:26`).
  - `shippable:githubTrustedHosts:v1` — GitHub host trust list (`githubHostTrust.ts:1`).
  - `shippable:show-inspector` (`inspectorVisibility.ts:2`).
  - `shippable:inline-comments` (`inlineComments.ts:2`).
  - `shippable:theme` (`tokens.ts:171`).
  - `shippable:anthropic:skip` — boot-prompt skip choice (`docs/architecture.md:35`).
  - `shippable.prompts.user` — user-authored prompts (`promptStore.ts:20`).
  - The Tauri menu zoom level (`useTauriMenu.ts:20`).
  - Worktrees-directory path (`useWorktreeLoader.ts:37`).
- Server-side SQLite (`server/src/db/schema.ts`):
  - `interactions` — primary table; columns: `id, thread_key, target, intent, author, author_role, body, created_at, changeset_id, worktree_path, agent_queue_status, payload_json`. Keyed by `changeset_id` for reviewer rows, `worktree_path` for agent rows.
  - `stat_dedup`, `settings`, `schema_meta` — bookkeeping (`schema.ts:43–58`).

### Current architecture decisions

- **Two-tier persistence with a clear split.** Reviewer-only signals (cursor, readLines, sign-offs, dismissed guides, drafts, quiz) → localStorage. Cross-actor signals (interactions, in all their forms) → SQLite. The justification is mechanical, not aesthetic: localStorage is invisible to the server and to MCP/agents; SQLite is the shared substrate. `docs/architecture.md:43` codifies it.
- **Single-blob localStorage.** All progress fields ride in one JSON object. `persist.ts:5–9` defends this: namespacing is already in the keys (hunkId / fileId embed csId), so one blob is cheap and trivial to inspect.
- **No migration policy.** `v` is the head schema version; anything else boots empty. "The prototype has no users to migrate" (`persist.ts:62`).
- **Validation at load, not at save.** Save is a dumb JSON dump; load filters out anything that doesn't resolve against the currently-loaded changesets (`persist.ts:231–267`). Save is fast (a `JSON.stringify` of a small blob); load is the slow path. Fine, given the volume.
- **Debounced save, not write-through.** Every state change reschedules a 300 ms save (`App.tsx:213`). No optimistic save on critical actions (sign-off, comment send); the next debounce tick handles it.
- **Boot resolves keyed by `cursor.changesetId`.** The peeked snapshot's cursor tells the resolver what changeset to look up in recents/stubs (`App.tsx:91–116`). Multi-changeset state is *stored* in one blob; multi-changeset *resume* is single-changeset by virtue of the cursor.
- **Recents are separate from session.** `recents.ts:1–12` is explicit: recents survive across sessions; they're the "where can I go back to" primitive, not the in-progress state.

### How it evolved

- The interactions migration (`v3 → v4`) is the load-bearing prior shape. Before that, comments / replies / acks lived in `shippable:review:v1`. After it, `persist.ts` is half its prior size and only carries progress. `docs/architecture.md:42–43` and `docs/concepts/local-session-persistence.md` document it from the destination side.
- `v4 → v5` added `reviewedChangesets` for revision-scoped sign-off — required because the previous shape only had file-level sign-off, no way to express "I signed off, but the diff moved."
- `v5 → v6` and `v6 → v7` evolved the quiz slice (`persist.ts:67–70`). The quiz state is the only piece of session-state-shaped-data that's not actually reviewer signal — it's question/answer payload that could equally live server-side.
- `pushRecent` learned to skip empty changesets after the boot crash was observed (`recents.ts:65–68`); `initialState` and `defaultCursor` learned to skip hunkless files (`state.ts:107`, `persist.ts:328`). Both are dated guards.
- The `Origin: null` opaque-origin case (`docs/architecture.md:26`, `server/src/index.ts`) shaped the server's CORS handling — which interacts with `useInteractionSync` because every sync is a fetch.

### Gaps

- **No isolation across changesets in the snapshot.** `readLines` is a global `Record<hunkId, ...>`; if you switch fixtures repeatedly the map grows. Filtered on load, never pruned on save.
- **No per-changeset "clear my progress on this one."** `clearSession` is the only reset, and it nukes everything (`persist.ts:142`).
- **No multi-window sync.** Two tabs on the same diff race the debounced save; last-write-wins. The duplicate-open guard is a deflection, not a fix.
- **No cross-machine continuity.** The split-storage choice means even users with the desktop app (where SQLite is available) get no portability for progress.
- **Cursor restoration ≠ scroll restoration.** Boot puts the cursor on the right line but the diff renderer scrolls to it via React effects; there's no explicit scroll-position persistence.
- **`drafts` aren't backed up anywhere else.** Localstorage quota / private mode silently drops them.
- **Boot-time complexity.** The "URL ?cs= → peeked snapshot → welcome" cascade in `App.tsx:65–124` is intricate; the comments are good but it's the kind of code that breaks when a sixth boot path lands.
- **The architecture doc references `web/src/interactionViewMode.ts`** (`docs/architecture.md:194`) but that file does not exist — possibly a stale plan reference. Worth a follow-up.

## 4. Rebuild opportunities

### Data unification

The big move is the same one this group keeps coming back to: **collapse the localStorage / SQLite split** for everything that's session state.

Snapshot fields, mapped to a rebuild's homes:

| Today | Home | Notes |
| --- | --- | --- |
| `cursor` | SQLite (`review_sessions.cursor_json`) | Single row per `(changeset_id, browser/session_id)`. |
| `readLines` | SQLite (`read_lines (changeset_id, hunk_id, line_idx)`) | Volume modest; per-changeset query on load. |
| `reviewedFiles` | SQLite (`reviewed_files`) | See `sign-off.md` § 4 — agents and teammates need to read this. |
| `reviewedChangesets` | SQLite (`reviewed_changesets`) | One row per token. Token-key compaction becomes trivial. |
| `dismissedGuides` | SQLite | Negligible volume. |
| `quiz` | SQLite | Questions already come from the server; the answers/asked log belongs in the same place. |
| `drafts` | localStorage | Loss-tolerant; multi-machine sync would surprise more than it helps. |

Sibling keys that should stay local-only:
- Recents (browser history shape) — `recents.ts:1–12` is explicit.
- UI preferences (theme, inspector visibility, inline-comments toggle, zoom).
- Per-worktree live-reload toggle (`persist.ts:26`) — already separate from the session snapshot for a reason, keep it that way.
- GitHub host trust list — security-critical, intentionally machine-local.

Cross-cutting opportunity: `reviewedChangesets` is unbounded today (`sign-off.md` § 3 gap). A SQLite table with `signed_off_at` makes pruning a one-liner.

### Better architecture

- **One backend, one envelope.** When the server is already a hard dependency (`docs/architecture.md:8`) and SQLite already holds interactions, the cost of moving progress out of localStorage is small. The benefit is: one health gate, one boundary, one validation layer, no schema-versioning code in the browser.
- **`review_sessions` table as the spine.** Primary key on `changeset_id`; columns for `cursor_json`, `last_active_at`, optional `session_id` for multi-window. Other progress tables FK to it.
- **`LOAD_CHANGESET` becomes a single fetch.** Today the reducer merges in interactions from a separate per-changeset fetch (`App.tsx:263–281`). A rebuild can fetch the whole session bundle (progress + interactions) in one request and apply it atomically. Cuts the in-flight-fetch / StrictMode dance.
- **Drop the single-blob, version-gated, no-migration localStorage shape.** It exists because the prototype started before there was a server. With a server present, "the data goes wherever the server says" is simpler than "we have a JSON schema with versions but no migrations."
- **Keep boot resolution boring.** The URL `?cs=` path is fine; the snapshot → recents → stub cascade in `App.tsx:65–124` is doing too much. With server-owned progress, the boot becomes: pick a changeset id (URL > most-recent > welcome), fetch its bundle, render. The validation in `persist.ts` becomes unnecessary because the server can refuse to return a session bound to ids that aren't in the changeset.
- **Treat drafts and prefs as the only legitimate localStorage citizens.** They're loss-tolerant and machine-local for product reasons. Anything else that lives there is inertia from the prototype era.
- **Investigate `web/src/interactionViewMode.ts`.** The architecture doc references it (`docs/architecture.md:194`) but it isn't in the tree. Either the doc is stale or the file got removed — worth confirming during a rebuild rather than carrying the discrepancy forward.

## Sources

- `web/src/persist.ts:1–403` — snapshot shape, save/load, schema versions, validation.
- `web/src/recents.ts:1–123` — LRU "go back to" list (intentionally separate).
- `web/src/App.tsx:50–215, 263–281` — boot resolver, hydration overlay, debounced save, per-changeset interaction fetch.
- `web/src/state.ts:98–143` — `initialState` and its hunkless-file defence.
- `web/src/types.ts:206–302` — `Cursor`, `ReviewState`.
- `server/src/db/schema.ts:1–110` — SQLite migration head and tables.
- `server/src/db/interaction-store.ts:1–311` — for comparison: what server-side session-scoped storage looks like today.
- `server/src/db/interaction-endpoints.ts:1–227` — GET / upsert / delete / enqueue endpoint shape.
- `docs/architecture.md:38–47, 222–230` — core data model, ingest paths, persistence split.
- `docs/concepts/local-session-persistence.md` — terse rationale for the split.
- `docs/concepts/review-state.md` — sign-off vs read principle.
- `docs/features/session-persistence.md` — the (very short) feature doc.
- `web/src/commentVisibility.ts`, `inlineComments.ts`, `inspectorVisibility.ts`, `tokens.ts`, `useTauriMenu.ts`, `useWorktreeLoader.ts`, `githubHostTrust.ts`, `promptStore.ts` — sibling localStorage keys.
