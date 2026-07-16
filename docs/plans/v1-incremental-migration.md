# v1 incremental migration — plan

**Status:** active (2026-07-14). Supersedes the one-shot-branch strategy in
`product-analysis/rebuild-sequence.md` (branch `rebuild/plan-on-main`, unmerged).
The *target design* is unchanged: `product-analysis/v1-architecture.md` —
vendored onto this branch from `rebuild/plan-on-main@a00d8d5` — remains the
design tie-breaker; only the execution strategy changed.

**Goal:** reach the v1 four-primitive architecture — `Anchor`, `Interaction`,
`ChangeSet`, `Capability`; server SQLite as system of record; AI via MCP only;
worktree-only ingest — as a sequence of steps that each merge to `main` and
leave it shippable.

**Why incremental (D3 revised):** `main` already has the pieces the one-shot
plan assumed had to be rebuilt — a SQLite store with a forward-migration
framework (`server/src/db/schema.ts`), a unified `Interaction` type
(`web/src/types.ts`), the interaction trust boundary
(`server/src/agent-queue.ts`), and a working agent queue + MCP bridge. The
remaining delta is a model swap behind an insulated view boundary, not a rewrite.
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
   `X-Shippable-User-Id`/`-Role` headers upsert a user and stamp the new
   `interactions.author_id` expand column on write. Display-name resolution
   and rendering (still the hardcoded `"you"`/`"agent"` labels) are deferred.
   **Done 2026-07-15.**
4. **Persist changesets** — `changesets` + `diff_files` written at ingest with
   the parent chain; per-request recompute stays as fallback until stable.
5. **Anchor cutover** *(expand/migrate/contract; depends on 1)* — dual-write
   `anchor_json` beside `threadKey` in `payload_json`; adapt the
   `interactions.ts`/`view.ts` boundary; thread via `resolveRootAnchor`; then
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

## Decision — intent vocabulary (2026-07-14; amends v1-architecture §1.2)

`ResponseIntent = "accept" | "reject" | "respond"`. The spec's two-verdict
vocabulary gains one neutral reply intent; everything else in §1.2 stands.

- **Why.** With verdicts only, any reply that exchanges information — an agent
  answering "why does `validateToken` return null?", a human posting "fixed in
  abc123, look again" — has no honest intent. Forcing a ✓/✗ label on
  non-verdict replies corrupts the verdict record, which is the data this tool
  exists to produce. `respond` is the honest label for both.
- **The forcing function moves, it doesn't disappear.** Clean accept/reject
  existed to force decisions. That now lives in *resolution semantics*: a
  thread rooted in a `blocker` (or any AI finding) counts as **unresolved
  until a verdict reply exists** — `respond`s never resolve it, `n`/`N`
  navigation and the sign-off surface keep counting it. `question`-rooted
  threads resolve by being answered. Pressure stays; dishonest labels go.
- **Unchanged:** the ask⇔code / response⇔interaction biconditional. Asks
  (`comment | question | blocker`) still cannot anchor on interactions — an
  ask is a claim about code and must carry its own code anchor (the
  evidence-mandatory rule). If a mid-thread message needs its own position,
  it is a new ask on code, not a reply. `respond` was chosen over widening
  replies to the full ask set precisely to keep claims anchored and
  intent-keyed projections free of anchor-type conditionals.
- **Encoded now:** `web/src/primitives/interaction.ts` carries the widened
  union as of this branch (step 1), so later steps build on the decided shape.
- **Step-5 remap targets:** `request → comment`, `ack → accept`, historical
  asks-on-interactions → `respond`.

## Decision — explicit role header (2026-07-15; amends v1-architecture §13)

§13 has role implied by route (`/api/agent/*` ⇒ `'ai'`, everything else ⇒
`'human'`). Step 3 landed an explicit `X-Shippable-User-Role` header instead —
`identityFrom` reads it and defaults to `'human'` when absent — because the
MCP subprocess already sends both headers on every call and a route-implied
rule would need every current and future agent route enumerated to stay
correct. First-sight role is sticky (`user-store.ts`'s upsert never updates
`role` on conflict), so a later request can't flip it either way.

`interactions.author_id` landed as the expand column: nullable, populated
from the resolved request identity on write, untouched on conflict so a
re-sync without headers can't clear it. Old rows read back `null`. Contract
(backfill or NOT NULL) is a step 5/6 decision, not this step's.

## Decision — author integrity on upsert (2026-07-16)

One identity must never rewrite another identity's row. Nothing legitimate
needs it: the web client mirrors only rows it authored
(`useInteractionSync`'s `shouldMirror`), and the MCP path writes only agent
rows. Today's `POST /api/interactions` allows it purely by omission — the id
is client-supplied and the conflict clause trusts the caller, overwriting
`body`/`author` while preserving `author_id`. Enforcement landed on this
branch (pulled forward from step 5 at review): `POST /api/interactions` 409s
an upsert whose resolved identity differs from the row's non-null
`author_id` — a headerless request counts as a different identity. Rows
whose `author_id` is null (pre-identity data, or a headerless write) adopt
the first identified writer rather than staying unowned forever.

## Decision — role vocabulary (2026-07-16)

Unify, don't map. `users.role`'s `human | ai` is the vocabulary; the legacy
`interactions.author_role` values remap in step 5's migration
(`user → human`, `agent → ai`).

## Open questions (decide before step 5)

- **`unack` remap.** No revocation intent exists in v1 (interactions are
  immutable; replies append). Candidate rule: latest verdict reply wins, and
  historical `unack` rows migrate as `respond` noting the withdrawal. Decide
  with step 5's resolution-semantics implementation.
- **Role correction path.** `users.role` is first-sight-sticky and the
  headers are unauthenticated, so a wrong first claim (buggy script sending
  `-Role: ai` with a human's id, or vice versa) is permanent — there is no
  correction path, not even manual. Not exploitable on a single-user
  127.0.0.1 bind: anyone positioned to squat a role can already edit the
  SQLite file directly. It becomes real exactly when localhost stops meaning
  "just me" — forwarded ports to shared dev hosts, or multi-user v1.x —
  where a pre-claimed id would mislabel a person's comments with the agent
  badge forever. Decide alongside §18's real-auth work; a manual
  `UPDATE users SET role` escape hatch may be enough until then.
- **Header boundary width.** Only `apiClient`'s three helpers send the identity
  header today. ~15 web modules still call raw `fetch` — harmless right now
  because all interaction writes route through `apiClient`, but don't assume
  full coverage without checking call sites first.

## Noted for steps 5/6 (accepted costs, not blocking)

- `upsertUser` fires a SQLite write on every identified `/api/*` call purely
  to bump `last_seen_at` — including every poll of the MCP watch loop.
  Throttle per-id if it ever shows up in profiles.
- The MCP subprocess mints a fresh agent id per process, so every restart
  inserts a `users` row that's never referenced again. Unbounded by design in
  the expand phase; GC (or subprocess id persistence, §18) needs a home in
  step 6.

## Data migration

The one-shot's "drop all prototype data at merge" is replaced by per-entity
moves through the existing migration framework. Each entity either migrates or
consciously starts empty as a last resort, announced as one release-note line per step.
