# Shippable v1 rebuild — document index

These docs describe a from-scratch rebuild of Shippable. They accumulated across
several sessions and a few of them **supersede** each other, so read them in the
order below and mind the **Status** column — it tells you which docs govern the
current design and which are kept only for history.

**The one rule:** when any doc disagrees with `v1-architecture.md`, `v1-architecture.md`
wins. It is the finalized design and its header explicitly supersedes the two
older architecture docs.

| Doc | Status | Read it for |
|---|---|---|
| [`v1-architecture.md`](./v1-architecture.md) | **AUTHORITATIVE — design** | The *what*: the four-primitive v1 design, schema, wire protocol, invariants |
| [`rebuild-sequence.md`](./rebuild-sequence.md) | **AUTHORITATIVE — execution** | The *how*: the phased build order, with regression guards and the merge gate |
| [`rebuild-execution-review.md`](./rebuild-execution-review.md) | Active — risk review | *Why* the sequence is shaped this way; the drift/security guards; open decisions (resolved) |
| [`product.md`](./product.md) | Reference — **§5 stale** | Feature inventory and per-feature acceptance criteria. Ignore §5's phasing (see `rebuild-sequence.md`) |
| `<feature>.md`, `_group{1..8}-*.md` | Reference | Per-feature detail and cross-cutting notes; still-valid input to the rebuild |
| [`suggested-architecture.md`](./suggested-architecture.md) | **SUPERSEDED** by `v1-architecture.md` | Early architecture proposal. History / rationale only |
| [`rebuild-plan.md`](./rebuild-plan.md) | **SUPERSEDED** by `v1-architecture.md` | The grilling decision log (#1–#15) — the *rationale* behind locked decisions. History only |

**Detailed per-phase implementation plans** live in
[`../docs/superpowers/plans/`](../docs/superpowers/plans/) as
`YYYY-MM-DD-rebuild-<phase>.md` (start: `2026-07-08-rebuild-primitives.md`).

## Why the two older docs are kept, not deleted

`rebuild-plan.md` holds the *why* behind each locked decision — the terse
`v1-architecture.md` records the decision, not the argument. `suggested-architecture.md`
is the proposal those decisions grilled. They are preserved as working notes so
the reasoning survives; they are **not** current design and must not be read as
such. The banners at the top of each say so.

## Provenance

This tree was authored on the `trunk` branch and vendored onto the main line
(trunk had diverged from `main`). The plan now tracks current `main` code.
