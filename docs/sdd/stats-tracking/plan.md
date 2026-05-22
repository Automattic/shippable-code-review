# Implementation Plan: Review stats tracking

Based on: docs/sdd/stats-tracking/spec.md

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## Status — complete

All 12 tasks below are implemented and committed, each as its own TDD commit.
A 13th task (e2e coverage of the consent banner and `review-started` report)
was added during implementation at the user's request. Deviations are recorded
in `implementation-notes.md`. Server, web, and Playwright e2e suites all pass.

Quality gates (run as relevant per task): `npm run typecheck` in `server/`,
`npm run test` for touched server/web modules, `npm run build` + `npm run lint`
in `web/`. Tests use the integration tier with a real in-process `createApp()`
and inject a recording test sink — see `docs/plans/test-strategy.md`.

## Tasks

### Task 1: Schema migration v2 — `stat_dedup` + `settings`
- **Files**: `server/src/db/schema.ts`, `server/src/db/schema.test.ts`
- **Do**:
  1. Write a failing test: migrating a fresh DB reaches `SCHEMA_HEAD === 2` and
     both `stat_dedup` and `settings` tables exist; the runner is idempotent on
     a DB already at head.
  2. Verify the test fails.
  3. Bump `SCHEMA_HEAD` to 2 and append `MIGRATIONS[1]` creating
     `stat_dedup(name, dedup_key, recorded_at, PRIMARY KEY(name, dedup_key))`
     and `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`.
  4. Verify the test passes; the `MIGRATIONS.length === SCHEMA_HEAD` invariant
     still holds.
  5. Commit: `feat(server): add schema v2 with stat_dedup and settings tables`
- **Verify**: schema test passes, `npm run typecheck` clean.
- **Depends on**: none

### Task 2: `settings` accessors + `installId()`
- **Files**: `server/src/stats/settings.ts`, `server/src/stats/install.ts`, adjacent `.test.ts` files
- **Do**:
  1. Write failing tests: `getSetting(key)`/`setSetting(key, value)` round-trip
     through the `settings` table; `installId()` generates and persists a UUID
     on first call and returns the same value on a later call, including a
     fresh module load when the row already exists.
  2. Verify the tests fail.
  3. Implement `getSetting`/`setSetting` over `getDb()`; implement `installId()`
     reading `settings.install_id`, generating via `crypto.randomUUID()` and
     storing on first call.
  4. Verify the tests pass.
  5. Commit: `feat(server): add settings store and install identity`
- **Verify**: stats settings/install tests pass.
- **Depends on**: Task 1

### Task 3: Consent module
- **Files**: `server/src/stats/consent.ts`, `server/src/stats/consent.test.ts`
- **Do**:
  1. Write failing tests: `consentGranted()` defaults `false`; `grantConsent()`
     writes the `stats_mc_consent` row and flips `consentGranted()` to `true`
     with no further DB read; a load-from-DB path restores `true` after a row
     already exists.
  2. Verify the tests fail.
  3. Implement an in-memory cached boolean, a `loadConsent()` that seeds it from
     `settings`, `consentGranted()` returning the cache, and `grantConsent()`
     writing the row + updating the cache. No "deny" transition.
  4. Verify the tests pass.
  5. Commit: `feat(server): add stats consent state with in-memory cache`
- **Verify**: consent tests pass.
- **Depends on**: Task 2

### Task 4: `StatSink` interface + `LogSink` + `McSink`
- **Files**: `server/src/stats/sink.ts`, `server/src/stats/sink.test.ts`
- **Do**:
  1. Write failing tests: `LogSink.record` writes `[stat] <name> +<count>` to
     `console.log`; `McSink.record` issues a GET to
     `https://pixel.wp.com/g.gif?v=wpcom-no-pv&x_<group>/<name>=<count>` (fetch
     stubbed) using `SHIPPABLE_STATS_GROUP` (default `shippable`); `McSink`
     swallows a rejected fetch without throwing.
  2. Verify the tests fail.
  3. Define the `StatSink` interface (`record(name, count)`); implement
     `LogSink` (console only) and `McSink` (fire-and-forget `fetch`, all errors
     swallowed).
  4. Verify the tests pass.
  5. Commit: `feat(server): add StatSink with log and MC pixel sinks`
- **Verify**: sink tests pass.
- **Depends on**: none

### Task 5: `KNOWN_STATS` + `recordStat`/`recordStatOnce`
- **Files**: `server/src/stats/known.ts`, `server/src/stats/record.ts`, `server/src/stats/record.test.ts`
- **Do**:
  1. Write failing tests: `recordStat` routes to `McSink` only when consent is
     granted and `LogSink` while undecided, and `grantConsent` flips routing
     live; `recordStatOnce` counts once, a second call with the same key is a
     no-op, distinct keys both count; neither throws on a sink/DB error.
  2. Verify the tests fail.
  3. Add `KNOWN_STATS` (the three web-reportable names:
     `review-started`, `review-completed`, `file-reviewed`). Implement
     `recordStat` (sink chosen per call from `consentGranted()`) and
     `recordStatOnce` (`INSERT OR IGNORE` into `stat_dedup`, sink fires only
     when `changes() === 1`). Allow a test sink to be injected. Both swallow
     every error.
  4. Verify the tests pass.
  5. Commit: `feat(server): add recordStat/recordStatOnce with consent routing`
- **Verify**: record tests pass, `npm run typecheck` clean.
- **Depends on**: Task 3, Task 4

### Task 6: Stats endpoints
- **Files**: `server/src/stats/endpoints.ts`, `server/src/stats/endpoints.test.ts`, `server/src/index.ts`
- **Do**:
  1. Write failing integration tests against `createApp()`:
     `POST /api/stats/event` with a `KNOWN_STATS` name → `204`; an unknown name
     and a server-side name (e.g. `comment-posted-user`) → `400`; a repeated
     `dedupKey` → second call still `204` with no extra count (test sink);
     `GET /api/stats/consent` defaults to `undecided`; `POST /api/stats/consent`
     `{consent:"granted"}` persists and the next `GET` reflects it; any other
     consent value → `400`.
  2. Verify the tests fail.
  3. Implement `POST /api/stats/event` (validate `name` against `KNOWN_STATS`,
     route to `recordStat`/`recordStatOnce`, `204`), `GET /api/stats/consent`,
     and `POST /api/stats/consent` (`grantConsent`, `204`). Register all three
     in `server/src/index.ts`.
  4. Verify the tests pass.
  5. Commit: `feat(server): add /api/stats/event and /api/stats/consent`
- **Verify**: endpoint integration tests pass.
- **Depends on**: Task 5

### Task 7: Install counters on startup
- **Files**: `server/src/index.ts`, `server/src/index.test.ts`
- **Do**:
  1. Write a failing integration test: `createApp()` startup fires
     `install-new` once and `install-active` once; a second startup against the
     same DB fires neither again that day (asserted via the test sink).
  2. Verify the test fails.
  3. After `initDb()`, call `recordStatOnce("install-new", installId())` and
     `recordStatOnce("install-active", installId() + ":" + <UTC YYYY-MM-DD>)`.
     Fire-and-forget.
  4. Verify the test passes.
  5. Commit: `feat(server): record install-new and install-active on startup`
- **Verify**: startup integration test passes.
- **Depends on**: Task 6

### Task 8: Wire `review.ts`
- **Files**: `server/src/review.ts`, `server/src/review.test.ts`
- **Do**:
  1. Write/extend a failing integration test: `POST /api/review` fires
     `ai-review-request`; a stream that completes with a `done` event also
     fires `comment-posted-ai`.
  2. Verify the test fails.
  3. `recordStat("ai-review-request")` on handler entry;
     `recordStat("comment-posted-ai")` when the stream emits `done` without
     error.
  4. Verify the test passes.
  5. Commit: `feat(server): count ai-review-request and comment-posted-ai`
- **Verify**: review tests pass.
- **Depends on**: Task 6

### Task 9: Wire `interaction-endpoints.ts`
- **Files**: `server/src/db/interaction-endpoints.ts`, `server/src/db/interaction-endpoints.test.ts`
- **Do**:
  1. Write a failing integration test: a `POST /api/interactions` upsert with an
     ask intent and `authorRole: "user"` fires `comment-posted-user` once;
     re-saving the same interaction id does not fire it again.
  2. Verify the test fails.
  3. In the upsert handler, when the interaction has an ask intent and
     `authorRole: "user"`, call
     `recordStatOnce("comment-posted-user", <interaction id>)`.
  4. Verify the test passes.
  5. Commit: `feat(server): count comment-posted-user on interaction upsert`
- **Verify**: interaction-endpoints tests pass.
- **Depends on**: Task 6

### Task 10: Wire the agent-replies handler
- **Files**: `server/src/index.ts` (`handleAgentPostReply`), `server/src/index.test.ts`
- **Do**:
  1. Write a failing integration test: `POST /api/agent/replies` fires
     `comment-posted-agent` for each stored agent interaction (both replies and
     top-level agent comments).
  2. Verify the test fails.
  3. In `handleAgentPostReply`, call `recordStat("comment-posted-agent")` for
     each agent-authored interaction stored.
  4. Verify the test passes.
  5. Commit: `feat(server): count comment-posted-agent on agent replies`
- **Verify**: index integration tests pass.
- **Depends on**: Task 6

### Task 11: Web `reportStat` helper + UI wiring
- **Files**: `web/src/reportStat.ts`, `web/src/reportStat.test.ts`, the review UI handler(s) for changeset load / mark-reviewed / toggle-file-reviewed
- **Do**:
  1. Write a failing test: `reportStat(name, dedupKey?)` POSTs
     `{name, dedupKey?}` to `/api/stats/event` and swallows fetch rejections.
  2. Verify the test fails.
  3. Implement `reportStat` (fire-and-forget `fetch`, all errors ignored). Call
     it from the **UI handlers** (never reducers): changeset loaded into review
     → `reportStat("review-started", changesetId)`; mark-changeset-reviewed →
     `reportStat("review-completed")`; toggle-file-reviewed on the **on**
     transition only → `reportStat("file-reviewed")`.
  4. Verify the test passes; `npm run build` + `npm run lint` clean.
  5. Commit: `feat(web): report review-activity stats to the server`
- **Verify**: reportStat test passes, web build + lint clean.
- **Depends on**: Task 6

### Task 12: Welcome consent banner
- **Files**: `web/src/components/Welcome.tsx`, `web/src/components/Welcome.css`, `web/src/components/Welcome.test.tsx`
- **Do**:
  1. Write a failing test: `Welcome` fetches `GET /api/stats/consent` on mount;
     `undecided` renders a non-dismissible banner with a single **Allow**
     button; **Allow** POSTs `{consent:"granted"}` and hides the banner;
     `granted` renders no banner; a fetch failure renders no banner.
  2. Verify the test fails.
  3. Implement the consent fetch and the inline non-dismissible banner ("Share
     anonymous usage counts to help improve the tool?") with only an **Allow**
     button — no decline, no close. Fail closed on fetch error.
  4. Verify the test passes; open `/` in the browser and confirm the banner
     shows on a fresh DB, disappears after Allow, and never reappears.
  5. Commit: `feat(web): add stats consent banner to the welcome page`
- **Verify**: Welcome test passes, web build + lint clean, verified in browser.
- **Depends on**: Task 6
