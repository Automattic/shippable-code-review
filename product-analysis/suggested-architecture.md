# Suggested architecture — Shippable rebuild

> **Status: Superseded by [`v1-architecture.md`](./v1-architecture.md)** (grill session 2026-05-25).
> This document is preserved as the brainstorming-stage proposal. The finalized
> v1 contract reflects decisions made during the entity-by-entity grill, including:
> Claim/Assignment/Activity dropped; agent role folded into ai; hunk anchor
> dropped; line/block collapsed to `block`; confidence enum replaced by a fixed
> validation rubric; server SQLite as source of truth; vertical-slice migration
> through worktree-only ingest first.

A first-principles architecture for the rebuild, derived from the
feature-by-feature deep dive in this folder. Opinionated and concrete:
where the analysis surfaced a fork, this picks one direction and
defends it.

This is the architecture I'd commit to. The migration path in §10
sketches how to get from today's prototype to this shape; not every
phase has to land at once.

---

## 1. What we're optimising for

Three things, in priority order.

1. **The reviewer stays present and engaged.** That's the IDEA's
   founding promise. The architecture must make the walk model, the
   inline AI notes, and the sign-off gesture the centre of gravity — not
   the side-panel chrome.

2. **Anything an agent or another human cares about reading lives in one
   place.** The Interactions store, server-owned. The minute we have
   two stores for the same concept, drift starts. The current prototype
   already pays this tax (cursor in localStorage, comments in SQLite;
   custom prompts in localStorage, library prompts on disk; sign-off
   nowhere an agent can read it).

3. **Boring beats clever.** Three primitives, three layers, one
   reducer family, one sync hook, one capability surface. Adding a
   fourth language should not require changing three files; adding a
   new ingest path should not require a new reducer action.

Two explicit non-goals, both inherited from the prototype's stance and
worth keeping:

- **Not an editor.** The product is review-first. No code edits leave
  Shippable. Suggestions and runner output produce *Interactions*, not
  patches.
- **Not a hosted service in v1.** Local-first, with a server that's a
  hard dependency in every deployment shape. The architecture must
  *degrade cleanly* to a hosted backend later (the Tauri/web duality
  proves we can), but we don't pay the multi-tenant tax up front.

---

## 2. The four primitives

Everything else in the product is built from four types. The current
prototype has analogues of all four; the rebuild collapses their
variants.

### 2.1 `Anchor`

Five shapes in the prototype say "this thing points at a piece of
diff" (`EvidenceRef`, `Interaction.anchor*`, `GuideSuggestion`'s
hunk+symbol pair, diagram nav payloads, `runRecipe`). One type:

```ts
export type Anchor =
  | { kind: "line"; file: string; lineNo: number; ctx?: AnchorCtx }
  | { kind: "block"; file: string; lo: number; hi: number; ctx?: AnchorCtx }
  | { kind: "hunk"; file: string; hunkId: string }
  | { kind: "symbol"; file: string; symbol: string; lineNo?: number }
  | { kind: "file"; file: string }
  | { kind: "thread"; threadKey: string };           // replies, never on code

export type AnchorCtx = {
  hash: string;            // FNV-1a of 5 lines centred on anchor
  contextLines: string[];  // 10 lines around anchor for relocation
  prefer: "before" | "after";
  originSha: string;       // commit (or "WORKING") this anchor was minted against
};
```

`AnchorCtx` is the prototype's `anchorContext` / `anchorHash` /
`originSha` / `prefer` collapsed onto the anchor itself instead of
spread across six Interaction fields. Re-anchoring (currently in
`web/src/anchor.ts:findAnchorInFile`) is one function over one type.

One renderer: `Reference.tsx`, promoted from "EvidenceRef renderer" to
canonical anchor renderer. Plan claims, comments, guides, diagram
clicks all consume the same React component.

### 2.2 `Interaction`

The Interactions migration is the high point of the prototype. The
rebuild extends it to subsume more, not redesign it.

```ts
export type AuthorRole = "user" | "ai" | "agent" | "teammate";
export type AskIntent      = "comment" | "question" | "request" | "blocker";
export type ResponseIntent = "ack"     | "unack"    | "accept"  | "reject";
export type Intent = AskIntent | ResponseIntent;

export type Interaction = {
  id: string;
  changesetId: string;
  threadKey: string;
  author: string;
  authorRole: AuthorRole;
  intent: Intent;
  body: string;
  anchor?: Anchor;            // omitted for `thread` replies
  external?: { source: "pr" | "mcp"; htmlUrl?: string; sentinelId?: string };
  runRecipe?: RunRecipe;      // makes the Interaction verifiable
  status?: "streaming" | "done" | "error";    // for streamed bodies
  createdAt: string;
  updatedAt: string;
};
```

Three changes vs. today (see `_group3-unification-notes.md` and
`_group5-unification-notes.md`):

- **`status` field.** Lets prompt runs and AI plan streams *be*
  Interactions instead of living in a parallel `PromptRunView`. The
  server upserts a `streaming` row on stream start; chunks update body
  in place; the row flips to `done` on completion. Client subscribes
  to a live channel keyed by interaction id. Persistence, reply-ability,
  and agent-readability fall out for free.

- **`threadKey` derives from `anchor`.** No more reply-to-ai-note /
  reply-to-hunk-summary / reply-to-teammate / reply-to-user /
  reply-to-agent target enum. `anchor.kind: "thread"` carries the
  parent thread; everything else carries an Anchor and threadKey is
  computed from `(anchor.kind, anchor.file, position)`. The
  `parseReplyKey` / `buildReplyAnchor` legacy goes away.

- **No `DeliveredInteraction` wrapper.** The `deliveredAt` field
  mirrored `createdAt`; consumers can read `status === "delivered"` on
  the queue-side rows.

The Interaction primitive *now* swallows three things that today live
beside it (`_group4` §4.2, `_group6`):

- **Prompt runs** = Interaction with `authorRole: "ai"`, `runRecipe = { source: promptId, inputs }`, `status: "streaming"` → `"done"`.
- **Dismissed guides** = Interaction with `intent: "ack"` on a `guide:<id>` thread.
- **Runner verdicts** = Interaction with `anchor.kind: "thread"` (parent = the AI note being verified), `intent: "accept" | "reject"`, body = `RunResult`.

The selector contract is enforceable, not aspirational (see §5.3).

### 2.3 `ChangeSet`

```ts
export type Provenance =
  | { kind: "paste" }
  | { kind: "file"; filename: string }
  | { kind: "url"; url: string }
  | { kind: "worktree"; path: string; range?: { from: string; to: "HEAD" | "WORKING" } }
  | { kind: "pr"; host: string; owner: string; repo: string; number: number };

export type Overlay =
  | { kind: "pr"; host: string; owner: string; repo: string; number: number };

export type ChangeSet = {
  id: string;
  provenance: Provenance;
  overlays: Overlay[];
  baseline?: { sha: string; ref: string };
  files: DiffFile[];
  loadedAt: string;
};
```

`provenance` is the discriminated union the prototype's parallel-optional
`worktreeSource?` + `prSource?` fields imply (`_group7-unification-notes.md`).
`RecentSource` (`web/src/recents.ts`) is promoted from a recents sidecar
to the canonical provenance shape.

`overlays` is the explicit list for the one real case where two
provenance kinds co-exist — a worktree with an open upstream PR
merging metadata in (today's "PR overlay pill"). Saying it out loud
beats relying on runtime mutation order in `MERGE_PR_OVERLAY` to
distinguish "worktree+PR overlay" from "PR-only."

### 2.4 `Capability`

The prototype gates features per language, per worktree, per credential
ad-hoc — `requiresWorktree` on definitions, "AI off" chip on missing
key, "def: unavailable" hint. One surface:

```ts
export type Capability =
  | { kind: "lsp";      language: string; available: boolean; reason?: string }
  | { kind: "runner";   language: string; available: boolean; reason?: string }
  | { kind: "worktree"; available: boolean }
  | { kind: "ai";       provider: "anthropic" | "openai"; available: boolean }
  | { kind: "shell";    flavour: "tauri" | "web" };

GET /api/capabilities -> { capabilities: Capability[], version: string }
```

Features read from a `useCapabilities()` hook. The "AI off" chip, the
`def:` toolbar pill, the runner availability badge, all read from the
same projection. `POST /api/capabilities/refresh` triggers a rescan
(addresses the "I just installed pyright" stale-cache problem in
`_group6-unification-notes.md`).

---

## 3. The three layers

The whole product decomposes cleanly into three layers. Each has one
responsibility and a small public surface.

```
┌─────────────────────────────────────────────────────────────┐
│  Walk          cursor • readLines • sign-off • dismissals   │
│                navigation • coverage • keyboard             │
└────────────────────────▲────────────────────────────────────┘
                         │ renders + writes annotations
┌────────────────────────┴────────────────────────────────────┐
│  Annotation    Interactions store • plan claims • AI notes  │
│                guides • runner verdicts • agent context     │
│                prompt runs • user comments                  │
└────────────────────────▲────────────────────────────────────┘
                         │ consumes
┌────────────────────────┴────────────────────────────────────┐
│  Ingest        paste • file • url • worktree • pr           │
│                external updates (drift / overlay / replies) │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Ingest layer

**Job:** turn any source into a `ChangeSet { provenance, files, baseline }`,
and propagate later external updates (worktree drift, PR refresh, agent
replies) against an already-loaded ChangeSet.

**Public surface (client):** `useLoadSurface()` — one hook for all five
paths, with one error rail, one empty-diff recovery, one optimistic
provenance-aware URL field that routes `pr` vs `diff` URLs by
inspection (the prototype already partly knows how — `isGithubPrUrl`).

**Public surface (server):** `POST /api/changesets`, body
`{ provenance, content?, url? }`. One endpoint, switches on
`provenance.kind`. Returns `{ changeset, interactions, progress, signOffs }`
in one bundle — kills the per-changeset interactions roundtrip and
the awkward StrictMode-guard comments in today's `App.tsx`.

**External updates** are one primitive:

```ts
type ExternalUpdate =
  | { kind: "worktree-drift"; files: DiffFile[]; baseline: BaselineRef }
  | { kind: "pr-overlay"; overlay: Overlay; interactions: Interaction[] }
  | { kind: "agent-replies"; interactions: Interaction[] };

POST /api/changesets/:id/refresh -> ExternalUpdate
```

One reducer action, `APPLY_EXTERNAL_UPDATE`, handles all three
(`_group7-unification-notes.md`). The content-anchor re-relocate step
is conditional on `kind === "worktree-drift"`; the idempotent
`external.source === "pr"` strip lifts to the shared reducer. One
`useExternalSync<T>` hook generalises the 3-strike error counter and
toggle gating; today's worktree poll and (future) PR auto-poll both
configure it.

The `Origin` discriminator on Anchor's `originSha` covers worktree
*and* PR-sourced re-anchoring, so the anchor machinery serves both
surfaces uniformly (`_group7-unification-notes.md`).

### 3.2 Annotation layer

**Job:** Turn a ChangeSet into an *annotated* ChangeSet by producing
Interactions. Every producer writes through one ADD/UPDATE/DELETE
seam; every consumer reads through one selector seam.

**Producers** (each is a thin module; all emit `Interaction`s):

| Producer       | When                                  | authorRole | Typical intent                |
|----------------|---------------------------------------|------------|-------------------------------|
| `aiPlan`       | Server-streamed on changeset load     | `ai`       | `comment` (claims)            |
| `aiNotes`      | Server-streamed on changeset load     | `ai`       | `comment` / `question`        |
| `guides`       | Server-derived from `cs.graph`        | `ai`       | `request` (look at X next)    |
| `composer`     | User keystroke (`c`/`r`/`a`)          | `user`     | any                           |
| `agentPoll`    | MCP-side write surfaces in store      | `agent`    | any                           |
| `prSync`       | PR overlay + later auto-poll          | `teammate` | tagged via sentinel           |
| `runner`       | After in-browser execution            | `user`     | `accept` / `reject`           |
| `promptRun`    | After user picks a prompt + selection | `ai`       | `comment`                     |
| `clickThrough` | Reviewer takes a definition jump      | `user`     | `comment` (low-noise context) |

Note: every observable artefact in the product becomes a row in one
table. The IDEA's "easily integrate insight from agent interactions"
becomes literal — the agent's writes and the human's writes are
indistinguishable in shape; the UI separates them by `authorRole`.

**Consumers** (read through one seam — `selectInteractions`):

- `DiffView` — per-line glyphs via `byThreadKey`
- `Sidebar` — per-file counts via `byFile`
- `Inspector` / `InlineThreadStack` — thread cards
- `n / N` walk — threads in file order
- Inbox view — `byIntent.request` / `byIntent.blocker`
- Coverage projection (see §6)
- GitHub push / PR-level verdict
- MCP read tools

The two-host arrangement (`InlineThreadStack` for panel mode,
`InlineLineThreads` for inline mode) collapses to one component that
takes a layout flag; the `interactionViewMode.ts` file the architecture
doc cites but the tree doesn't contain (`_group2-unification-notes.md`)
formally disappears.

### 3.3 Walk layer

**Job:** Local UI state — cursor, navigation, sign-off, dismissals,
view modes. Drives the reviewer's traversal of the ChangeSet.

State, in two buckets:

```ts
// per-changeset, server-owned (writes through one mutation per change)
type Progress = {
  cursor: Cursor;
  readLines: ReadLinesMap;
  signedOffFiles: string[];     // per-file
  signedOffAt?: string;         // changeset-level
  dismissedGuides: string[];    // legacy bucket — see below
};

// browser-owned, machine-specific, intentionally loss-tolerant
type LocalUI = {
  fileModes: Record<string, "diff" | "source" | "preview">; // §5.2
  expandLevels: Record<string, { above: number; below: number }>;
  drafts: Record<string, string>;
  inspectorOpen: boolean;
  zoom: number;
};
```

`Progress` is server-owned. `LocalUI` is localStorage-only. Drafts and
zoom are loss-tolerant; cursor and sign-off are not (`_group2`).

The dismissed-guides bucket collapses into Interactions in a later
phase (it's a `Set<string>` that's structurally `intent: "ack"` on a
`guide:<id>` thread; `_group4-unification-notes.md` §4.2). It stays as
a transitional field so the rebuild ships before the guide ⟶
Interaction conversion lands.

Sign-off being server-owned is the highest-leverage move in the entire
rebuild (`_group2-unification-notes.md`). It unlocks the IDEA's
"agent can ask: did the reviewer sign this off?" promise. The
current state where nothing outside the browser tab knows about
sign-off is the prototype's largest blocking limitation.

---

## 4. Storage architecture

```
SERVER (system of record)
  SQLite (Postgres-ready)
    ├── changesets        provenance, overlays, baseline, snapshot
    ├── files             ChangeSet files (or store inline if small)
    ├── interactions      one table; all authors, all intents
    ├── progress          per-changeset cursor/readLines/sign-off
    ├── prompts           library + user-authored
    ├── credentials       reference cache only (durable in Keychain)
    └── stats             telemetry consent + aggregates

CLIENT (projection)
  React state           Per-tab, hydrated from server on changeset open
  localStorage:
    shippable:prefs:v1    Theme, inspectorOpen, zoom, view modes
    shippable:drafts:<cs> Per-changeset unsaved composer text
    shippable:recents     Last-5 list
    shippable:auth:skip   "I clicked Skip on the boot AI prompt"

KEYCHAIN (Tauri only)
  ANTHROPIC_API_KEY
  GITHUB_TOKEN:<host>
  (allowlisted; web shape skips this rung)
```

Two rules:

1. **Anything an agent or another client might care about is server-side.**
   No exceptions for "but it's just per-user." If a reviewer signs off
   on file X, the agent can know.

2. **localStorage is for one tab's view of the world.** Drafts, view
   modes, theme, zoom, "I dismissed the boot AI prompt." Lossy is fine
   by design.

The six localStorage keys in the prototype (`shippable:anthropic:skip`,
`shippable:githubTrustedHosts:v1`, `shippable:theme`,
`shippable:interactionViewMode`, etc.) collapse to one
schema-versioned `shippable:prefs:v1` document plus the per-changeset
drafts key and the recents key. Three keys total in the rebuild,
not seven.

Schema migrations move out of `persist.ts`'s "no migration, fail closed"
shortcut into normal SQL migrations server-side
(`_group2-unification-notes.md`).

---

## 5. The reducer

Today: `web/src/state.ts` is 1655 lines with 30+ actions. Rebuild
target: 300-400 lines, four action families.

### 5.1 Four action families

```ts
type Action =
  | { type: "LOAD_CHANGESET";       changeset, interactions, progress }
  | { type: "APPLY_EXTERNAL_UPDATE"; update: ExternalUpdate }
  | { type: "INTERACT";              op: "add" | "update" | "delete"; interaction }
  | { type: "NAVIGATE";              op: "cursor" | "openFile" | "n"; ... }
  | { type: "UI";                    field: keyof LocalUI; ... };
```

Five if you count `LOAD_CHANGESET` separately, but it's a one-shot.
The collapses against today's surface:

- `TOGGLE_ACK` ⟶ `INTERACT` with an `intent: "ack"` Interaction
  (today modelled as one, dispatched separately — `_group3` §1).
- `TOGGLE_EXPAND_FILE` / `TOGGLE_PREVIEW_FILE` ⟶ `UI` with the file's
  mode field. Two `Set<fileId>` + mutual exclusion ⟶ one
  `Record<fileId, "diff" | "source" | "preview">` (`_group1` §4.9).
- `RELOAD_CHANGESET` / `MERGE_PR_OVERLAY` / `MERGE_PR_INTERACTIONS`
  ⟶ `APPLY_EXTERNAL_UPDATE` (§3.1).
- All ad-hoc dismissal toggles ⟶ Interactions over a phase boundary.

### 5.2 View modes as a Record

```ts
type FileMode = "diff" | "source" | "preview";
type FileModes = Record<string, FileMode>;
```

Replaces today's `fullExpandedFiles: Set<fileId>` + `previewedFiles:
Set<fileId>` with reducer-enforced exclusion. Type system carries the
constraint; `TOGGLE_EXPAND_FILE` / `TOGGLE_PREVIEW_FILE` inverse-set
logic disappears (`_group1-unification-notes.md`).

`FullFileLineViewModel` (`DiffLine` + a precomputed sign) also goes
away — inline the sign in the renderer or push it onto `DiffLine` once.

### 5.3 The read seam, actually enforced

The prototype built `selectInteractions` and then almost no consumer
called it (`_group3-unification-notes.md`). The rebuild enforces this
structurally:

- `state.interactions` is not exported from the store module.
- `useInteractions(state) → InteractionsProjection` is the only export
  consumers can import.
- `InteractionsProjection` is shaped for every consumer up front:
  `{ all, byThreadKey, byFile, byIntent, threads, coverage }`.

If you can't import the raw store, you can't bypass the seam. The
selector cache invalidates on `interactionsRevision` (one counter,
incremented in every write reducer). Coverage, sidebar counts, n/N
walk targets — all read from the same memoised projection.

The same pattern applies to coverage (§6): one projection, three
consumers.

---

## 6. Coverage as a first-class concept

The IDEA promises "coverage-like markers" where AI and human both
contribute. Today this is split: `state.readLines` is human;
`Hunk.aiReviewed: boolean` is AI; the intersection is not implemented;
hunk-coverage / file-coverage are computed in three places.

The rebuild has one projection:

```ts
type LineCoverage =
  | "human"          // reviewer's cursor passed over it
  | "ai"             // an AI Interaction is anchored at or spanning this line
  | "both"
  | "uncovered";

type Coverage = {
  byLine: (file: string, lineNo: number) => LineCoverage;
  perFile: Record<string, { human: number; ai: number; both: number; total: number }>;
  total:   { human: number; ai: number; both: number; total: number };
};

// One memoised projection per (changeset, readLines, interactionsRevision)
function computeCoverage(cs, progress, interactions): Coverage;
```

Consumers: sidebar meter, status bar, hunk header pip, optional
"filter to uncovered" mode in the walk layer. One source, four
readers. The three-place duplication today (`hunkCoverage` /
`fileCoverage` + sidebar walker + status-bar walker — `_group1`) is
just gone.

This also unlocks a feature the prototype gestures at but doesn't
have: "show me only the parts where both I and the AI looked"
becomes one filter expression.

---

## 7. Language services

One registry per layer, shaped the same:

```ts
// server/src/languages/<id>.ts
export interface LanguageModule {
  id: string;
  fileExtensions: string[];
  lsp?: { start(workspaceRoot): Promise<LspClient>; capabilities(): Capability[] };
  // ... etc
}

// web/src/languages/<id>.ts
export interface LanguageRunner {
  id: string;
  fileExtensions: string[];
  canRun(snippet): boolean;
  run(snippet, inputs): Promise<RunResult>;
  parseInputs(snippet): Input[];
}
```

Adding Python becomes: `server/src/languages/python.ts` (pyright LSP)
+ `web/src/languages/python.ts` (Pyodide runner) + register in two
index files. Two files; same shape; same capability surface (§2.4).

This collapses three places where hand-rolled regex shadows the LSP
today (`_group6-unification-notes.md`): `web/src/symbols.ts` (in-diff
symbol index), `web/src/codeGraph.ts` (regex import builder), and
`web/src/runner/parseInputs.ts` (regex param/var extractor). All
become *fallbacks* used when no LSP is available, not defaults.

The runner's `@php-wasm/web-8-3` worker doubles as the analyzer
backend for memory-only PHP click-through (`docs/plans/plan-symbols.md`
already calls this out). Same worker, two requests.

---

## 8. The unified graph

`cs.graph: CodeGraph` is server-resolved LSP, used by the diagram. The
rebuild has *one* graph at the changeset level, consumed by:

- The plan diagram (already today)
- The plan view's entry-points list
- Guide-suggestion generation (today reads per-hunk regex —
  `_group4-unification-notes.md` §4.6)
- The structure map (today computed independently from regex)
- Click-through fallback when LSP misses

```ts
type CodeGraph = {
  nodes: GraphNode[];      // files, symbols
  edges: GraphEdge[];      // imports, references, tests, type-uses
  resolvedBy: "lsp" | "regex" | "mixed";
  capabilities: Capability[];
};
```

Per-file LRU keyed on `(workspaceRoot, ref, language, file, contentHash)`
stays — that's already correct.

`buildPlanDiagram`'s legacy `classifyFileRole` fallback
(`planDiagram.ts:140-142`) goes away — the server always emits enriched
nodes now.

---

## 9. What this enables (architecture-level wins)

A short list of features that become tractable, not because we design
for them but because they fall out of the four primitives:

1. **Cross-machine continuity.** Server owns progress → start the
   review on a laptop, finish on a desktop. The reviewer's "where I
   am" travels with them.

2. **Agent-coordinated review.** Agent reads sign-offs and interactions
   on a stable API. "Have we reviewed file X?" is one query. The IDEA's
   "easily integrate insight from agent interactions" becomes literal.

3. **Verified claims.** Plan claim → AI Interaction. Runner verdict →
   reply Interaction with `intent: "accept" | "reject"`. The plan view
   shows green checks where claims are verified. The runner stops
   producing throwaway state.

4. **Coverage joins.** "Show me files where both I and the AI have
   looked" is one filter expression over the Coverage projection.
   "Show me uncovered hunks" likewise.

5. **PR round-trip with intent.** One Interaction wire shape, push/pull
   with sentinels. Works the same for GitHub today and GitLab tomorrow.
   The `REQUEST_CHANGES` verdict ("≥1 open blocker without an `accept`
   response") is computable from the seam without traversing prose.

6. **Prompt runs as durable artefacts.** Re-open a changeset hours
   later, see all prior prompt runs as Interactions, reply to them,
   re-hand to the runner. Custom prompts cross-machine because they're
   in SQLite, not localStorage.

7. **Live multi-window.** Two windows open on the same changeset both
   see updates in real time; the server is the system of record and
   broadcasts mutations via a subscribe stream. Today's `interactionsRevision`
   counter becomes a server-side concept.

8. **MCP is just another reader.** The agent doesn't read SQLite
   directly through MCP-specific schemas; it reads `/api/changesets/:id`
   like any other client. The Interaction primitive on the wire is what's
   in the store. One contract.

9. **Capabilities surface lets features hide cleanly.** "AI off"
   chip, `def: unavailable` toolbar pill, "PHP runner cold-loading"
   spinner — all read from `useCapabilities()`. New features get
   capability-gated by adding one entry, not by threading a boolean
   through five components.

---

## 10. Staged migration path

Eight phases. The rebuild can ship a usable product after Phase 3;
everything past that is incremental.

**Phase 0 — Types & primitives.**
Land `Anchor`, the expanded `Interaction` with `status`,
`ChangeSet.provenance` / `overlays`, `Capability`. Promote
`Reference.tsx` to the canonical anchor renderer. Migration
is mechanical — most usages already line up.

**Phase 1 — Server-owned progress.**
Move `cursor`, `readLines`, `signedOffFiles`, `signedOffAt` to SQLite.
Bundle the load roundtrip
(`GET /api/changesets/:id → { changeset, interactions, progress }`).
Kills the StrictMode-guard comments in `App.tsx`. Sign-off becomes
agent-readable from this phase onward.

**Phase 2 — One load surface.**
Land `useLoadSurface()`. URL/PR-URL fields collapse to one routing
input. Empty-diff recovery generalises. The five ingest paths share
one error rail.

**Phase 3 — `APPLY_EXTERNAL_UPDATE`.**
Worktree drift, PR overlay, agent replies are one reducer action and
one `useExternalSync<T>` hook. The `Origin` discriminator on Anchor
covers PR sources too.

After Phase 3 the rebuild is usable for the local-worktree + GitHub-PR
review flow that today's prototype targets. Phases 4–7 are
unifications that pay off later.

**Phase 4 — Interactions absorb three more shapes.**
Prompt runs become Interactions with `status: "streaming"`.
Dismissed guides become `intent: "ack"` Interactions. Runner verdicts
become reply Interactions. `PromptRunsPanel` becomes a filtered view
of `InlineThreadStack`. Three stores collapse to one.

**Phase 5 — One graph.**
Unify `StructureMap`, `cs.graph`, per-hunk `referencesSymbols` into one
`CodeGraph` at the ChangeSet level. Guides read `cs.graph`; structure
map derives from it; per-hunk regex becomes the no-worktree fallback.

**Phase 6 — Read seam, enforced.**
Make `state.interactions` and `state.progress` non-exports. Every
consumer reads through `useInteractions(state)` and `useProgress(state)`.
Drift becomes a type error, not a code-review hope. Selectors share one
memo'd projection (which includes Coverage).

**Phase 7 — Language registries.**
`LanguageModule` and `LanguageRunner` unify under one capabilities
surface. Hand-rolled regex symbol/scope analysis becomes fallback,
not default. Python becomes a two-file addition.

Out-of-band cleanups landable any time, low risk:

- One reactive credential prompt component (`CredentialsPanel` +
  `GitHubTokenModal` are 80% the same — `_group8`).
- One `prefs:v1` localStorage document.
- Drop AppleScript folder dialog in favour of `tauri-plugin-dialog`
  (`_group7-unification-notes.md`).
- Drop legacy `classifyFileRole` fallback.
- Drop env-var `ANTHROPIC_API_KEY` warning.
- Rename `Reply*` vocabulary that survived the Interactions migration.

---

## 11. What we explicitly keep

Things the prototype got right; the rebuild preserves rather than
re-imagines:

- **Evidence-is-mandatory.** The plan UI refuses to render a claim
  with no anchor. Anti-LGTM by construction. Don't loosen.
- **Server-as-hard-dependency.** `ServerHealthGate` is a feature.
  Boot fails closed when the server is unreachable; there is no
  browser-only fallback to maintain a phantom of.
- **Keyboard-first walk.** `j/k`, `]/[`, `Shift+M`, `Shift+S`, `n/N`,
  `c/r/a`. Hands stay on the keyboard.
- **One Interaction primitive.** This is the prototype's clearest
  architectural achievement. Build *on* it; the rebuild only extends
  what it covers.
- **Theme token model.** One map, CSS variables on `:root`, persisted
  id, single picker. Already boring.
- **Tauri + Keychain + server credential ladder.** Allowlisted Rust
  commands, server-first ordering, clean degradation for the web
  shape. The right shape.
- **Capability-gated language features.** Disabled is worse than absent.
- **The Anchor concept of "context lines + content hash" for re-anchoring.**
  The `web/src/anchor.ts:findAnchorInFile` algorithm works; it should
  serve `worktree-drift`, `pr-refresh`, and any future `Origin` kind.

---

## 12. What we explicitly drop

- `selectInteractions` as a *suggested* seam — replaced by a
  *structural* one (consumers can't import raw state).
- `TOGGLE_ACK` as a separate action — folded into `INTERACT`.
- `fullExpandedFiles` + `previewedFiles` as two parallel sets — one
  Record.
- `DeliveredInteraction` wrapper — `status` field on `Interaction`.
- Per-target reply enum (`reply-to-ai-note`, `reply-to-hunk-summary`,
  etc.) — one `anchor.kind: "thread"`.
- `ackedNotesToInteractions` fixture bridge — fixtures emit
  Interactions directly.
- `web/src/promptRun.ts` + `web/src/promptStore.ts` as separate
  models — collapsed into Interactions and a small `prompts` SQLite
  table.
- `web/src/symbols.ts` + `web/src/codeGraph.ts` regex paths as
  defaults — kept as no-worktree fallbacks.
- AppleScript folder dialog — `tauri-plugin-dialog`.
- `classifyFileRole` legacy renderer fallback in `planDiagram.ts`.
- The env-var `ANTHROPIC_API_KEY` warning in
  `server/src/index.ts:1446-1450`.
- `interactionViewMode.ts` (already missing; the doc reference is
  stale).
- Six of the seven `shippable:*` localStorage keys — one prefs doc
  carries them.

---

## 13. Risks & trade-offs

**Risk: server ownership of progress creates write traffic.**
Cursor moves are chatty. Mitigation: batch progress writes
(debounced 500ms), or only persist on file boundary / sign-off /
visibility-change. The reviewer can lose 500ms of cursor on a crash;
they cannot lose a sign-off.

**Risk: structural read-seam (private state) hurts test ergonomics.**
Mitigation: export a `__testHelpers` namespace from the store module
for test-only direct access. Production consumers go through the
hook; tests can break the rule explicitly.

**Risk: prompt runs as streaming Interactions complicate the
write-path.**
Server upserts a row with `status: streaming` immediately; chunks
mutate body in place; row flips to `done` (or `error`). One write
amplification per chunk is fine at human-read latency. SSE channel
broadcasts deltas to all subscribed tabs.

**Risk: capability discovery may stall first paint.**
Mitigation: `/api/capabilities` returns from cached state immediately;
a separate `/refresh` rescans. The DiffView never blocks on it.

**Risk: collapsing prompt-runs into Interactions is a UX rework, not
just a data move.**
`PromptRunsPanel` is a single panel today; making it a filter on the
existing thread infrastructure changes affordances. Worth it for the
data wins; design pass needed.

**Trade-off: hosted-backend deferral.**
This architecture is single-tenant in v1. Multi-tenant requires
namespacing `changesetId`s by org/user and adding auth on every
endpoint. Postponed deliberately — the prototype's principle of
"local product good enough to use day-to-day before cloud" stands.

**Trade-off: dropping `selectInteractions` as a non-structural seam
means the consumer-migration work the prototype skipped finally
happens.**
That's the right place for the work: the rebuild is the moment to
absorb the cost, because every consumer in the file gets rewritten
anyway.

---

## 14. Module map (web/)

For grounding. Not prescriptive about every filename.

```
web/src/
  primitives/
    anchor.ts            Anchor, AnchorCtx, re-anchoring
    interaction.ts       Interaction type, threadKey derivation
    changeset.ts         ChangeSet, Provenance, Overlay
    capability.ts        Capability + useCapabilities

  store/
    state.ts             Reducer (4 action families, ~350 lines)
    seam.ts              useInteractions, useProgress, useCoverage
    sync.ts              useExternalSync<T>, the single live channel

  layers/
    ingest/
      useLoadSurface.ts  paste | file | url routing
      worktree.ts        worktree-specific provenance
      githubPr.ts        PR-specific provenance + overlay
      external.ts        APPLY_EXTERNAL_UPDATE producer

    annotation/
      aiPlan.ts          server stream → Interactions
      aiNotes.ts         server stream → Interactions
      composer.ts        c/r/a → INTERACT
      agent.ts           MCP-side write surfaces in store
      prSync.ts          push/pull with sentinels
      runner.ts          mints accept/reject Interactions
      promptRun.ts       streaming Interaction with runRecipe
      guides.ts          cs.graph → Interaction(intent=request)
      clickThrough.ts    jumps mint low-noise context Interactions

    walk/
      cursor.ts
      keymap.ts          single KEYMAP registry → handler + help
      coverage.ts        the projection
      navigation.ts      n/N, ]/[
      signOff.ts

  views/
    DiffView.tsx
    Sidebar.tsx          consumes Coverage projection
    Inspector.tsx
    InlineThreadStack.tsx
    PlanView.tsx
    PromptPicker.tsx
    HelpOverlay.tsx      reads from KEYMAP, no hard-coded chord strings
    StatusBar.tsx
    Reference.tsx        canonical Anchor renderer

  languages/
    typescript.ts        LanguageRunner + LanguageModule
    php.ts               LanguageRunner (PHP-WASM) + LanguageModule (intelephense)
    python.ts            (future) LanguageRunner (Pyodide) + LanguageModule (pyright)
```

`server/src/` mirrors the boundaries:

```
server/src/
  db/                    SQLite, migrations
  changesets/            POST /api/changesets, GET /api/changesets/:id
  interactions/          mutation endpoints + SSE broadcast
  progress/              POST progress, GET progress
  plan/                  stream plan; mints AI Interactions server-side
  prompts/               library + user prompts table
  languages/             per-language LSP modules (unchanged shape)
  capabilities/          GET /api/capabilities, POST refresh
  auth/                  unchanged
  github/                PR proxy, push back
  mcp/                   thin shim over /api/changesets
```

One server-side directory per resource; one client-side layer per
concept. If the layout doesn't tell a new reader where a feature
lives, it isn't a good layout.

---

## 15. Where the IDEA promises land

For closure — every promise in `IDEA.md` mapped to where it lives in
this architecture:

| IDEA promise                                                   | Where it lives                                                       |
|----------------------------------------------------------------|----------------------------------------------------------------------|
| Remain present and engaged                                     | Walk layer + Coverage projection + inline AI notes                   |
| Validate that you understand                                   | Quiz / comprehension as Interactions (`intent: "question"`)          |
| Highlight what you already reviewed                            | Server-owned Progress + Coverage projection                          |
| AI guides you on what to review next                           | Guides as Interactions (`authorRole: "ai"`, `intent: "request"`)     |
| Micro-skills / contextual skill loaders                        | Prompts in SQLite with optional file-pattern scopes; picker filters  |
| Coverage-like markers (AI + human)                             | Coverage projection (§6)                                             |
| Request a teammate's review for a block                        | Block-anchored Interaction with `intent: "request"`; PR push routes  |
| Easily integrate insight from agent interactions               | Agent writes Interactions; UI reads through same seam as user writes |
| Web tool + dual mode (web/TUI)                                 | Server is the system-of-record; TUI is a new client over same API    |
| Work with any two git diffs                                    | `Provenance` discriminator; worktree path is one provenance kind     |
| Persistent reviews                                             | Server SQLite; localStorage holds only loss-tolerant UI state        |
| Connector API for hosts (GitHub, GitLab)                       | `prSync` producer + push module; per-host PAT; sentinel round-trip   |
| Diffs from URL                                                 | `Provenance.kind: "url"`; one ingest path                            |

The architecture has a home for every promise in the founding doc.
That is the test it has to pass.

---

## TL;DR

- Four primitives: `Anchor`, `Interaction`, `ChangeSet`, `Capability`.
- Three layers: Ingest, Annotation, Walk. One read seam per layer.
- Server owns progress + interactions + prompts. Client owns view
  state. Drafts live in localStorage; that's it.
- Four reducer action families.
- One Coverage projection. One CodeGraph. One Anchor renderer.
- Interactions absorb prompt runs, dismissed guides, and runner
  verdicts.
- Ship after Phase 3 (server-owned progress, one load surface, one
  external-update reducer). The rest is incremental.

The rebuild is mostly about taking patterns the prototype already
discovered (one Interaction, one anchor concept, one capability
gate) and applying them everywhere they belong instead of in three
places out of ten.
