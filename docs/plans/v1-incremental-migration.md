# v1 incremental migration — plan

**Status:** active (2026-07-14). Supersedes the one-shot-branch strategy in
`product-analysis/rebuild-sequence.md` (branch `rebuild/plan-on-main`, unmerged).
The *target design* is unchanged: `product-analysis/v1-architecture.md` on that
branch remains the design tie-breaker; only the execution strategy changed.

**Goal:** reach the v1 four-primitive architecture — `Anchor`, `Interaction`,
`ChangeSet`, `Capability`; server SQLite as system of record; AI via MCP only;
worktree-only ingest — as a sequence of steps that each merge to `main` and
leave it shippable.

**Why incremental (D3 revised):** `main` already has the pieces the one-shot
plan assumed had to be rebuilt — a SQLite store with a forward-migration
framework (`server/src/db/schema.ts`), a unified `Interaction` type
(`web/src/types.ts`), the interaction trust boundary
(`server/src/agent-queue.ts`), and a working agent queue + MCP bridge. The
remaining delta is a model swap behind an insulated view seam, not a rewrite.
Meanwhile this repo has already demonstrated the one-shot failure mode:
`refactor/unify-interactions-seam` died of branch rot while `main` moved on.

## Decisions

- **D1 — AI via MCP only.** End state unchanged: the server holds no Anthropic
  key and imports no LLM SDK. Rollout revised: the MCP path must work
  end-to-end *before* the server key path is removed, with one deprecation
  release carrying both plus a "connect an agent" banner.
- **D2 — worktree-only, diff read from disk.** Unchanged.
- **D3 — incremental steps to `main`.** Revised from "one-shot branch";
  rationale above.

## Guards — every step

- **G1** — interaction trust boundary: `source="local|external"` and the
  `<untrusted-quoted-content>` wrapping survive every step.
- **G2** — single-port `npm start` static-serve + same-origin CORS exception.
- Quality gates: web `build`/`lint`/`test`, server `typecheck`. Every step
  leaves `main` working end-to-end in the browser.
- Expand/contract discipline: any compatibility bridge lands with its removal
  step scheduled. No long-lived shims (AGENTS.md).

## Steps

One worktree/branch per step; normal PR to `main`.

1. **Primitives** *(additive)* — `web/src/primitives/`: `Anchor`+`BlockOrigin`,
   `Checks`, `Interaction` + write-time validator, `ChangeSet`, `Capability`.
   TDD plan: `docs/superpowers/plans/2026-07-08-rebuild-primitives.md`.
   Touches no existing code.
2. **Server-side progress state** — migrations for `read_lines`, `sign_offs`,
   `reviewed_changesets`, `prefs`; client writes through; localStorage keeps
   only cursor/drafts/dismissals.
3. **Users + identity** — `users` table; client-minted UUID +
   `X-Shippable-User-Id` header; replaces the hardcoded `"you"` author.
4. **Persist changesets** — `changesets` + `diff_files` written at ingest with
   the parent chain; per-request recompute stays as fallback until stable.
5. **Anchor cutover** *(expand/migrate/contract; depends on 1)* — dual-write
   `anchor_json` beside `threadKey` in `payload_json`; adapt the
   `interactions.ts`/`view.ts` seam; thread via `resolveRootAnchor`; then
   contract `threadKey`/`target`/`parentId` out of the client,
   `renderInteraction`, and the MCP tool together.
6. **agent_queue + wait_for_work** *(depends on 3)* — new `agent_queue` table
   (`plan`/`review`/`interaction`/`prompt`, channel-scoped);
   `shippable_wait_for_work` lands beside the old check/watch tools; producers
   migrate; old tools retire.
7. **AI via MCP (D1)** *(depends on 6)* — rule plan moves server-side;
   plan/review become queue jobs; the server Anthropic path is removed after
   one deprecation release.
8. **SSE + one external-update path** — per-changeset SSE replaces polling
   surface-by-surface; the `MERGE_*` reducers consolidate into a single
   `APPLY_EXTERNAL_UPDATE`.
9. **Capabilities, quiz, guards, polish** — `Capability` context; quiz
   tables/UI; React-free-core ESLint + test guard; AGENTS.md deployment-modes
   update per D2.

Steps 1–4 are order-flexible; dependencies as noted.

## Data migration

The one-shot's "drop all prototype data at merge" is replaced by per-entity
moves through the existing migration framework. Each entity either migrates or
consciously starts empty, announced as one release-note line per step.
