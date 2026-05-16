# Review State

## What it is
The local state model for an in-progress review session.

## What it does
- Tracks the current cursor position inside the diff tree.
- Separates read progress from explicit sign-off.
- Tracks dismissed guide suggestions, expand levels, and block selection.
- Stores every per-author signal — user replies, AI notes, teammate verdicts, agent responses, acks — as `Interaction`s in `state.interactions: Record<threadKey, Interaction[]>`. See `docs/architecture.md § Review interactions`.
- Keeps the current session shaped around one reviewer, one machine, and local persistence.

## Sign-off levels

Sign-off has two independent levels, each tracked in its own field on `ReviewState`:

- `reviewedFiles: Set<string>` — per-file sign-off, keyed by `fileId`. Toggled by Shift+M on a file.
- `reviewedChangesets: Record<string, string[]>` — per-changeset sign-off, keyed by `changesetId`, valued by the list of **review tokens** at which sign-off was given for that changeset (see below).

The two are **independent**. Marking a changeset as reviewed does **not** mark its files as reviewed, and marking every file as reviewed does **not** mark the changeset as reviewed. Either can be set or unset without touching the other.

### Why independent and not cascading

Cascading "mark changeset reviewed → mark every file reviewed" would feel natural for the bulk-sign-off case, but it would destroy a signal we may want later: which files the reviewer *actually* ticked off versus which got swept under a top-level mark. A reviewer who skims a 50-file PR, ticks the three files they cared about, and then signs off the whole changeset carries different information than a reviewer who ticked every file individually. Cascading collapses those two cases into one.

We're keeping the granularity even though we don't surface it in the UI today. The UI can compute and display whatever roll-up is useful ("3 of 7 files reviewed, changeset signed off") from the two fields independently. We don't yet know which roll-ups will matter, and the cheap thing is to preserve the underlying data.

The same logic applies in the other direction: marking every file reviewed should not auto-sign-off the changeset, because per-file ticks and "I've looked at this as a whole" are different claims.

## Review tokens and revision-scoped sign-off

A changeset's content can change after sign-off — new commits, a force-push, an uncommitted edit, a PR base moving. `reviewedChangesets` is keyed by `(changesetId, reviewToken)` so sign-off binds to the exact diff revision the reviewer saw, not to the id alone.

### What a review token is

A canonical string derived from the loaded `ChangeSet` by `getChangesetReviewToken(cs)`:

- Worktree-backed (any kind — branch / range / dirty / picked): `wt:${state.sha}:${state.dirtyHash ?? "-"}`, where `state` is `worktreeSource.state` captured at load time. The same `(sha, dirtyHash)` pair live-reload already uses to decide "did the loaded revision change?" When `worktreeSource` is present but `state` is missing (legacy persisted recents written before the field shipped), the token is `null` — we don't invent a fallback that might claim sign-off on a different revision than the reviewer saw.
- PR-only: `pr:${baseSha}:${headSha}`. Both ends matter — the diff moves when the base moves even if the head doesn't.
- Worktree + PR overlay: the worktree token wins. The displayed diff comes from the worktree load path; the PR overlay adds metadata around it.
- Paste / upload / stub / fixture: `null`. No stable revision identity, and no top-level sign-off control is offered.

### What sign-off binds to

- The diff content, not the `changesetId`. A refresh that swaps a `ChangeSet` while keeping its id (worktree live-reload, PR fetch, session hydration on boot, future in-place swaps) recomputes the token; only if the new token has a stored sign-off entry does the new revision read as signed off.
- Not the PR-as-social-object. PR conversation, labels, reviewers, and comments refresh without moving the worktree-backed token; sign-off is preserved.
- The reviewer's history, not just the current view. Stored entries for prior tokens are not deleted when the displayed revision changes — return to a previously signed-off revision and sign-off reappears with no re-confirmation. Switching revisions is *navigation*, not invalidation.
- The token, not the display id. A clean picked range stays signed off across HEAD movement that doesn't change the range.

### Storage shape and eviction

`reviewedChangesets: Record<changesetId, string[]>` — the list of review tokens at which sign-off has been given for the changeset. Lookup: "is the current token in the list?" Persisted at schema `v: 5`.

Eviction is explicit unsign-off only: toggling sign-off off on the displayed revision removes that token's entry; every other entry is preserved. We do **not** evict on "the displayed revision changed" — that was the previous at-token / drop-on-mismatch rule and it silently destroyed reviewer work whenever a refresh moved the token — and we do **not** cap the list. A token is short (sha-pair) and only appended on deliberate sign-off, so the per-changeset list grows monotonically with reviewer intent and stays well inside the localStorage budget that `readLines` already lives in.

Persist notes: `hasProgress()` must count `reviewedChangesets` (a session with only top-level sign-off must resume); the schema bump from `v: 4` to `v: 5` follows the existing exact-version load policy (reject non-v5 snapshots and boot empty). The previous v4 snapshot shape predates this field; no migration is shipped — the prototype has no users to carry over.

### Why a per-revision list, not a single at-token

The previous design stored one `at-token` per changeset and dropped sign-off on mismatch. That conflated navigation with invalidation: any refresh that moved the loaded revision (force-push to a new head, uncommitted edit, base move, or even a return trip through a different revision) erased the reviewer's prior sign-off, even when the original revision later came back. The list shape costs one small bounded array per changeset and removes that whole class of false-negative.

The stable-id case still motivates this: `pr:<host>:<owner>:<repo>:<number>` is intentionally stable across force-pushes so interactions and other state reattach, and the live worktree branch id (`wt-<headSha>`) hides dirty-tree movement under a stable id. Without the per-revision token, both cases silently re-apply prior sign-off to content the reviewer never saw.

### Acceptance cases

Each case is the testable form of one rule in this section. Cite the case id (W*n* / D*n*) in commits and PRs that touch `reviewedChangesets`.

**Want — behaviors that must hold**

- **W1 — Noise refresh preserves sign-off (worktree).** Signed off on worktree branch view at `(sha=A, dirtyHash=X)`. Reload while the working tree is unchanged. Token recomputes to `(A, X)`; sign-off still shows.
- **W2 — Noise refresh preserves sign-off (PR metadata).** Signed off on worktree↔PR overlay. PR conversation / labels / reviewers refresh; local diff unchanged. Worktree-backed token is unchanged; sign-off still shows.
- **W3 — Return-to-revision restores sign-off (worktree).** Signed off at `(A, X)`. An uncommitted edit moves the tree to `(A, Y)` — that revision shows as not signed off. Revert the edit so the dirty hash returns to `X`. Sign-off reappears on `(A, X)` with no re-confirmation.
- **W4 — Return-to-revision restores sign-off (PR force-push).** Signed off on PR at `(base=B, head=H1)`. Force-push moves head to `H2`; that revision shows as not signed off. A later force-push reverts head to `H1`. Sign-off reappears on `(B, H1)`.
- **W5 — Clean picked range survives HEAD movement.** Signed off on picked range with token `(fromSha=A, toSha=B)`, clean tree. Check out an unrelated branch (display id may change, HEAD moves). Token still resolves to `(A, B)`; sign-off still shows. Behavior follows the token, not the display id.
- **W6 — Explicit unsign-off scopes to the current revision.** Stored entries for `csId` at tokens T1 and T2. Reviewer toggles sign-off off while viewing T2. Only `(csId, T2)` is removed; T1 is preserved.

**Don't want — behaviors that must not occur**

- **D1 — No silent carry-over to new worktree content.** Signed off at `(A, X)`. Uncommitted edit reloads view to `(A, Y)`. The new revision must show as **not** signed off. Stable `changesetId` does not imply stable content.
- **D2 — No silent carry-over after PR force-push to new head.** Signed off at `(B, H1)`. Force-push moves head to `H2`. Must show as not signed off.
- **D3 — No silent carry-over when PR base moves.** Signed off at `(B1, H)`. Base ref moves; head unchanged; token recomputes to `(B2, H)`. Must show as not signed off. The reviewed object is `base..head`, not head alone.
- **D4 — Switching revisions does not destroy prior sign-off.** Signed off at `(A, X)`. Switch to `(A, Y)` and back to `(A, X)`. Sign-off on `(A, X)` must be preserved across the round-trip. (This is the rule W3 and W4 depend on; the old drop-on-mismatch model violated it.)
- **D5 — PR metadata changes do not clear sign-off.** Signed off on worktree↔PR overlay. PR comments / labels / reviewers refresh; local diff unchanged. Sign-off must stay. The claim is about the diff, not the PR-as-social-object.
- **D6 — No top-level sign-off affordance when token is null.** Paste / upload / stub changeset; `getChangesetReviewToken` returns `null`. The changeset-level sign-off control must be hidden or disabled — we do not invent fake stability for sources that cannot answer "what revision is this?"

### Future: surface revision diffs in the UI

Today the UI just renders "signed off" or "not signed off" based on the current token. The same data could power "you reviewed at SHA abc; the current revision differs — diff against your last sign-off?" or a one-click "still good" toggle that adds the current token to the list. That's a presentation follow-up, not a data-model change.

## Future direction: `reviewedTargets`

`reviewedFiles` and `reviewedChangesets` follow the same key/value pattern but their value shapes diverge: per-file is one bit per id (`Set<string>`), per-changeset is a list of review tokens (`Record<string, string[]>`). The reason: file ids are path-scoped under a parent changeset's revision, so refreshing the changeset produces a fresh file id and the persist layer's stale-id drop handles it; changeset ids are deliberately stable across content-moving refreshes (force-push, dirty-tree reload), which is exactly why the per-revision list is needed there.

Not a commitment, not scheduled — a note so the next person touching review state doesn't have to rediscover the shape. The sketch:

```ts
type TargetKind = "file" | "changeset" | "description" | "hunk" | "symbol";
reviewedTargets: Record<TargetKind, Record<string, string[]>>;
// kind → (targetId → review tokens at which it was signed off)
```

Every `(kind, targetId)` pair carries the same list-of-review-tokens shape. For kinds where one revision is enough (files today), the list is length 1; the cost is one bounded array per entry, the benefit is one persist shape and one stale-drop rule across kinds.

**Why we might want it.**

- *Description sign-off.* Reviewing PR description / changeset prose is a real part of a review, especially when the prose carries the design rationale. Today there's no way to mark it reviewed.
- *Hunk sign-off.* "I've signed off on this hunk but not the file" is plausible for long files. Today the only level below file is line-level read tracking (`readLines`), which is implicit and not a claim.
- *Symbol sign-off.* Once symbol navigation lands (`docs/plans/plan-symbols.md`), reviewing "the new behavior of `foo()`" across its uses is a sign-off shape that doesn't fit file/hunk.
- *Uniform persist / migration.* One field to serialize, one stale-drop rule, one shape to extend.

**Why we haven't done it yet.** Two sign-off levels don't justify the abstraction (the AGENTS.md "no premature abstraction" rule applies). The cost of refactoring later is small: rename, fold into the new shape, bump persist version, migration is "drop unknown kinds." We don't yet know which target kinds matter — description has the most pull; hunk and symbol are speculative. The UI question of how to surface multiple kinds without overwhelming the reviewer is harder than the data question.

**What would trigger doing it.** Any one of: a third sign-off level lands (most likely description); a consumer of review state needs to iterate over "everything signed off in this changeset" and per-field iteration becomes annoying; persist schema bumps for an unrelated reason and we can fold the rename in cheaply.

**Open questions for that time.** Whether `TargetKind` should be open (string, plugins can extend) or closed (union, safer). Whether review tokens are comparable across kinds or kind-specific (file token = parent changeset's token; description token = text hash; symbol token = symbol-definition hash — some derivable, some need storage). Whether `reviewedTargets` replaces `reviewedFiles` / `reviewedChangesets` or wraps them (replacing is cleaner, wrapping is one persist-version safer).

Out of scope even at that time: multi-reviewer / shared sign-off (different design, doesn't depend on this generalization); cross-changeset rollups ("reviewed in PR #123, don't ask in PR #124" — out of scope for the local-state model).
