# Shippable v1 Rebuild — Implementation Plan (master sequence)

> **For agentic workers:** this is the **master sequencing plan**. It covers
> multiple subsystems, so per the writing-plans scope check it does NOT inline
> every TDD step. Each phase below gets its own detailed, bite-sized TDD plan in
> `docs/superpowers/plans/YYYY-MM-DD-rebuild-<phase>.md`, written just before that
> phase is executed. Execute phases in order; each ends at a runnable milestone.

**Goal:** Rebuild Shippable to the `v1-architecture.md` four-primitive design on a
single branch, merging to `main` only when the whole sequence is at parity — without
regressing security, deploy shape, or shipped behavior along the way.

**Architecture:** Four primitives (`Anchor`, `Interaction`, `ChangeSet`,
`Capability`). Server SQLite is the system of record; the client runs a pure reducer
and writes results through. All AI flows through an external MCP agent — the server
holds no Anthropic key. Worktree-only ingest; the agent reads diffs from disk.

**Tech Stack:** React + Vite + TypeScript (web), Node + SQLite (server), Tauri 2
(desktop shell), stdio MCP subprocess (agent bridge).

**Authoritative spec:** `product-analysis/v1-architecture.md`. Where the older
`suggested-architecture.md` / `rebuild-plan.md` / `product.md` disagree, v1-architecture
wins (it supersedes them; see `rebuild-execution-review.md` §1). This plan's phase
order **is** v1-architecture §17 (items 1–11), made executable.

## Global Constraints

Every phase's acceptance criteria implicitly include these. Values copied verbatim.

- **Quality gate (AGENTS.md):** `npm run build` (web) passes; `npm run lint` (web)
  passes; `npm run test` (vitest) passes; `npm run typecheck` (server) passes.
- **Dependency cooldown:** npm/bun installs enforce a **7-day min-release-age**
  (`.npmrc`, `bunfig.toml` on `main`). Don't disable it to pull a fresh dep.
- **Server is a hard dependency** in every shape; `ServerHealthGate` probes
  `/api/health` at boot. No browser-only fallback.
- **React-free core invariant:** `state.ts`, `parseDiff.ts`, `types.ts`, `view.ts`,
  `anchor.ts` import React zero times. ESLint rule + test guard it (Phase 10).
- **Single-port deploy must keep working:** `npm start` serves the built web bundle
  from the Node server (`server/src/static-serve.ts`) with the **same-origin CORS
  exception** in `server/src/index.ts`. Do not regress to two-port-only.
- **Interaction trust boundary must be preserved:** external/agent-authored bodies
  carry a trust `source` and are wrapped as untrusted quoted content before they
  reach any prompt (today: `server/src/agent-queue.ts`, `mcp-server/src/index.ts`).
  The unified `Interaction` must keep this; see Guard G1.
- **No server-side Anthropic** (D1): server imports no LLM SDK; `@anthropic-ai/sdk`
  removed. All AI via MCP.
- **Worktree-only, diff-from-disk** (D2): the memory-only/no-clone deployment mode is
  dropped for v1. Update `AGENTS.md`'s deployment-modes section during Phase 11.
- **Commits:** conventional-ish, match `git log` style. No `Co-Authored-By: Claude`.
- **Branch discipline:** `git push origin <branch>`, never bare push; prefer rebase;
  never force-push.

---

## The one-shot branch process (this is the "without breakage" spine)

The spec chose a one-shot branch merged whole (`v1-architecture.md:1004`). The failure
mode that kills one-shot branches in this repo is **rot**: the last big refactor branch
(`refactor/unify-interactions-seam`) went stale 2026-05-13 and never merged while `main`
moved 24 commits. These rules exist to beat that:

1. **One branch:** `refactor/v1-rebuild` off current `main`. All phases land there.
2. **Rebase on `main` weekly.** Non-negotiable. Absorb drift while it's small —
   especially anything touching security (G1), the deploy shape (G2), or the worktree
   loader. A weekly rebase is minutes; a two-month reconciliation is why the last branch
   died.
3. **Every phase ends runnable.** After each phase the app must boot and its milestone
   flow must work end-to-end in the browser (not just green tests). Phases marked
   **▶ demoable** are the ones a human can actually exercise.
4. **Merge gate (all must hold):** items 1–10 complete; item 11 at its bar; the four
   quality-gate commands green; the Tauri DMG builds via `scripts/build-dmg.mjs`
   (`hdiutil` path, not the Finder AppleScript step); ported tests cover the parity set.
5. **Announce the data drop.** Prototype localStorage/SQLite state is orphaned at merge
   by design. Ship a one-line "previous reviews won't carry over" note in release notes
   and, ideally, a first-run banner.

---

## Pre-flight — reconcile the spec before Phase 1 (half a day, no code)

The spec has internal defects that will hard-fail at `CREATE TABLE` or mislead an
implementer. Fix them in `v1-architecture.md` first so the phases build on solid ground.

- [ ] **Fix the SQLite DDL (`v1-architecture.md:263-376`).** Concrete bugs:
  - `read_lines` PK is `(user_id, changeset_id, file)` but the table declares neither
    `changeset_id` nor `file` (it has `diff_file_id`). Declare the columns the PK needs.
  - `sign_offs`: missing comma after `diff_file TEXT NULL REFERENCES diff_files(id)`;
    PK references `file` but the column is `diff_file`; `changeset_id` present but PK/columns
    inconsistent. Reconcile columns ↔ PK.
  - `agent_queue_pending` index references `type`; the column is `request_type`.
  - `diff_files` uses MySQL `UNIQUE KEY (...)`; SQLite is `UNIQUE (...)`.
  - Trailing comma after the last column in `prompts` (and check `quizzes`).
  - `quiz_responses` is listed in §17 item 2 and referenced by `POST /api/.../quiz/responses`
    but has no `CREATE TABLE`. Add it (or fold responses into `quizzes.answers_json` and
    drop the reference — pick one).
- [ ] **Confirm the two decisions are written into the spec:** D1 (no Anthropic key) is
  already in §3b/§15. D2 (worktree-only, diff-from-disk) is in §17 item 5 / row `:989`.
  No change needed; just verify before starting.

---

## Phase 1 — Primitives  (`v1-architecture.md` §1, §17.1)

**Area:** `web/src/` React-free core — the four types, one file each.
**Deliverable:** `Anchor` (+ `BlockOrigin`), `Interaction`, `ChangeSet` (+ provenance
union), `Capability`, and `Checks = Record<CheckKey, CheckResult>` (note required on
every check) as pure TS with exhaustive type tests. No storage, no UI yet.
**Guard G1 (security) starts here:** `Interaction` must include the trust `source`
field from day one — do not ship the type without it, or Phase 4/6 re-open the
prompt-injection hole `main` closed.
**Acceptance:** type-level tests prove invalid states are unrepresentable (no `target`,
no `parentId`, no `threadKey`, no `status`; a reply is `anchor: {type:"interaction"}`;
a `Checks` missing a label won't compile). `npm run test` green. Core imports React zero
times.
**Detailed TDD plan:** `docs/superpowers/plans/<date>-rebuild-primitives.md` (write next).

## Phase 2 — Server SQLite schema + SSE  (§3, §4.3, §17.2)  ▶ demoable (via tests/curl)

**Area:** `server/src/db/` (schema, migrations, stores), `server/src/` SSE endpoint.
**Deliverable:** the corrected schema from Pre-flight as real tables + a forward
migration runner (the spec moves off `persist.ts`'s "no migration, fail closed" to
normal SQL migrations). Per-ChangeSet SSE channel (`GET /api/changesets/{id}/stream`)
emitting the §4.3 event set.
**Acceptance:** every table creates cleanly; round-trip store tests for interactions,
progress, sign-offs, users; SSE delivers a posted interaction to a listening client in a
test. Server `npm run typecheck` green.

## Phase 3 — Reducer + client state  (§17.3)

**Area:** `web/src/state.ts` (the pure reducer) + client UI-state holders.
**Deliverable:** one `APPLY_EXTERNAL_UPDATE` reducer path for ingest/refresh/SSE;
`LOAD_CHANGESET`, `INTERACT`, `NAVIGATE`, `UI` action families. UI state holds cursor
(memory + localStorage, never server-persisted), `fileDisplayMode` as
`Record<path, "diff"|"source"|"preview">`, drafts, dismissals.
**Acceptance:** reducer unit tests for each action; cursor never hits the server; file
display mode is type-enforced (no two-Set mutex). `npm run test` green.

## Phase 4 — REST + SSE + MCP wire  (§4.1, §4.2, §17.4)

**Area:** `server/src/` REST handlers; `mcp-server/src/` (three tools).
**Deliverable:** REST surface from §4.1; MCP tools `shippable_wait_for_work`,
`shippable_post_interaction`, `shippable_post_plan` (drop the old check/watch/get tools).
Both sign-off tiers via REST.
**Guard G1 (security):** `post_interaction` and the `wait_for_work` payload path must
tag `source` and wrap external bodies as untrusted quoted content — port the protection
from today's `mcp-server/src/index.ts`, don't lose it. Add a test that fails if an
external body reaches a prompt unwrapped.
**Guard G2 (deploy):** keep the single-port static-serve + same-origin CORS exception
intact while adding the new routes.
**Acceptance:** REST endpoint tests; MCP handler tests incl. the G1 wrapping test;
single-port `npm start` still boots and serves the app.

## Phase 5 — Worktree ingest  (§17.5)  ▶ demoable

**Area:** `server/src/worktrees.ts` + `POST /api/changesets/worktree`; client load surface.
**Deliverable:** worktree is the only ingest endpoint that ships; PR/paste/file/url stay
in the `ChangeSetSource` union at the type level only. Diff read from disk (D2). Reuse
the carried-across `parseDiff` (unchanged since merge-base — safe to port as-is).
**Acceptance:** loading a real local worktree produces a `ChangeSet`; the range+dirty
"one diff per file" behavior `main` fixed is preserved. **Milestone: a human can open a
worktree and see the diff.**

## Phase 6 — Diff walk + comments + sign-off (the spine)  (§5, §6, §17 partial)  ▶ demoable

**Area:** `web/src/` views (DiffView, Sidebar, HelpOverlay, InlineThreadStack,
`Reference.tsx`), keymap, coverage projection, sign-off.
**Deliverable:** keyboard walk (`j`/`k`, `Shift+M`, `]`/`[`, `n`/`N`, gutter rail);
line/block/reply comments anchored via `Anchor`; read-lines + cursor write-through
(cursor client-only, sign-off immediate server write); two-tier sign-off; coverage
computed on read. `Reference.tsx` is the one canonical anchor renderer.
**Guard G1:** human-authored bodies are `source: "local"`; any agent/PR body stays
wrapped. **Milestone: a reviewer can walk a diff, comment, and sign off end-to-end.**
**Acceptance:** anchoring survives a reload (re-anchor via FNV-1a + `BlockOrigin`);
sign-off is agent-readable via REST; ported anchoring/coverage tests green.

## Phase 7 — Plan + agent_queue + AI via MCP  (§7, §7b, §3b, §17.6)  ▶ demoable

**Area:** `server/src/plan.ts` (rule plan only — no Anthropic), `agent_queue` store,
watch-mode claim, auto-queue prefs; `web/src/` plan + inspector views.
**Deliverable:** rule plan + rule quiz floor generated synchronously at ingest (Plan
surface never empty); AI plan/review/interaction via `agent_queue` claimed by a watching
MCP agent; reviewer Interactions auto-enqueued as `interaction` items;
`prefs[user:autoQueuePlan]='on'`, `prefs[user:autoQueueReview]='off'`.
**Guard D1:** verify the server holds no Anthropic key and imports no LLM SDK; remove
`@anthropic-ai/sdk`. **Guard (UX):** "Connect an agent" banner when `ai.mcp` capability
reports no watcher — the empty state must read as discovery, not error.
**Acceptance:** with no agent, rule plan renders and all human review works; with a stub
MCP watcher, a `plan` job round-trips and a posted plan appears via SSE.

## Phase 8 — Users + identity surfacing  (§13, §17.7)

**Deliverable:** unified `users` store; composite declared+observed badge; human `userId`
minted client-side (localStorage UUID v4, `X-Shippable-User-Id` header); MCP subprocess
mints its own UUID; `generated_by`/`requested_by`/`claimed_by` populated.
**Acceptance:** badge shows declared vs observed; mismatch is visible; server upserts a
`users` row on first sight for both roles.

## Phase 9 — Capability system  (§17.8)

**Deliverable:** server detects environment; `ingest.worktree` lit, other ingest
capabilities report `{available:false, reason:'Not in v1; PR ingest lands in v1.5'}`;
reactive context; `capability.changed` SSE.
**Acceptance:** capability-gated features hide cleanly (not disabled); `ai.mcp` reflects
watcher presence live.

## Phase 10 — Quiz + TUI invariant guard  (§12, §15, §17.9-10)

**Deliverable:** `quizzes`(/`quiz_responses`) tables + UI + MCP-readable quiz; ESLint
rule + test that fail if the core imports React.
**Acceptance:** quiz round-trips; the React-free-core test fails when a React import is
added to a core file and passes otherwise.

## Phase 11 — Polish (the item-11 bar)  (§17.11)

**Deliverable:** refresh-link flow, error states, prefs UI, `tauri-plugin-dialog` for the
directory picker with AppleScript fallback in browser-dev macOS. **Also: update
`AGENTS.md` deployment-modes to reflect D2** (memory-only dropped for v1).
**Bar for merge:** the polish items above are done or consciously deferred with a note;
the merge gate (top of doc) holds.

---

## Regression guards → phases (traceability)

- **G1 — Interaction trust boundary** (`source` + untrusted-content wrapping): introduced
  Phase 1 (type), enforced Phase 4 (MCP/REST) and Phase 6 (human vs agent bodies).
- **G2 — Single-port deploy + same-origin CORS:** held in Phase 4, re-checked at merge.
- **D1 — No server-side Anthropic:** enforced Phase 7.
- **D2 — Worktree-only / diff-from-disk:** enforced Phase 5; docs updated Phase 11.

## Self-review (done against v1-architecture.md)

- **Coverage:** §1 primitives→P1; §3 schema→P2; §4.1/4.2/4.3 wire→P4 (SSE also P2);
  §5 coverage→P6; §6 sign-off→P6; §7/§7b plan+queue→P7; §9b prompts→P7/P9; §12 quiz→P10;
  §13 identity→P8; §15 invariants→P1/P10; §17 order→phases 1–11; §18 deferrals→out of scope.
- **Not stale:** the core files P1/P3/P5/P6 build on are unchanged since the spec's
  merge-base — safe to port. Only `App.tsx` wiring and the two guard areas (G1/G2)
  drifted, and they're called out.
- **Deferred (spec §18), not in this plan:** PR/paste/file/url ingest, full-file/preview
  modes, multi-user auth, persisted MCP identity, workspace-mode runner, cross-device
  cursor/drafts.
