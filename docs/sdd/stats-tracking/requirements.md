# Requirements: Review stats tracking

**Source:** [`design.md`](./design.md) — approved design.

## Problem

We have no idea how much the tool is actually used. We want counters for review
activity — reviews started/completed, files marked okay, comments posted — and a
path to push them to Automattic's MC stats, without baking the MC endpoint into
every call site and without sending anything off a contributor's machine before
they've agreed to it.

## Functional requirements

- Count a small set of review-activity events (reviews started/completed, files
  marked okay, comments posted by user/agent/AI, AI review requests).
- Count unique installs (`install-new`) and daily-active installs
  (`install-active`).
- Push counts somewhere MC-shaped, with a swappable destination.
- Nothing goes to MC until the user explicitly consents.
- The consent ask lives on the welcome page; once granted it never shows again.
- `review-started` counts once per changeset, even across reloads.
- Web-reportable events cross a validated trust boundary; the web cannot forge
  server-only stat names.

## Non-functional requirements

- Stats are best-effort: recording must never throw or disturb the review flow.
- `recordStat` must not block on a DB read — consent state is cached in memory.
- Consent can be granted mid-session with no server restart.

## Constraints

- Server is a hard dependency in every deployment shape (per AGENTS.md).
- Persistence is SQLite via the existing migration runner (`SCHEMA_HEAD`,
  `MIGRATIONS`).
- Group and stat names are static slugs, each capped at 32 characters.

## Scope

**In:** stats module + sink abstraction, consent storage + endpoints, schema
migration v2, install identity, server-side call-site wiring, web `reportStat`
helper, welcome-page consent banner.

**Out:** a stats dashboard or `/api/stats` read API (counters are write-only);
historical backfill; sending any identifier to MC; an environment-variable
consent override (consent is the only switch).
