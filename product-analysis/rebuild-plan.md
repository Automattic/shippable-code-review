# Shippable rebuild — working plan & handoff

**Status:** in progress. This captures a grilling session that turns the
`product-analysis/` feature outline into a concrete rebuild plan. It is a
*living* decision log, not a finished spec.

**How to resume (method):** we are using the `grill-me` skill —
interview relentlessly, one question at a time, each with a recommended
answer; walk every branch of the design tree resolving dependencies
before moving on; explore the codebase to answer a question rather than
asking when the code can tell us. Pick up at **Open questions** below,
starting with the one marked ← NEXT.

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
Agents are **full peers for reading, comment-writers for writing**:
- **Read:** changeset, plan, review progress, sign-off.
- **Write:** comments, replies, validation reports.
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
type Anchor =
  | { kind: "block";  path: string; lo: number; hi: number; reanchor: ReanchorHint } // line = lo===hi
  | { kind: "hunk";   path: string; hunkId: string }
  | { kind: "symbol"; path?: string; name: string; symbolKind?: string }
  | { kind: "file";   path: string }
  | { kind: "comment"; commentId: string }   // anchoring to a comment = a reply

interface Comment {
  id: string;
  createdAt: string;
  author: Author;                 // identity — STORAGE STILL OPEN (Q-B)
  anchor: Anchor;                 // block/hunk/symbol/file roots a thread; comment = reply
  intent: Intent;                 // comment | question | request | blocker | ack | accept | reject
  body: string;
  validation?: ValidationReport;  // replaces `confidence`
}
```

Consequences (all wins):
- **`target` and `parentId` are gone.** A reply is `anchor.kind ===
  "comment"`. This deletes the `target: line|block|reply` enum and the
  legacy Reply vocabulary §4.10 wanted gone — by construction.
- **Nested replies for free** (a comment can anchor to a reply).
- **Claims are AI-authored comments.** Plan claim / inline AI note =
  `{ author.role:"ai", anchor:{symbol|hunk}, intent:"comment", body, validation }`.
  No separate `claim` kind.
- `Anchor` is the canonical pointer everywhere (§4.1): comments, plan
  evidence, quiz `Question.target` (today `changeset|file|hunk|symbol`,
  `web/src/quiz.ts`), diagram clicks, runner recipes. Promote
  `Reference.tsx` to the one renderer.

### 9. ValidationReport — confidence becomes evidence (partial)
`confidence: low|medium|high` → a rubric of yes/no checks the agent
verified. Aligns with the product's evidence-is-mandatory principle.

```ts
// agent blocker:
validation: { checks: [
  { label: "Reproduced",          result: "yes", note: "test in auth.test.ts" },
  { label: "Tests run",           result: "yes" },
  { label: "Tests pass after fix",result: "no"  },
] }
```
Locked sub-decisions:
- **Checks phrased as positive assertions** so `yes` is always the
  verified/good state. Split ambiguous "Ran the tests" into "Tests run"
  + "Tests pass."
- **Optional `note` per check** (a one-liner / evidence pointer).
- May appear on any comment; **expected on agent action-intents**
  (blocker/request).
- **Check-label source is OPEN** — see Q-A ← NEXT.

Relationship to the **quiz** (human-side "validate you understood",
anti-LGTM): kept **distinct** in v1 (quiz tests the human; validation
reports the agent). Both reuse `Anchor`. Possible future unification;
not now.

---

## Open questions (resume here)

Each has a recommendation. Grill one at a time.

### Q-A. ValidationReport check-label source ← NEXT
Where do check labels come from? **Rec: fixed catalog keyed by intent**
(blocker/bug → {Reproduced, Tests run, Tests pass}; request → {Tests
run}; comment/question → none required). Comparable across comments,
server can *require* them, consistent UI badges. Growth path: **hybrid**
(catalog + optional agent-added extras). Reject free-form (lets an agent
post "Vibes: yes" and skip the real checks — defeats the anti-theater
point) and single-verdict (loses the evidence trail).

### Q-B. Identity storage
Participants table vs embed-per-comment vs derived-view vs hybrid.
**Stakes dropped** now that assignment is gone (no `assigneeId` to
resolve — identity is only for rendering the author badge + provenance).
**Rec to reconsider:** embed a thin `author { role, id, displayName }`
inline for cheap rendering + a lightweight `participants` row holding the
full declared/observed provenance, looked up only when the human
inspects "where from." Not the capabilities/availability registry (still
deferred).

### Q-C. Plan structure — flat comments vs structured document
Is the AI plan a flat list of AI-authored comments, or a structured
**Plan document** (headline + intent claims + structure map + ≤3 entry
points, per `product-analysis/review-plan.md`) that *references*
comments? "Everything is a comment" pulls toward flat, but the plan's
headline/structure-map/entry-points are document-level, not per-anchor.
**Rec (tentative):** keep a thin `Plan` document for the
headline/structure/entry-points, where each **intent claim is a
comment** (AI-authored, anchored, with evidence + validation). The
document is a curated ordering over claim-comments, not a parallel type.
Needs grilling — thesis-central ("where do I start?").

### Q-D. AI claim persistence — durable vs recomputed
Prototype strips `authorRole !== "user"` on persist and regenerates from
ingest (`web/src/types.ts:584`). With server-as-record, do AI
comments/claims persist server-side, or recompute each load? **Rec:**
persist them (server is the record; recompute is wasted tokens and loses
reply threads hung off a claim), with a `generation`/`changesetRev` tag
so a re-ingest can supersede stale AI comments.

### Q-E. Write-through: derived state vs event-source
Write "file X signed off" (derived) or "REVIEWED_LINES h12 10-15"
(events the server folds)? **Rec:** derived-state write-through for v1 —
simplest, and it's exactly what the agent wants to read. Event-sourcing
buys audit history we don't need yet.

### Q-F. Confirm `threadKey` removal
Threading now derives from `anchor.kind === "comment"` chains. Confirm no
dedup/grouping responsibility of the old prefixed `threadKey`
(`note:`/`block:`/`user:`/`teammate:`) is left unhomed.

### Q-G. Anchor details
- Does `hunk` need a `reanchor` hint too (hunks shift on reload)?
- Does `Anchor` need a `changeset` kind? (quiz has changeset-level
  questions.)
- `ReanchorHint` shape: `{ originSha?, originType: "committed"|"dirty",
  hash (FNV-1a), context: DiffLine[] }` — confirm.

---

## Downstream agenda (not yet grilled)

- **Persistence schema** (SQLite tables for comments, progress,
  sign-off, participants; the "one bundle per changeset" load endpoint).
- **MCP tool surface** for the read-peer (get-changeset, get-plan,
  get-progress/sign-off) on top of today's three comment tools.
- **Phasing / sequencing** — revisit §5's Phase 0→7 against this reduced,
  agent-centric scope. Phase 0 = the types above.
- **UI surfaces** — diff-view modes, sidebar, keyboard map, inspector
  (inline vs panel), the agent identity badge, the validation-report
  rendering.
- **Worktree directory picker** — server AppleScript (today, macOS-only)
  vs `tauri-plugin-dialog` (§group7). Cross-platform argues for Tauri;
  keep AppleScript for browser-dev.
- **Ingest** — worktree loader + `APPLY_EXTERNAL_UPDATE`-style reducer
  even though only worktree ships (§4.5, §group7), so reload is one path.

## Carry across unchanged (the prototype got these right)
Evidence-is-mandatory (plan refuses claim w/o evidence); the unified
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
