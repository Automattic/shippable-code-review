# Implementation Notes — Review stats tracking

All 12 planned tasks landed, plus a 13th (e2e coverage) added mid-flight at the
user's request. Server suite (463 tests) and web suite (591 tests) green;
typecheck and lint clean; the full Playwright e2e suite (58 tests) passes.

## Deviations from Spec

### Consent cache is lazy-loaded, not seeded at startup
- **Spec said**: consent is "cached in memory" and read by `consentGranted()`;
  it implied the cache is populated when the server starts.
- **Implementation does**: `consentGranted()` lazy-loads the cache from the
  `settings` table on its first call; there is no startup `loadConsent()` wiring.
- **Reason**: a self-seeding cache removes a startup-ordering dependency and the
  matching test hook. The first read costs one in-memory SQLite query; every
  read after is cache-only, which is what the spec actually wanted.
- **Impact**: none functional. `resetConsentForTests()` exists so tests can drop
  the cache between cases.

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
- **Open item (unchanged from the design)**: confirm `SHIPPABLE_STATS_GROUP`
  (default `shippable`) does not collide with an existing MC group before MC
  consent is exercised in production. Non-blocking — `LogSink` needs no MC setup.
