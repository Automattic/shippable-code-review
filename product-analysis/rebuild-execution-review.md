# Rebuild execution review — how to land it without breaking things

**Purpose:** the `product-analysis/` set describes a from-scratch rebuild of
Shippable. This doc reviews *how to execute it without breakage* — it does
not re-litigate the design. Read `v1-architecture.md` first; this sits on top.

**Method:** analysis done in worktree `trunk-refactor-analysis` (current `main`
+ the `product-analysis/` tree overlaid from `origin/trunk`). Evidence is cited
`file:line` against that tree.

---

## 0. TL;DR

- **There are three overlapping specs, not one.** `v1-architecture.md` is the
  authoritative one (newest, and it explicitly supersedes the other two). The
  other two are historical and disagree with it on strategy and scope. Anyone
  picking up "the refactor" must be told which doc governs, or they build the
  wrong thing.
- **The spec's own chosen strategy is a breakage strategy by design:** a
  *one-shot refactor on a separate branch, zero back-compat, prototype data
  dropped at merge* (`v1-architecture.md:1004`). So "without breakage" cannot
  mean "preserve old data" — it must mean *don't leave the shipped app broken,
  and don't let the branch die before it lands.*
- **The dominant risk is empirical and already visible in this repo:** the last
  big refactor branch (`refactor/unify-interactions-seam`, the Interaction-
  primitive unification) went stale on **2026-05-13** and never merged, while
  `main` moved **24 commits in ~7 weeks**. A one-shot branch that rebuilds
  ~34k LOC across 15 features will face that same drift pressure at far greater
  magnitude. Branch rot — not data migration — is what "breaks" this.
- **Three concrete regressions to guard** (details in §4): a prompt-injection
  protection the spec predates; a deploy shape the spec predates; and a
  fundamental change to the out-of-box AI experience that reads as a feature
  removal.

---

## 1. What "the refactor spec" actually is

Four docs, one supersession chain (dates = last commit on `origin/trunk`):

| Doc | Date | Status | Model |
|---|---|---|---|
| `product.md` | 05-25 | feature inventory + §5 phasing | old `Interaction` |
| `suggested-architecture.md` | 05-26 12:51 | **superseded** (says so in its header) | `Interaction` w/ status |
| `rebuild-plan.md` | 05-26 16:16 | **superseded**; grill log #1–#15 | `Comment` + `Claim` |
| **`v1-architecture.md`** | **05-27 18:07** | **AUTHORITATIVE** | four primitives |

`v1-architecture.md:5`: *"Supersedes `suggested-architecture.md` and
`rebuild-plan.md` (both preserved as working notes)."*

**The trap:** the authoritative doc chose "one-shot branch" (`:1004`) but gives
only a thin sequencing sketch. The *rich* phased breakdown — Phase 0→7 with
"usable after Phase 3" — lives in the **superseded** `suggested-architecture.md:634`
and the **superseded** `product.md:§5`, and both are written against the *old*
data model. So the two documents that tell you *how to sequence the work* are
exactly the two that were retired, and their sequencing assumes types that
`v1-architecture.md` replaced. That gap has to be closed before anyone starts:
**re-derive a phase plan against the four-primitive model.**

---

## 2. The core tension: "without breakage" vs. the chosen strategy

`v1-architecture.md:957,1004` picks, deliberately, over the alternatives:

> Strategy: one-shot refactor on a separate branch. Not strangler-fig in-place
> on `main`; not a clean rebuild from zero. [...] Zero backwards compatibility
> with the prototype's persisted shapes — prototype data is dropped at merge.

This is a reasonable call for a prototype the README says not to trust. But it
means three things are **not** what "without breakage" can protect:

- Existing localStorage review state and existing SQLite interactions are
  **orphaned at merge**. No migration is written *by design*. Acceptable — but
  make it an explicit, announced decision, not a surprise on first launch.
- There is no incremental fallback on `main`: the branch is either merged whole
  or not at all. That concentrates all integration risk at one moment.

So the honest reframing of the request: **"how do we run a one-shot rebuild
branch so that (a) `main` stays shippable throughout, (b) the branch reaches
merge before it rots, and (c) the merge doesn't silently drop behavior or
security we already have."** The rest of this doc is that.

---

## 3. The failure mode this repo has already demonstrated

`refactor/unify-interactions-seam` (9 commits, +5,742/−4,409, the "one shape for
every review signal" work) is the previous attempt at the *same* unification the
rebuild centers on. Last commit **2026-05-13**; never merged; `main` has since
advanced 30 commits over its fork point. It is, in effect, dead.

The rebuild is that effort an order of magnitude larger. The lesson is not
"don't branch" — it's that a long-lived one-shot branch against a fast trunk in
this repo does not survive on its own. Every mitigation in §5 is aimed at this.

---

## 4. Concrete breakage risks (verified) and their guards

### 4.1 Security regression — the interaction trust boundary
`main` shipped prompt-injection hardening after the spec was written: every
interaction now carries `source: "local" | "external"` and external bodies are
wrapped in `<untrusted-quoted-content>` (`server/src/agent-queue.ts`,
`mcp-server/src/index.ts`). **`v1-architecture.md` contains no mention of it** —
grep for `untrusted`/`CommentSource`/`quoted-content` returns nothing on the
interaction body. The unified `Interaction`, as specified, drops back to an
untagged body.
**Guard:** carry the trust `source` field and the untrusted-content wrapping
into the new `Interaction` primitive as a Phase-0 requirement. Add a test that
fails if an external body reaches a prompt unwrapped.

### 4.2 Deploy shape the spec predates — single-port `npm start`
`main` added a third deploy shape: the server can serve the built web bundle so
the whole app runs on one port (`7cb203e`, `server/src/static-serve.ts`,
`scripts/start.mjs`), with a **same-origin CORS exception** in
`server/src/index.ts`. The spec's deployment reasoning still assumes only
dev + Tauri sidecar.
**Guard:** the new server must keep serving the single-port shape and preserve
the same-origin exception; don't regress `npm start` to two ports.

### 4.3 The out-of-box AI experience changes fundamentally (biggest product call)
This is the one to escalate to a human before any code. `v1-architecture.md:388,
467,915` make it a load-bearing invariant: **the server holds no Anthropic key,
imports no LLM SDK, and makes no LLM calls; all AI flows through an external MCP
agent.** Today the desktop app produces an AI plan and streaming review with
just an `ANTHROPIC_API_KEY`. After the rebuild, **with no MCP agent connected
there is no AI at all** — no plan, no review, no inline notes. To a current user
that is indistinguishable from "the AI features were removed."
**This is not a breakage the execution plan can paper over — it's a product
decision.** Confirm it is truly intended for v1, and if so, design the
empty-state/degradation and onboarding for "AI requires connecting an agent"
loudly. (The spec gestures at degradation banners but the first-run story is
the risk.)

### 4.4 Disk-required is now baked into the data flow, not just ingest
`v1-architecture.md:989` drops shipping diff content over MCP — *"the agent
reads diff from disk."* Combined with worktree-only ingest (paste/file/url/PR
all deferred to v1.5), this hard-codes a local checkout into the architecture,
which directly contradicts the **memory-only / can't-clone-to-disk** constraint
AGENTS.md:70 calls "a real near-term constraint, not an edge case."
**Guard:** at minimum keep the *types* disk-agnostic (the spec asks for this
elsewhere), but recognize that "agent reads from disk" is stronger than
"worktree-only ingest" and reopens a constraint the team said mattered. Decide
consciously; don't let it arrive as an emergent property of the MCP change.

### 4.5 The test suite is the executable spec — don't drop it on the floor
Current: **57 test files, ~15k LOC** (`web/src/*.test.*`), plus server and
mcp-server suites. A from-scratch rebuild that doesn't port *test intent* loses
the only regression net for behavior the prototype got right (`product.md:§6`
lists these: evidence-mandatory, keyboard walk, ServerHealthGate, etc.).
**Guard:** treat the existing tests as behavior specs to re-express against the
new types, feature by feature, before deleting them. "Green build" on the new
branch means nothing if it tests a tenth of what shipped.

### 4.6 Spec-internal schema bugs will bite at table-creation time
The v1 SQLite DDL in `v1-architecture.md:§3` has internal inconsistencies
(e.g. `quiz_responses` referenced but absent from the DDL box; `read_lines` /
`sign_offs` primary keys reference columns not declared). These are cheap to fix
on paper and expensive to hit as a `CREATE TABLE` error mid-Phase-1.
**Guard:** reconcile the DDL before Phase 0 lands; it's the foundation the
"server is system of record" decision rests on.

### 4.7 What is *not* a risk (checked, so we don't over-plan)
The core files the spec reasons about — `state.ts`, `types.ts`, `persist.ts`,
`parseDiff.ts`, `anchor.ts`, `view.ts`, `quiz.ts` — are **unchanged since the
spec's merge-base** (`34d9248`). Their data-model citations are still accurate.
Only `App.tsx` line references drifted (wiring, not model). So the "spec is
stale" worry is real for §4.1–§4.2 only, not for the type model.

---

## 5. Recommended way to run it without breakage

Honor the spec's clean-cut intent, but defuse the branch-rot failure mode:

1. **Reconcile the spec into one execution plan first.** Re-derive a phase
   sequence against `v1-architecture.md`'s four primitives (the existing Phase
   0→7 lives in superseded docs on the *old* model). Fold §4.1–§4.6 guards into
   it as explicit acceptance criteria. Fix the DDL. Output: one plan doc the
   branch executes against.
2. **Resolve the two product decisions before code** (§4.3 AI-via-MCP-only,
   §4.4 disk-required). They reshape onboarding and deployment; a wrong default
   here is the most expensive kind of rework.
3. **Keep the branch always-runnable, vertical-slice by vertical-slice.** The
   spec is right that it's one branch; the mistake to avoid is a multi-week dark
   period. Sequence so that after each slice the app boots and one flow works
   end to end (the superseded phasing's instinct — "usable after Phase 3" — is
   worth keeping even though its model changed).
4. **Rebase the branch on `main` weekly, and hold the line on scope.** The v1
   feature line is already cut down; keep it cut. Every week absorb `main`'s
   drift — especially security (§4.1) and deploy (§4.2) — so the merge is never
   a big-bang reconciliation.
5. **Gate the merge on parity + build + tests.** Merge only when the v1 scope
   reaches parity (or accepted-drop), the Tauri DMG builds (`scripts/build-dmg.mjs`,
   `hdiutil` path), and the ported tests pass. Not before.
6. **Announce the data drop.** Since prototype data is dropped by design, ship a
   one-line "previous reviews won't carry over" note rather than letting first
   launch look like data loss.

---

## 6. Decisions (resolved 2026-07-08)

- **D1 — AI via MCP only: CONFIRMED.** The server-holds-no-Anthropic-key
  invariant (§4.3) is the real v1 target. Consequence to design: the first-run
  experience must make "AI requires connecting an agent" explicit; with no agent
  connected there is no plan/review/inline-AI.
- **D2 — Disk-required: ACCEPTED.** v1 is worktree-only, diff read from disk
  (`v1-architecture.md:989`). The memory-only / no-clone deployment mode
  (AGENTS.md:70) is **dropped for v1**. Follow-up: update AGENTS.md's deployment-
  modes section during the rebuild so the docs stop claiming a constraint v1
  intentionally abandons.
- **D3 — One-shot branch: CONFIRMED.** One branch, one merge (`:1004`). The
  anti-rot mitigations that stay compatible with one-shot still apply: weekly
  rebase on `main` (absorb §4.1 security + §4.2 deploy drift), hard scope hold,
  and gate the merge on parity + DMG build + ported tests (§5.4–§5.6). The
  "slices to `main` behind a flag" alternative is dropped.
- **D4 — Reconciled phase plan: to be written next.** The authoritative doc
  has no step-by-step build order on the four-primitive model; the only phased
  plans (`suggested-architecture.md:634`, `product.md:§5`) are superseded and
  describe the *old* model. This doc's author to produce the reconciled
  build-order plan before code starts.
