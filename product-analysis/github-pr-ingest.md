# GitHub PR Ingest

## 1. Product reasoning & priority

A reviewer that can only consume locally-produced diffs is a reviewer for solo agent loops. To support the IDEA.md framing ("ten new PRs in the morning, no clue where to start") the tool has to talk to where the work actually lives — for now, GitHub.com and self-hosted GHE. The PR ingest path adds two capabilities the other four paths can't: (1) round-trip metadata (title, state, base/head refs, conversation comments, line-anchored review comments) that the reviewer can use as additional context, and (2) the worktree↔PR overlay, where a loaded local diff gets enriched with the open upstream PR's review threads. v0 is deliberately paste-only and read-only; push-back is a deferred SDD that pairs with a hosted backend.

Suggested priority: **must-have** — without it Shippable can't review the most common kind of remote diff teams actually look at, and the worktree↔PR overlay is the keystone of the "review-while-they-work" loop because it is the only path that fuses local-diff truth with upstream conversation.

## 2. Acceptance criteria for a rebuild

- Pasting `https://<host>/<owner>/<repo>/pull/<n>` in the LoadModal URL field detects the PR shape (`isGithubPrUrl`) and routes to `POST /api/github/pr/load`.
- A PR URL whose host has no PAT yet causes the server to return `github_token_required` *with* the host; the client checks the Tauri Keychain once (`isTauri()` gate) and only opens `GitHubTokenModal` if Keychain has no entry.
- Pasting a PR URL whose host is *not* `github.com` and is not in the trusted-hosts list shows the host-trust step inside `GitHubTokenModal` before the PAT input becomes visible; copy includes the exact `https://<host>/api/v3` destination the token will be sent to.
- Submitting a token writes to the Tauri Keychain (account `GITHUB_TOKEN:<host>`) and to the server-memory store, then retries the pending PR load exactly once.
- A 401/403 from GitHub for an already-configured host returns `github_auth_failed` with optional `hint: "rate-limit" | "invalid-token" | "scope"`, surfaced in the modal's rejection copy.
- A PR load yields `{ changeSet, prInteractions, prDetached }`; `changeSet.prSource` is set; `changeSet.prConversation` carries issue-level comments; line-anchored review comments live in `prInteractions` keyed by `userCommentKey` / `blockCommentKey`; outdated comments (`line: null`) are `DetachedInteraction`s with `anchorContext` derived from `diff_hunk` and `anchorLineNo = original_line`.
- A PR loaded from a worktree whose `origin` remote matches the PR's host/owner/repo + branch can be merged via `MERGE_PR_OVERLAY` + `MERGE_PR_INTERACTIONS` without dropping `worktreeSource`.
- `lookupPrForBranch` only runs once per `worktreePath` change and never auto-overlays; the click on the pill is what dispatches the merge.
- Refresh on a PR-loaded changeset re-runs `pr/load`, and the `MERGE_PR_INTERACTIONS` reducer removes prior `external.source === "pr"` entries before re-installing the new ones (idempotent).
- `persist.ts` strips `Reply.external.source === "pr"` entries on save; they re-arrive on next `pr/load`.

## 3. Existing architecture & system design

### Data model

- `PrSource` (`web/src/types.ts:521-538`) — full PR provenance: `{ host, owner, repo, number, htmlUrl, headSha, baseSha, state, title, body, baseRef, headRef, lastFetchedAt, truncation? }`. Lives on `ChangeSet.prSource` (`web/src/types.ts:178`).
- `PrConversationItem` (`web/src/types.ts:541-547`) — issue-level (non-line-anchored) comments. Attached at `ChangeSet.prConversation` (`web/src/types.ts:183`).
- `Interaction.external` and `Interaction.anchorContext` / `anchorLineNo` / `originSha` / `originType` — the shared anchored-comment fields the live-reload work introduced get reused by PR ingest. PR review comments are *not* a separate kind; they are normal `Interaction`s tagged with `external = { source: "pr", htmlUrl }`.
- `ChangeSet.prSource` and `ChangeSet.worktreeSource` are independent and can both be set (`docs/concepts/changeset-hierarchy.md:11`).
- `PrMatch` (`web/src/githubPrClient.ts:27-35`) — the shape `branch-lookup` returns: `{ host, owner, repo, number, title, state, htmlUrl }`.

### Current architecture decisions

- **Five endpoints, one bundled load.** `POST /api/github/pr/load` does the four-fanout (meta / files / line-comments / issue-comments) on the server (`server/src/github/pr-load.ts:162-189`). `POST /api/github/pr/branch-lookup` resolves a worktree's branch → open upstream PR (`server/src/github/branch-lookup.ts:55`). Auth lives on `POST /api/auth/{set,clear,has}` (the unified `auth/store.ts` is shared with the Anthropic key).
- **GHE auto-detection.** `resolveApiBase` (`server/src/github/url.ts:10-19`) returns `https://api.github.com` for `github.com` and `https://<host>/api/v3` otherwise. The test override env var keeps e2e off the public API.
- **Per-host PAT, two-tier.** Tokens live in Tauri Keychain (account `GITHUB_TOKEN:<host>`, `web/src/auth/credential.ts:13-20`) as the durable store and in server-memory (`server/src/auth/store.ts`) as the active runtime cache. The web app moves tokens between them via `useCredentials` and is never the long-term holder.
- **First-use vs rejection split.** `useGithubPrLoad` (`web/src/useGithubPrLoad.ts:62-119`) treats `github_token_required` and `github_auth_failed` differently — the former optionally tries one Keychain rehydrate before opening the modal, the latter always opens it with `reason: "rejected"` and the hint copy. Critically, the cache-retry is bounded to one attempt or an older server's behavior could loop forever (`useGithubPrLoad.ts:53-61`).
- **Host trust gate.** `web/src/githubHostTrust.ts:32-52` adds an explicit "I trust this GHE host" step in front of the PAT field for non-`github.com` hosts. Trusted hosts persist to localStorage (`shippable:githubTrustedHosts:v1`). This is a UX guard against typosquatted Enterprise hosts, not an auth boundary.
- **Server-side parse re-uses web parser.** `server/src/github/pr-load.ts:1` imports `web/src/parseDiff.ts` directly — keeps parser behavior identical with no second copy.
- **PR comments as `Interaction`s.** The earlier v0 design that added a `prReviewComments?: PrReviewComment[]` field on `DiffLine` was retired (see `docs/sdd/gh-connectivity/spec.md:278-279`). PR review comments now live in the same `Reply` / `Interaction` store as user / AI / agent threads, keyed under `userCommentKey(hunkId, lineIdx, threadId)` or `blockCommentKey(hunkId, lo, hi, threadId)`. Replies are grouped by GitHub's `in_reply_to_id`. Outdated comments are `DetachedInteraction`s.
- **Worktree↔PR overlay is opt-in.** `ReviewWorkspace.tsx:1252-1269` runs `lookupPrForBranch` once per worktree-path change, sets `pillMatch`, and only on user click dispatches `MERGE_PR_OVERLAY` + `MERGE_PR_INTERACTIONS`. The local diff is untouched; only metadata + comments are merged.
- **HTTPS proxy support.** `server/src/proxy.ts` reads `HTTPS_PROXY`/`https_proxy`/`NO_PROXY` and produces an `undici.ProxyAgent` passed as `dispatcher` to every GitHub fetch (`spec.md:158-159`). Required for most GHE deployments behind corporate egress.

### How it evolved

`docs/sdd/gh-connectivity/spec.md` is the canonical record. The v0 design treated PR comments as a parallel surface (new `prReviewComments` field on `DiffLine`, new `PrReviewCommentsSection` Inspector component, new gutter glyph). Slice 6 of the spec retired all three in favor of routing through the existing `Reply` / `ReplyThread` rendering — same line glyph, same thread cards — with `Reply.external.source === "pr"` as the only differentiator (drives the "↗ open on GitHub" affordance and the persist-skip rule). The persist skip matters because PR-sourced replies should re-arrive with every refresh; persisting them would create duplicates.

The "Unified load surface" section of the spec (`spec.md:184-187`) committed to folding three duplicate load flows (Welcome, LoadModal, ReviewWorkspace refresh path) into one `useLoadSurface()` hook. That refactor is partial — `useGithubPrLoad` exists, but the URL/paste/file paths are still inline.

### Gaps

- **No push-back.** v0 cannot post comments or reviews to GitHub. The reviewer can comment locally and even thread the PR's existing comments, but those edits don't leave the host.
- **No expand-context for remote PR files.** With no on-disk worktree the symbol nav / runner affordances on PR-only loads either no-op or are hidden.
- **Single PAT per host.** Multi-account on the same host is explicitly out (`spec.md:269`). Switching accounts means clearing and re-entering.
- **No multi-PR match for a branch.** `branch-lookup` returns the first match; rare but exotic to hit.
- **No rate-limit visualization.** Surfacing remaining quota is on the follow-up list.
- **PR rename / transfer breaks identity.** `ReviewState` is keyed by `(host, owner, repo, number)`; a repo rename loses the cached review state.

## 4. Rebuild opportunities

### Data unification

GitHub PR ingest is the single biggest reason `ChangeSet` carries two coexisting source fields. The other four ingest paths each set zero or one of `worktreeSource` / `prSource`; only the worktree↔PR overlay sets both. Modelling that as a discriminated `provenance` with an explicit `overlay` slot:

```ts
type Provenance =
  | { kind: "paste" | "file" | "url"; meta: ... }
  | { kind: "worktree"; worktreeSource: WorktreeSource;
      overlay?: { prSource: PrSource; lastFetchedAt: string } }
  | { kind: "pr"; prSource: PrSource };
```

…says out loud what the current shape implies: the overlay is a worktree-loaded ChangeSet that *added* PR metadata, not a PR-loaded ChangeSet that *coincidentally* has a worktree. Today the only signal that distinguishes the two cases is "which field was set first," which is read from the runtime mutation order in `MERGE_PR_OVERLAY` (`web/src/state.ts:618`).

The same principle applies to PR replies: they ride on the unified `Interaction` shape and are tagged with `external.source = "pr"`. That's the cleaner half of the data model — *one* store, one rendering path, with the source carried as a per-record tag. The "merge external state into the open changeset" pattern shared with worktree-live-reload is the cross-cutting move worth lifting (see `_group7-unification-notes.md`).

### Better architecture

- **One `MERGE_EXTERNAL` reducer.** Today there's `MERGE_PR_OVERLAY` (metadata) + `MERGE_PR_INTERACTIONS` (replies) + `RELOAD_CHANGESET` (worktree refresh with re-anchor). All three are variants of "external state arrived; reconcile against current changeset." Unifying them around a single `applyExternalUpdate({ provenance, interactions, detached, replaceMode })` reducer cuts the action surface and the rule for idempotent-on-refresh is written once, not three times.
- **Make `external.source` a proper discriminator.** Today it's `{ source: "pr"; htmlUrl: string }`. A near-future second external source (teammate ingest, GitLab MR, sentinel re-pull from GitHub round-trip) will want the same shape; widening to `{ source: "pr" | "gitlab" | "teammate" | ...; htmlUrl?: string; externalId?: string }` early avoids a v2 migration.
- **Push branch-lookup latency off the critical path.** `ReviewWorkspace.tsx:1252-1269` runs the lookup synchronously on every worktree-path change, including paths with no remote. The endpoint can return quickly when there's no GitHub-shaped remote, but the call still happens. A capability-flag bit on the worktree changeset response (server already runs `git remote`) would skip the round-trip entirely for non-GitHub repos.
- **Surface the proxy state.** `HTTPS_PROXY` is silent today — it works or it doesn't. A short "via proxy.example.com" trace line in the changeset header would save debugging hours when a GHE deployment intermittently fails. Same hook for rate-limit headers (`X-RateLimit-Remaining`).
- **Recents drawer with PR memory.** `pushRecent` already records the PR URL on every successful load; surfacing the last N PRs as one-click reopens would close the main "paste-only" UX gap without committing to a full "my PRs" list.

## Sources

- `/workspace/docs/sdd/gh-connectivity/spec.md` (esp. lines 1-110, 156-220, 277-289)
- `/workspace/docs/features/github-pr-ingest.md`
- `/workspace/docs/concepts/changeset-hierarchy.md`
- `/workspace/server/src/github/url.ts:10-19`
- `/workspace/server/src/github/pr-load.ts:162-310`
- `/workspace/server/src/github/branch-lookup.ts:55-146`
- `/workspace/server/src/proxy.ts`
- `/workspace/web/src/githubPrClient.ts:56-144`
- `/workspace/web/src/useGithubPrLoad.ts:40-236`
- `/workspace/web/src/githubHostTrust.ts:1-52`
- `/workspace/web/src/auth/credential.ts:13-20`
- `/workspace/web/src/components/GitHubTokenModal.tsx:1-170`
- `/workspace/web/src/components/ReviewWorkspace.tsx:1252-1310`
- `/workspace/web/src/state.ts:281-308, 618-650`
- `/workspace/web/src/types.ts:178, 521-547`
