# v1 architecture — Shippable rebuild

The finalized architecture for v1, derived from four grill sessions of [`suggested-architecture.md`](./suggested-architecture.md) and the earlier [`rebuild-plan.md`](./rebuild-plan.md) handoff:

Supersedes `suggested-architecture.md` and `rebuild-plan.md` (both preserved as working notes).

---

## 1. The four primitives

The whole product is expressed in four types. Everything else is derived.

### 1.1 Anchor

A position. Used by every feature that asks "where in the code?".

```ts
type Anchor =
  | { type: "block";       file: string; lo: number; hi: number; origin: BlockOrigin }
  | { type: "symbol";      file: string; symbol: string }
  | { type: "file";        file: string }
  | { type: "changeset" }                           // zero-data: applies to the whole ChangeSet
  | { type: "interaction"; interactionId: string }; // anchors to another Interaction (reply chain)

type BlockOrigin =
  | { type: "committed"; sha: string }                  // git re-derives the window from sha on demand
  | { type: "dirty";     hash: string; context: blob }; // non-git hash, file snapshot in OUR store (stored when there are interactions, but in a central store: once per hash-file, not per interaction)
```

**Key decisions:**

- **No `hunk` type.** Hunks are an artifact of how diffs are parsed; once parsed, ranges are sufficient.
- **No `line` vs `block` distinction.** A single-line position is `block` with `lo === hi`.
- **`changeset` type for ChangeSet-level claims** (e.g. "this changeset is mostly cosmetic"; quiz changeset-level questions). Zero-data; carries no file/range.
- **`file: string` is the path within the ChangeSet** (matches `diff_files.path`). The prototype's synthetic `fileId` collapses to `path` in v1 — file rows are uniquely keyed by `(changeset_id, path)` in storage and by `path` within a single ChangeSet's namespace. `UIState.fileDisplayMode` keys by the same `path` string.
- **`interaction` anchors are how threading works.** A reply is an Interaction anchored to its parent. Reply-of-reply allowed. Cycles prevented by acyclic insert.
- **`symbol` resolves lazily.** Anchor stores symbol name + file; the renderer asks the code-graph to resolve symbol → line. Survives line drift; falls back to text-search when LSP unavailable.
- **`BlockOrigin` is a discriminated union, not a flat `originType` flag.** Committed code is content-addressed by SHA — git already stores the window, so we store only the address and call `git show <sha>:<path>` when we need it. Dirty (uncommitted) code has no SHA; we store a hash for the file, plus the file itself at write time, because that's the only moment the content exists. We never `git hash-object -w` — we don't write blobs into the user's `.git`. The principle is *steal content-addressing, not the object store.*
- **Re-anchoring is off the hot path.** Fires on reload (diff content changed), never on keystrokes. The committed `git show` is per-file, batched at ingest, cacheable by `(sha, path)` if it ever shows up hot.
- **Recoverable only while reachable.** A committed `BlockOrigin` loses its window if the commit gets garbage-collected (rebase/amend + prune). Anchors detach with a "lost commit" caption; accepted as audit-trail decay rather than data loss for live review.

**Reply chain resolution.** `resolveRootAnchor(anchor)` walks the `interaction`-anchor chain until it hits a code-or-changeset anchor. Terminates because interactions must root on non-`interaction` anchors (write-time rule).

### 1.2 Interaction

The unified signal. One shape for every reviewer event — human comment, AI finding (from a review job, §7b), MCP agent post, reply, ack/reject. (External PR comments are deferred to v1.5+; see §1.3 and §18.)

```ts
type AskIntent      = "comment" | "question" | "blocker";
type ResponseIntent = "accept" | "reject";
type Intent         = AskIntent | ResponseIntent;

type CheckKey =
  | "reproduced"
  | "tests-run"
  | "tests-pass"
  | "traced-the-code"
  | "confirmed-by-second-agent";

type CheckResult = { result: "yes" | "no"; note: string };   // note required on every check
type Checks      = Record<CheckKey, CheckResult>;          // completeness enforced by the type

type Interaction = {
  id: string;
  changesetId: string;
  anchor: Anchor;
  authorId: string;       // → authors.id (§3.1, §13)
  intent: Intent;
  body: string;           // markdown
  createdAt: string;
  updatedAt: string;
};

type AgentInteraction = Interaction & {
  checks?: Checks;
  rationale?: string;
  suggestedFix?: string;
}
```

**Write-time validation rules:**

- `intent ∈ AskIntent`  →  `anchor.type !== "interaction"` (asks root on code/changeset).
- `intent ∈ ResponseIntent`  →  `anchor.type === "interaction"` (responses reply).
- `anchor.type === "interaction"`  →  the referenced `interactionId` must exist at insert time (parent-must-exist; rejects orphan replies).
- author's role is `"agent"` → full rubric required, regardless of intent (every `CheckKey` answered, each with `result` and a non-empty `note`).
- author's role is `"human"`  →  `rubric`, `rationale`, `suggestedFix` absent. Humans can use any of the four `AskIntent`s (comment, question, blocker); the intent vocabulary describes the *kind of ask*, not the kind of author.
- `Interaction.anchor`, `intent`, `authorId`, and all AI-only fields are **immutable post-insert.** `PATCH /api/interactions/{id}` can modify only `body` and `updatedAt`, and only for human-authored rows. AI Interactions cannot be patched at all — the agent replies to revise its position, doesn't edit history.
- Anchor immutability + parent-must-exist means comment-chain cycles are impossible by construction.
- Interactions are inserted atomically — no streaming state. An AI review job posts each Interaction with a separate MCP write, and SSE delivers them one by one as they arrive (§7b).

**Key decisions:**

- **No `threadKey` field.** Threading derives from `anchor.type === "interaction"` chains. The prototype's prefixed keys (`note:`, `block:`, `user:`, `teammate:`, `hunkSummary:`) were a workaround; the anchor is the unified pointer.
- **No `target`, no `parentId`.** Anchor is the sole positioning field.
- **AuthorId references `authors`, not a free-text display name.** Identity lives in one table (§13). Read-side denormalizes — every Interaction surfaced over the wire (REST, SSE, MCP queue payload) carries its `author: {id, role, displayName, declared?}` expanded inline so callers don't need a second lookup.
- **Rubric is a flat 5-label closed set, complete every time, required on every AI Interaction regardless of intent.** The type is `Record<CheckLabel, CheckResult>` so a partial rubric is unrepresentable by construction. The agent must face every label — including the uncomfortable ones (`second-agent-confirmed`) — on every Interaction it posts (comment, question, request, blocker, or any reply). Not-done is encoded as `result: "no"` with a note explaining why; there is no `na`.
- **`note` is required on every check, including `yes` ones.** "Tests run: yes" without context is empty; "Tests run: yes, `npm test -- auth/token.test.ts`" is evidence. Yes-with-no-note is rejected server-side.
- **Self-attested in v1.** No runner verifies the rubric in v1; the win is a comparable, requirable, filterable vocabulary — what the agent reports it did. Verification waits for the (deferred) code-runner.
- **AI fills its own rubric; humans don't touch it.** Disagreement expressed via `accept`/`reject` reply, not by editing the AI's self-report.
- **`rationale` and `suggestedFix` stay structured.** Renderable as distinct UI elements (e.g. "apply this patch" button).
- **Revision tag = `changesetId`.** AI Interactions are tied to a specific ChangeSet by their FK column; there is no separate `generation` field. On re-ingest, old AI Interactions stay on their original ChangeSet and surface as "from prior revision" via the parent chain in `changesets`.
- **No Plan or Claim is an Interaction.** Plan claims are Plan-internal value types (§7); Interactions are reviewer events on positions.

### 1.3 ChangeSet

The unit of review. A snapshot of a diff plus the source it came from.

```ts
type ChangeSet = {
  id: string;
  parentChangesetId?: string;  // set on refresh; links to prior snapshot
  source: ChangeSetSource;
  files: DiffFile[];
  ingestedAt: string;
};

type ChangeSetSource = // current only worktree. other types need to be thought-through later
  | { kind: "worktree"; workdir: string; branch: string; identifier: string; dirty: boolean }; // identifier is the commit sha, of computed identifier in case of uncomitted changes
//  | { kind: "pr";       owner: string; repo: string; number: number; sha: string; title: string; body: string; author: string }
//  | { kind: "paste";    raw: string; pastedAt: string }
//  | { kind: "file";     filename: string; size: number }
//  | { kind: "url";      url: string; sha?: string };
```

**ChangeSet id derivation:**

| Provenance | id format                                     |
|------------|-----------------------------------------------|
| worktree   | `worktree:{workdir}@{indentifier}`            |
<!-- to be defined later
| pr         | `pr:{owner}/{repo}/{number}@{sha}`            |
| url        | `url:{url}@{sha}` (or content-hash if no sha) |
| paste      | `paste:{contentHash}`                         |
| file       | `file:{filename}:{contentHash}`               |
-->

**Key decisions:**

- **Immutable.** Reload creates a new ChangeSet with `parentChangesetId`, if there are changes. Re-anchoring migrates interactions forward. Audit trail preserved.
- **No `external` field in v1.** PR ingest in v1.5+ reintroduces an `external` discriminated variant on Interaction (provenance for mirrored PR comments + an `htmlUrl` back to the original). The field is omitted from v1 entirely rather than carried as dead surface; see §18.
- **Union keeps only worktree variant in v1.**

### 1.4 Capability

The flag system that decides what UI mounts.

```ts
type CapabilityKey =
  | "lsp.typescript" | "lsp.php" | "lsp.python"
  | "runner.js" | "runner.php"
  | "ai.mcp"                                       // any watcher present
  | "picker.directory"                             // tauri-plugin-dialog or AppleScript

type Capability =
  | { available: true }
  | { available: false; reason: string };

type Capabilities = Record<CapabilityKey, Capability>;
```

**Key decisions:**

- **Capabilities inform which system capabilities are available.** They are not general feature flags.
- **Server ∩ ChangeSet.** Server reports its base set ("typescript-language-server installed"); ChangeSet provenance narrows it ("paste, no worktree disk"). Effective capability = intersection.
- **Reactive.** Capabilities live in a context. Flag flip-off unmounts consumer components; open dialogs auto-close.
- **Reasons on unavailable caps.** UI renders "feature off because X" tooltips.

---

## 2. Three layers

Doc-level organisation. Not a code partition.

### 2.1 Ingest

Turns an external source into a ChangeSet. Server-side, end to end.

- **Worktree is the only ingest endpoint that ships in v1.** Client posts a workdir; server reads git state, builds a ChangeSet, returns the id. PR/paste/file/url remain in the `Provenance` union at the type level but their endpoints don't land — first follow-up is PR ingest in v1.5. v1's MCP integration assumes the agent has filesystem access to the worktree; reintroducing non-disk provenances will need a separate channel for shipping diff content to the agent, designed when that work lands.
- **Live reload watches the worktree.** A file-system watcher (the prototype's `useWorktreeLiveReload` + server-side fs notifier) detects changes under the workdir and surfaces a "refresh available" affordance (`LiveReloadBar`). Refresh produces a new ChangeSet with `parentChangesetId` set; the existing changeset's interactions migrate forward through re-anchoring (§1.1). Live reload is worktree-specific; PR/paste/file/url provenances have no equivalent.
- **Single reducer path for external updates** (the `APPLY_EXTERNAL_UPDATE` shape). Initial load, refresh, SSE-pushed changes from other actors — all hit the same `applyExternalUpdate(state, changeset)` reducer. Re-anchoring runs once, in one place.

### 2.2 Review

Produces Interactions. Two sources:

- **Human:** client `POST /api/interactions` with optimistic insert.
- **AI agent (MCP):** an external agent (Claude Code or any MCP-capable peer) calls `shippable_post_interaction` for each finding. Atomic per-Interaction. The agent is driven either by a queued review job (§7b) or by a direct user prompt in its own UI.

There is no server-side Anthropic call and no streaming Interaction state. AI Interactions arrive one at a time via MCP; SSE delivers each to all connected clients as soon as it lands.

AI Interactions are tied to a specific ChangeSet by their `changesetId` FK column. Re-ingest of the same source with a different sha produces a new ChangeSet; prior-revision AI Interactions stay on the old ChangeSet, and the "from prior revision" UI walks the parent chain in `changesets`.

### 2.3 Walk

The review state machine: cursor, read-line tracking, projections.

- **Cursor is client-only.** Lives in the React state tree (and localStorage for resume-on-reload within a tab). Never written to the server. Per-tab independence is a feature, not a bug — single-user-local in v1.
- **Read-lines batch+debounce on the client; POST every 1–2s.** Server stores compact merged ranges keyed by `(userId, changesetId, file)`.
- **Read-lines do not carry forward across ChangeSet refresh.** They're scoped by `changesetId`; the child ChangeSet starts empty. Per-range re-anchoring would need the same anchor-hash machinery Interactions use (§1.1), which is overkill for what is effectively passive attention-tracking. Re-reading after a revision is part of reviewing the new revision — consistent with sign-off's "explicit re-sign" rule (§6).
- **Sign-off writes immediate, per-gesture.** Two tiers — file-level and changeset-level (§6).
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
│  • reviewed_changesets   (changeset-level human sign-off)   │
│  • prefs                 (k/v per user — incl. auto-queue, recents) │
│  • trusted_hosts         (server policy table)              │
│  • authors               (unified identity — humans + AI)   │
│  • plans                 (append-only; latest wins per cs)  │
│  • agent_queue           (plan/review/interaction; channel- │
│                           scoped; watch-claimed; §7b)       │
│  • user_prompts          (per-user prompt overrides; §9b)   │
│  • quizzes / quiz_responses                                 │
├─────────────────────────────────────────────────────────────┤
│  Keychain (Tauri) / RAM (dev) — secrets only                │
│  • github tokens (per host)                                 │
├─────────────────────────────────────────────────────────────┤
│  Client — in-app memory + localStorage (UI state only)      │
│  • cursor per changeset      (per tab; not server-persisted)│
│  • fileDisplayMode           (Record<path, "diff"|"source"  │
│                                |"preview">; type-enforced)  │
│  • locally-generated userId                                 │
│  • dismissals (e.g. hint tooltips)                          │
│  • drafts in progress (lost on reload)                      │
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

CREATE TABLE authors (
  id             TEXT PRIMARY KEY,                   -- authorId — client-minted UUID (humans) or MCP-subprocess-minted UUID (AI)
  role           TEXT NOT NULL,                      -- 'human' | 'ai'
  display_name   TEXT NOT NULL,
  declared_json  TEXT,                               -- AI only: { handle, purpose, model }
  observed_json  TEXT,                               -- AI only: { worktreePath, harness, osUser, host, firstSeenAt }
  last_seen_at   TEXT NOT NULL
);

CREATE TABLE interactions (
  id              TEXT PRIMARY KEY,
  changeset_id    TEXT NOT NULL REFERENCES changesets(id),
  anchor_json     TEXT NOT NULL,                     -- Anchor discriminated union
  references_json TEXT,                              -- Anchor[] or NULL (supplementary positions)
  author_id       TEXT NOT NULL REFERENCES authors(id),
  intent          TEXT NOT NULL,
  body            TEXT NOT NULL,
  rubric_json     TEXT,                              -- Record<CheckLabel, CheckResult> or NULL
  rationale       TEXT,
  suggested_fix   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_interactions_cs ON interactions(changeset_id);

CREATE TABLE read_lines (
  user_id      TEXT NOT NULL REFERENCES authors(id),
  changeset_id TEXT NOT NULL REFERENCES changesets(id),
  file         TEXT NOT NULL,
  ranges_json  TEXT NOT NULL,                        -- compact [lo,hi][]
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, changeset_id, file)
);

CREATE TABLE sign_offs (
  user_id      TEXT NOT NULL REFERENCES authors(id),
  changeset_id TEXT NOT NULL REFERENCES changesets(id),
  file         TEXT NOT NULL,
  signed_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, changeset_id, file)
);

CREATE TABLE reviewed_changesets (
  user_id      TEXT NOT NULL REFERENCES authors(id),
  changeset_id TEXT NOT NULL REFERENCES changesets(id),
  signed_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, changeset_id)
);

CREATE TABLE prefs (
  user_id    TEXT NOT NULL REFERENCES authors(id),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE trusted_hosts (
  host       TEXT PRIMARY KEY,
  trusted_at TEXT NOT NULL
);

CREATE TABLE plans (
  id                TEXT PRIMARY KEY,
  changeset_id      TEXT NOT NULL REFERENCES changesets(id),
  source            TEXT NOT NULL,                   -- 'rule' | 'ai'
  headline          TEXT NOT NULL,
  structure_json    TEXT NOT NULL,                   -- StructureMap (§7)
  claims_json       TEXT NOT NULL,                   -- Claim[] (inline; §7)
  entry_points_json TEXT NOT NULL,                   -- EntryPoint[] (≤3; §7)
  generated_by      TEXT REFERENCES authors(id),     -- AI author; null = rule
  created_at        TEXT NOT NULL
);
CREATE INDEX plans_by_changeset ON plans(changeset_id, created_at DESC);

CREATE TABLE agent_queue (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,                     -- 'plan' | 'review' | 'interaction' | 'prompt'
  channel_path    TEXT NOT NULL,                     -- worktree path (v1); broader in v1.5 (PR/url/etc.)
  changeset_id    TEXT NOT NULL REFERENCES changesets(id),
  status          TEXT NOT NULL,                     -- 'pending' | 'in_progress' | 'done' | 'failed'
  requested_at    TEXT NOT NULL,
  requested_by    TEXT NOT NULL REFERENCES authors(id),  -- always set to the requester's author_id (human for user-initiated/auto-queue-from-human-action; AI for future agent-to-agent enqueue)
  claimed_at      TEXT,
  claimed_by      TEXT REFERENCES authors(id),       -- AI author once claimed
  completed_at    TEXT,
  payload_json    TEXT,                              -- type-specific: {interactionId} for type='interaction'; params for plan/review
  result_id       TEXT,                              -- FK to plans.id when type='plan'
  error_msg       TEXT
);
CREATE INDEX agent_queue_pending  ON agent_queue(channel_path, status, type, requested_at);
CREATE INDEX agent_queue_by_cs    ON agent_queue(changeset_id, status);

CREATE TABLE user_prompts (
  user_id      TEXT NOT NULL REFERENCES authors(id),
  id           TEXT NOT NULL,                        -- prompt id (matches library id when overriding)
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  args_json    TEXT NOT NULL,                        -- PromptArg[]
  body         TEXT NOT NULL,                        -- markdown
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE quizzes (
  id             TEXT PRIMARY KEY,
  changeset_id   TEXT NOT NULL REFERENCES changesets(id),
  questions_json TEXT NOT NULL,                      -- Question[] with Anchor targets
  created_at     TEXT NOT NULL
);

CREATE TABLE quiz_responses (
  quiz_id      TEXT NOT NULL REFERENCES quizzes(id),
  user_id      TEXT NOT NULL REFERENCES authors(id),
  answers_json TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (quiz_id, user_id)
);
```

### 3.2 Identity, secrets

- **Identity.** Every Interaction, plan, agent_queue row, sign-off, read-line, pref, user prompt, and quiz response references `authors.id`. Humans mint their `authorId` client-side (UUID v4 in localStorage; `X-Shippable-User-Id` header); the server upserts the row on first sight (role `'human'`, no declared/observed). For AI, the **MCP subprocess** (`mcp-server/`, the stdio bridge between the LLM and the Node server) mints a UUID v4 on startup and attaches it as `X-Shippable-Author-Id` to every HTTP call it makes; the LLM peer never sees the header. The Node server upserts a row (role `'ai'`) on first sight. Declared identity (handle, purpose, model) arrives via the optional `identity` parameter on `shippable_wait_for_work` — no separate handshake. Observed identity (worktree, harness, osUser, host) is filled from connection context and refreshed on every call. The subprocess holds its UUID in memory only — restarts mint a new id and a new `authors` row; persistence is deferred (§18). No accounts, no auth in v1 — multi-user identity is deferred (§18).
- **Secrets.** Only GitHub tokens. Keychain in Tauri, server memory in dev. Server is the policy boundary; secrets never reach the client.
- **No Anthropic key.** All AI work flows through MCP; agents hold their own credentials. Rationale, patterns, and degradation in §3b.

---

## 3b. AI integration model

Every AI workflow in v1 flows through an external MCP agent. The server holds no Anthropic key, imports no LLM SDK, and makes no outbound LLM calls. This is a load-bearing choice (restated as an invariant in §15) and the rest of the architecture — Plan jobs, watch-mode queue, identity surfacing, degradation banners — derives from it.

### Why MCP-only

- **The user already has an agent.** Shippable's audience is reviewers who use Claude Code (or another MCP-capable peer) as their primary surface. Making them paste a second key into Shippable duplicates configuration they already have. Better to talk to the agent they're already using.
- **Keys stay with the user.** The server never sees, stores, or forwards Anthropic credentials. The trust boundary collapses: server is policy
  + persistence, agent is the LLM. GitHub tokens remain the only server-held secret (§10) and they're scoped to git operations, not AI.
- **Agent context comes along for free.** The agent that calls `shippable_post_interaction` brings its own conversation history, prompt customizations, and harness. The user's `~/CLAUDE.md`, their custom prompts, and their preferred model are already wired into the agent; Shippable doesn't need to mirror any of it.
- **Billing and rate limits aren't Shippable's problem.** No Shippable- side cost surface, no Anthropic dashboard to surface, no key-rotation flow to design.
- **Lock-in is protocol-level rather than commercial.** Any MCP-capable agent works — Claude Code today, other MCP clients tomorrow. Shippable defines the *protocol* (tools in §4.2), not the model.

### How agents drive AI work

**Watch mode only.** The agent calls `shippable_wait_for_work` in a loop. Pending `agent_queue` rows (`plan`, `review`, `interaction`, or `prompt` — see §7b) in the agent's declared channels are atomically claimed; the call returns the queue item with server-unique context (existing interactions, plan, parent chain, prompt body) inlined. The agent reads the diff content directly from the worktree, computes, then calls `shippable_post_plan` or `shippable_post_interaction` per finding. This is the "AI is reviewing, comments appear as they land" UX (§7b).

**No direct-prompt path through MCP.** The user can still prompt their agent freely in the agent's own UI — that's outside Shippable's surface. The way to get an agent's output *into* Shippable is to run a library prompt: the UI affordance enqueues a `prompt` row (§9b), the watcher claims it, the result posts back as Interactions (or a Plan, for plan-shaped prompts). Every write into Shippable goes through the queue.

**MCP carries server-unique state only.** Diffs live on disk in the worktree; the agent reads them itself via its native filesystem tools. The MCP layer ferries what the server uniquely has — existing interactions, plans, queue context, prompt bodies — and accepts the agent's writes back. No diff bytes cross the MCP boundary in v1.

### Degradation: no agent connected

The capability flag `ai.mcp` reports watcher presence. When absent:

- Rule plan (§7) still generates synchronously at ingest; the Plan surface is never empty.
- All human review (Interactions, sign-off, coverage, quiz) works unchanged. Worktree-mode review remains fully functional.
- The UI shows a "Connect an agent" setup banner (§7b) — a discovery affordance, not a key prompt and not an error state.

This is why MCP-only is safe to commit to: the floor is functional without it, and the ceiling rises as soon as an agent connects.

### What moves, what goes

**Moves to MCP, doesn't go away:**

- *AI plan generation.* The prototype's `server/src/plan.ts` calls Anthropic directly with a Zod-schema'd output format. In v1 the same AI plan is produced by an external MCP agent that posts via `shippable_post_plan` after claiming a `plan` job (§7b). The schemas survive as wire-validation at the MCP boundary; the Anthropic-SDK call site is gone.
- *AI review.* The prototype's `server/src/review.ts` exposes an SSE token stream from the server to the browser. In v1 there is no server-side stream: MCP agents claim `review` jobs and post each finding via `shippable_post_interaction`. SSE then delivers each Interaction to all clients (§4.3). Atomic-per-finding, no token-level streaming.

**Truly goes away:**

- The `@anthropic-ai/sdk` dependency in `package.json`.
- The Anthropic credential rows in the auth store and the credential UI for them (§10).
- The `ANTHROPIC_API_KEY` env-var warning at `server/src/index.ts`.
- The server-to-browser token-stream wire and `ClientEvent` event type from `review.ts`.

Prototype users with a saved Anthropic key migrate by registering an MCP agent instead; operational steps belong in release notes, not here.

---

## 4. Wire protocol

### 4.1 REST surface

- `POST /api/changesets/worktree`                  → `{ changesetId }` (only ingest endpoint in v1)
- `GET  /api/changesets/{id}`                      → `ChangeSet`
- `GET  /api/changesets/{id}/interactions`         → `Interaction[]` (authors expanded inline)
- `GET  /api/changesets/{id}/plan`                 → latest visible `Plan` (rule or AI, §7)
- `GET  /api/changesets/{id}/quiz`                 → `Quiz`
- `POST /api/changesets/{id}/quiz/responses`       → `QuizResponse`
- `POST /api/interactions`                         → `Interaction` (human path)
- `PATCH /api/interactions/{id}`                   → `Interaction`
- `POST /api/read-lines`                           → `{ ok: true }` (batched ranges)
- `POST /api/sign-offs`                            → `{ ok: true }` (file-level; body: `{changesetId, file}`)
- `DELETE /api/sign-offs?changesetId=...&file=...` → `{ ok: true }` (revoke file-level)
- `POST /api/sign-offs/changeset`                  → `{ ok: true }` (changeset-level; body: `{changesetId}`)
- `DELETE /api/sign-offs/changeset?changesetId=...`→ `{ ok: true }` (revoke changeset-level)
- `GET  /api/code-graph/{csid}/{file}`             → `{ symbols, references, provenance }`
- `GET  /api/prefs`                                → `Record<key, value>`
- `PATCH /api/prefs`                               → `{ ok: true }`
- `POST /api/credentials/github`                   → `{ ok: true }` (only kind in v1)
- `POST /api/changesets/{id}/agent-queue`          → `AgentQueueItem` (user-initiated request; §7b)
- `GET  /api/agent-queue?changesetId=...&status=...` → `AgentQueueItem[]`
- `GET  /api/watchers/active`                      → `Watcher[]` (presence indicator; new in v1; §7b)
- `GET  /api/library/prompts`                      → `Prompt[]` (bundled / path / git; §9b)
- `POST /api/library/sync`                         → `{ ok: true }` (re-resolve a git-sourced library)
- `GET  /api/user-prompts`                         → `Prompt[]` (per-user overrides)
- `PUT  /api/user-prompts/{id}`                    → `Prompt`
- `DELETE /api/user-prompts/{id}`                  → `{ ok: true }`

PR / paste / file / url ingest endpoints are defined at the type level but not implemented in v1 — first follow-up is `POST /api/changesets/pr` in v1.5.

### 4.2 MCP tool surface

Agent peers connect via stdio MCP subprocess (`mcp-server/src/index.ts`) talking to the Node server on `127.0.0.1:{port}/api/agent/*`. MCP is the **sole** AI integration path — the server holds no Anthropic key and makes no LLM calls itself.

Three tools. Watch mode is the only flow; the agent reads diff content from the worktree itself, so MCP carries only server-unique state (existing interactions, plan, queue context).

**The spine — long-poll claim, watch mode:**

- `shippable_wait_for_work({timeout, types, channels, identity?})` — blocks until a pending `agent_queue` row matches one of the caller's declared `channels` (worktree paths) and `types`, or the timeout fires. Returns the claimed `AgentQueueItem` with type-specific context inlined (see payload table below). Single-consumer claim: first watcher in a channel wins. Long-poll calls implicitly stamp presence per `(authorId, channelPath)`; watchers older than `WATCH_TTL_MS` are considered offline.

  `identity` is optional. When provided, the server upserts `authors.declared_json` (handle, purpose, model) so the human-facing badge can show rich identity (§13). Agents that skip it are observed-only — badge shows just the worktree path and `firstSeenAt`.

  Payload returned by `wait_for_work` (no diff content — agent reads the worktree directly):

  | Queue type    | Inlined payload                                                            | |---------------|----------------------------------------------------------------------------| | `plan`        | `{ regenerate?: boolean }`                                                 | | `review`      | `{ scope?: { files?: string[] }, interactions: Interaction[], plan?: Plan }` | | `interaction` | `{ interaction: Interaction, parentChain: Interaction[] }`                 | | `prompt`      | `{ promptId, promptBody, args?: Record<string,unknown> }` (server-resolved; agent never reads the library directly — §9b) |

**Write tools:**

- `shippable_post_interaction({changesetId, anchor, intent, body, rubric, rationale?, suggestedFix?, references?})` — one Interaction per call. Atomic. Replies use `anchor: { type: "interaction", interactionId }` — there is no separate `parentInteractionId`. `rubric` is required (universal for AI authors). Used for review/prompt/reply output.
- `shippable_post_plan({changesetId, headline, structure, claims[], entryPoints[], questions?})` — atomic Plan insert. Appends a new row; latest wins (§7). The caller's `authorId` (from the `X-Shippable-Author-Id` header) becomes the plan's `generated_by`. The optional `questions` array carries an AI quiz alongside the plan (§12); a rule-based quiz floor is generated at ingest regardless. **Write-time validation:** `claims[*].references` must be non-empty per claim; `entryPoints` longer than 3 is truncated server-side to the first 3 by array order (matches the prototype's `assemblePlan` behavior).

**Auth header.** Every request to `/api/agent/*` carries `X-Shippable-Author-Id: <uuid>`. The header is minted and attached by the **MCP subprocess** (`mcp-server/`) — a UUID v4 generated on startup, cached in memory for the subprocess lifetime. The LLM peer calling MCP tools never sees the header; identity is plumbing handled by the bridge. The Node server upserts an `authors` row (role `'ai'`) on first sight from that id and refreshes `observed_json` + `last_seen_at` on every call. No prior handshake — the first `wait_for_work` is both registration and the first poll. Subprocess restart = new UUID = new `authors` row; in-memory by design (§13).

### 4.3 SSE per-ChangeSet

`GET /api/changesets/{id}/stream` opens an EventSource. Server pushes:

- `interaction.created`     — full Interaction (author expanded)
- `interaction.updated`     — full Interaction (human body edits via `PATCH /api/interactions/{id}`; no token streaming)
- `interaction.deleted`     — `{ id }`
- `plan.created`            — full Plan (latest visible row; clients always re-fetch / replace)
- `agent_queue.created`     — full `AgentQueueItem`
- `agent_queue.updated`     — full `AgentQueueItem` (status transitions)
- `sign_off.changed`        — `{ userId, file, signedAt | null }` (file-level)
- `changeset_sign_off.changed` — `{ userId, signedAt | null }` (changeset-level)
- `capability.changed`      — `{ key, available, reason? }`

Reconnects use `Last-Event-Id`. Heartbeats every 30s. Snapshot-per-event for Plans means each event carries the full document; no incremental token deltas.

### 4.4 Mutation latency model

**Optimistic insert + reconcile on SSE echo.** Client generates a `clientNonce`, inserts a placeholder, POSTs to the server, and on SSE echo matches the canonical row by nonce and replaces the placeholder. On POST failure, the client rolls back and surfaces an error.

---

## 5. Coverage projection

Coverage answers "what fraction of this ChangeSet has been reviewed, by whom?" — split into AI-coverage and human-coverage.

- **Inputs (server-side):** `read_lines` rows + existing AI Interactions.
- **Computed on read.** No materialised coverage table.
- **Per-line covered:**
  - **AI-covered** iff any AI Interaction anchors that line (primary or any `references` entry).
  - **Human-covered** iff the line is in the user's `read_lines`.
- **Combined** is the union, surfaced for the "did anyone look at this?" view.
- **Rubric `result === "no"` does not exclude** an AI Interaction from coverage. Coverage measures attention, not verdict.
- **Plans do not contribute to coverage.** Coverage is "where did evidence-bearing commentary land", line-level. Plan claims are ChangeSet-level assertions about scope/structure; including them would inflate coverage misleadingly. Plans and coverage are orthogonal projections.

**MCP exposure.** None in v1 — agents don't read coverage. If a flow emerges where the agent needs to know what the human has read, add a read tool back; today's queue-driven work doesn't need it.

---

## 6. Sign-off

A first-class concept: the human deliberately marks a unit "reviewed, I'm done with this." Distinct from coverage (passive, line-level attention). Central to the IDEA target: "an agent can ask 'did the human sign off file X?'."

**Two tiers, independent of each other.**

- **File-level** (`sign_offs` table). UI affordance: `Shift+M` keymap and a sidebar button mark a file signed off. Toggle revokes.
- **Changeset-level** (`reviewed_changesets` table). A separate gesture marks the whole review done as a unit. UI affordance: a "mark changeset reviewed" button in the changeset header. Toggle revokes.

Both tiers are scoped by `(userId, changesetId[, file])`. Atomic writes + SSE events. No MCP exposure in v1 — agents don't read sign-off state.

**Why two gestures, not one.** They mean different things:

- File-level: "I'm done with *this file*." Used to track per-file walk completion; lets an agent ask "did the human sign off `auth.ts`?".
- Changeset-level: "I've reviewed the *whole change* as a unit." Captures cross-file invariants the AI can't easily check ("did the renamed API's 12 call sites all match?"). A reviewer can sign off the changeset without signing off every file (trivial cosmetic PR), or sign off every file without signing off the changeset (still verifying cross-file consistency).

**Cascades on ChangeSet refresh.** Neither tier carries forward to the child ChangeSet automatically; the user explicitly re-signs after reviewing the changes. The parent ChangeSet's sign-offs remain visible in history.

**Orthogonal to Plan.** Signing off does not acknowledge or silence Plan claims, and Plan generation does not affect sign-off state. Sign-off is about *the diff*; Plan is the AI's commentary on the diff.

---

## 7. Plan as a document

The AI's plan is a curated document, not a flat list of Interactions. Plan, Claim, and EntryPoint are **value types** specific to the Plan document — distinct from Interaction (§1.2), which is the unified event signal.

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
  headline: string;                                 // single-line plain text, no markdown; derived from ChangeSet title (branch/commit subject or PR title)
  structure: StructureMap;
  claims: Claim[];                                  // ordered intent claims (array order = ordinal)
  entryPoints: EntryPoint[];                        // ≤3; server truncates to the first 3 by array order at write time
  generatedBy?: string;                             // → authors.id; null when source='rule'
  createdAt: string;
};

type StructureMap = {
  files: {
    path: string;                                   // file = changeset-scoped path
    status: "added" | "modified" | "deleted" | "renamed";
    added: number;
    removed: number;
    isTest: boolean;
  }[];
  symbols: {
    name: string;
    definedIn: string;                              // path within the ChangeSet
    referencedIn: string[];                         // paths within the ChangeSet
    exported: boolean;                              // exported symbols stay in the map even when unused locally
  }[];
};
```

**Why a document and not Interactions:**

- `headline` and `structure` are ChangeSet-level signals that don't fit a single anchored position.
- `entryPoints` are an *ordering* — "start here, then here, then here" — orthogonal to per-finding anchors.
- Claims are AI-only ChangeSet-level assertions; they have no intent (blocker/request/note), no rubric, no status, no threading. Forcing them into the Interaction shape required seven carve-outs.

**Plan/Claim are split from Interaction.** Earlier drafts merged them; v1 reverses that. Humans do not author or reply to Claims — Claims are presented, not interacted with. Disagreement lives as a normal Interaction anchored to code, not as commentary on a Claim.

**Claim.references is non-empty.** UI refuses to render a Claim with no references; server validates at write time. This is the evidence-mandatory invariant: every Claim must point at code that substantiates it; an unbacked Claim is unrenderable by construction. (The field is named `references` to match Interaction's `references` — the structural shape is "Anchor[] pointing at code." Evidence-of-verification lives in the rubric, not in pointer lists.)

**EntryPoint is flat, not a composed Claim.** Same underlying shape as a Claim (text + Anchor[]), but distinct type. Claims and EntryPoints are rendered differently (bullet list vs. ordered "start here" sequence) and serve different domains; sharing the type would be a structural pun.

**Append-only, latest wins.** Each generation (rule on ingest, AI on job completion, any future regenerate) inserts a new row in `plans`. No row is ever updated or deleted. Reader picks the latest visible:

```sql
SELECT * FROM plans
WHERE changeset_id = ?
ORDER BY created_at DESC LIMIT 1;
```

**Lifecycle:**

1. **Ingest writes the rule plan** synchronously (`source='rule'`, `generatedBy=null`). It is the floor; always available.
2. **Auto-queue AI plan** if a watcher is present in the channel and the user's `autoQueuePlan` setting is on (default on). An `agent_queue` row is inserted with `type='plan'`; a watching agent claims it via `shippable_wait_for_work`. On success the agent calls `shippable_post_plan` (atomic), which inserts a new `plans` row with `source='ai'` and updates the queue row to `done` with `result_id = plans.id`.
3. **Failure (`status='failed'` on the queue row)** leaves the previous visible plan in place (rule, or a prior successful AI plan). The UI shows the previous plan with an inline "AI plan generation failed — retry?" affordance above it.
4. **Regenerate** is agent-initiated. The user goes back to their agent ("review this again"); the agent reposts via `shippable_post_plan`. A new row appears; latest wins. The Shippable UI offers a "regenerate" button that creates an `agent_queue` row of `type='plan'` for a watching agent to claim — same path as auto-queue, just user-triggered.

**No streaming.** MCP is request/response; the agent buffers its full plan and posts atomically. SSE emits a single `plan.created` event when the row lands.

**Re-ingest creates a new ChangeSet** with `parentChangesetId` set. The new ChangeSet runs ingest from scratch — including its own rule plan and (if a watcher is present) its own AI plan job. Old plans remain on their original ChangeSet; they don't carry forward.

---

## 7b. Agent queue and watch mode

`agent_queue` is the unified inbox between Shippable and external MCP agents. Four row types: `plan`, `review`, `interaction`, `prompt`. The agent sees everything via one tool (`shippable_wait_for_work`); the server holds delivery state in one table.

```ts
type AgentQueueType   = "plan" | "review" | "interaction" | "prompt";
type AgentQueueStatus = "pending" | "in_progress" | "done" | "failed";

type AgentQueueItem = {
  id: string;
  type: AgentQueueType;
  channelPath: string;                              // worktree path (v1)
  changesetId: string;
  status: AgentQueueStatus;
  requestedAt: string;
  requestedBy: string;                              // authors.id of the requester (always set)
  claimedAt?: string;
  claimedBy?: string;                               // authors.id once claimed
  completedAt?: string;
  payload?: PlanPayload | ReviewPayload | InteractionPayload | PromptPayload;
  resultId?: string;                                // FK to plans.id when type='plan'
  errorMsg?: string;
};

type PlanPayload        = { regenerate?: boolean };
type ReviewPayload      = { scope?: { files?: string[] } };
type InteractionPayload = { interactionId: string };
type PromptPayload      = {
  promptId: string;                                 // matches library/user prompt id (§9b)
  promptBody: string;                               // server-resolved markdown (args substituted) — the agent treats this as the instruction
  args?: Record<string, unknown>;                   // the args the user supplied; agent can reference if needed
};
```

`wait_for_work` returns the row with the persisted `payload` *plus* type-specific context inlined for the agent (existing interactions, plan, parent chain — see §4.2 payload table). The persisted column stores only the small parameters above; the inlined context is computed at claim time.

**Channels.** Every row carries a `channel_path` (the worktree path in v1). Agents declare which channels they're watching via the `channels` parameter on `shippable_wait_for_work`; the call returns only rows whose `channel_path` matches the caller's declared set. Two watchers on different worktrees never see each other's work; two on the same worktree race on first-claim. The channel concept generalises to PR / url / etc. in v1.5.

**Producers:**

- **Auto-queue plan + review.** On ingest, the server inserts a `plan` row if `prefs[user:autoQueuePlan] = 'on'` (default on). After a plan completes, the UI prompts "want an AI review too?"; on yes, a `review` row is inserted. `prefs[user:autoQueueReview]` defaults to `'off'`.
- **Auto-enqueue interaction.** When a human-authored Interaction is inserted on a ChangeSet whose channel has at least one watcher, the server inserts an `interaction` row with `payload = {interactionId}`. No intent filter — the agent gets the full firehose of human Interactions (questions, requests, blockers, comments, replies). Insertions by AI authors do not auto-enqueue (they *are* the agent's work).
- **User-initiated.** "Regenerate plan" and "Run AI review now" buttons insert `plan` / `review` rows via `POST /api/changesets/{id}/agent-queue`. The prompt-library "Run this prompt" affordance (§9b) resolves the prompt body server-side and inserts a `prompt` row through the same endpoint.

**Consumers — watch mode.** Agents call `shippable_wait_for_work({timeout, types, channels})` in a loop. When a row is pending in a watched channel, the server atomically claims it and returns it to the caller. Single- consumer claim — first watcher wins. Multiple watchers on the same channel = redundancy, not parallelism.

**Lifecycle per type:**

- `plan`, `review`, `prompt`: `pending → in_progress` on claim → `done | failed` on agent transition. The agent reports completion explicitly. `prompt` is shaped exactly like `review` from the agent's perspective — execute the body, post Interactions (or a Plan, for plan-shaped prompts), transition the row when done.
- `interaction`: `pending → done` on claim. Claim is the ack. The agent doesn't need to mark anything afterwards. If the agent wants to reply, it inserts a new Interaction (which won't auto-enqueue because the author is AI).

**Presence.** Long-poll calls to `shippable_wait_for_work` stamp a last-seen timestamp per `(authorId, channelPath)`. Watchers older than `WATCH_TTL_MS` are considered offline. The UI subscribes to `GET /api/watchers/active` for the "Agent is watching" indicator — **new endpoint in v1**, not previously wired in the prototype.

**No watcher = setup banner.** If no watcher is present in a worktree's channel, the UI shows the rule plan with a visible "Connect an agent for AI plans and reviews" banner — a discovery affordance, not an error state. The capability `ai.mcp` is `false` for that channel; AI features hide themselves cleanly.

**Stuck row recovery.** On boot, the server sweeps `agent_queue WHERE status='in_progress'` and marks them `'failed'` with `errorMsg='server restarted while in flight'`. Local dev/desktop restarts often; this gives clean recovery without periodic janitor logic.

**Review jobs produce Interactions.** A watcher that claims a `review` row calls `shippable_post_interaction` once per finding. The UI sees Interactions arrive incrementally via SSE — the "AI is reviewing, you can see comments as they appear" UX. When the agent is done, it transitions the row to `done`.

**Plan jobs produce a Plan (and optionally a Quiz).** A watcher posts a single `Plan` via `shippable_post_plan`; the server inserts the row, marks the queue item `done` with `resultId` pointing at it. The same `shippable_post_plan` call carries `questions?: Question[]` for the optional AI-generated quiz (§12); the rule-based quiz floor is generated synchronously at ingest regardless.

---

## 8. Code graph + language services

### 8.1 LSP, server-side

- typescript-language-server, intelephense, etc. as long-lived subprocesses.
- **Eager index of diff-modified files** at ChangeSet ingest.
- **Lazy on demand** for files outside the diff; cached per-file by content hash.
- **Prefetch on file open.**

### 8.2 Fallback

When LSP is unavailable, regex+heuristics produce best-effort symbols. Result carries `provenance: "regex"`; UI badges as best-effort.

### 8.3 API

`GET /api/code-graph/{changesetId}/{file}` is synchronous, cached per-file. Returns `{ symbols, references, provenance: "lsp" | "regex" }`.

---

## 9. In-browser code runner

A free-form scratchpad sandbox. Not data-driven, not coupled to Interactions.

- **Paste-and-run.** The user (or, in the future, an agent over MCP) drops code into the runner panel; it executes in a sandboxed iframe (`/runner-sandbox.html`) for JS/TS and via `@php-wasm` for PHP. No filesystem reach. Works in every provenance.
- **No structured recipe.** Interactions no longer carry a `runRecipe` field; the runner reads code from its own panel state, not from the data model. The earlier "verify-this-finding" flow (AI Interaction → runner) is gone in v1.
- **Capability-gated** via `runner.js` / `runner.php`.
- **v1 status: kept as-is, no new investment.** The prototype's runner ships as-is; we don't rebuild it. Verification of the rubric's "Tests run / Tests pass" checks remains self-attested in v1. A workspace-mode runner that re-couples to findings is a v2 candidate (§18).

---

## 9b. Prompt library

A small content-management surface that ships markdown prompts the user can run against a ChangeSet. Distinct from Plan and Interaction; the library doesn't produce findings itself — running a prompt enqueues a `prompt` row (§7b) that a watching agent claims and executes.

```ts
type Prompt = {
  id: string;
  name: string;
  description: string;
  args: PromptArg[];                                 // declared in frontmatter
  body: string;                                      // markdown
  source: "library" | "user";                        // library = bundled; user = author-edited
};

type PromptArg = {
  name: string;
  required: boolean;
  auto?: string;                                     // frontend-interpreted pre-fill hint ('selection', 'file', 'changeset.diff'…)
  description?: string;
};
```

**Two stores, merged on read.**

- **Library prompts.** Markdown files under `library/prompts/` with YAML frontmatter (`name`, `description`, `args`). v1 ships four: `explain-this-hunk`, `security-review`, `suggest-tests`, `summarise-for-pr`. The server resolves the library root from one of three sources:
  - `bundled` — files baked into the server build (`library/` next to the source tree; what the prototype ships).
  - `path` — operator-pointed local directory.
  - `git` — operator-pointed git remote + ref, cloned into `server/var/library/checkout` and re-fetched on `sync`. The resolution policy lives in `server/src/library.ts`; the prompt loader (`server/src/prompts.ts`) reads from whichever root resolved.
- **User prompts.** Per-user authored or edited prompts that override a library prompt of the same id. Persisted in `user_prompts` (per-user rows; the prototype's localStorage key `shippable.prompts.user` migrates here, consistent with the "no scattered localStorage" move in §16).

**Read path.** The client picker calls `GET /api/library/prompts` and `GET /api/user-prompts`, merges by id with user taking precedence, and caches in-process.

**Write path.** User prompt edits go through `PUT /api/user-prompts/{id}` and `DELETE /api/user-prompts/{id}`. Library prompts are read-only at the surface — to change them, the operator changes the library source (`path` or `git`).

**Run path — through the queue, not direct MCP.** The picker's "Run this prompt" button calls `POST /api/changesets/{id}/agent-queue` with `type: 'prompt'`. The server resolves the prompt body (looks up the prompt by id, substitutes args from the user's form), and inserts a `prompt` row with `payload = { promptId, promptBody, args }` (see §7b). A watching agent claims it, executes against the worktree, and posts results as Interactions (or a Plan, for plan-shaped prompts like `summarise-for-pr`). The agent never reads the library directly — the server has already resolved it.

**Capability.** No explicit flag — the library always resolves (worst case, to the empty bundled set). The picker mounts unconditionally. Running a prompt requires a watcher in the channel; if none is present, the "Run" button surfaces the same "Connect an agent" affordance as §7b's setup banner.

**Not in v1 (open):** prompt frontmatter–driven rubric extensions (§18), per-prompt MCP routing.

## 10. Credential prompt — reactive queue

Single `<CredentialPrompt>` component plus a queue-backed service. GitHub-only in v1 (Anthropic is gone per §3.2 / §4.2):

```ts
const token = await credentials.require("github:api.github.com");
```

- Boot, settings, on-401 all funnel through `require()`.
- One queue; the prompt renders the head.
- Trusted-host opt-in is part of the prompt UX; opting in PATCHes the server's `trusted_hosts`.

Today's `CredentialsPanel` + `GitHubTokenModal` duplication collapses to one component. The Anthropic key panel is removed; if MCP is not connected the UI shows the "no watcher" banner from §7b, not a key prompt.

---

## 11. Themes

Unchanged from the prototype. Four themes (Light, Dark, Dollhouse, Dollhouse Noir), CSS variables on `:root`, single `ThemePicker`. Only difference: selected theme id is a row in `prefs` (scoped by userId), not a localStorage key.

---

## 12. Quiz

Human-side comprehension check ("anti-LGTM"). Distinct from rubric (quiz tests the human; rubric reports the AI). Both reuse Anchor — `Question.target: Anchor`.

```ts
type Question = {
  id: string;
  target: Anchor;                                    // block | symbol | file | changeset
  prompt: string;
  acceptableAnswers: string[];                       // the AI's answer(s); shown after the user submits for self-evaluation. Not used for grading — there is no correctness check in v1.
};

type Quiz = {
  id: string;
  changesetId: string;
  questions: Question[];
  createdAt: string;
};
```

- Capability-gated via `quiz.enabled` (lit in v1).
- **No correctness check.** The quiz is presentational. The user answers, then `acceptableAnswers` is revealed and the user self-evaluates. The server stores both the user's response and the question text; it does not score. An agent asking "has the human responded?" is a presence check, not a pass/fail.
- **Rule-based floor at ingest.** A deterministic question generator runs alongside the rule plan and emits at least one changeset-level and one file-level question, so a quiz always exists even with no watcher connected.
- **AI-generated questions ride alongside the AI plan.** Agents post questions via `shippable_post_plan({..., questions?: Question[]})` — one call delivers both Plan and Quiz. No separate `shippable_post_quiz` tool; the coupling is real (the agent already has the ChangeSet loaded when producing the plan).
- Responses persist in `quiz_responses`. MCP-readable so an agent can ask "has the human responded to comprehension questions on this changeset?"

---

## 13. Authors (unified identity)

`authors` is the one identity table. Every "who did this?" question resolves through it.

```ts
type Author = {
  id: string;                                        // authorId — UUID, generated client-side for humans, server-assigned for AI
  role: "human" | "ai";
  displayName: string;                               // stable name for the author; "You" is render-time UI, not stored data
  declared?: {                                       // AI only
    handle: string;                                  // 'security-review'
    purpose: string;                                 // 'Audit auth flow'
    model: string;                                   // 'Claude Opus 4.7'
  };
  observed?: {                                       // AI only
    worktreePath: string;                            // from MCP env / parent proc
    harness: string;                                 // 'Claude Code' (inferred)
    osUser: string;
    host: string;
    firstSeenAt: string;
  };
  lastSeenAt: string;
};
```

**Humans** mint their `authorId` client-side (UUID v4) on first load and store it in `localStorage` under `shippable:userId:v1`. The id is sent on every API request as `X-Shippable-User-Id: <authorId>`; the server upserts the `authors` row on first sight (`{role: 'human', displayName: <os-user-or-empty-string>, declared: undefined, observed: undefined}`). A settings affordance lets the human update `displayName` later; "You" is rendered by the UI when `interaction.author.id === currentUserId`, not stored as data. localStorage is one of the few keys we intentionally keep client-side — `prefs` is keyed by `authorId`, so it can't bootstrap itself.

**AI identity is minted by the MCP subprocess**, not by the LLM peer. The subprocess (`mcp-server/src/index.ts`) generates a UUID v4 on startup and caches it in memory; every HTTP call it makes to `/api/agent/*` carries `X-Shippable-Author-Id: <uuid>`. The LLM calling MCP tools is unaware of this — the bridge handles plumbing. The Node server upserts the `authors` row on first sight (role `'ai'`) and refreshes `observed_json` from the transport context on every call (`worktreePath` derived from the declared channel and connection; `harness` inferred from process tree; `osUser`/`host` from the server's view of the localhost connection). Declared identity (handle, purpose, model) arrives via the optional `identity` parameter on `shippable_wait_for_work` — the subprocess passes through whatever the LLM peer supplies via the MCP tool call. Sent on every poll; last write wins; subprocesses (or LLMs) that skip it stay observed-only.

Subprocess restart mints a new UUID and creates a new `authors` row — the old row stays in the table as historical (`lastSeenAt` stops advancing). In-memory minting is intentional in v1; persisted identity across subprocess restarts is deferred (§18).

**Badge UI** (human-facing) combines fields so mismatches are visible:

```
security-review · Claude Opus 4.7 · via Claude Code · ~/work/feat · since 14:32
```

**Trust boundary (v1 assumption, documented):** self-declared identity is unauthenticated. Any localhost process can claim a handle. Acceptable for single-user-local. The moment v1.x goes multi-user, identity needs real auth.

**Where identity surfaces:**

- `interactions.author_id` — who wrote a comment / finding / reply.
- `plans.generated_by` — which agent produced a Plan (null for rule-based).
- `agent_queue.requested_by` — who requested the row (always set).
- `agent_queue.claimed_by` — which watcher claimed the row.
- `read_lines.user_id` / `sign_offs.user_id` / `reviewed_changesets.user_id` / `prefs.user_id` / `user_prompts.user_id` / `quiz_responses.user_id` — every per-user state row FKs to `authors.id`.

Wire surfaces **denormalize the author inline** — every Interaction returned by REST, SSE, or MCP queue payload carries its `author` expanded as `{id, role, displayName, declared?}`, so callers never need a second lookup to resolve who said what.

---

## 14. Client state architecture

**Split:**

- **Server-state query cache** (TanStack Query or equivalent) holds Interactions, ChangeSet, plan, sign-offs, prefs, capabilities. SSE events update the cache. Mutations call the server; optimistic update via cache.
- **UI state store** (Zustand or `useReducer`) holds cursor, modal open/closed, picker state, in-progress text, dismissals, and `fileDisplayMode`.

```ts
type UIState = {
  cursor: { changesetId: string; file: string; line: number } | null;
  fileDisplayMode: Record<string, "diff" | "source" | "preview">;  // keyed by path within ChangeSet
  draft: { /* in-progress text per anchor */ };
  dismissals: Record<string, true>;
  // ... modal/picker state
};
```

**`fileDisplayMode` is a `Record`, not parallel Sets.** The prototype held `fullExpandedFiles: Set<fileId>` + `previewedFiles: Set<fileId>` and relied on the reducer to enforce "a file can't be in both sets at once." The Record shape makes that invariant type-level: a file is in exactly one mode by construction. In v1 only `"diff"` is the user-visible mode; `"source"` and `"preview"` are dormant until full-file-view / preview-mode land in v1.5+, but the shape is fixed now.

**`APPLY_EXTERNAL_UPDATE` action shape.** Every external change — initial load, refresh, SSE-pushed update — funnels through one reducer:

```ts
type ApplyExternalUpdate =
  | { kind: "changeset.loaded";          changeset: ChangeSet; interactions: Interaction[]; plan?: Plan; agentQueue?: AgentQueueItem[] }
  | { kind: "interaction.upsert";        interaction: Interaction }
  | { kind: "interaction.delete";        id: string }
  | { kind: "plan.created";              plan: Plan }
  | { kind: "agent_queue.upsert";        item: AgentQueueItem }
  | { kind: "sign_off.changed";          userId: string; file: string; signedAt: string | null }
  | { kind: "changeset_sign_off.changed"; userId: string; signedAt: string | null }
  | { kind: "capability.changed";        key: CapabilityKey; cap: Capability };

applyExternalUpdate(state, action): state
```

Re-anchoring runs once, in one place, on `changeset.loaded` for the refresh case.

---

## 15. Invariants

Constraints the prototype validated; refactor agents must not undo them without escalation.

- **Stack:** React + Vite + TypeScript (web); Node + SQLite (server); Tauri (desktop shell). The tech-reset option was declined.
- **TUI door:** the core (`web/src/state.ts`, `parseDiff.ts`, `types.ts`, `view.ts`, `anchor.ts`) imports React zero times. An ESLint rule + a test guard the property. No formal `core/` package until a second consumer exists (rule of two).
- **ServerHealthGate:** server is a hard dependency in every shape. Web app probes `/api/health` at boot via `ServerHealthGate` and refuses to load without it. No browser-only fallback. Per AGENTS.md.
- **Keyboard-first walk:** `j`/`k` line navigation, `Shift+M` mark reviewed (file), `]`/`[` next/prev file, `n`/`N` next/prev unresolved comment, gutter rail. The keymap is product-defining; locked.
- **Capability-gated language features:** "disabled is worse than absent." A feature whose backend is down hides itself entirely.
- **References-mandatory on Claims:** `Claim.references` is non-empty; UI refuses to render a Claim with none (§7). Server validates at write time.
- **Rubric-mandatory on every AI Interaction:** the rubric is a complete `Record<CheckLabel, CheckResult>` — partial rubrics are unrepresentable by construction. Required regardless of intent (comment, question, request, blocker, or any reply). Every check carries a non-empty `note`, including the yes ones.
- **Interaction anchors are immutable post-insert:** combined with parent-must-exist for response-intent inserts, comment-chain cycles are impossible by construction. PATCH affects only `body` / `updatedAt`, and only on human-authored rows.
- **No server-side AI calls:** the server holds no Anthropic key and imports no LLM SDK. AI work happens exclusively through MCP agents (§4.2). Reintroducing a server-side LLM path requires explicit re-architecture, not a quick fix.
- **Plan is immutable per row:** rows in `plans` are append-only. Each generation produces a new row; latest visible wins. No row is ever updated or deleted.
- **Content-addressed anchor recovery:** committed anchors store only `{type: 'committed', sha}` and re-derive their window via `git show`. We never `git hash-object -w` — Shippable does not write to the user's `.git`.
- **Cursor never persists server-side:** cursor is client-only (in-app memory + per-tab localStorage for resume). Re-introducing server-side cursor requires explicit re-architecture.
- **File display mode is type-enforced:** `Record<path, "diff" | "source" | "preview">` keyed by ChangeSet-scoped path. Parallel Sets with reducer-enforced exclusion do not return.

---

## 16. What we dropped

Recorded so future archaeology doesn't resurrect them:

| Dropped                                  | Replaced by                              |
|------------------------------------------|------------------------------------------|
| `Anchor.prefer?: "before" \| "after"`    | Renderer falls back to diff-context default; revisit if needed (§18) |
| `Interaction.generation` / `Plan.generation` field; `generation_json` columns | `changesetId` FK is the revision tag |
| `shippable_post_interaction({…, parentInteractionId?})` parameter | Replies via `anchor: { type: "interaction", interactionId }` |
| Mutable Interaction anchors / intent / authorId / AI-only fields | Immutable post-insert; PATCH limited to `body` + `updatedAt` on human-authored rows |
| Separate `jobs` table | `agent_queue` table with three types (`plan`/`review`/`interaction`) and `channel_path` scope (§7b) |
| `interactions.agent_queue_status` + `interactions.worktree_path` (prototype) | Delivery state lives entirely on `agent_queue` rows |
| Synthetic `fileId` everywhere               | `path` is the file key within a ChangeSet; storage PK is `(changeset_id, path)` |
| Separate `shippable_get_interactions` MCP tool | Existing Interactions are inlined in the `wait_for_work` payload (authors expanded) for the queue types that need them — no explicit MCP read |
| `Interaction.runRecipe` field + `RunRecipe` type | Runner decoupled from data model; free-form scratchpad (§9) |
| `run_recipe_json` column on `interactions` | Removed                                 |
| Server-side Anthropic call inside `server/src/plan.ts` | AI plan moves to MCP — agent posts via `shippable_post_plan` after claiming a `plan` job; rule plan still generated inline at ingest (§7b). The Zod schemas survive as wire-validation. |
| SSE token-stream review wire in `server/src/review.ts` (`streamReview` + `ClientEvent`) | AI review moves to MCP — agent claims `review` jobs and posts each finding via `shippable_post_interaction`; SSE delivers Interactions atomically, no token-level streaming (§4.3) |
| `@anthropic-ai/sdk` dependency | Removed — no LLM SDK on the server |
| Anthropic credential rows in `auth/store` | Only GitHub credentials remain (§3.2)    |
| Client-side GitHub PR loading (`useGithubPrLoad`, `githubPrClient`) | None in v1; PR ingest returns server-side in v1.5 |
| Flat `AnchorCtx { hash, contextLines, originType }` on every anchor | `BlockOrigin` discriminated union — committed: `{sha}` only; dirty: `{context}` snapshot |
| Stored fingerprint hash on anchors       | Derived FNV-1a at re-anchor time         |
| Writing blobs into the user's `.git` to address dirty content | Welded `context: string[]` snapshot in our SQLite |
| Intent-keyed rubric (blocker:4, request:2, comment:0) | Flat 5-label `Record<CheckLabel, CheckResult>`; required on AI {blocker, request} |
| `note` required only when `pass===false` | `note` required on every check, including yes |
| `Interaction.evidence` field             | `Interaction.references` (matches Claim) |
| Free-text `author` + parallel `authorRole` column | `author_id` FK to unified `authors` table |
| Separate `agent_identities` table        | Folded into `authors` (humans + AI)      |
| `confidence: low\|medium\|high`          | Flat 5-label rubric                      |
| Rubric scoped to AI {blocker, request} only | Universal — rubric required on every AI Interaction regardless of intent (§1.2, §15) |
| Server-side cursor                       | Client-only (in-app memory + localStorage) |
| Server-side `cursor` POST endpoint       | None — cursor never leaves the client    |
| 4 ingest endpoints (pr/paste/file/url)   | Type-level union only in v1; PR follow-up in v1.5 |
| Strangler-fig phased PRs to `main`       | One-shot refactor on a branch; zero back-compat with prototype data |
| Two-Set file display state (`fullExpandedFiles` + `previewedFiles` + reducer mutex) | `Record<path, "diff" | "source" | "preview">` |
| Single-tier sign-off (file only)         | Two-tier: file + changeset, independent  |
| Merging Claim into Interaction           | Claim + EntryPoint as Plan-internal types (§7) |
| `Plan.claimIds` (FK to Interactions)     | `Plan.claims: Claim[]` inline            |
| Single-row `plans` (PK on changeset_id)  | Append-only `plans`; latest wins         |
| Server-side Anthropic streaming          | MCP-only AI; agents post atomically      |
| Server-side Anthropic key path           | Gone entirely; only GitHub credentials   |
| `Interaction.status = streaming\|error`  | Atomic insert; no streaming state        |
| Token-delta SSE events                   | Snapshot-per-event; one event per Plan   |
| `shippable_check_review_comments`        | `shippable_wait_for_work({types:[…]})`   |
| `shippable_watch_review_comments`        | `shippable_wait_for_work({types:[…]})`   |
| Old `EvidenceRef` union                  | `Anchor[]` (both `Claim.references` and `Interaction.references`) |
| `Assignment` entity                      | Nothing — out of scope                   |
| `Activity` entity                        | Derive from interaction stream           |
| `AuthorRole = "agent"`                   | Folded into `"ai"`                       |
| `Interaction.target` field               | `anchor.type` discriminator              |
| `Interaction.parentId` field             | `anchor: { type: "interaction", interactionId }` |
| `Interaction.threadKey` field            | `resolveRootAnchor()` walks chains       |
| `Anchor.kind = "hunk"`                   | `block` covering hunk lines              |
| `Anchor.kind = "line"`                   | `block` with `lo === hi`                 |
| `Anchor` discriminator field name `kind` | `type` (matches `BlockOrigin.type`)      |
| `Anchor.kind = "comment"` / `commentId`  | `Anchor.type = "interaction"` / `interactionId` |
| `Interaction.external { source, htmlUrl?, sentinelId? }` | Dropped from v1; reintroduced in v1.5 when PR ingest lands (§18) |
| `interactions.external_json` column      | Dropped (along with `Interaction.external`) |
| `shippable_get_settings()` MCP tool      | Dropped — auto-queue prefs are server-side queueing decisions, not agent-respected |
| `shippable_announce({identity, channels})` MCP tool | Dropped — identity is implicit (UUID in `X-Shippable-Author-Id` header, server upserts on first sight); declared identity arrives via optional `identity` param on `shippable_wait_for_work`; channels are a param on `wait_for_work` |
| `shippable_get_changeset(id)` MCP tool   | Dropped — diff lives on disk in the worktree, agent reads it itself; existing interactions/plan are inlined in `wait_for_work` payloads |
| `shippable_get_plan(id)` MCP tool        | Dropped — folded into `wait_for_work` inline payload (no flow needed Plan in isolation from the rest of the changeset) |
| `shippable_get_progress(id)` MCP tool    | Dropped — no v1 flow needed it; add back when an agent needs mid-task introspection |
| `shippable_get_sign_off(id)` MCP tool    | Dropped — subset of progress; same rationale |
| Direct-prompt MCP read path              | Dropped — library prompts route through the queue (§7b `prompt` type, §9b); every AI write into Shippable goes through watch mode |
| Diff content shipped over MCP            | Dropped — worktree-only ingest means the agent reads diff from disk; MCP carries server-unique state only |
| `agent_queue.requested_by` nullable      | `NOT NULL`; always set to the requester's `author_id` |
| Human `displayName` hardcoded to `'You'` | Real display name stored on `authors`; "You" is render-time UI |
| `CredentialsPanel` + `GitHubTokenModal`  | One `<CredentialPrompt>` + queue (GitHub-only) |
| Anthropic credential panel               | "No watcher" banner (§7b)                |
| Scattered `shippable:*` localStorage     | `prefs` SQLite table (server)            |
| `ANTHROPIC_API_KEY` env-var warning      | Server has no Anthropic SDK              |
| Client-side primary persistence          | Server SQLite for shared state           |
| `RubricCheck.comment` field name         | `CheckResult.note`                       |
| Separate ingest reducers per provenance  | One `APPLY_EXTERNAL_UPDATE` reducer      |

---

## 17. Refactor execution order

**Strategy: one-shot refactor on a separate branch.** Not strangler-fig in-place on `main`; not a clean rebuild from zero. Branch off `main`, do every change below in one branch, merge when done. Zero backwards compatibility with the prototype's persisted shapes — prototype data is dropped at merge.

The order below is the dependency-driven execution order on the branch. Earlier items unblock later items; the branch is not shippable until the whole sequence completes.

1. **Primitives** — `Anchor` discriminated union with `BlockOrigin`; `Interaction` shape (no `target`, no `parentId`, no `threadKey`, no `status`; `references?` instead of `evidence`; `author_id` FK). Flat 5-label `Rubric = Record<CheckLabel, CheckResult>` with notes required on every check.

2. **Server SQLite schema** — `changesets`, `diff_files`, `authors` (unified — humans + AI), `interactions`, `read_lines`, `sign_offs`, `reviewed_changesets`, `prefs`, `trusted_hosts`, `plans`, `agent_queue`, `user_prompts`, `quizzes`, `quiz_responses`. SSE per-ChangeSet wired.

3. **Reducer + client state** — one `APPLY_EXTERNAL_UPDATE` reducer for ingest/refresh/SSE. UI state holds cursor (in-app memory + localStorage), `fileDisplayMode` as `Record<path, mode>`, drafts, dismissals.

4. **REST + SSE + MCP wire** — REST surface from §4.1; SSE events from §4.3; MCP tools from §4.2 (`shippable_wait_for_work`, `shippable_post_interaction`, `shippable_post_plan`). Both sign-off tiers exposed via REST.

5. **Worktree ingest** — the only provenance whose endpoint ships in v1. PR/paste/file/url remain in the `Provenance` union at the type level but their endpoints don't land.

6. **Plan + agent_queue + auto-queue prefs** — rule plan + rule quiz floor generated synchronously at ingest; AI plan + quiz via `agent_queue` claimed by a watching MCP agent; AI review via `review` queue items; reviewer Interactions auto-enqueued as `interaction` queue items. `prefs[user:autoQueuePlan]='on'` and `prefs[user:autoQueueReview]='off'` defaults. Server holds no Anthropic key.

7. **Authors + identity surfacing** — `authors` is the unified store; composite declared+observed badge UI; the MCP subprocess mints a UUID on startup and sends it as `X-Shippable-Author-Id` (server upserts), while declared identity arrives via the `identity` param on `shippable_wait_for_work`; `generated_by` on plans, `requested_by`/`claimed_by` on `agent_queue` rows. Human `userId` minted client-side (UUID v4 in localStorage); `X-Shippable-User-Id` / `X-Shippable-Author-Id` headers on all `/api/*` and `/api/agent/*` calls respectively.

8. **Capability system** — server detects environment, ChangeSet provenance narrows, reactive context, reasons on unavailable. `ingest.worktree` lit; the other ingest capabilities report `{available: false, reason: 'Not in v1; PR ingest lands in v1.5'}`.

9. **Quiz** — `quizzes`/`quiz_responses` tables; UI; MCP-readable.

10. **TUI invariant guard** — ESLint rule + test ensuring the core stays React-free.

11. **Polish** — refresh-link flow, error states, prefs UI, adoption of `tauri-plugin-dialog` for the directory picker (the prototype doesn't use it yet; v1 wires it for the worktree picker, with an AppleScript fallback in browser-dev macOS).

The branch merges to `main` once items 1–10 are complete and item 11 has reached its bar. Item ordering is dependency-driven; later items rely on the primitive shapes and schema from items 1–2.

---

## 18. Open questions for later

Deferred past v1:

- **PR ingest (v1.5).** First follow-up after v1 ships. Must extend the MCP-watcher pattern to PR-loaded ChangeSets: the server fetches the diff via the GitHub API, and the watcher needs a way to read content it can't pull from a local worktree. Likely shape: a new MCP read tool that returns file content by path, or fat payloads on `wait_for_work` that inline the diff for non-worktree provenances. Design when the work lands.
- **Paste / file / url ingest.** Deferred past PR ingest. Type-level union retained for forward-compatibility.
- **Full-file-view + preview mode.** `fileDisplayMode` Record already has the slots; the UI / capability work lands later.
- **Renderer hint for vanished anchors.** Dropped the `prefer?: "before" | "after"` field on `block` anchors in session 5 — underspecified, no use sites. Renderer defaults are sufficient today. Revisit if the vanished-block UX needs a writer-side hint.
- **Multi-user identity.** Replace local userId with real auth. The prefs/read-lines/coverage/sign-off shapes are already scoped-by-userId; migration is mostly auth-side.
- **Persisted MCP-subprocess identity.** v1 mints a fresh UUID per subprocess startup (in-memory), so a restart shows up as a new `authors` row and the badge's "since 14:32" history resets. If badge continuity becomes desirable, persist the UUID to a small file (e.g., `~/.shippable/mcp-author-id`) and reload on startup. Cheap add when there's a use case.
- **Workspace-mode runner.** Inline-only today. A worktree-only `runner.workspace` capability for real test commands (e.g. `php artisan test`) is a v2 candidate.
- **Cross-device cursor / drafts.** Single-tab in v1. Both shapes already scoped-by-user when needed.
- **Drafts as Interactions with `status: "draft"`.** Useful when agents want "human is typing" awareness. Schema is forward-compatible.
- **Per-prompt rubric extensions.** Fixed enum in v1; extensible via prompt frontmatter in v2.
- **Live capability degradation** beyond available/unavailable. First- class tri-state for "degraded with regex fallback" can come later; reason string carries this informationally in v1.
- **Authenticated agent identity.** Self-declared is unauthenticated in v1. When multi-user, identity needs real auth.
