# Shippable rebuild — working plan & handoff

**Status:** in progress. This captures a grilling session that turns the
`product-analysis/` feature outline into a concrete rebuild plan. It is a
*living* decision log, not a finished spec.

**Progress (last worked 2026-05-26):** locked #9 (Checks — was Q-A),
#10 (Identity storage — was Q-B), #11 (Plan structure — was Q-C),
#12 (AI comment persistence — was Q-D), #13 (Progress write-through —
was Q-E), #14 (`threadKey` removal — was Q-F), and **#15 (Anchor
old-code recovery — was Q-G Part 2)** this session; Q-G Part 1 (the
`changeset` Anchor kind) folded into #8 earlier. #15 reshaped the anchor
model: the old four-field `ReanchorHint` is **gone** — committed code is
re-derived from git by SHA (content-addressing, git's own principle),
dirty code keeps one immutable welded snapshot in OUR store, and the
matching fingerprint is derived not stored. We will **not** write into
the user's `.git`. #11 **revises #8**: plan bullets are a `Claim` type,
NOT comments. #12: AI notes are durable comments (only the `Plan`
regenerates); `changesetId` on `Comment`+`Plan`; staleness is per-anchor.
#13: progress is "save-the-answer," sign-off immediate / cursor+readLines
~1s debounced. #14: threading by parent-pointer (`anchor.kind==="comment"`),
safe because of #12. Earlier model edits: `hunk` folded into `block`,
roles merged to `human | ai`, `Author` the single identity type.

**RESUMED + RESOLVED Q-G Part 2 → #15.** Every lettered question
Q-A…Q-G is now locked. Next is the **Downstream agenda** below — none of
it grilled yet.

**Working rule (top of mind):** the rebuild keeps **zero backwards
compatibility** with the prototype — no migrations, no preserving old
data shapes. Always pick the clean redesign; the prototype's persisted
shapes have no claim on us (drove #15's "drop the stored hash").

**How to resume (method):** we are using the `grill-me` skill —
interview relentlessly, one question at a time, each with a recommended
answer; walk every branch of the design tree resolving dependencies
before moving on; explore the codebase to answer a question rather than
asking when the code can tell us. **Plain-language rule:** explain every
question/option in plain terms first (analogies over jargon), precise
version underneath — the human asked for this explicitly.

**← RESUME HERE:** every Q-letter is locked, so work moves to the
**Downstream agenda** below. Recommended first item: the **persistence
schema** — it's the most foundational (it realizes #4, #12, #13) and #15
explicitly handed it an open thread: where the dirty `BlockOrigin.context`
snapshot lives, and the "one bundle per changeset" load shape. Grilling it
pressure-tests those locked decisions against a concrete SQLite schema.
Confirm the item with the human, then grill one question at a time.

**Source material:**
- `product-analysis/product.md` — the synthesis (feature inventory, tiers, §4 unification opportunities, §5 rebuild sequence).
- `product-analysis/_group{1..8}-unification-notes.md` — cross-cutting notes.
- `product-analysis/<feature>.md` — 30 per-feature analyses (acceptance criteria, current arch, gaps). Not all read yet; pull in per branch.
- `IDEA.md` — the original problem statement / product bets.
- Code cited inline below uses `path:line` against the current tree.

---

## Decisions locked

Ordered as decided. Each is settled unless reopened explicitly.

### 1. Clean from-scratch rebuild
Not an in-place refactor. **Driver:** the prototype was always disposable
(IDEA/README "don't trust it yet") — it existed to validate concepts;
now it gets replaced wholesale. The brief's §4/§6 read like a refactor
backlog, but we are *not* refactoring; we port validated concepts, not
code.

### 2. Scope: proven core only
Rebuild the concepts that validated; drop marginal features. Design the
**types** so they don't preclude collaboration or a TUI, but **do not
build** those surfaces in v1.

### 3. Stack unchanged
React + Vite + TypeScript (web), Node + SQLite (server), Tauri (desktop
shell). The tech-reset option was explicitly declined. The core
(`state.ts` reducer, `parseDiff.ts`, `types.ts`, `view.ts`, `anchor.ts`)
already imports React **zero** times — it's pure TS today — so the TUI
door is nearly free and needs **no formal `core/` package** until a
second consumer actually exists (rule of two).

### 4. State authority: server records, client computes
| Data | System of record | Computed |
|---|---|---|
| comments, readLines, reviewedFiles (sign-off), cursor, dismissedGuides | **Server SQLite** | Browser reducer |
| drafts, theme, view-mode, zoom, recents, anthropic-skip | localStorage | Browser |

- The server is the **system of record**, not a mirror. Lines-reviewed and
  approved-files live there. This is what makes "an agent can ask: did
  the human sign off file X?" work — the IDEA's named target.
- "Client computes" = the browser runs the (pure, fast) reducer for
  instant keystroke response, then **writes the result through** to the
  server. On reload / for agents, the server copy is authoritative;
  the browser rehydrates from it (the §4.4 "one bundle per changeset" load).
- **No server-side compute** (no reducer-on-server, no conflict merge).
  That's the multiplayer build, deferred. Single-user-local only in v1.

### 5. v1 feature line
Take the brief's must-have tier, **minus** paste/file/URL ingest,
**plus** an agent MCP peer:

**In v1:** diff-view, file-sidebar, keyboard-help, review-progress,
sign-off, session-persistence (server-side), comments + replies +
anchoring (incl. block), ai-inspector, review-plan, api-key-setup,
themes, **worktree-directory-picker (the sole ingest path)**, **agent
MCP peer** (see #6).

**Dropped:** plan-diagram (costly LSP+regex, rarely load-bearing);
agent-context-panel's poll-and-scrape implementation (concept folded
into MCP, see #6).

**Deferred to v1.5+:** full-file-view, context-expansion,
guide-suggestions, prompt-library / custom-prompts / prompt-results,
code-runner, click-through-definitions, github-pr-ingest,
commit-range-picker, worktree-live-reload.

**Open-but-unbuilt:** the `provenance` discriminated union still
enumerates `paste | file | url | worktree | pr`; only the worktree
loader ships. Caveat: worktree-only = **disk-required**, which closes
the memory-only / no-clone deployment mode AGENTS.md calls a real
near-term constraint. Acceptable for v1 *if the types don't assume
disk*.

### 6. MCP agent peer scope
Agents (MCP peers — `ai`-role authors, #8) are **full peers for
reading, comment-writers for writing**:
- **Read:** changeset, plan, review progress, sign-off.
- **Write:** comments and replies, each carrying the `checks` rubric (#9).
- **Not in v1:** block assignment (no targeting), activity stream (no
  observation). These were removed when the data model unified (see #8);
  the anchor/intent enums stay *able* to grow into them later.

Current MCP surface to extend (`mcp-server/src/index.ts`): three tools —
`shippable_check_review_comments`, `shippable_watch_review_comments`,
`shippable_post_review_comment` (already supports agent top-level posts
with rationale/suggestedFix/confidence). The MCP server is a stdio
subprocess in the **agent's** environment, talking to the Node server
over `127.0.0.1:<port>/api/agent/*` (`mcp-server/src/handler.ts`).

### 7. Agent identity = composite (declared + observed)
- **Self-declared** (convenient, spoofable): `{ handle, purpose, model }`.
- **Server-observed** (hard to forge — MCP server runs in the agent's
  env): `{ worktreePath, harness (from env/parent-proc), osUser, host,
  firstSeenAt, sessionId? }`.
- Human UI shows a composite badge, e.g.
  `security-review · Claude Opus 4.7 · via Claude Code · ~/work/feat · since 14:32`.
  Mismatch between claimed and observed is visible. Model name alone is
  the *least* useful field (two Claudes are indistinguishable by model).
- **Trust boundary (v1 assumption, not a build item):** self-declared
  identity is **unauthenticated**; any localhost process can claim a
  handle. Acceptable for single-user-local. The moment this goes
  multi-user (collaboration door), identity needs real auth.

### 8. Data model — ONE `Comment` type, discrimination on `Anchor`
The prototype's flat `Interaction` (`web/src/types.ts:587`) is one type
with **12 optional fields** held together by JSDoc ("present on…",
"ignored in reply mode") — invalid states representable. Rather than a
discriminated union over `kind`, we unify harder: **one `Comment`
type**, with the variation pushed onto the **anchor** and the **intent**.

```ts
type Role = "human" | "ai";       // merged: an MCP agent is an `ai` author; *which* ai = identity (#7), not role
type Author = { id: string; role: Role; displayName: string };  // uniform; provenance (#7) stored separately, keyed by id

type Anchor =
  | { kind: "block";  path: string; lo: number; hi: number; origin: BlockOrigin } // line = lo===hi; a hunk is just a block; origin = how to recover the old code (#15)
  | { kind: "symbol"; path?: string; name: string; symbolKind?: string }
  | { kind: "file";   path: string }
  | { kind: "comment"; commentId: string }   // anchoring to a comment = a reply
  | { kind: "changeset" }                     // the whole change (Q-G Part 1); quiz changeset-Q, overall comments, old "description" evidence — no payload (changesetId is on Comment/Plan, #12)

interface Comment {
  id: string;
  changesetId: string;            // membership: which review (#12); stable across re-ingests
  createdAt: string;
  authorId: string;               // → Author.id; reference not embed (#10), expanded on read
  anchor: Anchor;                 // block/symbol/file roots a thread; comment = reply
  intent: Intent;                 // comment | question | request | blocker | ack | accept | reject
  body: string;
  checks?: Checks;                // replaces `confidence` — see #9 (absent = no rubric; when present, complete)
}

// AI plan bullet — its OWN type, NOT a Comment (#11). Read-only, not repliable.
interface Claim {
  text: string;
  references: Anchor[];           // ≥1, mandatory (anti-LGTM); reuses Anchor + Reference renderer
}
```

Consequences (all wins):
- **`target` and `parentId` are gone.** A reply is `anchor.kind ===
  "comment"`. This deletes the `target: line|block|reply` enum and the
  legacy Reply vocabulary §4.10 wanted gone — by construction.
- **Nested replies for free** (a comment can anchor to a reply).
- **`hunk` folded into `block`.** A hunk is just a `block` (line range)
  — one code-range anchor kind, all reanchored on reload. Drops the
  stable `hunkId`; a hunk reference survives via re-anchoring (#15), not an id.
  (Resolves Q-G's hunk question by construction.)
- **Roles merged to `human | ai`.** An MCP agent and the built-in plan
  generator are both `ai` authors; the human tells them apart by
  **identity/provenance** (#7), not by role. `agent` and
  `teammate` drop out of the enum (it stays able to grow back per #2).
- **Inline AI notes are comments; plan bullets are `Claim`s (#11).** An
  inline AI note has one home anchor → it's an AI-authored comment
  `{ authorId, anchor:{symbol|block}, intent:"comment", body, checks }`
  (role `ai`). A *plan bullet* is not a comment: it's a `Claim`
  `{ text, references: Anchor[] }` living in the Plan (#11) — multi-pin
  and not repliable. (Amends the original "all AI output is comments".)
- `Anchor` is the canonical pointer everywhere (§4.1): comments, claim
  `references`, quiz `Question.target` (today `changeset|file|hunk|symbol`,
  `web/src/quiz.ts`), diagram clicks, runner recipes. Promote
  `Reference.tsx` to the one renderer.

### 9. Checks — confidence becomes evidence (RESOLVED, was Q-A)
`confidence: low|medium|high` → a **mandatory rubric** of yes/no checks
the agent verified, each with a free-form comment. Aligns with the
product's evidence-is-mandatory principle. No wrapper type: the field is
`Comment.checks?: Checks` directly (a report-level wrapper bought nothing
— verdict is `intent`, author is `author`, timestamp is `createdAt`).

```ts
type CheckLabel =
  | "Reproduced"          // confirmed the issue occurs
  | "Tests run"           // ran the relevant tests
  | "Tests pass"          // …and they pass (no = they fail — the blocker)
  | "Traced the code"     // read the code path line-by-line (the honest check for non-runnable findings)
  | "Second agent confirmed"; // a second/3rd-party agent reviewed AND agreed

type CheckResult = { result: "yes" | "no"; note: string };  // note REQUIRED — free-form comment on every check
type Checks      = Record<CheckLabel, CheckResult>;          // every label is a key ⇒ all rubrics answered by construction

// agent blocker — didn't consult a second agent, so it says so:
checks: {
  "Reproduced":             { result: "yes", note: "auth.test.ts:42 throws on empty token" },
  "Tests run":              { result: "yes", note: "npm test -- auth" },
  "Tests pass":             { result: "no",  note: "3 failures after the change" },
  "Traced the code":        { result: "yes", note: "validateToken → decode → null deref" },
  "Second agent confirmed": { result: "no",  note: "no second agent consulted" },
}
```
Locked sub-decisions:
- **Flat closed set**, not keyed by intent. Keying `intent × catalog`
  bakes a mapping we have no evidence we need, and mis-fits design
  blockers (no test reproduces a coupling smell). One closed enum.
- **Mandatory full rubric.** The agent answers *every* label, every
  time — it cannot omit the uncomfortable one. Modeled as
  `Record<CheckLabel, CheckResult>` so "skipped a rubric" is
  **unrepresentable** (you can't build a `Checks` missing `Tests pass`).
  Completeness is the type's job; the server only checks *presence*.
- **Not-done = `no`.** Didn't run the tests → `Tests run: no` /
  `Tests pass: no`. The "Tests run" + "Tests pass" split disambiguates
  "ran & failed" (`yes/no`) from "didn't run" (`no/no`) — which is why
  there is **no `na`**: a third state is just the cop-out the mandatory
  rubric exists to prevent.
- **Binary `result`**, phrased as positive assertions so `yes` is always
  the verified/good state (drove the Tests split + "Second agent
  **confirmed**"). Each check carries a **required free-form `note`** —
  the agent justifies every yes/no, including the no's.
- **No hybrid / agent-added extras in v1.** The escape hatch
  reintroduces free-form "Vibes: yes". Growing the enum is a one-line
  change we own; add labels (`Build passes`, `Typecheck passes`) the
  first time a real finding needs them, not speculatively.
- **Scope:** required on `role:"ai"` + `intent ∈ {blocker, request}` —
  the agent-posted findings that ask the human to act (an MCP agent is an
  `ai` author, #7). Omitted elsewhere (incl. human authors and any
  `comment`/`question`/`ack`/`accept`/`reject`), including the plan
  generator's `ai` + `comment` output
  (it carries an `anchor` for evidence but no test rubric — the plan
  generator orients, it doesn't run tests).
- **All checks are self-attested in v1** (no runner verifies them yet).
  The win is a comparable, requirable, filterable vocabulary — *what the
  agent reports it did* — not machine verification. Verification waits for
  the (deferred) code-runner.

Relationship to the **quiz** (human-side "validate you understood",
anti-LGTM): kept **distinct** in v1 (quiz tests the human; checks
report the agent). Both reuse `Anchor`. Possible future unification;
not now.

### 10. Identity storage — reference, not embed (RESOLVED, was Q-B)
`Comment` carries `authorId: string` → an `Author` record, never an
embedded author copy. One source of identity; "same `id`, two different
`displayName`s" is unrepresentable (the drift embedding would allow).
The composite declared/observed provenance (#7) hangs off the `Author`,
present only for the `ai` authors that have it — a human is just an
absent provenance row.

- **No join cost:** the load bundle ships `authors` next to `comments`
  (#4), and live/SSE updates carry any newly-seen author, so a comment
  is never rendered without its author in hand.
- **Read wire is denormalized:** stored normalized (`authorId`), the
  read API / MCP **expands `author` inline** so an agent's "get comments"
  returns names with no second call.
- Not the capabilities/availability registry (still deferred).

### 11. Plan structure — `Claim` is its own type (RESOLVED, was Q-C)
A plan bullet is a **`Claim`**, not a `Comment`. This **revises #8** ("all
AI output is comments"): *inline* AI notes stay comments (one home
anchor); *plan bullets* are their own read-only type.

```ts
interface Claim {
  text: string;
  references: Anchor[];       // ≥1, mandatory — the anti-LGTM rule; named `references`, not `evidence`
}

interface Plan {              // thin, per-changeset singleton; regenerate = overwrite in place
  changesetId: string;        // membership (#12); the plan is for this review
  headline: string;           // = verbatim cs.title (derived, never generated — plan.ts:378)
  intent: Claim[];            // model output
  map: StructureMap;          // deterministic changeset walk (derived — buildStructureMap)
  entryPoints: EntryPoint[];  // ≤3; each { fileId, hunkId?, reason: Claim }
}
```
Locked sub-decisions:
- **Multi-reference retained.** A claim keeps `references: Anchor[]` (the
  prototype's `Claim.evidence: EvidenceRef[]`, rendered as clickable chips
  — `ReviewPlanView.tsx:489`). The single-anchor rule from #8 was a
  *Comment* constraint and never bound claims — which dissolves the
  original Q-C.1 A/B framing as the wrong question.
- **Not repliable in v1.** Plan bullets are read-only orientation. The
  three things a `Comment` has that a `Claim` lacks — author, intent,
  threading — are exactly what we decline for plan bullets. ("Comment on
  this claim" is a flagged future in `review-plan.md`; revisit later, it's
  a small bridge.)
- **The Plan is mostly derived.** `headline` verbatim title; `map` a
  deterministic walk. Only `intent` + `entryPoints` (+ quiz questions) are
  model output, so the stored Plan is thin. (Resolves Q-C.2 / Q-C.3.)
- **Field named `references`, not `evidence`.** Aligns with the canonical
  `Reference.tsx` renderer; an `Anchor` *is* a reference. The *principle*
  stays "evidence-is-mandatory" — only the field carries the structural
  name.

Unification with comments (the "what's worth borrowing" branch):
- **Share the pin, keep types apart.** `Claim.references` and
  `Comment.anchor` both use the one `Anchor` + `Reference` renderer
  (#8/§4.1). That's where the usefulness travels; no type merge.
- **No references/evidence field on `Comment` yet.** Add
  `evidence?: Anchor[]` to `Comment` only when a real AI *finding*
  (blocker/request) needs a second pin beyond its home anchor — one-field
  change, renderer ready. Not speculative (matches #9's "add when needed").
- **`checks` (#9) and a claim's `references` are distinct cousins.**
  `checks` = procedural backing ("what I verified"); `references` =
  locational backing ("where this is true"). Keep both; don't collapse.

### 12. AI comment persistence — durable comments, only the Plan regenerates (RESOLVED, was Q-D)
The prototype recomputes AI annotations: its localStorage blob strips
`authorRole !== "user"` and regenerates from ingest (`web/src/types.ts:584`).
That was an artifact of AI notes never being first-class persisted
comments. In the rebuild they **are** comments (#8), so:

- **Inline AI notes are durable comments.** They persist server-side
  like any comment (#4) — *comments don't recompute, they persist*.
  Generated once by the annotation pipeline (just another `ai` author,
  same shape as an MCP peer, distinguished by identity #7), then they
  live as durable comments and **re-anchor on drift** like any comment.
  A stale AI note is handled exactly like a stale human comment
  (relocates, or detaches if its lines vanish).
- **Only the Plan regenerates.** The `Plan` is a per-changeset singleton;
  regenerate **overwrites it in place**. Claims aren't repliable (#11),
  so replacing them loses no human work. Comments are never batch-superseded.
- **No generation tag, no changeset rev.** Staleness lives entirely at
  the **anchor** level — a `Comment`'s `anchor` *and* a `Claim`'s
  `references` both re-anchor, so "stale" = "its pointer detached." No
  monotonic counter, no content-version field anywhere.
- **`changesetId` on `Comment` and `Plan`** (was the proposed
  `changesetReference`, simplified to just the id). Pure membership:
  which review a comment/plan belongs to; self-describing on the
  agent read wire (#10). **Not** a version — drift is the anchor's job.
- **Assumption (flag for ingest/persistence design):** a changeset's
  `id` is **stable across re-ingests** (drift mutates content in place,
  matching the prototype's `RELOAD_CHANGESET`). That's what lets
  `changesetId`-as-membership survive drift while anchors re-anchor
  within it.
- **Deferred:** a *second* AI pass over a drifted diff would need dedup
  ("already noted this"). v1 generates once; skip it.

### 13. Progress write-through — save-the-answer, two write speeds (RESOLVED, was Q-E)
Moving review *progress* (cursor, readLines, sign-off) server-side (#4)
is genuinely new: the prototype's SQLite SDD migrated **interactions**
only — *"`persist.ts` keeps only review progress"* — so progress is still
the `shippable:review:v1` localStorage blob today. Two axes:

- **Axis 1 — source of truth: derived state ("save the answer").** The
  client computes state and writes the *result* through; the server keeps
  the latest, overwriting. No event log. Matches the interactions SDD's
  per-mutation upsert. An agent reads current state directly (the IDEA's
  *"did they sign off X?"* is a state query, not a history query).
  Event-sourcing — tempting for `readLines` (additive, commutative,
  audit) — is **deferred**: v1 is single-user-local (no multi-window
  merge yet, #4) and needs no audit. If it ever lands, `readLines` is the
  natural first thing to event-source. Door open, unbuilt.
- **Axis 2 — write frequency: two speeds.** `readLines` is
  *"auto-populated on every cursor move"* (`types.ts:260`) and `cursor`
  moves every `j`/`k`, so per-keystroke writes are needless chatter; but
  sign-off is rare, deliberate, and must not be lost.
  - **Sign-off (`reviewedFiles`, `reviewedChangesets`) → immediate**,
    per-gesture write. Agent-readable the moment it happens; never lost.
  - **cursor + readLines → coalesced ~1s debounce**, flushed on
    `visibilitychange`/`beforeunload`. Lose ≤1s of walk position on a
    crash — acceptable; no agent depends on the live cursor.
- **v1 progress = `{ cursor, readLines, reviewedFiles, reviewedChangesets }`.**
  No `dismissedGuides` — guide-suggestions are deferred to v1.5+ (#5),
  so there are no dismissals to store.

### 14. `threadKey` removed — threading by parent-pointer (RESOLVED, was Q-F)
The prototype's prefixed `threadKey` (`note:`/`block:`/`user:`/`teammate:`/
`hunkSummary:`/`userFile:`/`blockFile:`/`dt:`, parsed by `parseReplyKey`
`types.ts:725`) did **six** jobs; all rehome, so it's removed:

| `threadKey` job | Rehomed to |
|---|---|
| threading (same key = one thread, `App.tsx:317`) | parent-pointer: `anchor.kind === "comment"` → root |
| encode location | structured `anchor` (block/symbol/file) — no string parsing |
| encode kind/source (`note`=AI / `user` / `teammate`) | `author.role` + identity (#7/#8) + `anchor.kind` |
| de-collision (`:id` suffix) | every comment's own `id` — separate comments, separate threads |
| reply-anchor reconstruction (`buildReplyAnchor`) | a reply *is* `{kind:"comment", commentId}` — no reconstruction |
| detached threads (`dt:` synthetic key) | derived: anchor failed to re-anchor; replies stay threaded by id |

Deletes `parseReplyKey`, `buildReplyAnchor`, `lineNoteReplyKey`,
`hunkSummaryReplyKey`, `teammateReplyKey`, `userCommentKey`,
`blockCommentKey`, `userFileCommentKey`, `blockFileCommentKey`, `noteKey`,
`mintCommentId` — and the `lastIndexOf` colon-gymnastics forced by
colon-bearing PR hunkIds (`pr:host:owner:repo:N`).

- **Safe *because of #12.*** The old key was location-derived so a
  **recomputed** AI note (fresh id each reload) re-attached its reply by
  landing on the same key. Durable notes (#12, stable ids) let replies
  thread by id instead. #8 id-threading and #12 durability are mutually
  load-bearing — remove `threadKey` only because notes are now durable.
- **Behavior change (improvement, but named):** `note:<hunk>:<line>` and
  `teammate:<hunk>` carry no id, so the prototype **merged** multiple AI
  notes on a line / teammate comments on a hunk into one thread. The new
  per-comment id means they **don't merge** — two findings = two threads.
- **Deferred flag:** `guide:<id>` was also a threadKey (dismissed-guides-
  as-ack, §4.2). Guides are v1.5+ (#5); when they return, a dismissal
  needs a threading home (the guide needs an id to ack against).

### 15. Anchor old-code recovery — content-addressed, never touch `.git` (RESOLVED, was Q-G Part 2)
Re-anchoring needs the **old** version of a commented line — to relocate
it after the diff moves, or to caption it once detached. Where that old
code comes from splits by whether git can address it, applying git's own
principle (content-addressing + immutability) **in our store, without
writing to the user's `.git`.**

- **Committed → git IS the storage.** `git show <sha>` reproduces the
  exact old diff, deterministically, on demand. Store only the address
  (`{ sha }`) + position; re-derive the window when needed — no snapshot.
  A fixed commit's diff is immutable, so committed anchors barely
  re-anchor at all (only when HEAD advances, and then both sides are
  SHA-addressable). **Caveat:** recoverable only while the commit is
  reachable — a rebase/amend can orphan it and GC eventually prunes it.
  Accepted over copying.
- **Dirty → we hold one immutable snapshot.** Uncommitted content has no
  SHA; git can't reconstruct it and forgets it on the next edit. So a
  dirty anchor welds a frozen 10-line `context` window **at write time** —
  the only unavoidable copy. Lives in OUR store (SQLite TEXT). Capturing
  it at write time is mandatory: it's the one moment the content exists.
- **Rejected — writing blobs into `.git`.** `git hash-object -w` would
  give dirty content a SHA too, collapsing both cases to `{ sha }`. We
  decline it: it mutates the repo under review, forces us to manage git
  GC/reachability (a `notes` ref to survive prune), and is heavy machinery
  for a ~10-line minority payload a TEXT column holds with zero intrusion.
  Steal git's *principle*, not its object store.
- **The matching fingerprint is derived, never stored.** Relocation scans
  the new diff, fingerprinting each candidate window (cheap FNV-1a) and
  comparing — O(lines in the changed file), the same cost whether or not a
  target hash was persisted. Storing it saved one hash out of hundreds, so
  it's dropped (a back-compat-free call, per the working rule). The
  committed window is fingerprinted right after `git show`; the dirty
  window from its welded `context`. FNV, **not** a crypto SHA: a collision
  here = a missed match (same outcome as no match), so identity-grade
  hashing is unneeded — git needs crypto for identity, we need cheap for
  fuzzy relocation.
- **`ReanchorHint` (the old four-field struct) is gone.** `originSha` →
  the committed `sha`; `originType` → the union discriminant; `context`
  survives only on dirty anchors; `hash` is derived. The block anchor:

```ts
| { kind: "block"; path: string; lo: number; hi: number; origin: BlockOrigin }

type BlockOrigin =
  | { type: "committed"; sha: string }      // git re-derives the window; nothing else stored
  | { type: "dirty"; context: DiffLine[] }  // git can't address it → immutable snapshot in OUR store
```

- **Perf: off the hot path.** Re-anchoring fires on reload (diff content
  changed), never on a keystroke (`j`/`k`/typing don't touch it). The
  committed `git show` is per-file (not per-comment), batched into a moment
  already running git for re-ingest, and cacheable per `(sha, path)` if it
  ever shows up hot.
- **Detached** still falls out of a failed re-anchor (#14); the caption
  reads old code from git (committed) or the welded `context` (dirty).
  Whether "detached" is a derived flag or its own `Anchor` kind is a
  UI-model detail deferred to the UI-surfaces branch.
- **Open thread for the persistence-schema branch:** `BlockOrigin.dirty`
  is the only anchor that carries stored content; the SQLite design must
  hold its `context` (and the schema can content-address it for dedup
  later — inline is fine for v1).

---

## Open questions (resume here)

Each has a recommendation. Grill one at a time.

### Q-G. Anchor details — RESOLVED → #15
**Part 1 (changeset kind)** folded into #8's model block — `{ kind:
"changeset" }` is the canonical "whole change" pointer (quiz changeset-Q1,
the old `EvidenceRef { kind: "description" }`, changeset-level comments /
sign-off), no payload.

**Part 2 (re-anchoring / old-code recovery)** resolved as **#15**, *not*
as the doc's earlier "confirm all four `ReanchorHint` fields." The
four-field struct is gone: committed code re-derives from git by SHA,
dirty code keeps an immutable welded snapshot in our store, the matching
fingerprint is derived, and we never write to `.git`. See #15 for the
`BlockOrigin` shape and rationale.

**All lettered questions Q-A…Q-G are now locked.** Work moves to the
**Downstream agenda** below — none of it grilled yet.

---

## Downstream agenda (not yet grilled)

- **Persistence schema** (SQLite tables for comments, progress,
  sign-off, authors; the "one bundle per changeset" load endpoint).
- **MCP tool surface** for the read-peer (get-changeset, get-plan,
  get-progress/sign-off) on top of today's three comment tools.
- **Phasing / sequencing** — revisit §5's Phase 0→7 against this reduced,
  agent-centric scope. Phase 0 = the types above.
- **UI surfaces** — diff-view modes, sidebar, keyboard map, inspector
  (inline vs panel), the agent identity badge, the `checks` rubric
  rendering.
- **Worktree directory picker** — server AppleScript (today, macOS-only)
  vs `tauri-plugin-dialog` (§group7). Cross-platform argues for Tauri;
  keep AppleScript for browser-dev.
- **Ingest** — worktree loader + `APPLY_EXTERNAL_UPDATE`-style reducer
  even though only worktree ships (§4.5, §group7), so reload is one path.

## Carry across unchanged (the prototype got these right)
Evidence-is-mandatory (plan refuses an unanchored AI comment); the unified
primitive (we're unifying *harder*); server-as-hard-dependency +
`ServerHealthGate`; keyboard-first walk (`j`/`k`, `Shift+M`, `]`/`[`,
`n`/`N`, gutter rail); theme token model; Tauri + sidecar + Keychain
credential ladder; capability-gated language features ("disabled is
worse than absent").

## Unification opportunities still in play (from product.md §4)
§4.1 one Anchor + one renderer (adopted, #8). §4.2 fold prompt-runs /
dismissed-guides / runner-verdicts into the comment model (when those
features return). §4.3 actually consume the read seam / one coverage
projection. §4.4 server persistence (adopted, #4). §4.5 provenance union
+ one external-update reducer. §4.6 one graph at different granularities
(deferred with diagram/click-through). §4.7 one reactive credential
prompt + one prefs doc. §4.8 capability + language-module registry
(deferred with runner/click-through). §4.9 mode-as-Record. §4.10 finish
half-done migrations (mostly moot in a clean cut).
