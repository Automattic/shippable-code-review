# Review stats → pluggable sink (MC-ready)

**Date:** 2026-05-20
**Status:** Approved design, ready for implementation plan

## Problem

We have no idea how much the tool is actually used. We want counters for
review activity — reviews started/completed, files marked okay, comments
posted — and a path to push them to Automattic's MC stats, without baking the
MC endpoint into every call site and without sending anything off a
contributor's machine before they've agreed to it.

## Goals

- Count a small set of review-activity events.
- Count unique installs and daily-active installs.
- Push them somewhere MC-shaped, but keep the destination swappable.
- Nothing goes to MC until the user explicitly consents.
- The consent ask lives on the welcome page; once granted it never shows again.
- `review-started` counts once per changeset, even across reloads.

## Non-goals

- A stats dashboard or `/api/stats` read API. Counters are write-only for now.
- Historical backfill.
- Sending any identifier to MC. The install id stays on the host; only
  anonymous bump counts ever leave the machine.
- An environment-variable override. Consent is the only switch.

## Architecture

### Stats module — `server/src/stats/`

One recording entry point, fire-and-forget, never throws:

```ts
recordStat(name: string, count?: number): void          // count defaults to 1
recordStatOnce(name: string, dedupKey: string): void     // counts once per (name, dedupKey)
```

A `StatSink` interface with a single `record(name, count)` method, and two
implementations:

- **`LogSink`** — `console.log("[stat] <name> +<count>")`. No network.
- **`McSink`** — fire-and-forget GET to
  `https://pixel.wp.com/g.gif?v=wpcom-no-pv&x_<group>/<name>=<count>`.
  The `x_<group>/<name>=<count>` multiplier form bumps the named stat by
  `count` in a single request (default 1 — no looping). No cache-buster param
  is needed: that pattern exists to defeat the browser image cache, which a
  server-side `fetch` does not have. All network errors are swallowed.

The active sink is **chosen per record call** from the live consent state
(see below): `McSink` when consent is granted, `LogSink` otherwise. Consent
can be granted mid-session from the welcome banner — there is no restart and
no startup-fixed sink. Consent is cached in memory so `recordStat` never
blocks on a DB read.

The group name comes from `SHIPPABLE_STATS_GROUP` (default `shippable`).
Group and stat name must be static slugs — the `KNOWN_STATS` allowlist and
the fixed server-side names already guarantee this.

### Consent

Binary, persisted server-side: `granted` once the user opts in, otherwise
`undecided` (no row stored). There is no "deny" — declining is simply never
opting in, which needs nothing persisted.

- `consentGranted(): boolean` — reads the in-memory cache.
- `grantConsent()` — writes the DB row and updates the cache. The only
  transition; consent never moves back.

### Persistence — schema migration v2

One migration step (bumps `SCHEMA_HEAD` to 2, appends `MIGRATIONS[1]`) creates
two tables:

```sql
CREATE TABLE stat_dedup (
  name        TEXT NOT NULL,
  dedup_key   TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (name, dedup_key)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- `recordStatOnce` does an `INSERT OR IGNORE` into `stat_dedup`; it calls the
  sink only when the insert created a new row (`changes() === 1`).
- Consent lives in `settings` under key `stats_mc_consent`.
- `stat_dedup` grows with activity — one row per distinct comment, changeset,
  and install-day. Volume is low for a single-user prototype, so no pruning is
  built now; if it ever matters, drop `install-active` rows older than ~90
  days.
- The install identifier lives in `settings` under key `install_id`.

### Install identity

`installId()` reads `settings.install_id`; on first call it generates a random
UUID (`crypto.randomUUID()`), stores it, and returns it. It is an opaque,
random token — no machine, network, or user information — and it **never
leaves the machine**: it is only used as a `recordStatOnce` dedup key, so MC
receives bumps, never the id itself.

This is what makes "unique" counts work without sending any identifier off the
host (see `install-new` / `install-active` below).

## Stat catalog

Dimensions are encoded in the name — each name is independently graphable in MC.

| Stat name              | Fired when                                                       | Where        |
|------------------------|------------------------------------------------------------------|--------------|
| `review-started`       | a changeset is first opened into the review UI (once per id)     | web → server |
| `review-completed`     | a changeset is marked reviewed (`reviewedChangesets`)            | web → server |
| `file-reviewed`        | a file is toggled reviewed **on** (not on toggle-off)            | web → server |
| `comment-posted-user`  | `POST /api/interactions` upsert, ask intent, `authorRole: user`, deduped per interaction id | server |
| `comment-posted-agent` | `POST /api/agent/replies` — each agent interaction stored        | server       |
| `comment-posted-ai`    | `POST /api/review` stream completes successfully                 | server       |
| `ai-review-request`    | every `POST /api/review`                                         | server       |
| `install-new`          | server startup — once ever per install                          | server       |
| `install-active`       | server startup — once per UTC calendar day per install          | server       |

`ai-review-request` minus `comment-posted-ai` is the AI review failure count —
a free side benefit, not a separate stat.

`install-new` is `recordStatOnce("install-new", installId)` — local dedup
allows at most one MC bump per install ever (a crash between the dedup insert
and the pixel send can lose it; acceptable for best-effort stats), so the MC
total approximates the count of unique installs. `install-active` is
`recordStatOnce("install-active", installId + ":" + <UTC YYYY-MM-DD>)` — one
bump per install per day, so the per-day bump count tracks daily-active
installs. Neither sends the id; both rely on the local `stat_dedup` table.

A `KNOWN_STATS` allowlist constant holds the **three web-reportable** names
(`review-started`, `review-completed`, `file-reviewed`) — it is the single
source of truth for what the `/api/stats/event` endpoint will accept. The
server-side names are string literals at their call sites and must never be
acceptable from the web.

## Endpoints

All registered in `server/src/index.ts`.

### `POST /api/stats/event` — the web→server event boundary

- Body: `{ name: string, dedupKey?: string }`.
- `name` is validated against `KNOWN_STATS`; an unknown name returns `400`.
  This is the trust boundary — internal `recordStat` callers are not
  re-validated.
- With `dedupKey` → `recordStatOnce(name, dedupKey)`. Without → `recordStat(name)`.
- Returns `204`.

### `GET /api/stats/consent`

- Returns `{ consent: "granted" | "undecided" }`.

### `POST /api/stats/consent`

- Body: `{ consent: "granted" }`. Any other value → `400`.
- Persists via `grantConsent`, returns `204`.

## Wiring

### Server-side call sites

These handlers already exist; each gains one `recordStat` / `recordStatOnce`
call:

- `server/src/review.ts` — `recordStat("ai-review-request")` on entry;
  `recordStat("comment-posted-ai")` when the stream emits its `done` event
  without error.
- `server/src/db/interaction-endpoints.ts` — in the upsert handler, when the
  interaction has an ask intent and `authorRole: "user"`,
  `recordStatOnce("comment-posted-user", <interaction id>)`. The handler is an
  upsert, so deduping on the interaction id counts distinct comments rather
  than re-saves and edits.
- The agent-replies handler — `recordStat("comment-posted-agent")` for each
  agent-authored interaction it stores; that endpoint handles both replies and
  top-level agent comments, and both count.

### Server startup

After migrations run, the server calls `recordStatOnce("install-new", id)` and
`recordStatOnce("install-active", id + ":" + <UTC date>)`, where `id` comes
from `installId()`. Both are fire-and-forget; a fresh install also creates the
`install_id` row as a side effect of the first `installId()` call.

### Web — event reporting

A tiny helper `reportStat(name, dedupKey?)` in `web/src/` — a fire-and-forget
`fetch` to `/api/stats/event`; all errors ignored (stats must never disturb
the review flow). Called from the **UI handlers** that dispatch the relevant
actions, never from reducers (reducers stay pure):

- changeset loaded into review → `reportStat("review-started", changesetId)`
- mark-changeset-reviewed handler → `reportStat("review-completed")`
- toggle-file-reviewed handler, on the **on** transition only →
  `reportStat("file-reviewed")`

`reportStat` always fires regardless of consent — the server routes the event
to `LogSink` or `McSink` per consent. The web app does not gate on consent.

### Web — consent banner on the welcome page

`Welcome` (`web/src/components/Welcome.tsx`) fetches `GET /api/stats/consent`
on mount.

- `undecided` → render an inline, **non-dismissible** banner: a short notice
  ("Share anonymous usage counts to help improve the tool?") with a single
  **Allow** button.
  - **Allow** → `POST /api/stats/consent { consent: "granted" }`, hide banner.
- `granted` → no banner.
- Fetch failure → no banner (fail closed: MC stays off).

There is no decline button and no close (×): declining is simply not clicking
Allow, which needs nothing stored. The banner is non-blocking — the user can
load a review with it still showing — and it stays put across welcome visits
until Allow is clicked, after which it never appears again.

## Error handling

Stats are best-effort. `recordStat`, `recordStatOnce`, and `reportStat`
swallow every error — network, DB, validation — and never propagate to the
review flow. A failed stat is logged at most once, not retried. A failed
consent fetch leaves MC off and shows no banner.

## Testing

Per `docs/plans/test-strategy.md` (integration tier uses real in-process
`createApp()`):

- Unit: `LogSink` output; `McSink` builds the expected pixel URL with the
  `x_<group>/<name>=<count>` multiplier (fetch stubbed) and swallows fetch
  rejections.
- Unit: `recordStat` routes to `McSink` only when consent is granted,
  `LogSink` while `undecided`; `grantConsent` flips routing live.
- Unit: `recordStatOnce` counts once, second call with the same key is a
  no-op; distinct keys both count.
- Unit: `installId()` generates and persists a UUID on first call and returns
  the same value on later calls (including a fresh module load with the row
  already in `settings`).
- Unit: schema migration v1→v2 creates `stat_dedup` and `settings`; runner is
  idempotent.
- Integration: `POST /api/stats/event` — a web-reportable name → `204`; an
  unknown name → `400`; a server-side name (e.g. `comment-posted-user`) → `400`
  (the web cannot forge server stats); `dedupKey` repeat → second call still
  `204`, no extra count.
- Integration: `createApp()` startup fires `install-new` once and
  `install-active` once; a second startup against the same DB fires neither
  again that day (asserted via the test sink).
- Integration: `GET /api/stats/consent` defaults to `undecided`;
  `POST /api/stats/consent` persists and the next `GET` reflects it; an
  invalid consent value → `400`.
- Integration: an existing `/api/review` test asserts `ai-review-request`
  fired; an `/api/interactions` upsert test asserts `comment-posted-user`
  fires on first save and *not* on re-saving the same interaction id.
  Tests inject a recording test sink rather than asserting on `console`.

## Open questions

None blocking. `LogSink` is fully functional with no MC setup, and `McSink`
works the moment consent is granted.
