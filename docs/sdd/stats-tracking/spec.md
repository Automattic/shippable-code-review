# Spec: Review stats tracking

## Goal

Add write-only usage counters for review activity and install identity, routed
through a pluggable sink that defaults to a no-network log and switches to an
MC-shaped pixel only after the user explicitly consents from the welcome page.
This gives us real usage signal without coupling call sites to MC and without
sending anything off a contributor's machine before they agree.

## Requirements Summary

- Count review activity (started/completed, file-marked-okay, comments by
  user/agent/AI, AI review requests) and install identity (`install-new`,
  `install-active`).
- One fire-and-forget recording API; never throws.
- Sink chosen per record call from live consent state: `LogSink` while
  undecided, `McSink` once granted.
- Consent is binary, persisted server-side, granted once from a non-dismissible
  welcome-page banner; no deny, no env override.
- `review-started` deduped per changeset; install counters deduped via a local
  `install_id` that never leaves the host.
- `/api/stats/event` is the web→server trust boundary — only `KNOWN_STATS`
  names accepted; server-only names rejected with `400`.

## Chosen Approach

**Pluggable `StatSink` with per-call consent routing** — locked by the approved
design doc ([`design.md`](./design.md), status: *Approved design, ready for
implementation plan*).

A `server/src/stats/` module exposes `recordStat` / `recordStatOnce`. A
`StatSink` interface (`record(name, count)`) has two implementations: `LogSink`
(console only) and `McSink` (fire-and-forget GET to the `g.gif` pixel using the
`x_shippable/<name>=<count>` multiplier form). The active sink is selected on
each record call from the live consent state, so granting consent mid-session
takes effect immediately with no restart.

### Alternatives Considered

The approved design fixed this approach; no open alternatives. Rejected
implicitly: a startup-fixed sink (would need a restart to honor consent), an
env-variable consent override (consent is the only switch), and a read-side
`/api/stats` API (counters are write-only for now).

## Technical Details

### Architecture

New `server/src/stats/` module sitting beside the existing DB layer. It owns
the sink abstraction, consent cache, install identity, and the `KNOWN_STATS`
allowlist. Existing handlers (`review.ts`, `interaction-endpoints.ts`, the
agent-replies handler) gain a single record call each. Server startup fires the
install counters after migrations run. New endpoints register in
`server/src/index.ts`. The web app gets a `reportStat` helper and a consent
banner on `Welcome.tsx`.

### Data Flow

- **Web events:** UI handler → `reportStat(name, dedupKey?)` →
  `POST /api/stats/event` → validated against `KNOWN_STATS` →
  `recordStat`/`recordStatOnce` → sink (per consent).
- **Server events:** handler → `recordStat`/`recordStatOnce` directly (no
  re-validation — internal trust boundary) → sink.
- **Consent:** `Welcome` → `GET /api/stats/consent`; **Allow** →
  `POST /api/stats/consent` → `grantConsent()` writes the `settings` row → the
  next `recordStat` reads it and routes to `McSink`.
- **Dedup:** `recordStatOnce` does `INSERT OR IGNORE` into `stat_dedup`; sink
  fires only when `changes() === 1`.

### Key Components

| Component | Responsibility |
|-----------|----------------|
| `recordStat` / `recordStatOnce` | Fire-and-forget recording entry points; never throw |
| `StatSink` + `LogSink` / `McSink` | Sink interface and the two implementations |
| Consent | `consentGranted()` / `grantConsent()`; reads/writes the `settings` row |
| `installId()` | Lazily generates + persists an opaque UUID; used only as dedup key |
| `KNOWN_STATS` | Allowlist of the 3 web-reportable stat names |
| `reportStat` (web) | Fire-and-forget `fetch` to `/api/stats/event` |
| Consent banner | Non-dismissible welcome-page Allow prompt |

### Schema migration v2

Bumps `SCHEMA_HEAD` to 2, appends `MIGRATIONS[1]`, creating:
- `stat_dedup(name, dedup_key, recorded_at, PRIMARY KEY(name, dedup_key))`
- `settings(key PRIMARY KEY, value)` — holds `stats_mc_consent` and `install_id`.

### Stat catalog

`review-started`, `review-completed`, `file-marked-okay` (web-reportable —
`KNOWN_STATS`); `comment-posted-user/-agent/-ai`, `ai-review-request`,
`install-new`, `install-active` (server-side only). See the design doc table
for exact firing conditions.

### File Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `server/src/stats/` | new | Stats module: sinks, `recordStat`/`recordStatOnce`, consent, `installId`, `KNOWN_STATS` |
| `server/src/db/migrations` (runner + `MIGRATIONS`) | modify | Add v2 migration creating `stat_dedup` + `settings` |
| `server/src/index.ts` | modify | Register `/api/stats/event`, `/api/stats/consent` (GET+POST); fire install counters on startup |
| `server/src/review.ts` | modify | `recordStat("ai-review-request")` on entry; `recordStat("comment-posted-ai")` on stream `done` |
| `server/src/db/interaction-endpoints.ts` | modify | `recordStatOnce("comment-posted-user", <id>)` for user ask interactions |
| agent-replies handler | modify | `recordStat("comment-posted-agent")` per stored agent interaction |
| `web/src/` (new helper) | new | `reportStat(name, dedupKey?)` fire-and-forget fetch |
| web review UI handlers | modify | Call `reportStat` on changeset load, mark-reviewed, file-toggle-on |
| `web/src/components/Welcome.tsx` | modify | Consent fetch + non-dismissible Allow banner |
| tests (server + web) | new/modify | Unit + integration coverage per design doc "Testing" section |

## Out of Scope

- A stats dashboard or `/api/stats` read API — counters are write-only.
- Historical backfill.
- Sending any identifier to MC — only anonymous bump counts leave the host.
- An environment-variable consent override — consent is the only switch.
- Pruning `stat_dedup` — low volume for a prototype; revisit if it ever matters.

## Open Questions Resolved

- **Sink lifetime** — chosen per record call from live consent, not fixed at
  startup, so mid-session consent works with no restart.
- **MC infra** — none needed: `g.gif` auto-creates the stat on first bump.
- **Consent shape** — binary (`granted` / `undecided`); declining stores
  nothing, so there is no deny state or close button.
- **MC group** — the group is hardcoded `shippable`; the `SHIPPABLE_STATS_GROUP`
  env override was removed as unused (review feedback). Still owed before MC
  consent is exercised in production: confirm `shippable` does not collide with
  an existing MC group. Non-blocking for `LogSink`.

## Follow-ups

Tracked here rather than built now — see [`design.md`](./design.md) for the
rationale that these are acceptable for a prototype:

- **`stat_dedup` growth** — `recordStatOnce` writes one permanent row per
  `(name, dedupKey)` and the table is never pruned, so the daily
  `install-active` key grows it indefinitely. Cleanups, when this matters:
  cap `dedupKey` length at the `/api/stats/event` edge, and add a retention
  sweep (or fold the daily `install-active` marker into a single overwriting
  `settings` row).
