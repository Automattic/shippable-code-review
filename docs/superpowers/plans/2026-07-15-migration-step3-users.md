# Migration step 3 — users + identity

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development
> (or superpowers:executing-plans). Tasks use `- [ ]` checkboxes.

**Goal:** a `users` table plus end-to-end identity plumbing: the web client mints a
UUID and sends it as `X-Shippable-User-Id`; the MCP subprocess mints its own and adds
`X-Shippable-User-Role: ai`; the server upserts a `users` row on first sight and stamps
`author_id` on new interaction writes. Purely expand-phase: no old row is touched, no
wire shape changes for existing clients, requests without headers behave exactly as today.

**Spec:** `product-analysis/v1-architecture.md` §3.1 (users DDL), §13 (identity), amended
by `docs/plans/v1-incremental-migration.md` step 3 and these sign-offs (2026-07-15):
- Display-name affordance deferred to step 2's prefs UI; upsert `display_name: ''`.
- MCP subprocess identity included now.
- `interactions.author_id` lands now as a nullable expand column; old rows stay NULL.
- Role comes from an explicit `X-Shippable-User-Role` header (`"ai"` ⇒ ai, anything
  else/absent ⇒ human) — NOT from the route. Role is immutable after first sight:
  upsert conflict updates `last_seen_at` only.

## Global constraints

- Quality gates before each commit: `npm run test` + `npm run typecheck` (server, in the
  package you touched), `npm run test` + `npm run lint` + `npm run build` (web, if touched;
  note `vitest` does NOT typecheck — `npm run build` runs `tsc -b`, the real check),
  `npm run test` (mcp-server, if touched).
- Conventional-ish commits matching `git log`; NEVER a Co-Authored-By line.
- Trust boundary: header values are external input — bound their length, don't interpolate
  into SQL (prepared statements only, matching the existing stores).
- No new deps.

## File map

- Create: `server/src/db/user-store.ts` (+ `user-store.test.ts`)
- Modify: `server/src/db/schema.ts` (two new migrations, `SCHEMA_HEAD` 2 → 4)
- Create: `server/src/identity.ts` (+ `identity.test.ts`) — header extraction
- Modify: `server/src/index.ts` (upsert-on-request wiring), `server/src/db/interaction-store.ts`
  (+ its tests), `server/src/agent-queue.ts` reply path if it owns the insert
- Create: `web/src/userId.ts` (+ `userId.test.ts`)
- Modify: `web/src/apiClient.ts` (+ `apiClient.test.ts`)
- Modify: `mcp-server/src/handler.ts` (+ `handler.test.ts`)

---

### Task 1: users table + author_id migrations + user store

**Files:** `server/src/db/schema.ts`, `server/src/db/user-store.ts`, `server/src/db/user-store.test.ts`.

- [ ] Migration v2→v3:

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  role           TEXT NOT NULL,            -- 'human' | 'ai'
  display_name   TEXT NOT NULL,
  declared_json  TEXT,
  observed_json  TEXT,
  last_seen_at   TEXT NOT NULL
)
```

- [ ] Migration v3→v4: `ALTER TABLE interactions ADD COLUMN author_id TEXT` (nullable;
      no index yet — nothing queries by author). Bump `SCHEMA_HEAD` to 4.
- [ ] `user-store.ts`, mirroring the style of the existing stores (plain functions over
      the shared db handle, prepared statements):

```ts
export type UserRole = "human" | "ai";
export function upsertUser(id: string, role: UserRole, now?: string): void;
// INSERT ... ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
// role and display_name are NOT updated on conflict (first sight wins).
export function getUser(id: string): { id: string; role: UserRole; displayName: string; lastSeenAt: string } | undefined;
```

- [ ] Tests (follow the existing db test setup pattern — see how `interaction-store` /
      `agent-queue` tests open an in-memory or temp db and run migrations):
      fresh db migrates 0→4 cleanly; a v2 db (create tables via the first two migrations
      manually) migrates to 4 preserving interaction rows; upsert inserts with empty
      display_name; second upsert bumps only last_seen_at; conflicting role claim does
      not flip role; getUser round-trips.
- [ ] Commit: `feat(server): users table + author_id column + user store (migration v4)`

### Task 2: identity extraction + upsert on request

**Files:** `server/src/identity.ts`, `server/src/identity.test.ts`, `server/src/index.ts`.

- [ ] `identity.ts`:

```ts
export type RequestIdentity = { userId: string; role: "human" | "ai" };
// Reads X-Shippable-User-Id / X-Shippable-User-Role from a node IncomingMessage-like
// headers object. Returns null when the id header is absent/empty/longer than 128 chars.
// role === "ai" only when the role header is exactly "ai" (case-insensitive); else "human".
export function identityFrom(headers: Record<string, string | string[] | undefined>): RequestIdentity | null;
```

- [ ] Wire into `index.ts` once, before route dispatch on `/api/*` requests: if
      `identityFrom(req.headers)` is non-null, `upsertUser(userId, role)`. Failure to
      upsert must not fail the request (log and continue) — identity is best-effort
      in the expand phase.
- [ ] Make the resolved identity available to handlers (pass alongside req or attach
      via the existing handler-args pattern in index.ts — follow how other cross-cutting
      values like the db status flow; do not invent middleware infra).
- [ ] Tests: unit tests for identityFrom (absent, empty, oversized, role variants);
      integration test through the real app (follow the in-process `createApp()` pattern
      from `docs/plans/test-strategy.md` and existing endpoint tests): request with
      id header creates a users row with role human; with role header `ai` creates role
      ai; second request with a different role does not flip it; request without header
      creates nothing and still succeeds.
- [ ] Commit: `feat(server): upsert users from X-Shippable-User-Id/-Role headers`

### Task 3: author_id stamped on new interaction writes

**Files:** `server/src/db/interaction-store.ts` (+ tests), the reviewer POST endpoint
handler, the agent reply insert path (`server/src/agent-queue.ts` or wherever
`/api/agent/replies` inserts rows).

- [ ] Interaction create/insert paths accept an optional `authorId?: string`, stored in
      the new column. `StoredInteraction` (server-side wire shape) gains
      `authorId: string | null` — additive; the web client's local mirror ignores
      unknown fields, so no web change.
- [ ] Reviewer path: `POST /api/interactions` passes the request identity's userId when
      present. Agent path: `POST /api/agent/replies` likewise.
- [ ] Old rows: read paths return `authorId: null` for pre-migration rows. Nothing
      renders it yet — storage-side expand only.
- [ ] Tests: store round-trip with and without authorId; endpoint-level: POST with
      identity header → row carries that author_id; POST without → NULL. Existing
      endpoint tests must pass unchanged (proves no-header compatibility).
- [ ] Commit: `feat(server): stamp author_id on new interaction writes`

### Task 4: client userId + header on apiClient

**Files:** `web/src/userId.ts`, `web/src/userId.test.ts`, `web/src/apiClient.ts`,
`web/src/apiClient.test.ts`.

- [ ] `userId.ts`: `getUserId(): string` — reads `localStorage["shippable:userId:v1"]`;
      mints `crypto.randomUUID()` and persists on first call. Storage errors (private
      mode) fall back to an in-memory id for the session — identity is best-effort.
- [ ] `apiClient.ts`: all three helpers send `X-Shippable-User-Id: getUserId()`.
      (No role header — absent means human by Task 2's rule.)
- [ ] Tests: userId is stable across calls and across module functions; uuid-shaped;
      apiClient tests assert the header is present on POST/GET/DELETE (extend the
      existing apiClient.test.ts mocking pattern).
- [ ] Web gates: `npm run test`, `npm run lint`, `npm run build` (tsc -b is the typecheck).
- [ ] Commit: `feat(web): mint a persistent userId and send it on every API call`

### Task 5: MCP subprocess identity

**Files:** `mcp-server/src/handler.ts`, `mcp-server/src/handler.test.ts`.

- [ ] Module-level `const AGENT_USER_ID = crypto.randomUUID()` minted once per process
      (in-memory by design; restart = new identity, per spec §13).
- [ ] Every server call the handler makes (all `fetchFn(...)` sites) sends
      `X-Shippable-User-Id: AGENT_USER_ID` and `X-Shippable-User-Role: ai`.
- [ ] Tests: use the existing injectable `fetchFn` seam to assert both headers on each
      call path (check, watch, post-reply); id is identical across calls within the
      process.
- [ ] Commit: `feat(mcp): subprocess mints an agent identity and sends it on every call`

### Task 6: cross-package integration proof + docs

**Files:** one server integration test file; `docs/plans/v1-incremental-migration.md`.

- [ ] Integration test through the real app: (1) reviewer POSTs an interaction with a
      human id header → users row role `human`, interaction row author_id set;
      (2) agent posts a reply with id+role headers → users row role `ai`, reply row
      author_id set; (3) `GET /api/interactions` returns both rows with authorId
      populated and legacy rows (inserted directly without author_id) as null.
- [ ] Update `docs/plans/v1-incremental-migration.md` step 3 line: mark done, note the
      explicit `X-Shippable-User-Role` header (design detail beyond arch §13's
      route-implied role) and that `interactions.author_id` landed as the expand column.
- [ ] Commit: `test(server): end-to-end identity proof; docs: mark step 3 done`

---

## Exit criteria

- All gates green in all three packages (server test+typecheck, web test+lint+build,
  mcp-server test).
- A request with no identity headers behaves byte-identically to today (existing tests
  unchanged and green).
- Fresh db migrates 0→4; existing v2 db migrates 2→4 losslessly.
- No UI change: "You" rendering untouched; no badge; no settings input.
