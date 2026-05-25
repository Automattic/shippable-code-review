# Load Changeset

## 1. Product reasoning & priority

The `LoadModal` is the front door to the entire reviewer — until a `ChangeSet` is in memory there is no diff, no plan, no interactions to write. The product takes IDEA.md's pitch ("review any two git diffs, not just GitHub") literally and surfaces four roughly co-equal ingest pathways: paste a unified diff, drop a `.diff`/`.patch` file, fetch a URL the browser can reach, or hand off the URL to the server for GitHub PR ingest. A worktree section pre-empts those when a local server is reachable. The modal is the only place these paths actually share UI, so it's also the place that has accumulated the most product debt (four sections, three text fields, two error layers, one nested `RangePicker`).

Suggested priority: **must-have** — the prototype's entire value proposition collapses if there is no way to bring a diff into the app, and the three client-parsed ingest paths cost essentially nothing to keep.

## 2. Acceptance criteria for a rebuild

- Modal opens via the topbar "load" button and via `?cs=<id>` failover when boot can't resolve the requested changeset.
- Pasting raw unified-diff text into the textarea and clicking `parse` produces a `ChangeSet` with `id = "pasted-<base36>"` and `source = { kind: "paste" }`.
- Dropping/selecting a `.diff` / `.patch` file produces a `ChangeSet` with `id` derived from the filename minus extension and `source = { kind: "file", filename }`.
- Pasting an HTTPS URL that matches `/<owner>/<repo>/pull/<n>` routes through the GitHub PR flow (`loadGithubPr`) instead of `fetch`; everything else is fetched directly by the browser.
- A `fetch` failure surfaces a CORS-specific hint when the error is a `TypeError`, distinct from HTTP-status errors.
- Parse failures and empty-diff parses surface inline; the modal does not close and does not dispatch `LOAD_CHANGESET`.
- Outside-click on the backdrop only closes when both the URL field and the paste textarea are empty — protects long pasted diffs.
- Escape inside any focused input closes the modal even though the global keymap bails out for inputs.
- The "From a local repo or worktrees folder" section only renders when `/api/health` answered OK (`serverAvailable === true`); it is invisible (not disabled) when the server is unreachable.
- Successful loads call `onLoad(cs, source, prData?)` and push the entry to recents via `pushRecent`.
- A PR URL load surfaces the `GitHubTokenModal` only when the server returns `github_token_required` and no Keychain cache satisfies the host.

## 3. Existing architecture & system design

### Data model

- `ChangeSet` (`web/src/types.ts:144-191`) — the universal target shape. Optional `worktreeSource` (`web/src/types.ts:171`) and `prSource` (`web/src/types.ts:178`) are independent provenance fields that can co-exist.
- `RecentSource` (`web/src/recents.ts:20-25`) — discriminated by `kind: "url" | "file" | "paste" | "worktree" | "stub" | "pr"`. This is the *real* ingest-path enum and the closest thing the codebase has to a unified ingest discriminator.
- `LoadModal` `Props.onLoad` (`web/src/components/LoadModal.tsx:29-37`) — load callback whose third argument (`prData`) is set *only* on the GitHub PR branch, carrying `prInteractions` + `prDetached` that the parent must merge separately via `MERGE_PR_INTERACTIONS`.

### Current architecture decisions

- **Three sections, three handlers in LoadModal itself.** `loadFromUrl` (`web/src/components/LoadModal.tsx:121`), `loadFromFile` (`web/src/components/LoadModal.tsx:149`), and `loadFromPaste` (`web/src/components/LoadModal.tsx:162`) all funnel through `handleParsedText` (`web/src/components/LoadModal.tsx:66`), which calls `parseDiff` and reports empty-file / parse errors. The worktree section is delegated to `useWorktreeLoader` and the GitHub PR section to `useGithubPrLoad`.
- **Client-parsed sources.** Paste, file, and direct-URL go through `web/src/parseDiff.ts` in the browser. The server is not involved.
- **Server-mediated sources.** Worktree (`/api/worktrees/*`) and GitHub PR (`/api/github/pr/load`) hit the server, which itself runs `parseDiff` on its side — `server/src/github/pr-load.ts:1` imports the *web* package's `parseDiff.ts` directly across the package boundary to keep parser semantics identical.
- **URL routing inside the modal.** `isGithubPrUrl` (`web/src/useGithubPrLoad.ts:228-236`) is a regex test against `/<owner>/<repo>/pulls?/\d+/?$`. A PR-shaped URL takes the PR path; everything else is fetched as raw diff. The URL input is a single text field and the modal's hint copy advertises the dual purpose ("A GitHub PR URL […] or any URL serving a unified diff").
- **The empty-diff branch is split.** Paste/file/URL surface `"No files parsed from that diff — is it empty or malformed?"` synchronously (`LoadModal.tsx:74`). Worktree empty-diffs throw `EmptyDiffError` (`worktreeChangeset.ts:25-32`) which `useWorktreeLoader` catches and turns into a structured `wtEmpty` UI on the relevant row plus an auto-opened `RangePicker`. PR empty-diffs hit `loadPr`'s error path.
- **GitHubTokenModal as a nested modal.** When `useGithubPrLoad` flips `tokenModal` non-null, `LoadModal` renders `GitHubTokenModal` inside the same `.modal` container (`LoadModal.tsx:201-209`).

### How it evolved

`docs/concepts/diff-ingestion.md` is the original framing: parse unified-diff text → `ChangeSet` tree, partial parses preferred over hard failure. The plans add ingest paths in order: `docs/plans/worktrees.md` introduced the worktree tab (the *fourth* path) and the directory chooser; `docs/plans/worktree-live-reload.md` then changed how the worktree path interacts with the loaded `ChangeSet` (separate analysis); `docs/sdd/gh-connectivity/spec.md` added the *fifth* path (GitHub PR) and explicitly flagged in its "Unified load surface" section that the three duplicate copies of load logic (Welcome.tsx, LoadModal.tsx, ReviewWorkspace.tsx) should be folded into a single `useLoadSurface()` hook (`spec.md:184-187`). That refactor was deferred and only partially landed — `useGithubPrLoad` and `useWorktreeLoader` are factored hooks, but the three client-parsed paths are still inline copies in LoadModal.

### Gaps

- **No GitLab, Bitbucket, or Gerrit ingest.** The URL field will fetch a `.diff` URL from any of those if CORS allows it, but the rich-metadata path (`prSource` + review comments + conversation) is GitHub-only. IDEA.md called this out as a future need ("connector API").
- **Authenticated diff URLs.** A private `.diff` URL on `gitlab.example.com` requires headers the browser fetch cannot set; the user has to fall back to file upload.
- **No drag-and-drop into the modal.** The file input is a plain `<input type="file">`; dropping a `.diff` onto the modal body has no effect.
- **Recents drawer / "My PRs" surface is missing.** The user re-pastes the URL every time even though `pushRecent` is already recording the last source on every successful load.
- **Empty-diff UX is duplicated.** Paste/file/URL show a generic error string; worktree shows the rich `EmptyDiffError` summary plus a `RangePicker` rescue. PR has neither.

## 4. Rebuild opportunities

### Data unification

The five ingest paths funnel through one callable today (`onLoad(cs, source, prData?)`), but the *contract* is irregular:

- Paste / file / URL: parsed `ChangeSet` only; no extra payload.
- Worktree: parsed `ChangeSet` with `worktreeSource` already set inside it; no extra payload.
- GitHub PR: parsed `ChangeSet` with `prSource` already set inside it, *plus* a third positional argument (`prData`) the parent must merge separately.

A cleaner contract would return a single `LoadResult` discriminated union:
```ts
type LoadResult =
  | { kind: "plain"; changeset: ChangeSet }
  | { kind: "worktree"; changeset: ChangeSet; provenance: WorktreeSource }
  | { kind: "pr"; changeset: ChangeSet; provenance: PrSource;
      interactions: Record<string, Interaction[]>; detached: DetachedInteraction[] };
```

That removes both the "is `prData` set?" branch in `App.handleLoadChangeset` and the fact that `worktreeSource` / `prSource` are mutated onto the `ChangeSet` *before* the reducer sees it. Provenance becomes a sibling of the diff, not a field hiding inside it. This pairs naturally with the cross-cutting suggestion in `_group7-unification-notes.md` to make `ChangeSet` immutable post-parse.

### Better architecture

- **Land `useLoadSurface()`.** `docs/sdd/gh-connectivity/spec.md:184-187` already named this and called out the three current copies. The three client-parsed branches in LoadModal (`loadFromUrl`, `loadFromFile`, `loadFromPaste`) are ~80 lines that could become a single hook consumed by `LoadModal`, `Welcome`, and the multi-window boot path.
- **Collapse "URL" and "GitHub PR" into one field.** The spec already commits to this. `isGithubPrUrl` detects the routing; the field copy can document both modes the way the LoadModal hint already half-does. Saves one full section.
- **Promote empty-diff UX.** Lift `EmptyDiffError`-style structured "no changes" handling out of `worktreeChangeset.ts` to a generic `LoadOutcome` that any ingest path can return. URL / paste / file fetches that produce zero files can offer a `RangePicker`-equivalent affordance ("show me line stats" / "look at the raw response").
- **One error rail.** `LoadModal` has three separate error surfaces today: top-level `err` from the synchronous handlers, `worktrees.err` from the worktree section, `pr.error` from the PR hook. They render in different places with different copy. A single error pipeline with origin tagging would let the modal show *the* error rather than three possible ones.
- **Drag-and-drop on the modal body.** Cheap UX win; the file input already exists, only the surface area is missing.

## Sources

- `/workspace/web/src/components/LoadModal.tsx:1-475`
- `/workspace/web/src/parseDiff.ts`
- `/workspace/web/src/recents.ts:20-25`
- `/workspace/web/src/useGithubPrLoad.ts:228-236`
- `/workspace/web/src/useWorktreeLoader.ts:33-164`
- `/workspace/web/src/worktreeChangeset.ts:25-60`
- `/workspace/docs/concepts/diff-ingestion.md`
- `/workspace/docs/concepts/changeset-hierarchy.md`
- `/workspace/docs/features/load-changeset.md`
- `/workspace/docs/sdd/gh-connectivity/spec.md:184-187`
- `/workspace/docs/architecture.md:222-231`
