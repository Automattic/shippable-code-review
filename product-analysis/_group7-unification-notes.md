# Group 7 — ingest unification notes

Cross-cutting observations across `load-changeset`, `github-pr-ingest`, `commit-range-picker`, `worktree-directory-picker`, `worktree-live-reload`.

## ChangeSet provenance

- `ChangeSet` currently carries two parallel optional source fields (`worktreeSource?`, `prSource?`) that can both be set. Co-existence is real but rare — only the worktree↔PR overlay produces it.
- A discriminated `provenance: { kind; ...; overlay? }` is structurally cleaner: paste/file/url have no overlay; worktree has an optional PR overlay; PR has no overlay. Says out loud what the current shape implies.
- `RecentSource` (`web/src/recents.ts:20-25`) already discriminates the five ingest paths with the right names; it could be the canonical provenance type, not a recents-only sidecar.

## "External state arrives; reconcile against current changeset"

- `RELOAD_CHANGESET` (worktree drift), `MERGE_PR_OVERLAY` (PR metadata), and `MERGE_PR_INTERACTIONS` (PR replies) are three actions for one primitive.
- One `APPLY_EXTERNAL_UPDATE` reducer with `{ provenance, interactions?, detached?, replaceMode? }` covers all three. The content-anchor pass becomes a conditional step keyed on `kind === "reload"`.
- The idempotent-on-refresh rule (strip prior `external.source === "pr"` entries before merging new ones) only lives in `MERGE_PR_INTERACTIONS` today; lifting it to the shared reducer means worktree-style sources can opt in for free.

## Anchored interactions are the unification surface

- The anchor fields on `Interaction` (`originSha`, `originType`, `anchorPath`, `anchorContext`, `anchorHash`, `anchorLineNo`) were designed for worktree live-reload but are already reused by PR-sourced detached interactions in `server/src/github/pr-load.ts:248-272`.
- `originType: "committed" | "dirty"` should generalise to a full `Origin` discriminator covering PR sources too. That lets the same re-anchoring code chase a comment across both worktree reload and PR refresh.

## Polling is one shape, used once

- Only `useWorktreeLiveReload` polls today; PR ingest is manual-refresh-only. A shared `useExternalSync({ source, interval, onDrift })` hook generalises the 3-strike error counter, toggle gating, and baseline drift detection so the second instance (PR auto-poll, if we ever ship it) is a config change, not a duplication.

## Load surface duplication is the named refactor

- `docs/sdd/gh-connectivity/spec.md:184-187` explicitly named `useLoadSurface()` — fold the three duplicate URL/file/paste load paths (Welcome, LoadModal, ReviewWorkspace refresh) into one hook. Partially landed (`useGithubPrLoad`, `useWorktreeLoader` exist); the three client-parsed branches are still inline in LoadModal.
- Side benefit: "URL" and "GitHub PR" tabs collapse to one URL field with `isGithubPrUrl` routing — already noted in the spec.

## Empty-diff handling is split

- `EmptyDiffError` (worktrees) has a typed summary and triggers a `RangePicker` recovery; URL/file/paste empty-diffs just print a generic string. Lifting the typed-error pattern to a shared `LoadOutcome` would let any ingest path offer recovery.

## Directory chooser lives in the server, not Tauri

- `server/src/worktrees.ts:189-231` opens a macOS-only AppleScript folder dialog. `tauri-plugin-dialog` is available but unused. Cross-platform support, sandbox-friendliness, and consistency with the rest of the desktop UX argue for moving the chooser into the Tauri shell. The trade-off is the browser-dev fallback (today's AppleScript path stays useful there).

## Three sharpest things to fix

1. Land `APPLY_EXTERNAL_UPDATE` (one reducer for worktree reload + PR overlay + PR replies).
2. Land `useLoadSurface()` — folds three load paths into one, collapses URL/PR fields, gives all ingest paths the same error rail and empty-diff recovery.
3. Make `Origin` (currently `originType: committed | dirty`) a true discriminator that includes `kind: "pr"`, so the anchor machinery serves both surfaces.
