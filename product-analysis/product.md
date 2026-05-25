# Shippable — Product Analysis

A product-level read of the current prototype, distilled from per-feature
analyses under this folder. Each feature has its own file (`<feature>.md`)
with the full breakdown — acceptance criteria, current architecture, gaps,
rebuild opportunities. This document is the synthesis: what's in the
product today, what should ship in a rebuild, and where the same idea is
implemented two or three ways and could collapse into one.

The per-group cross-cutting notes are in `_group{1..8}-unification-notes.md`.

---

## 1. What the product is

Shippable is a code-review tool that walks a human reviewer through a
diff. The wager (`IDEA.md`) is that the *review* side of the AI-coding
loop deserves a first-class tool — most existing tools are built around
editing or around bots that post PR comments. Shippable aims to keep a
human present and engaged while they process the day's diffs, whether
those came from a teammate, an agent, or themselves.

The current shape (see `docs/overview.md`):

- Open a diff (paste, file, URL, local worktree, or GitHub PR).
- An AI **plan** describes the change with a headline, intent claims, a
  structure map, and ≤3 entry points. Every claim points back to a
  hunk, file, or symbol — never floats.
- The reviewer **walks the diff** with the keyboard. A cursor tracks
  every line passed over; a gutter rail shows what's been read; each
  file gets an explicit sign-off gesture.
- **AI notes** ride inline on the lines they're about. The reviewer can
  ack/reply/run them. For JS/TS and PHP hunks, an AI note can hand a
  snippet to an in-browser **runner** that verifies the claim.
- A **prompt library** ships with the app and is editable. Selecting a
  hunk and running a prompt streams a response back.
- Reviews **persist** locally (cursor, sign-off, drafts in localStorage;
  comments/replies in server SQLite).
- Same web app runs in Vite for development and inside a Tauri shell
  for the desktop DMG. The Node server is a hard dependency in every
  shape (`docs/architecture.md:8`).

The product is explicitly a prototype — the README and IDEA both say
"don't trust it yet" — but the architectural decisions still matter
because we don't want to ship into corners we can't escape later.

---

## 2. Feature inventory

The product surface decomposes into eight functional groups. Each
feature has its own analysis file; links below.

### Diff viewing & navigation — `_group1-*.md`
The reading surface and the keyboard-driven walk.
- [diff-view](./diff-view.md) — three-mode renderer (diff / source / preview), cursor, gutter rail, inline glyphs
- [file-sidebar](./file-sidebar.md) — orientation rail with read meter, status char, comment badge
- [full-file-view](./full-file-view.md) — a *mode* of `DiffView`, not a separate component
- [context-expansion](./context-expansion.md) — reveal-above/below; pure client-side derivation
- [keyboard-help](./keyboard-help.md) — `?` overlay, KEYMAP registry drives both dispatcher and overlay

### Review state & progress — `_group2-*.md`
What the reviewer has done, and what the next session needs to know.
- [review-progress](./review-progress.md) — cursor, per-hunk readLines, dismissed guides, coverage
- [sign-off](./sign-off.md) — file-level (`Shift+M`) and changeset-level (`Shift+S`) gestures
- [session-persistence](./session-persistence.md) — `shippable:review:v1` blob (v7, no migrations) + sibling keys

### Comments & interactions — `_group3-*.md`
The largest single architectural lift in the codebase — one `Interaction` primitive replacing five per-author types.
- [anchored-comments](./anchored-comments.md) — FNV-1a + context-line re-anchoring across reloads
- [block-comments](./block-comments.md) — selection → `block:<hunkId>:<lo>-<hi>:<id>` thread
- [line-comments-and-replies](./line-comments-and-replies.md) — composer keybindings, intent picker, currentAsk/currentResponse derivation
- [agent-context-panel](./agent-context-panel.md) — JSONL transcript matching, 2s poll, "watching" indicator

### AI plan & guidance — `_group4-*.md`
The "where do I start, and what is this change trying to do?" layer.
- [ai-inspector](./ai-inspector.md) — AI notes inline, claims/evidence, run-hook integration, panel vs inline mode
- [review-plan](./review-plan.md) — `/api/plan`, headline + intent claims + structure map + entry points
- [plan-diagram](./plan-diagram.md) — LSP-resolved `/api/code-graph` with regex fallback, per-file LRU
- [guide-suggestions](./guide-suggestions.md) — "you've changed X, also look at Y" prompts, dismissal as state

### Prompts — `_group5-*.md`
- [prompt-library](./prompt-library.md) — bundled markdown prompts, admin-token-gated refresh
- [custom-prompts](./custom-prompts.md) — localStorage-backed user prompts, fork/edit, transparent override
- [prompt-results](./prompt-results.md) — ephemeral `PromptRunView`, SSE streaming, no persistence

### Runners & language services — `_group6-*.md`
- [code-runner](./code-runner.md) — sandboxed iframe + Worker for JS/TS, `@php-wasm` for PHP, network lockdown
- [click-through-definitions](./click-through-definitions.md) — `typescript-language-server`, `intelephense`/`phpactor`, in-diff Tier 0 floor

### Ingest — `_group7-*.md`
Five paths into the same `ChangeSet`.
- [load-changeset](./load-changeset.md) — paste / file / URL via LoadModal
- [github-pr-ingest](./github-pr-ingest.md) — per-host PAT, prSource, PR conversation merge
- [commit-range-picker](./commit-range-picker.md) — range selection with "include uncommitted" toggle
- [worktree-directory-picker](./worktree-directory-picker.md) — macOS-only AppleScript folder dialog (today)
- [worktree-live-reload](./worktree-live-reload.md) — 5s poll, anchor-aware re-attach

### Configuration — `_group8-*.md`
- [api-key-setup](./api-key-setup.md) — Tauri Keychain durable, server-memory runtime, boot prompt + reactive modal
- [themes](./themes.md) — token map + CSS variables + Shiki adapter (Light / Dark / Dollhouse / Dollhouse Noir)

---

## 3. Priorities for a rebuild

Suggested priorities are explained per feature; the rollup is below.
Tier choices are framed for **a clean rebuild of this product**, not
for the existing 0.1.0 ship.

### Must-have — the spine
Without these the product is no longer Shippable.

| Feature | Why |
|---|---|
| diff-view | The reading surface; everything else hangs off it. |
| file-sidebar | Orientation; the reviewer's "where am I" rail. |
| keyboard-help | The keyboard is the primary input; discoverability is non-optional. |
| review-progress | Tracking what you've read is the IDEA's central commitment. |
| sign-off | "I finished this file" is the LGTM-replacement gesture. |
| session-persistence | Reload-survival is table stakes. |
| line-comments-and-replies | Comments are the unit of human contribution. |
| anchored-comments | Comments without re-anchoring rot on the next reload. |
| block-comments | Range comments are how you reference *concepts*, not just lines. |
| ai-inspector | The inline AI surface; the product's most distinctive feature. |
| review-plan | "Where do I start?" — the answer to the IDEA's opening problem. |
| api-key-setup | No key, no AI; setup must be first-class. |
| themes | Boring infra, but the dark / dollhouse identity is a product asset. |
| load-changeset | At least one ingest path is required; paste/file/URL is the floor. |
| worktree-directory-picker | The local-first promise needs disk ingest. |

### Nice-to-have — ship if time allows
Significant value but the product still functions without them in a rebuild's first release.

| Feature | Why |
|---|---|
| full-file-view | Useful but a mode of diff-view, not a separate product surface. |
| context-expansion | Convenience; non-blocking. |
| guide-suggestions | "Look at this next" is the IDEA's most ambitious bet; ship after the core walk is solid. |
| plan-diagram | Beautiful when it works; rare day-to-day load-bearing use. |
| prompt-library | Bundled prompts on disk; small surface. |
| custom-prompts | Power user feature; usable through Settings. |
| prompt-results | Currently ephemeral; valuable only if persisted (see §4). |
| code-runner | High wow-factor, narrow language reach. |
| click-through-definitions | Excellent when a worktree is mounted; null otherwise. |
| github-pr-ingest | Loosens the local-first stance; second most-common entry point after worktrees. |
| commit-range-picker | Boring but real for long-running branches. |
| worktree-live-reload | The "review while they work" loop; depends on worktrees. |
| agent-context-panel | Differentiator (review the agent's path) but narrow audience until agents are mainstream. |

### Drop-it candidates
Nothing rises to outright **drop**. Two come close:

- **plan-diagram** — costly LSP plumbing, regex fallback that's often noisy, and the per-file LRU adds maintenance surface. If the rebuild can ship without it, do — re-introduce only when the diagram tells the reviewer something the plan claims don't.
- **agent-context-panel** in its current poll-and-parse form — the *idea* (surface the agent's tool calls alongside the diff) is core to the IDEA; the *implementation* (JSONL transcript scraping, 2s polling, "watching" approximated by a TTL) is fragile. Drop the implementation; keep the concept and rebuild via the same Interactions store the agent already writes into.

---

## 4. Cross-cutting unification opportunities

This is the meat of the rebuild brief. Each subsection below is a
pattern that appears in three or more groups and would simplify the
codebase substantially if collapsed.

### 4.1 One `Anchor` type, one renderer
**Today:** four shapes that all say "this thing points at a piece of diff":
- `EvidenceRef` — plan claims (`file | hunk | symbol | description`).
- `Interaction.anchor*` — user/AI/agent comments (`anchorFile`, `anchorHunkId`, `anchorLineNo`, `anchorContext`, `anchorHash`).
- `GuideSuggestion` — `(fromHunkId, toFileId, toHunkId, symbol)`.
- Diagram nav payload — `{ kind: "file", path }`.
- `runRecipe = { source, inputs }` — an anchor with an optional verifier.

**Rebuild:** one `Anchor` discriminated union (`line | block | hunk | symbol | file`) with optional `anchorContext` / `anchorHash` for re-anchoring. `Reference.tsx` already renders every `EvidenceRef` variant — promote it to the canonical anchor renderer. Plan claims, user comments, AI notes, guide suggestions, diagram clicks, runner recipes all consume one shape. **(Touches groups 1, 3, 4, 6.)**

### 4.2 Fold prompt-runs, dismissed guides, and runner verdicts into `Interaction`
The typed-Interactions migration (`docs/plans/typed-review-interactions.md`) collapsed five per-author shapes into one. Three more shapes are still hanging off the side of the model and want to join.

- **Prompt runs** are `Interaction` with `authorRole: "ai"`, `runRecipe = { source: promptId, inputs }`, body = streamed text. Blockers are small: add an optional `status: "streaming" | "done" | "error"`, commit the picker's selectionInfo to the result, and fold `PromptRunsPanel` into `InlineThreadStack`. (See `_group5-unification-notes.md` for the path.)
- **Dismissed guides** are `state.dismissedGuides: Set<string>` (localStorage). Structurally an `Interaction { intent: "ack" }` against a `guide:<id>` threadKey. The migration already walked this for `state.ackedNotes`.
- **Runner verdicts** are `Interaction { target: "reply-to-ai-note", intent: "accept" | "reject" }` carrying the `RunResult` body. Today they're `useState`-local and thrown away on unmount — the highest-leverage tiny refactor in the codebase (`_group6-unification-notes.md`).

**Payoff:** persistence, reply, agent hand-off, GitHub round-trip, detached-window propagation — all free for each of these once they're Interactions.

### 4.3 One store, one seam — actually use the seam
`selectInteractions` was built as "the only read seam" but is essentially unused in production (`_group3`). Every cross-thread consumer (`buildCommentCounts`, `buildCommentStops`, `agentStartedThreads`, the sidebar comment badge) still walks `state.interactions` directly. The architecture exists; the consumers weren't migrated. A rebuild should either complete the migration or delete the seam — having both is the worst of both worlds.

Same shape appears in coverage: `hunkCoverage` / `fileCoverage` is re-walked by the diff hunk header, the sidebar meter, and the status bar (`_group1`). One memoised coverage projection per (changeset, readLines) tick replaces three walks.

### 4.4 Server-side persistence: finish the job
**Today's split:**
- **Server SQLite (`server/src/db/`):** Interactions (one table).
- **localStorage:** cursor, readLines, reviewedFiles, reviewedChangesets, dismissedGuides, drafts, quiz, custom prompts, theme, view-mode, host-trust list, anthropic-skip, recents.

**The split has a mechanical reason** — agents and the MCP bridge can read SQLite, not localStorage — and a historical reason: this was a browser-only prototype before the server became hard-required. The historical reason no longer applies.

**Migrate to server SQLite:** `reviewedFiles`, `reviewedChangesets`, `dismissedGuides`, `readLines`, `cursor`, `quiz`, custom prompts. These are session state that benefits from multi-window safety, cross-machine continuity, and agent readability.

**Keep in localStorage:** drafts (loss-tolerant), `theme`, `inspector` mode, zoom, recents, `anthropic-skip`. Machine-specific, intentionally so.

**Sign-off is the highest-leverage move** (`_group2`). Moving `reviewedFiles` to SQLite unlocks "an agent can ask: did the reviewer sign this off?" — which the IDEA names as a target and which today nothing supports.

**Bonus collapse:** `LOAD_CHANGESET` already triggers a per-changeset fetch with awkward StrictMode-guarding comments (`App.tsx:270–280`). One server bundle per changeset (progress + interactions + sign-off) kills the in-flight-fetch hazard.

### 4.5 `ChangeSet` provenance as a discriminated union
**Today:** `ChangeSet` has parallel-optional `worktreeSource?` and `prSource?` fields that can both be set (worktree+PR overlay) — but only that pair. The current shape implies more flexibility than exists.

**Rebuild:** `provenance: { kind: "paste" | "file" | "url" | "worktree" | "pr"; ...; overlay?: { kind: "pr" } }`. `RecentSource` (`web/src/recents.ts:20-25`) already discriminates the five paths with the right names — promote it from a recents-only sidecar to the canonical provenance type.

**Pair this with one external-update reducer.** `RELOAD_CHANGESET` (worktree drift), `MERGE_PR_OVERLAY` (PR metadata), and `MERGE_PR_INTERACTIONS` (PR replies) are three actions for one primitive ("external state arrived; reconcile"). One `APPLY_EXTERNAL_UPDATE` with `{ provenance, interactions?, detached?, replaceMode? }` carries all three. The content-anchor pass becomes conditional. The idempotency rule (strip prior `external.source === "pr"` entries) lifts to the shared reducer.

### 4.6 One graph at different granularities
Three symbol/import graphs co-exist (`_group4`, `_group6`):
- `StructureMap.symbols[].referencedIn` — regex, diff-only, used by rule-based plan.
- `cs.graph: CodeGraph` — server-resolved LSP, used by the diagram.
- `Hunk.referencesSymbols` / `Hunk.definesSymbols` — per-hunk regex, what guides read today.
- Plus: `web/src/symbols.ts` (in-diff index for click-through Tier 0), `web/src/runner/parseInputs.ts` (regex param/var extractor for the runner).

When a worktree is mounted, the LSP `documentSymbol` answer is canonical. The regex paths should be no-worktree fallbacks, not the default. Pull guides onto `cs.graph` — non-JS guide accuracy lifts for free. Pull `StructureMap` onto `cs.graph` — the rule-based plan inherits LSP edges. Drop the `classifyFileRole` legacy fallback in `planDiagram.ts:140-142` — the server has always emitted enriched nodes for a while now.

### 4.7 One reactive prompt component, one prefs document
`CredentialsPanel` (boot + settings) and `GitHubTokenModal` (reactive on PR load) are 80% the same component with different reasons-to-prompt (`_group8`). Same shape: password-input row, host-trust interstitial, typed error copy. Same pattern for `ThemePicker`, which is rendered five times with `value`/`onChange` passed each time. A single context-driven consumer collapses both.

Same group has six localStorage keys for prefs (`shippable:anthropic:skip`, `shippable:githubTrustedHosts:v1`, `shippable:theme`, `shippable:interactionViewMode`, etc.). One schema-versioned `shippable:prefs:v1` document covers all non-secret user prefs; secrets stay in Keychain / server memory.

### 4.8 Capabilities & language modules
`server/src/languages/{types,index,typescript,php}.ts` is a real `LanguageModule` registry behind `click-through-definitions`. The runner has the same shape *informally* — `switch (lang)` in `executeJs` / `executePhp` / `parseInputs` (`_group6`). One `LanguageRunner` interface alongside `LanguageModule`, both in `web/src/languages/<id>.ts`, makes "add Python" one file's worth of work for both features, not three. Capability discovery is one-shot in both today; a shared `POST /api/capabilities/refresh` plus a watcher would let "I just installed pyright" land without restart.

The runner's PHP worker (`@php-wasm/web-8-3`) is sunk-cost infrastructure that can also host a `nikic/php-parser` analyzer for memory-only PHP click-through. Same worker, different request — already noted in `docs/plans/plan-symbols.md:362`.

### 4.9 Three loose mode-as-Set shapes → one Record
- `fullExpandedFiles: Set<fileId>` + `previewedFiles: Set<fileId>` with reducer-enforced mutual exclusion → `Record<fileId, "diff" | "source" | "preview">` (`_group1`).
- `state.dismissedGuides: Set<string>` → Interactions (covered in §4.2).
- `state.ackedNotes` already replaced by Interactions — the precedent.

### 4.10 Finish the half-done migrations
Several named refactors landed the structural change but not all the surfaces:

- **Typed Interactions slices.** Slice 2 (composer intent picker — every authored Interaction defaults to `intent: "comment"`) ❌. Slice 3 (ack as `ADD_INTERACTION` — modelled as one, dispatched through a separate `TOGGLE_ACK` action) ⚠. Slice 6 (GitHub round-trip with sentinels + glyphs — push/pull is plain-comment-only) ❌. `_group3` enumerates these in detail.
- **`useLoadSurface()`** specified in `docs/sdd/gh-connectivity/spec.md:184-187`. `useGithubPrLoad` and `useWorktreeLoader` exist; the three client-parsed branches (paste / file / URL) are still inline across `LoadModal` and `Welcome`. Folding them collapses URL/PR-URL into one routing field.
- **Legacy "Reply" vocabulary.** `buildReplyAnchor`, `parseReplyKey`, `lineNoteReplyKey`, `hunkSummaryReplyKey`, `teammateReplyKey` operate on Interactions; the names trail the migration. Pure rename.
- **`DeliveredInteraction`** is `Interaction` plus a `deliveredAt` that mirrors `createdAt`. Consumers can read `agentQueueStatus === "delivered"` directly.

A rebuild that doesn't close these out re-imports the same drift.

---

## 5. Suggested rebuild sequence

A read of the per-feature acceptance criteria and the unification work
above. Ordered for a clean cut, not a port.

**Phase 0 — types.**
Land one `Anchor`, one `Interaction` with `status`, one `ChangeSet.provenance` discriminator. Promote `Reference.tsx` to the canonical anchor renderer. (§4.1, §4.2 partial, §4.5)

**Phase 1 — the spine.**
Diff view + file sidebar + keyboard help + load-changeset (paste/file/URL) + worktree-directory-picker. Server SQLite carries all session state for these from day one (§4.4). One `useLoadSurface()` hook (§4.10).

**Phase 2 — comments & sign-off.**
Line + block + reply, anchored. Sign-off persists server-side. Composer intent picker ships (§4.10). Reviewer can finish a diff end-to-end.

**Phase 3 — AI plan + ai-inspector.**
Plan claim and AI note are both `AnnotatedClaim`s — see §4.1. AI annotations land in Interactions on ingest. One read seam, actually consumed (§4.3).

**Phase 4 — prompts as Interactions.**
Prompt-runs become Interactions; `PromptRunsPanel` becomes a filtered view of `InlineThreadStack`. Custom prompts move to server SQLite. (§4.2, §4.4)

**Phase 5 — language services.**
One `LanguageModule`/`LanguageRunner` registry per feature; runner verdicts mint Interactions (§4.8, §4.2). One `cs.graph` consumed by guides, plan, diagram (§4.6).

**Phase 6 — external state.**
`APPLY_EXTERNAL_UPDATE` reducer (§4.5). Worktree live-reload and GitHub PR overlay share one path. Origin discriminator covers both (`_group7`).

**Phase 7 — agent context.**
Rebuild from Interactions instead of from a polled JSONL transcript. The agent already writes Interactions; this is "show the agent's stream" rather than "scrape its log file."

Things that can ship any time, low-risk:
- One reactive credential prompt component (§4.7).
- One `prefs:v1` localStorage document (§4.7).
- `mode-as-Record` collapse (§4.9).
- Drop the env-var fallback warning and `classifyFileRole` legacy fallback (`_group4`, `_group8`).

---

## 6. Things to carry across, not redesign

A short list of things the prototype got right and a rebuild should
preserve rather than re-imagine:

- **Evidence-is-mandatory.** The plan UI refuses to render a claim with no `EvidenceRef`. This is the product's anti-LGTM gesture and the IDEA's central commitment; don't loosen it.
- **One Interactions primitive.** The migration that landed is the cleanest piece of architecture in the repo. Build on it, don't re-invent it.
- **Server-as-hard-dependency.** The `ServerHealthGate` is a feature, not a limitation. It removes a whole class of "works offline maybe?" confusion.
- **Keyboard-first walk.** `j`/`k`, `Shift+M`, `]`/`[`, `n`/`N`, gutter rail. The reviewer keeps their hands on the keyboard; the UI follows.
- **Theme token model.** One map, CSS variables on `:root`, persisted id, single picker. Already as boring as it needs to be. (`_group8`.)
- **The Tauri + sidecar + Keychain credential ladder.** It degrades cleanly for the web-only shape and the Rust allowlist on Keychain commands is the right shape. (`_group8`.)
- **Capability-gated language features.** Click-through hides itself when a worktree isn't mounted; the runner refuses PHP without WASM. The principle ("disabled is worse than absent") is correct. (`_group6`.)

---

## 7. Per-feature files in this folder

```
product.md                                     ← this file
_group1-unification-notes.md                   ← diff-view / sidebar / full-file / context / keymap
_group2-unification-notes.md                   ← review-progress / sign-off / session-persistence
_group3-unification-notes.md                   ← comments & interactions
_group4-unification-notes.md                   ← plan / inspector / diagram / guides
_group5-unification-notes.md                   ← prompts
_group6-unification-notes.md                   ← runner / click-through
_group7-unification-notes.md                   ← ingest
_group8-unification-notes.md                   ← config

agent-context-panel.md
ai-inspector.md
anchored-comments.md
api-key-setup.md
block-comments.md
click-through-definitions.md
code-runner.md
commit-range-picker.md
context-expansion.md
custom-prompts.md
diff-view.md
file-sidebar.md
full-file-view.md
github-pr-ingest.md
guide-suggestions.md
keyboard-help.md
line-comments-and-replies.md
load-changeset.md
plan-diagram.md
prompt-library.md
prompt-results.md
review-plan.md
review-progress.md
session-persistence.md
sign-off.md
themes.md
worktree-directory-picker.md
worktree-live-reload.md
```
