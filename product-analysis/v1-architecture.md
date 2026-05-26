# v1 architecture — Shippable rebuild

The finalized architecture for v1, derived from two grill sessions of
[`suggested-architecture.md`](./suggested-architecture.md):

- **Session 1 (2026-05-25):** entity-by-entity validation of the
  four-primitive proposal.
- **Session 2 (2026-05-26):** reconciliation with the earlier
  [`rebuild-plan.md`](./rebuild-plan.md) handoff — sign-off, agent
  identity, MCP read-peer surface, refactor (not rebuild) shape,
  invariants.

Supersedes `suggested-architecture.md` (preserved as the brainstorming-stage
draft) and absorbs `rebuild-plan.md` (preserved as session-1 working notes).

---

## 1. The four primitives

The whole product is expressed in four types. Everything else is derived.

### 1.1 Anchor

A position. Used by every feature that asks "where in the code?".

```ts
type Anchor =
  | { kind: "block";     file: string; lo: number; hi: number; ctx?: AnchorCtx }
  | { kind: "symbol";    file: string; symbol: string }
  | { kind: "file";      file: string }
  | { kind: "changeset" }                       // zero-data: applies to the whole ChangeSet
  | { kind: "comment";   commentId: string };   // anchors to another Interaction (= reply)

type AnchorCtx = {
  hash: string;                                  // FNV-1a over context window
  contextLines: string[];                        // surrounding lines for fuzzy re-anchor
  prefer: "before" | "after";
  originSha?: string;                            // absent for paste/file/url
  originType: "committed" | "dirty";             // explicit, not derived from sentinel
};
```

**Key decisions:**

- **No `hunk` kind.** Hunks are an artifact of how diffs are parsed; once
  parsed, ranges are sufficient.
- **No `line` vs `block` distinction.** A single-line position is `block`
  with `lo === hi`.
- **`changeset` kind for ChangeSet-level claims** ("this changeset is
  mostly cosmetic"; quiz changeset-level questions). Zero-data; carries
  no file/range.
- **`comment` anchors are how threading works.** A reply is an
  Interaction anchored to its parent. Reply-of-reply allowed. Cycles
  prevented by acyclic insert.
- **`symbol` resolves lazily.** Anchor stores symbol name + file; the
  renderer asks the code-graph to resolve symbol → line. Survives line
  drift; falls back to text-search when LSP unavailable.
- **`originType` is explicit** on AnchorCtx, not derived from
  `originSha === "WORKING"`. Re-anchoring policy can differ for
  committed vs dirty origins.

**Comment chain resolution.** `resolveRootAnchor(anchor)` walks the
comment chain until it hits a code-or-changeset anchor. Terminates
because asks must root on non-comment anchors (write-time rule).

### 1.2 Interaction

The unified signal. One shape for every reviewer event — human comment,
AI annotation, external PR comment, agent post, reply, ack/reject.

```ts
type AuthorRole = "human" | "ai";

type AskIntent      = "comment" | "question" | "request" | "blocker";
type ResponseIntent = "ack" | "unack" | "accept" | "reject";
type Intent         = AskIntent | ResponseIntent;

type RubricCheck = {
  pass: boolean;
  note?: string;                    // required when pass === false
};

// Rubric shape varies by intent. Empty for low-stakes intents.
type RubricFor<I extends Intent> =
  I extends "blocker" ? {
    reproduced:  RubricCheck;
    testsRun:    RubricCheck;
    testsPassed: RubricCheck;
    verified:    RubricCheck;       // not a false positive
  } :
  I extends "request" ? {
    testsRun:    RubricCheck;
    verified:    RubricCheck;
  } :
  // comment | question | ack | unack | accept | reject
  Record<string, never>;             // no rubric required

type RunRecipe = {
  source: string;                                   // inline code; runner has no fs reach
  inputs: Record<string, string>;
};

type Interaction = {
  id: string;
  changesetId: string;

  anchor: Anchor;
  evidence?: Anchor[];                              // optional supporting refs

  authorRole: AuthorRole;
  author: string;                                   // display name; provenance elsewhere
  intent: Intent;

  body: string;                                     // markdown

  // ai-only structured fields
  rubric?: RubricFor<Intent>;
  rationale?: string;
  suggestedFix?: string;

  runRecipe?: RunRecipe;

  external?: {
    source: "pr" | "mcp";
    htmlUrl?: string;
    sentinelId?: string;
  };

  // generation tag: AI interactions are tied to a specific ChangeSet revision.
  // On re-ingest (new ChangeSet via parent chain), prior-generation AI
  // interactions stay on the old ChangeSet and surface as "from prior revision".
  generation?: { ingestId: string; sha: string };

  status?: "streaming" | "done" | "error";
  createdAt: string;
  updatedAt: string;
};
```

**Write-time validation rules:**

- `intent ∈ AskIntent`  →  `anchor.kind !== "comment"` (asks root on code/changeset).
- `intent ∈ ResponseIntent`  →  `anchor.kind === "comment"` (responses reply).
- `authorRole === "ai"` AND `intent === "blocker"`  →  full blocker rubric required at `status === "done"`.
- `authorRole === "ai"` AND `intent === "request"`  →  request rubric required at `status === "done"`.
- `authorRole === "ai"` AND `intent ∈ {"comment", "question"}`  →  no rubric required.
- `authorRole === "human"`  →  `rubric`, `rationale`, `suggestedFix` absent.
- `pass === false` on any rubric check  →  `note` required.
- Streaming/error rows may omit `rubric`; only `done` rows enforce.
- **Plan-claim Interactions** (those referenced by `Plan.claimIds`, §7)
  require non-empty `evidence: Anchor[]`. UI refuses to render a plan
  claim with no evidence.

**Key decisions:**

- **No `threadKey` field.** Threading derives from `anchor.kind ===
  "comment"` chains. The prototype's prefixed keys (`note:`, `block:`,
  `user:`, `teammate:`, `hunkSummary:`) were a workaround; the anchor
  is the unified pointer.
- **No `target`, no `parentId`.** Anchor is the sole positioning field.
- **AuthorRole is two-valued.** Agent posts (MCP) and in-app streaming
  reviews are both "AI signal"; `external.source` discriminates origin
  when origin matters.
- **Rubric varies by intent.** Universal rubric was theatre on low-stakes
  comments. Blockers carry the full four-check rubric; requests carry
  two; comments/questions carry none. Forces rigor where stakes warrant.
- **AI fills its own rubric; humans don't touch it.** Disagreement
  expressed via `ack`/`reject` reply, not by editing the AI's
  self-report.
- **`rationale` and `suggestedFix` stay structured.** Renderable as
  distinct UI elements (e.g. "apply this patch" button).
- **`evidence: Anchor[]`** lets one Interaction cite multiple code
  positions for cross-cutting claims. UI renders as inline "see also"
  links. Required for plan claims; optional elsewhere.
- **`generation` tag on AI rows.** Tracks which ingest revision the
  claim was generated against. On re-ingest, old AI claims stay on
  their original ChangeSet; the parent-chain link is the navigation
  path between revisions.

### 1.3 ChangeSet

The unit of review. A snapshot of a diff plus the source it came from.

```ts
type ChangeSet = {
  id: string;
  parentChangesetId?: string;                       // set on refresh; links to prior snapshot
  provenance: Provenance;
  files: DiffFile[];
  ingestedAt: string;
};

type Provenance =
  | { kind: "worktree"; workdir: string; branch: string; sha: string | "WORKING"; dirty: boolean }
  | { kind: "pr";       owner: string; repo: string; number: number; sha: string; title: string; body: string; author: string }
  | { kind: "paste";    raw: string; pastedAt: string }
  | { kind: "file";     filename: string; size: number }
  | { kind: "url";      url: string; sha?: string };
```

**ChangeSet id derivation:**

| Provenance | id format                                     |
|------------|-----------------------------------------------|
| worktree   | `worktree:{workdir}@{sha-or-WORKING}`         |
| pr         | `pr:{owner}/{repo}/{number}@{sha}`            |
| url        | `url:{url}@{sha}` (or content-hash if no sha) |
| paste      | `paste:{contentHash}`                         |
| file       | `file:{filename}:{contentHash}`               |

**Key decisions:**

- **Immutable.** Refresh creates a new ChangeSet with
  `parentChangesetId`. Re-anchoring migrates interactions forward.
  Audit trail preserved.
- **Provenance-derived id with content-hash fallback** for paste/file/
  url-without-sha.
- **PR comments materialised at ingest** as immutable read-only
  Interactions with `external.source: "pr"`.
- **Metadata lives on the provenance variant**, not a flat `meta` bag.

### 1.4 Capability

The flag system that decides what UI mounts.

```ts
type CapabilityKey =
  | "ingest.worktree" | "ingest.pr" | "ingest.paste" | "ingest.file" | "ingest.url"
  | "lsp.typescript" | "lsp.php" | "lsp.python"
  | "runner.js" | "runner.php"
  | "ai.streaming" | "ai.mcp"
  | "vcs.gh-clone"
  | "picker.directory"                              // tauri-plugin-dialog or AppleScript
  | "quiz.enabled";

type Capability =
  | { available: true }
  | { available: false; reason: string };

type Capabilities = Record<CapabilityKey, Capability>;
```

**Key decisions:**

- **Per-feature granularity.** One flag per shippable feature.
- **Server ∩ ChangeSet.** Server reports its base set ("typescript-
  language-server installed"); ChangeSet provenance narrows it ("paste,
  no worktree disk"). Effective capability = intersection.
- **Reactive.** Capabilities live in a context. Flag flip-off unmounts
  consumer components; open dialogs auto-close.
- **Reasons on unavailable caps.** UI renders "feature off because X"
  tooltips.

---

## 2. Three layers

Doc-level organisation. Not a code partition.

### 2.1 Ingest

Turns an external source into a ChangeSet. Server-side, end to end.

- **All ingest runs on the server.** Client uploads paste content / file
  bytes, posts URL/PR coordinates, gets back a ChangeSet id.
- **One endpoint per provenance**, all returning `{ changesetId }`.
- **PR ingest pulls comments at the same time** and inserts them as
  Interactions in the same transaction.
- **Single reducer path for external updates** (the
  `APPLY_EXTERNAL_UPDATE` shape). Initial load, refresh, SSE-pushed
  changes from other actors — all hit the same `applyExternalUpdate(state,
  changeset)` reducer. Re-anchoring runs once, in one place.

### 2.2 Annotation

Produces Interactions. Three sources:

- **Human:** client `POST /api/interactions` with optimistic insert.
- **AI streaming (Path B):** server streams from Anthropic, inserts a
  row with `status: "streaming"` at start, appends to `body` as tokens
  arrive, finalises `status: "done"` with rubric on completion. SSE
  pushes deltas. Interrupted streams settle as `status: "error"` with
  partial body and no rubric.
- **AI external (Path A, MCP):** worktree-running agent calls
  `POST /mcp/comments` with a complete Interaction. Atomic.

AI interactions carry `generation: { ingestId, sha }`. Re-ingest of the
same source with a different sha produces a new ChangeSet; AI claims on
the old ChangeSet remain immutable.

### 2.3 Walk

The review state machine: cursor, read-line tracking, projections.

- **Client owns the cursor.** Per-changeset localStorage. Each browser
  tab gets its own. Single-user-local in v1.
- **Read-lines batch+debounce on the client; POST every 1–2s.** Server
  stores compact merged ranges keyed by `(userId, changesetId, file)`.
- **No persisted drafts.** Submit-or-lose.
- **Coverage** and **sign-off** are derived projections (§§5–6).

---

## 3. Storage architecture

```
┌─────────────────────────────────────────────────────────────┐
│  SQLite (server)         — source of truth                  │
│  • interactions          (the unified timeline)             │
│  • changesets            (immutable snapshots; parent chain)│
│  • diff_files            (denormalised file rows per cs)    │
│  • read_lines            (ranges per user/cs/file)          │
│  • sign_offs             (file-level human sign-off)        │
│  • prefs                 (k/v per user)                     │
│  • trusted_hosts         (server policy table)              │
│  • agent_identities      (declared + observed)              │
│  • plans                 (one row per changeset)            │
│  • quizzes / quiz_responses                                 │
├─────────────────────────────────────────────────────────────┤
│  Keychain (Tauri) / RAM (dev) — secrets only                │
│  • anthropic API key                                        │
│  • github tokens (per host)                                 │
├─────────────────────────────────────────────────────────────┤
│  localStorage (client) — UI state only                      │
│  • cursor per changeset                                     │
│  • locally-generated userId                                 │
│  • dismissals (e.g. dismissed guides, hint tooltips)        │
│  • drafts in progress (not persisted across reloads)        │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Column-level shapes

```sql
CREATE TABLE changesets (
  id                   TEXT PRIMARY KEY,
  parent_changeset_id  TEXT REFERENCES changesets(id),
  provenance_kind      TEXT NOT NULL,
  provenance_json      TEXT NOT NULL,                -- discriminated variant blob
  ingested_at          TEXT NOT NULL
);

CREATE TABLE diff_files (
  changeset_id  TEXT NOT NULL REFERENCES changesets(id),
  path          TEXT NOT NULL,
  status        TEXT NOT NULL,                       -- added | modified | deleted | renamed
  file_json     TEXT NOT NULL,                       -- hunks, lines
  PRIMARY KEY (changeset_id, path)
);

CREATE TABLE interactions (
  id              TEXT PRIMARY KEY,
  changeset_id    TEXT NOT NULL REFERENCES changesets(id),
  anchor_json     TEXT NOT NULL,                     -- Anchor discriminated union
  evidence_json   TEXT,                              -- Anchor[] or NULL
  author_role     TEXT NOT NULL,                     -- human | ai
  author          TEXT NOT NULL,
  intent          TEXT NOT NULL,
  body            TEXT NOT NULL,
  rubric_json     TEXT,                              -- intent-shaped rubric or NULL
  rationale       TEXT,
  suggested_fix   TEXT,
  run_recipe_json TEXT,
  external_json   TEXT,                              -- pr | mcp provenance
  generation_json TEXT,                              -- AI-only { ingestId, sha }
  status          TEXT,                              -- streaming | done | error | NULL
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_interactions_cs ON interactions(changeset_id);

CREATE TABLE read_lines (
  user_id      TEXT NOT NULL,
  changeset_id TEXT NOT NULL REFERENCES changesets(id),
  file         TEXT NOT NULL,
  ranges_json  TEXT NOT NULL,                        -- compact [lo,hi][]
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, changeset_id, file)
);

CREATE TABLE sign_offs (
  user_id      TEXT NOT NULL,
  changeset_id TEXT NOT NULL REFERENCES changesets(id),
  file         TEXT NOT NULL,
  signed_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, changeset_id, file)
);

CREATE TABLE prefs (
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE trusted_hosts (
  host       TEXT PRIMARY KEY,
  trusted_at TEXT NOT NULL
);

CREATE TABLE agent_identities (
  session_id     TEXT PRIMARY KEY,
  declared_json  TEXT NOT NULL,                      -- { handle, purpose, model }
  observed_json  TEXT NOT NULL,                      -- { worktreePath, harness, osUser, host, firstSeenAt }
  last_seen_at   TEXT NOT NULL
);

CREATE TABLE plans (
  changeset_id    TEXT PRIMARY KEY REFERENCES changesets(id),
  headline        TEXT NOT NULL,
  structure_json  TEXT NOT NULL,                     -- StructureMap
  entry_points_json TEXT NOT NULL,                   -- Anchor[] (≤3)
  claim_ids_json  TEXT NOT NULL,                     -- string[]
  generation_json TEXT NOT NULL,                     -- { ingestId, sha }
  created_at      TEXT NOT NULL
);

CREATE TABLE quizzes (
  id             TEXT PRIMARY KEY,
  changeset_id   TEXT NOT NULL REFERENCES changesets(id),
  questions_json TEXT NOT NULL,                      -- Question[] with Anchor targets
  created_at     TEXT NOT NULL
);

CREATE TABLE quiz_responses (
  quiz_id     TEXT NOT NULL REFERENCES quizzes(id),
  user_id     TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (quiz_id, user_id)
);
```

### 3.2 Identity, secrets

- **Identity.** Local-only userId, generated on first POST and persisted
  client-side. No accounts, no auth in v1. Deferred to multi-user.
- **Secrets.** Keychain in Tauri, server memory in dev. Server is the
  policy boundary; secrets never reach the client. The dead
  `ANTHROPIC_API_KEY` env-var warning at `server/src/index.ts:1446-1450`
  is deleted — the boot panel is the only entry point.

---

## 4. Wire protocol

### 4.1 REST surface

- `POST /api/changesets/{provenance}`             → `{ changesetId }`
- `GET  /api/changesets/{id}`                     → `ChangeSet`
- `GET  /api/changesets/{id}/interactions`        → `Interaction[]`
- `GET  /api/changesets/{id}/plan`                → `Plan`
- `GET  /api/changesets/{id}/quiz`                → `Quiz`
- `POST /api/changesets/{id}/quiz/responses`      → `QuizResponse`
- `POST /api/interactions`                        → `Interaction` (canonical)
- `PATCH /api/interactions/{id}`                  → `Interaction`
- `POST /api/read-lines`                          → `{ ok: true }` (batched ranges)
- `POST /api/sign-offs`                           → `{ ok: true }`
- `DELETE /api/sign-offs`                         → `{ ok: true }` (revoke)
- `GET  /api/code-graph/{csid}/{file}`            → `{ symbols, references, provenance }`
- `GET  /api/prefs`                               → `Record<key, value>`
- `PATCH /api/prefs`                              → `{ ok: true }`
- `POST /api/credentials/{kind}`                  → `{ ok: true }`

### 4.2 MCP tool surface

Agent peers connect via stdio MCP subprocess (`mcp-server/src/index.ts`)
talking to the Node server on `127.0.0.1:{port}/api/agent/*`.

**Write tools** (carried forward from prototype):

- `shippable_check_review_comments`
- `shippable_watch_review_comments`
- `shippable_post_review_comment` (already accepts agent top-level posts
  with rationale/suggestedFix; rubric replaces today's `confidence`)

**Read tools** (new in v1):

- `shippable_get_changeset(id)`       → `ChangeSet` + file content
- `shippable_get_plan(id)`            → `Plan` + claim Interactions
- `shippable_get_progress(id)`        → coverage + sign-off projections
- `shippable_get_sign_off(id)`        → per-file sign-off table

All read tools include the requesting agent's identity in their request
context; the server records the read against the agent's `session_id`
in `agent_identities`.

### 4.3 SSE per-ChangeSet

`GET /api/changesets/{id}/stream` opens an EventSource. Server pushes:

- `interaction.created` — full Interaction
- `interaction.updated` — full Interaction (streaming deltas, status
  transitions, rubric finalisation)
- `interaction.deleted` — `{ id }`
- `sign_off.changed`    — `{ userId, file, signedAt | null }`
- `capability.changed`  — `{ key, available, reason? }`

Reconnects use `Last-Event-Id`. Heartbeats every 30s.

### 4.4 Mutation latency model

**Optimistic insert + reconcile on SSE echo.** Client generates a
`clientNonce`, inserts a placeholder, POSTs to the server, and on SSE
echo matches the canonical row by nonce and replaces the placeholder.
On POST failure, the client rolls back and surfaces an error.

---

## 5. Coverage projection

Coverage answers "what fraction of this ChangeSet has been reviewed, by
whom?" — split into AI-coverage and human-coverage.

- **Inputs (server-side):** `read_lines` rows + existing AI Interactions.
- **Computed on read.** No materialised coverage table.
- **Per-line covered:**
  - **AI-covered** iff any AI Interaction anchors that line (primary
    or any `evidence` entry).
  - **Human-covered** iff the line is in the user's `read_lines`.
- **Combined** is the union, surfaced for the "did anyone look at this?"
  view.
- **Rubric pass=false does not exclude** an AI Interaction from
  coverage. Coverage measures attention, not verdict.

**MCP exposure.** `shippable_get_progress(id)` returns coverage so the
agent can know what the human has and hasn't read.

---

## 6. Sign-off

A first-class concept: the human deliberately marks a file "reviewed,
I'm done with this." Distinct from coverage (passive, line-level
attention). Central to the IDEA target: "an agent can ask 'did the
human sign off file X?'."

- **Per-file action.** UI affordance: `Shift+M` (existing keymap) and a
  sidebar button mark a file signed off. Toggle revokes.
- **Server table** (`sign_offs`), scoped by `(userId, changesetId,
  file)`. Atomic write + SSE event.
- **MCP-readable** via `shippable_get_sign_off(id)`.
- **Independent of coverage.** A user can sign off a file without
  reading every line (e.g. trivial rename). Coverage and sign-off are
  two projections, not one.
- **Cascades on ChangeSet refresh.** Sign-off does NOT carry forward to
  the child ChangeSet automatically; the user explicitly re-signs after
  reviewing the changes. The parent ChangeSet's sign-offs remain
  visible in history.

---

## 7. Plan as a document

The AI's plan is a curated document, not a flat list of comments.

```ts
type Plan = {
  changesetId: string;
  headline: string;
  structure: StructureMap;                          // file-tree summary, dependencies, etc.
  entryPoints: Anchor[];                            // ≤3 starting points
  claimIds: string[];                               // ordered references to AI Interactions
  generation: { ingestId: string; sha: string };
  createdAt: string;
};
```

**Why a document and not just AI interactions:**

- `headline` and `structure` are ChangeSet-level signals that don't fit
  on a single anchored claim.
- `entryPoints` are an *ordering* over the diff — "start here, then
  here, then here" — orthogonal to per-claim anchors.
- `claimIds` is a curated subset: not every AI Interaction is part of
  the plan; the plan is a thin organising layer over selected claim-
  Interactions.

**Plan claims have required evidence.** A plan-claim Interaction (id in
`Plan.claimIds`) must have non-empty `evidence: Anchor[]`. The UI
refuses to render a plan claim with no evidence — preserves the
prototype's `docs/architecture.md:41` invariant.

**Plan generation runs alongside AI annotation** in the streaming-review
flow. The plan is produced by the same Anthropic call (or a follow-up
call) that produces the claim Interactions.

**Re-ingest creates a new Plan** tied to the new ChangeSet via the
parent chain. Old plans remain on their original ChangeSet.

---

## 8. Code graph + language services

### 8.1 LSP, server-side

- typescript-language-server, intelephense, etc. as long-lived
  subprocesses.
- **Eager index of diff-modified files** at ChangeSet ingest.
- **Lazy on demand** for files outside the diff; cached per-file by
  content hash.
- **Prefetch on file open.**

### 8.2 Fallback

When LSP is unavailable, regex+heuristics produce best-effort symbols.
Result carries `provenance: "regex"`; UI badges as best-effort.

### 8.3 API

`GET /api/code-graph/{changesetId}/{file}` is synchronous, cached per-
file. Returns `{ symbols, references, provenance: "lsp" | "regex" }`.

---

## 9. In-browser code runner

A renderer for `Interaction.runRecipe`, not a primitive.

- **Inline code only.** `runRecipe = { source, inputs }`. No filesystem
  reach. Works in every provenance + memory-only mode.
- **Client-side sandbox.** Sandboxed iframe (`/runner-sandbox.html`) +
  postMessage for JS/TS. `@php-wasm` for PHP.
- **Capability-gated** via `runner.js` / `runner.php`.

---

## 10. Credential prompt — reactive queue

Single `<CredentialPrompt>` component plus a queue-backed service.

```ts
const token = await credentials.require("github:api.github.com");
```

- Boot, settings, on-401 all funnel through `require()`.
- One queue; the prompt renders the head.
- Trusted-host opt-in is part of the prompt UX; opting in PATCHes the
  server's `trusted_hosts`.

Today's `CredentialsPanel` + `GitHubTokenModal` duplication collapses to
one component.

---

## 11. Themes

Unchanged from the prototype. Four themes (Light, Dark, Dollhouse,
Dollhouse Noir), CSS variables on `:root`, single `ThemePicker`. Only
difference: selected theme id is a row in `prefs` (scoped by userId),
not a localStorage key.

---

## 12. Quiz

Human-side comprehension check ("anti-LGTM"). Distinct from rubric
(quiz tests the human; rubric reports the AI). Both reuse Anchor —
`Question.target: Anchor`.

```ts
type Question = {
  id: string;
  target: Anchor;                                    // block | symbol | file | changeset
  prompt: string;
  acceptableAnswers: string[];
};

type Quiz = {
  id: string;
  changesetId: string;
  questions: Question[];
  createdAt: string;
};
```

- Capability-gated via `quiz.enabled`.
- AI generates the quiz alongside the plan; same generation tag.
- Responses persist in `quiz_responses`. MCP-readable so an agent can
  ask "has the human passed comprehension on this changeset?"

---

## 13. Agent identity

Composite of declared + observed.

```ts
type AgentIdentity = {
  sessionId: string;                                 // server-assigned on first MCP handshake
  declared: {
    handle: string;                                  // 'security-review'
    purpose: string;                                 // 'Audit auth flow'
    model: string;                                   // 'Claude Opus 4.7'
  };
  observed: {
    worktreePath: string;                            // from MCP env / parent proc
    harness: string;                                 // 'Claude Code' (inferred)
    osUser: string;
    host: string;
    firstSeenAt: string;
  };
  lastSeenAt: string;
};
```

**Badge UI** (human-facing): combines fields so mismatches are visible.

```
security-review · Claude Opus 4.7 · via Claude Code · ~/work/feat · since 14:32
```

**Trust boundary (v1 assumption, documented):** self-declared identity
is unauthenticated. Any localhost process can claim a handle.
Acceptable for single-user-local. The moment v1.x goes multi-user,
identity needs real auth.

---

## 14. Client state architecture

**Split:**

- **Server-state query cache** (TanStack Query or equivalent) holds
  Interactions, ChangeSet, plan, sign-offs, prefs, capabilities. SSE
  events update the cache. Mutations call the server; optimistic
  update via cache.
- **UI state store** (Zustand or `useReducer`) holds cursor, modal
  open/closed, picker state, in-progress text, dismissals.

The reducer is small; most state lives in the query cache.

**`APPLY_EXTERNAL_UPDATE` action shape.** Every external change —
initial load, refresh, SSE-pushed update — funnels through one reducer:

```ts
type ApplyExternalUpdate =
  | { kind: "changeset.loaded";  changeset: ChangeSet; interactions: Interaction[]; plan?: Plan }
  | { kind: "interaction.upsert"; interaction: Interaction }
  | { kind: "interaction.delete"; id: string }
  | { kind: "sign_off.changed";   userId: string; file: string; signedAt: string | null }
  | { kind: "capability.changed"; key: CapabilityKey; cap: Capability };

applyExternalUpdate(state, action): state
```

Re-anchoring runs once, in one place, on `changeset.loaded` for the
refresh case.

---

## 15. Invariants

Constraints the prototype validated; refactor agents must not undo
them without escalation.

- **Stack:** React + Vite + TypeScript (web); Node + SQLite (server);
  Tauri (desktop shell). The tech-reset option was declined.
- **TUI door:** the core (`web/src/state.ts`, `parseDiff.ts`,
  `types.ts`, `view.ts`, `anchor.ts`) imports React zero times. An
  ESLint rule + a test guard the property. No formal `core/` package
  until a second consumer exists (rule of two).
- **ServerHealthGate:** server is a hard dependency in every shape.
  Web app probes `/api/health` at boot via `ServerHealthGate` and
  refuses to load without it. No browser-only fallback. Per AGENTS.md.
- **Keyboard-first walk:** `j`/`k` line navigation, `Shift+M` mark
  reviewed, `]`/`[` next/prev file, `n`/`N` next/prev unresolved
  comment, gutter rail. The keymap is product-defining; locked.
- **Capability-gated language features:** "disabled is worse than
  absent." A feature whose backend is down hides itself entirely.
- **Evidence-mandatory at the plan level:** the UI refuses to render
  a plan claim with no evidence (§7).

---

## 16. What we dropped

Recorded so future archaeology doesn't resurrect them:

| Dropped                                  | Replaced by                              |
|------------------------------------------|------------------------------------------|
| `Claim` entity                           | Interaction + anchor + evidence          |
| `Assignment` entity                      | nothing — out of scope                   |
| `Activity` entity                        | derive from interaction stream           |
| `AuthorRole = "agent"`                   | folded into `"ai"`                       |
| `Interaction.target` field               | `anchor.kind` discriminator              |
| `Interaction.parentId` field             | `anchor: { kind: "comment", commentId }` |
| `Interaction.threadKey` field            | `resolveRootAnchor()` walks chains       |
| `Anchor.kind = "hunk"`                   | `block` covering hunk lines              |
| `Anchor.kind = "line"`                   | `block` with `lo === hi`                 |
| `confidence: low\|medium\|high`          | intent-shaped validation rubric          |
| Universal rubric (every AI interaction)  | rubric varies by intent                  |
| `CredentialsPanel` + `GitHubTokenModal`  | one `<CredentialPrompt>` + queue         |
| Scattered `shippable:*` localStorage     | `prefs` SQLite table (server)            |
| `ANTHROPIC_API_KEY` env-var warning      | boot panel only                          |
| Client-side primary persistence          | server SQLite for shared state           |
| `EvidenceRef` standalone type            | `Anchor[]` on Interaction.evidence       |
| `RubricCheck.comment` field name         | `RubricCheck.note`                       |
| Separate ingest reducers per provenance  | one `APPLY_EXTERNAL_UPDATE` reducer      |

---

## 17. Migration plan

**Strategy: strangler-fig refactor in-place on `main`.** Not a clean
rebuild. The prototype's code is the starting point; we evolve it.
Each PR is shippable. Prototype data is dropped at the persistence
cutover.

**Phase order — primitives first, then persistence:**

1. **Anchor union** — introduce `Anchor` discriminated union alongside
   today's flat `anchorPath`/`anchorHash`/etc. fields. Add a
   write-side helper that takes the new union and writes both for one
   release. Add `changeset` kind. Read-side switches to the union.
2. **Interaction shape** — collapse `target`/`parentId`/`threadKey`;
   intent split validated at write time; AuthorRole reduced to
   `human|ai`. Rename `comment` → `note` in RubricCheck. Add
   `generation` tag on AI rows.
3. **Validation rubric** — intent-shaped rubric replaces
   `confidence`. The streaming-review prompt emits the shape; MCP
   handler validates.
4. **APPLY_EXTERNAL_UPDATE reducer** — unify ingest, refresh, and
   SSE-update paths into one action shape. Worktree refresh stops
   having its own code path.
5. **Server-side persistence** — Interactions, ChangeSets,
   read_lines, sign_offs, prefs move from localStorage to SQLite.
   SSE per-ChangeSet wired. Old localStorage cleared on first boot of
   this phase; prototype data dropped.
6. **Sign-off + MCP read tools** — add `sign_offs` table; ship the
   four MCP read tools. Capability `ai.mcp` reflects the expanded
   surface.
7. **Plan as document** — `plans` table; Plan generation alongside AI
   streaming; UI consumes Plan + claim Interactions; evidence-
   required validation at write time.
8. **Agent identity** — `agent_identities` table; composite badge UI;
   declared+observed handshake on first MCP connect.
9. **Capability system refactor** — server detects environment,
   ChangeSet provenance narrows, reactive context, reasons on
   unavailable.
10. **Quiz** — `quizzes`/`quiz_responses` tables; UI; MCP-readable.
11. **TUI invariant guard** — ESLint rule + test ensuring the core
    stays React-free.
12. **Polish** — refresh-link flow, error states, prefs UI,
    `tauri-plugin-dialog` directory picker (AppleScript fallback in
    browser-dev macOS).

Each phase ends with `main` shippable. The order is roughly
dependency-driven: every later phase relies on the primitive shapes
locked in phases 1–4. Phase 5 (persistence) is the riskiest single
migration; everything before it is type-only refactors.

---

## 18. Open questions for later

Deferred past v1:

- **Multi-user identity.** Replace local userId with real auth. The
  prefs/read-lines/coverage/sign-off shapes are already scoped-by-
  userId; migration is mostly auth-side.
- **Workspace-mode runner.** Inline-only today. A worktree-only
  `runner.workspace` capability for real test commands (e.g. `php
  artisan test`) is a v2 candidate.
- **Cross-device cursor / drafts.** Single-tab in v1. Both shapes
  already scoped-by-user when needed.
- **Drafts as Interactions with `status: "draft"`.** Useful when
  agents want "human is typing" awareness. Schema is forward-
  compatible.
- **Per-prompt rubric extensions.** Fixed by intent in v1; extensible
  via prompt frontmatter in v2.
- **Live capability degradation** beyond available/unavailable. First-
  class tri-state for "degraded with regex fallback" can come later;
  reason string carries this informationally in v1.
- **Authenticated agent identity.** Self-declared is unauthenticated
  in v1. When multi-user, identity needs real auth.
