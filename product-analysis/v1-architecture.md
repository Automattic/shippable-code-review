# v1 architecture — Shippable rebuild

The finalized architecture for v1, derived from three grill sessions of
[`suggested-architecture.md`](./suggested-architecture.md):

- **Session 1 (2026-05-25):** entity-by-entity validation of the
  four-primitive proposal.
- **Session 2 (2026-05-26):** reconciliation with the earlier
  [`rebuild-plan.md`](./rebuild-plan.md) handoff — sign-off, agent
  identity, MCP read-peer surface, refactor (not rebuild) shape,
  invariants.
- **Session 3 (2026-05-26):** Plan/Claim split out of Interaction;
  MCP-only AI (no server-side Anthropic calls); first-class job queue
  driven by the existing watch-mode pattern.

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
AI finding (from a review job, §7b), external PR comment, MCP agent
post, reply, ack/reject.

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

  createdAt: string;
  updatedAt: string;
};
```

**Write-time validation rules:**

- `intent ∈ AskIntent`  →  `anchor.kind !== "comment"` (asks root on code/changeset).
- `intent ∈ ResponseIntent`  →  `anchor.kind === "comment"` (responses reply).
- `authorRole === "ai"` AND `intent === "blocker"`  →  full blocker rubric required.
- `authorRole === "ai"` AND `intent === "request"`  →  request rubric required.
- `authorRole === "ai"` AND `intent ∈ {"comment", "question"}`  →  no rubric required.
- `authorRole === "human"`  →  `rubric`, `rationale`, `suggestedFix` absent.
- `pass === false` on any rubric check  →  `note` required.
- Interactions are inserted atomically — no streaming state. An AI
  review job posts each Interaction with a separate MCP write, and SSE
  delivers them one by one as they arrive (§7).

**Key decisions:**

- **No `threadKey` field.** Threading derives from `anchor.kind ===
  "comment"` chains. The prototype's prefixed keys (`note:`, `block:`,
  `user:`, `teammate:`, `hunkSummary:`) were a workaround; the anchor
  is the unified pointer.
- **No `target`, no `parentId`.** Anchor is the sole positioning field.
- **AuthorRole is two-valued.** All AI Interactions arrive via MCP
  write tools posted by an external agent; `external.source`
  discriminates the path when origin matters.
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
  links. Always optional — Plan claims have their own non-empty
  `references` requirement (§7), independent of Interactions.
- **`generation` tag on AI rows.** Tracks which ingest revision the
  Interaction was generated against. On re-ingest, old AI Interactions
  stay on their original ChangeSet; the parent-chain link is the
  navigation path between revisions.
- **No Plan or Claim is an Interaction.** Earlier drafts merged
  Plan claims into Interactions; v1 splits them. Claims are
  Plan-internal value types (§7); Interactions are reviewer events
  on positions.

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
  | "ai.mcp"                                        // any watcher present
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

### 2.2 Review

Produces Interactions. Two sources:

- **Human:** client `POST /api/interactions` with optimistic insert.
- **AI agent (MCP):** an external agent (Claude Code or any MCP-capable
  peer) calls `shippable_post_interaction` for each finding. Atomic
  per-Interaction. The agent is driven either by a queued review job
  (§7) or by a direct user prompt in its own UI.

There is no server-side Anthropic call and no streaming Interaction
state. AI Interactions arrive one at a time via MCP; SSE delivers each
to all connected clients as soon as it lands.

AI Interactions carry `generation: { ingestId, sha }`. Re-ingest of the
same source with a different sha produces a new ChangeSet; prior-
generation AI Interactions stay on the old ChangeSet.

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
│  • prefs                 (k/v per user — incl. auto-queue)  │
│  • trusted_hosts         (server policy table)              │
│  • agent_identities      (declared + observed)              │
│  • plans                 (append-only; latest wins per cs)  │
│  • jobs                  (plan/review queue; watch-claimed) │
│  • quizzes / quiz_responses                                 │
├─────────────────────────────────────────────────────────────┤
│  Keychain (Tauri) / RAM (dev) — secrets only                │
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
  id                TEXT PRIMARY KEY,
  changeset_id      TEXT NOT NULL REFERENCES changesets(id),
  source            TEXT NOT NULL,                   -- 'rule' | 'ai'
  headline          TEXT NOT NULL,
  structure_json    TEXT NOT NULL,                   -- StructureMap
  claims_json       TEXT NOT NULL,                   -- Claim[] (inline; §7)
  entry_points_json TEXT NOT NULL,                   -- EntryPoint[] (≤3; §7)
  generation_json   TEXT NOT NULL,                   -- { ingestId, sha }
  generated_by_json TEXT,                            -- AgentIdentity; null = rule
  created_at        TEXT NOT NULL
);
CREATE INDEX plans_by_changeset ON plans(changeset_id, created_at DESC);

CREATE TABLE jobs (
  id                TEXT PRIMARY KEY,
  changeset_id      TEXT NOT NULL REFERENCES changesets(id),
  type              TEXT NOT NULL,                   -- 'plan' | 'review'
  status            TEXT NOT NULL,                   -- 'pending' | 'in_progress' | 'done' | 'failed'
  requested_at      TEXT NOT NULL,
  requested_by_json TEXT,                            -- AgentIdentity or 'user'
  claimed_at        TEXT,
  claimed_by_json   TEXT,                            -- AgentIdentity once claimed
  completed_at      TEXT,
  payload_json      TEXT,                            -- type-specific params (e.g. review scope)
  result_id         TEXT,                            -- FK to plans.id when type='plan'
  error_msg         TEXT
);
CREATE INDEX jobs_pending ON jobs(status, type, requested_at);
CREATE INDEX jobs_by_changeset ON jobs(changeset_id, status);

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
- **Secrets.** Only GitHub tokens. Keychain in Tauri, server memory in
  dev. Server is the policy boundary; secrets never reach the client.
- **No Anthropic key.** All AI work flows through MCP — an external
  agent holds its own credentials. The prototype's Anthropic SDK
  dependency and the dead `ANTHROPIC_API_KEY` env-var warning at
  `server/src/index.ts:1446-1450` are removed.

---

## 4. Wire protocol

### 4.1 REST surface

- `POST /api/changesets/{provenance}`             → `{ changesetId }`
- `GET  /api/changesets/{id}`                     → `ChangeSet`
- `GET  /api/changesets/{id}/interactions`        → `Interaction[]`
- `GET  /api/changesets/{id}/plan`                → latest visible `Plan` (rule or AI, §7)
- `GET  /api/changesets/{id}/quiz`                → `Quiz`
- `POST /api/changesets/{id}/quiz/responses`      → `QuizResponse`
- `POST /api/interactions`                        → `Interaction` (human path)
- `PATCH /api/interactions/{id}`                  → `Interaction`
- `POST /api/read-lines`                          → `{ ok: true }` (batched ranges)
- `POST /api/sign-offs`                           → `{ ok: true }`
- `DELETE /api/sign-offs`                         → `{ ok: true }` (revoke)
- `GET  /api/code-graph/{csid}/{file}`            → `{ symbols, references, provenance }`
- `GET  /api/prefs`                               → `Record<key, value>`
- `PATCH /api/prefs`                              → `{ ok: true }`
- `POST /api/credentials/github`                  → `{ ok: true }` (only kind in v1)
- `POST /api/changesets/{id}/jobs`                → `Job` (user-initiated request; §7)
- `GET  /api/jobs?changesetId=...&status=...`     → `Job[]`
- `GET  /api/watchers/active`                     → `Watcher[]` (presence indicator; §7)

### 4.2 MCP tool surface

Agent peers connect via stdio MCP subprocess (`mcp-server/src/index.ts`)
talking to the Node server on `127.0.0.1:{port}/api/agent/*`. MCP is
the **sole** AI integration path — the server holds no Anthropic key
and makes no LLM calls itself.

**Write tools:**

- `shippable_announce(identity)` — register the agent's declared
  identity at session start. Returns `sessionId`.
- `shippable_post_interaction({changesetId, anchor, intent, body,
  rubric?, rationale?, suggestedFix?, evidence?, parentInteractionId?})`
  — one Interaction per call. Atomic. Used for both review-job output
  and reply-to-reviewer flows.
- `shippable_post_plan({changesetId, headline, structure, claims[],
  entryPoints[], generation, generatedBy})` — atomic Plan insert.
  Appends a new row; latest wins (§7).

**Wait tool (long-poll, watch mode):**

- `shippable_wait_for_work({timeout, types: ['interactions','plan','review']})`
  — blocks until work is available or the timeout fires. Returns one
  of:
  - `{type: 'interactions', interactions: [...]}` — unread reviewer
    Interactions for the agent to address.
  - `{type: 'plan', job: Job}` — pending plan job, claimed by this
    caller atomically.
  - `{type: 'review', job: Job}` — pending review job, claimed.
  Single-consumer claim semantics: the first watcher to receive a job
  owns it. Long-poll calls implicitly stamp presence (the
  `watchPolls`/`WATCH_TTL_MS` pattern at `server/src/agent-queue.ts:421`).

**Read tools:**

- `shippable_get_changeset(id)`       → `ChangeSet` + file content
- `shippable_get_plan(id)`            → latest visible `Plan` (full document; §7)
- `shippable_get_progress(id)`        → coverage + sign-off projections
- `shippable_get_sign_off(id)`        → per-file sign-off table
- `shippable_get_settings()`          → auto-queue prefs the agent should respect

All tools include the requesting agent's identity in their request
context; the server records reads/writes against the agent's
`session_id` in `agent_identities`. The legacy
`shippable_check_review_comments` and `shippable_watch_review_comments`
collapse into `shippable_wait_for_work` with `types: ['interactions']`.

### 4.3 SSE per-ChangeSet

`GET /api/changesets/{id}/stream` opens an EventSource. Server pushes:

- `interaction.created` — full Interaction
- `interaction.updated` — full Interaction (human body edits via
  `PATCH /api/interactions/{id}`; no token streaming)
- `interaction.deleted` — `{ id }`
- `plan.created`        — full Plan (latest visible row; clients
  always re-fetch / replace)
- `job.created`         — full Job
- `job.updated`         — full Job (status transitions)
- `sign_off.changed`    — `{ userId, file, signedAt | null }`
- `capability.changed`  — `{ key, available, reason? }`

Reconnects use `Last-Event-Id`. Heartbeats every 30s. Snapshot-per-event
for Plans means each event carries the full document; no incremental
token deltas.

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
- **Plans do not contribute to coverage.** Coverage is "where did
  evidence-bearing commentary land", line-level. Plan claims are
  ChangeSet-level assertions about scope/structure; including them
  would inflate coverage misleadingly ("the AI covered 100% because
  one claim references the whole changeset"). Plans and coverage are
  orthogonal projections.

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
- **Orthogonal to Plan.** Signing off a file does not acknowledge or
  silence Plan claims that reference it, and Plan generation does not
  affect sign-off state. Sign-off is about *the diff*; Plan is the AI's
  commentary on the diff.

---

## 7. Plan as a document

The AI's plan is a curated document, not a flat list of Interactions.
Plan, Claim, and EntryPoint are **value types** specific to the Plan
document — distinct from Interaction (§1.2), which is the unified
event signal.

```ts
type Claim = {
  text: string;
  references: Anchor[];                             // non-empty; UI refuses to render if empty
};

type EntryPoint = {
  target: Anchor;                                   // explicit navigation target
  rationale: string;                                // short text justifying this start
  references: Anchor[];                             // backing for the rationale
};

type Plan = {
  id: string;
  changesetId: string;
  source: "rule" | "ai";
  headline: string;
  structure: StructureMap;
  claims: Claim[];                                  // ordered intent claims (array order = ordinal)
  entryPoints: EntryPoint[];                        // ≤3
  generation: { ingestId: string; sha: string };
  generatedBy?: AgentIdentity;                      // null when source='rule'
  createdAt: string;
};
```

**Why a document and not Interactions:**

- `headline` and `structure` are ChangeSet-level signals that don't
  fit a single anchored position.
- `entryPoints` are an *ordering* — "start here, then here, then
  here" — orthogonal to per-finding anchors.
- Claims are AI-only ChangeSet-level assertions; they have no intent
  (blocker/request/note), no rubric, no status, no threading. Forcing
  them into the Interaction shape required seven carve-outs.

**Plan/Claim are split from Interaction.** Earlier drafts merged them;
v1 reverses that. Humans do not author or reply to Claims — Claims
are presented, not interacted with. Disagreement lives as a normal
Interaction anchored to code, not as commentary on a Claim.

**Claim.references is non-empty.** UI refuses to render a Claim with
no references; server validates at write time. Preserves the
prototype's `docs/architecture.md:41` evidence-mandatory invariant.

**Append-only, latest wins.** Each generation (rule on ingest, AI on
job completion, any future regenerate) inserts a new row in `plans`.
No row is ever updated or deleted. Reader picks the latest visible:

```sql
SELECT * FROM plans
WHERE changeset_id = ?
ORDER BY created_at DESC LIMIT 1;
```

**Lifecycle:**

1. **Ingest writes the rule plan** synchronously (`source='rule'`,
   `generatedBy=null`). It is the floor; always available.
2. **Auto-queue AI plan** if a watcher is present and the user's
   `autoQueuePlan` setting is on (default on). A `jobs` row is
   inserted with `type='plan'`; a watching agent claims it via
   `shippable_wait_for_work`. On success the agent calls
   `shippable_post_plan` (atomic), which inserts a new `plans` row
   with `source='ai'` and updates the job to `done` with
   `result_id = plans.id`.
3. **Failure (`status='failed'` on the job)** leaves the previous
   visible plan in place (rule, or a prior successful AI plan). The
   UI shows the previous plan with an inline "AI plan generation
   failed — retry?" affordance above it.
4. **Regenerate** is agent-initiated. The user goes back to their
   agent ("review this again"); the agent reposts via
   `shippable_post_plan`. A new row appears; latest wins. The
   Shippable UI offers a "regenerate" button that creates a `jobs`
   row of `type='plan'` for a watching agent to claim — same path
   as auto-queue, just user-triggered.

**No streaming.** MCP is request/response; the agent buffers its full
plan and posts atomically. SSE emits a single `plan.created` event
when the row lands.

**Re-ingest creates a new ChangeSet** with `parentChangesetId` set.
The new ChangeSet runs ingest from scratch — including its own rule
plan and (if a watcher is present) its own AI plan job. Old plans
remain on their original ChangeSet; they don't carry forward.

---

## 7b. Jobs and watch mode

The job queue is how Shippable asks external agents to do work.
Plans and AI reviews are the two job types in v1.

```ts
type JobType   = "plan" | "review";
type JobStatus = "pending" | "in_progress" | "done" | "failed";

type Job = {
  id: string;
  changesetId: string;
  type: JobType;
  status: JobStatus;
  requestedAt: string;
  requestedBy: AgentIdentity | "user";
  claimedAt?: string;
  claimedBy?: AgentIdentity;
  completedAt?: string;
  payload?: unknown;                                // type-specific
  resultId?: string;                                // FK to plans.id when type='plan'
  errorMsg?: string;
};
```

**Producers:**

- **Auto-queue.** On ingest, the server inserts a `plan` job if a
  watcher is present and `prefs[user:autoQueuePlan] = 'on'` (default
  on). After a plan completes, the UI prompts the user "want an AI
  review too?"; on yes, a `review` job is inserted.
  `prefs[user:autoQueueReview]` defaults to `'off'`.
- **User-initiated.** "Regenerate plan" and "Run AI review now"
  buttons in the UI insert `jobs` rows directly via
  `POST /api/changesets/{id}/jobs`.

**Consumers — watch mode.** Agents in watch mode call
`shippable_wait_for_work` in a loop. When a job is pending, the
server atomically transitions the row to `in_progress` and assigns
`claimedBy = caller.identity`, returning the job to that caller only.
Single-consumer claim — the first watcher wins. Multiple watchers =
redundancy, not parallelism.

**Presence.** Long-poll calls to `shippable_wait_for_work` stamp a
last-seen timestamp per agent (the existing `watchPolls` map at
`server/src/agent-queue.ts:421`, extended to carry identity from
`shippable_announce`). Watchers older than `WATCH_TTL_MS` are
considered offline. The UI subscribes to `/api/watchers/active` for
the "Agent is watching" indicator (already wired in
`AgentContextSection.tsx:140`).

**No watcher = setup banner.** If no watcher is present, the UI
shows the rule plan with a visible "Connect an agent for AI plans
and reviews" banner — a discovery affordance, not an error state.
The capability `ai.mcp` is `false`; AI features hide themselves
cleanly.

**Stuck row recovery.** On boot, the server sweeps
`jobs WHERE status='in_progress'` and marks them `'failed'` with
`errorMsg='server restarted while job was in flight'`. Local
dev/desktop restarts often; this gives clean recovery without
periodic janitor logic.

**Review jobs produce Interactions.** A watcher that claims a `review`
job calls `shippable_post_interaction` once per finding (the agent
streams its model output internally but the wire to Shippable is
one Interaction per call). The UI sees Interactions arrive
incrementally via SSE — the "AI is reviewing, you can see comments
as they appear" UX. When the agent is done, it transitions the job
to `done`.

**Plan jobs produce a Plan.** A watcher posts a single `Plan` via
`shippable_post_plan`; the server inserts the row and marks the job
`done` with `resultId` pointing at it.

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
GitHub-only in v1 (Anthropic is gone per §3.2 / §4.2):

```ts
const token = await credentials.require("github:api.github.com");
```

- Boot, settings, on-401 all funnel through `require()`.
- One queue; the prompt renders the head.
- Trusted-host opt-in is part of the prompt UX; opting in PATCHes the
  server's `trusted_hosts`.

Today's `CredentialsPanel` + `GitHubTokenModal` duplication collapses to
one component. The Anthropic key panel is removed; if MCP is not
connected the UI shows the "no watcher" banner from §7, not a key prompt.

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

**Where identity surfaces:**

- `agent_identities.session_id` keyed on `shippable_announce` at session
  start.
- `plans.generated_by_json` — which agent produced a Plan (null for
  rule-based).
- `jobs.requested_by_json` — agent or `'user'` that initiated the job.
- `jobs.claimed_by_json` — watcher that claimed the job.
- `interactions.author` (free-text display name) plus
  `external.source = 'mcp'` plus the read-side join against
  `agent_identities` if an Interaction's author maps to a known
  session.

The badge UI reads these to disambiguate "Claude Code's plan vs
custom-review's plan" when multiple agents have touched a ChangeSet.

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
  | { kind: "changeset.loaded";   changeset: ChangeSet; interactions: Interaction[]; plan?: Plan; jobs?: Job[] }
  | { kind: "interaction.upsert"; interaction: Interaction }
  | { kind: "interaction.delete"; id: string }
  | { kind: "plan.created";       plan: Plan }
  | { kind: "job.upsert";         job: Job }
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
- **References-mandatory on Claims:** `Claim.references` is non-empty;
  UI refuses to render a Claim with none (§7). Server validates at
  write time.
- **No server-side AI calls:** the server holds no Anthropic key and
  imports no LLM SDK. AI work happens exclusively through MCP
  agents (§4.2). Reintroducing a server-side LLM path requires
  explicit re-architecture, not a quick fix.
- **Plan is immutable per row:** rows in `plans` are append-only.
  Each generation produces a new row; latest visible wins. No row is
  ever updated or deleted.

---

## 16. What we dropped

Recorded so future archaeology doesn't resurrect them:

| Dropped                                  | Replaced by                              |
|------------------------------------------|------------------------------------------|
| Merging Claim into Interaction           | Claim + EntryPoint as Plan-internal types (§7) |
| `Plan.claimIds` (FK to Interactions)     | `Plan.claims: Claim[]` inline            |
| Single-row `plans` (PK on changeset_id)  | append-only `plans`; latest wins         |
| Server-side Anthropic streaming          | MCP-only AI; agents post atomically      |
| Server-side Anthropic key path           | gone entirely; only GitHub credentials   |
| `Interaction.status = streaming\|error`  | atomic insert; no streaming state        |
| Token-delta SSE events                   | snapshot-per-event; one event per Plan   |
| `shippable_check_review_comments`        | `shippable_wait_for_work({types:[…]})`   |
| `shippable_watch_review_comments`        | `shippable_wait_for_work({types:[…]})`   |
| Old `EvidenceRef` union                  | `Anchor[]` (Claim.references)            |
| `evidence` field naming on Claims        | `references` (Interaction keeps `evidence`) |
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
| `CredentialsPanel` + `GitHubTokenModal`  | one `<CredentialPrompt>` + queue (GitHub-only) |
| Anthropic credential panel               | "no watcher" banner (§7b)                |
| Scattered `shippable:*` localStorage     | `prefs` SQLite table (server)            |
| `ANTHROPIC_API_KEY` env-var warning      | server has no Anthropic SDK              |
| Client-side primary persistence          | server SQLite for shared state           |
| `RubricCheck.comment` field name         | `RubricCheck.note`                       |
| Separate ingest reducers per provenance  | one `APPLY_EXTERNAL_UPDATE` reducer      |

---

## 17. Migration plan

**Strategy: strangler-fig refactor in-place on `main`.** Not a clean
rebuild. The prototype's code is the starting point; we evolve it.
Each PR is shippable. Prototype data is dropped at the persistence
cutover.

**Phase order — primitives first, then persistence, then MCP-only AI:**

1. **Anchor union** — introduce `Anchor` discriminated union alongside
   today's flat `anchorPath`/`anchorHash`/etc. fields. Add a
   write-side helper that takes the new union and writes both for one
   release. Add `changeset` kind. Read-side switches to the union.
2. **Interaction shape** — collapse `target`/`parentId`/`threadKey`;
   intent split validated at write time; AuthorRole reduced to
   `human|ai`. Rename `comment` → `note` in RubricCheck. Add
   `generation` tag on AI rows. Drop `status` field.
3. **Validation rubric** — intent-shaped rubric replaces
   `confidence`. MCP handler validates.
4. **APPLY_EXTERNAL_UPDATE reducer** — unify ingest, refresh, and
   SSE-update paths into one action shape. Worktree refresh stops
   having its own code path.
5. **Server-side persistence** — Interactions, ChangeSets,
   read_lines, sign_offs, prefs move from localStorage to SQLite.
   SSE per-ChangeSet wired. Old localStorage cleared on first boot of
   this phase; prototype data dropped.
6. **Sign-off + MCP read tools** — add `sign_offs` table; ship the
   read tools (`get_changeset`, `get_plan`, `get_progress`,
   `get_sign_off`, `get_settings`). Capability `ai.mcp` reflects the
   expanded surface.
7. **Jobs + watch generalisation** — `jobs` table; generalise the
   existing `shippable_watch_review_comments` long-poll into
   `shippable_wait_for_work` returning `interactions | plan | review`.
   Add `shippable_announce` for declared identity. Boot-time sweep
   for stuck `in_progress` rows. UI surfaces the
   `/api/watchers/active` presence indicator.
8. **Plan as document + Anthropic kill** — add `plans` table (multi-row
   append-only); land `shippable_post_plan` MCP write tool; rule-based
   plan generated synchronously at ingest; AI plans land via the
   job queue. Delete the server's Anthropic SDK dependency, the
   credentials path for `anthropic`, the `CredentialsPanel` Anthropic
   slot, and the streaming-review code path. Capability flag
   `ai.streaming` removed; `ai.mcp` is the only AI capability.
9. **AI review job + auto-queue prefs** — add the `review` job type;
   server inserts a `plan` job on ingest if a watcher is present and
   `autoQueuePlan` is on; after a plan completes, prompt the user for
   an AI review (the `autoQueueReview` pref governs whether the
   prompt is shown). Watching agents claim and execute review jobs by
   calling `shippable_post_interaction` repeatedly.
10. **Agent identity** — `agent_identities` table; composite badge UI;
    declared+observed handshake on `shippable_announce`; `generatedBy`
    on Plans, `requestedBy`/`claimedBy` on Jobs.
11. **Capability system refactor** — server detects environment,
    ChangeSet provenance narrows, reactive context, reasons on
    unavailable.
12. **Quiz** — `quizzes`/`quiz_responses` tables; UI; MCP-readable.
13. **TUI invariant guard** — ESLint rule + test ensuring the core
    stays React-free.
14. **Polish** — refresh-link flow, error states, prefs UI,
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
