# Implementation Notes — Review stats tracking

All 12 planned tasks landed, plus a 13th (e2e coverage) added mid-flight at the
user's request. Server suite (463 tests) and web suite (591 tests) green;
typecheck and lint clean; the full Playwright e2e suite (58 tests) passes.

## Deviations from Spec

### Consent is read straight from the DB — no in-memory cache
- **Spec said**: consent is "cached in memory" and read by `consentGranted()`.
- **Implementation does**: `consentGranted()` reads the `settings` row on every
  call; there is no cache.
- **Reason**: review feedback. The cache existed only to spare the "stats hot
  path" a DB round-trip, but stats fire at human pace and the lookup is a local
  SQLite read — a few microseconds. The cache's one real cost was a test-only
  `resetConsentForTests()` export in production code; dropping the cache removes
  that, per the project's no-test-scaffolding-in-prod rule.
- **Impact**: none functional. One settings-table `SELECT` per recorded stat.

### Install counters fire from `main()`, not from `createApp()`
- **Spec/plan said**: the plan's Task 7 test phrased it as "`createApp()`
  startup fires `install-new` once".
- **Implementation does**: a `recordInstallStats()` function fires the two
  counters from `main()` right after `initDb()` succeeds. `createApp()` only
  builds the HTTP server and never runs migrations, so it is the wrong hook.
  The test calls `recordInstallStats()` directly against a fresh `:memory:` DB.
- **Reason**: `main()` is the real startup path; putting the call inside
  `initDb()` would invert the db→stats module dependency.
- **Impact**: install counters are verified by a direct unit test rather than a
  `createApp()` boot assertion. Confirmed working end-to-end — the e2e server
  logs `[stat] install-new +1` / `[stat] install-active +1` on boot.

### `review-completed` counts the on-transition only
- **Spec said**: the wiring section listed "mark-changeset-reviewed handler —
  `reportStat("review-completed")`" without the explicit "on transition only"
  qualifier it gave `file-marked-okay`.
- **Implementation does**: fires `review-completed` only on the off→on
  transition, and not at all for the token-null no-op (paste/upload).
- **Reason**: `TOGGLE_CHANGESET_REVIEWED` is a toggle; counting an un-review as
  a completion would be wrong. "A changeset is marked reviewed" (the stat
  catalog wording) is the transition into reviewed.
- **Impact**: `review-completed` reflects genuine completions, not toggle churn.

### Stats reach sinks without test-only injection; `SHIPPABLE_STATS_GROUP` removed
- **Spec/plan said**: the plan tested routing by swapping in recording sinks.
- **Implementation does** (review feedback): the `setStatSinksForTests` /
  `resetStatSinksForTests` hooks are gone from `record.ts`. Tests assert against
  the real sinks — `LogSink` via a `console.log` spy, `McSink` via a stubbed
  `fetch` — through a shared `captureStats()` / `startTestServer()` helper in
  `server/src/test-helpers.ts`. The `SHIPPABLE_STATS_GROUP` env override was
  also removed; `McSink`'s group is the hardcoded constant `shippable`.
- **Reason**: keep test scaffolding out of production code, and a universal
  server-test harness over per-file `listen()` boilerplate.
- **Impact**: `record.ts`, `consent.ts`, and `sink.ts` export only product API;
  five server test files moved onto the shared helper.

## Notes

- **Files beyond the plan's explicit list**: `web/src/statsConsent.ts` (the web
  consent client — the plan folded consent I/O into Task 12 without naming a
  module); `server/src/db/index.test.ts` (one assertion hardcoded the schema
  version `"1"` and broke under v2 — now derived from `SCHEMA_HEAD`); and the
  e2e additions `mockStatsConsent` / `mockStatsEvent`.
- **e2e fixture default**: the real server now answers `/api/stats/consent`, so
  the welcome banner would otherwise appear non-deterministically in unrelated
  welcome-page journeys. The shared fixture now installs
  `mockStatsConsent(page, "granted")` by default; banner tests override it to
  `"undecided"` before `visit()`.
- **Open item**: the MC group is hardcoded `shippable`. Confirm it does not
  collide with an existing MC group before MC consent is exercised in
  production. Non-blocking — `LogSink` needs no MC setup.
- **Follow-up**: `stat_dedup` is never pruned — see the "Follow-ups" section in
  [`spec.md`](./spec.md) for the cleanup (cap `dedupKey` length, add retention).
