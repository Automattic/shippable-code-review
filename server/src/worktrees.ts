import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createHash } from "node:crypto";
import { isGraphAnalyzablePath } from "../../web/src/codeGraph.ts";
import {
  buildRepoGraphRequest,
  invalidateCodeGraphForWorkspace,
  resolveCodeGraph,
} from "./codeGraph.ts";
import type { CodeGraph } from "../../web/src/types.ts";

// PROTOTYPE: thin wrapper around `git worktree list --porcelain` and
// `git show`. Production hardening is needed before this ships outside dev:
//   - tighter path validation (realpath + allowed-roots list),
//   - per-IP rate limits,
//   - a max-output cap on `git show` (very large commits could OOM),
//   - explicit user consent / picker for the directory rather than a free-form
//     text input.

const execFileAsync = promisify(execFile);

// Resolve `git` once at module load so a later $PATH change can't redirect us
// to a different binary. Falls back to bare "git" if the lookup fails.
export const GIT = resolveGit();

function resolveGit(): string {
  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "git");
    try {
      const st = fsSync.statSync(candidate);
      if (!st.isFile()) continue;
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // try next entry
    }
  }
  return "git";
}

export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
}

export interface ListResult {
  worktrees: Worktree[];
}

/**
 * Live-reload probe: HEAD sha plus a digest of the working tree. The digest
 * comes from `git status --porcelain=v2 -z` (cheap; no diff content) so the
 * polling endpoint stays well under the cost of a full diff. `dirtyHash` is
 * null when the tree is clean.
 */
export interface WorktreeState {
  sha: string;
  dirty: boolean;
  dirtyHash: string | null;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  parents: string[];
}

export interface RangeCommit {
  sha: string;
  shortSha: string;
  subject: string;
  /** Commit message body — everything after the subject line. May be empty. */
  body: string;
  author: string;
  date: string;
  parents: string[];
  /** Repo-relative paths touched by this commit. May be empty for merges. */
  files: string[];
}

export interface ChangesetResult {
  diff: string;
  sha: string;
  subject: string;
  author: string;
  date: string;
  branch: string | null;
  /**
   * Per-commit breakdown. Newest first. Populated for paths that resolve a
   * range (single-commit, branch, or fromRef..toRef); absent on dirty-only
   * loads. Capped to keep the response small — see PER_COMMIT_LIMIT.
   */
  commits?: RangeCommit[];
  /**
   * Worktree state observed when this changeset was produced. Returned
   * alongside the diff so the live-reload poll can start with a baseline
   * without a second round-trip.
   */
  state: WorktreeState;
  /**
   * Display label rendered in the topbar after `<branch> → `. May be a
   * short-sha (when the branch has diverged from a base ref), the literal
   * string "working tree" (when the branch is at parity with its base and
   * the diff is uncommitted-only), or null (no base ref could be resolved
   * — caller falls back to a placeholder).
   */
  parentSha: string | null;
  /**
   * Post-change content for files the frontend can render specially —
   * currently markdown files for the preview pane. Keys are repo-relative
   * paths matching the `+++ b/<path>` lines in the diff. Files deleted in
   * this commit are omitted (no post-change content exists). Files large
   * enough to fail the per-file maxBuffer are also skipped silently rather
   * than failing the whole request.
   */
  fileContents: Record<string, string>;
}

export type PickDirectoryResult =
  | { path: string }
  | { cancelled: true };

/**
 * Validate that `dir` is an absolute path that exists, is a directory, and
 * contains a `.git` entry (file for worktrees, dir for the main repo).
 * Throws a user-facing Error on failure.
 *
 * Prototype-grade: doesn't follow symlinks defensively, doesn't enforce an
 * allowed-roots list. Sufficient for a local-only dev tool; revisit before
 * exposing to untrusted callers.
 */
async function assertGitDir(dir: string): Promise<void> {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("dir must be a non-empty string");
  }
  if (!path.isAbsolute(dir)) {
    throw new Error(`dir must be an absolute path, got: ${dir}`);
  }
  // Quick traversal sanity check — path.isAbsolute on darwin already rejects
  // most weirdness, but explicitly bail on `..` segments anyway.
  if (dir.split(path.sep).includes("..")) {
    throw new Error("dir must not contain '..' segments");
  }
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new Error(`dir does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`dir is not a directory: ${dir}`);
  }
  // `.git` is a directory in the main repo and a file (`gitdir: …`) in
  // worktrees — accept either.
  try {
    await fs.stat(path.join(dir, ".git"));
  } catch {
    throw new Error(`dir does not look like a git repo (no .git entry): ${dir}`);
  }
}

async function normalizeDefaultDirectory(
  startPath: string | undefined,
): Promise<string | null> {
  if (!startPath || !path.isAbsolute(startPath)) return null;
  try {
    const stat = await fs.stat(startPath);
    if (!stat.isDirectory()) return null;
    return startPath;
  } catch {
    return null;
  }
}

function toAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function pickDirectory(
  startPath?: string,
): Promise<PickDirectoryResult> {
  if (process.platform !== "darwin") {
    throw new Error("directory chooser is only wired up on macOS right now");
  }

  const defaultDir = await normalizeDefaultDirectory(startPath);
  const args: string[] = [];
  if (defaultDir) {
    args.push(
      "-e",
      `set chosenFolder to choose folder with prompt "Choose a local repo or worktrees folder" default location POSIX file "${toAppleScriptString(defaultDir)}"`,
    );
  } else {
    args.push(
      "-e",
      'set chosenFolder to choose folder with prompt "Choose a local repo or worktrees folder"',
    );
  }
  args.push("-e", "return POSIX path of chosenFolder");

  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", args, {
      maxBuffer: 128 * 1024,
    });
    const chosen = stdout.trim();
    if (!chosen) {
      throw new Error("folder chooser returned an empty path");
    }
    return { path: chosen };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("User canceled") ||
      message.includes("User cancelled") ||
      message.includes("(-128)")
    ) {
      return { cancelled: true };
    }
    throw err;
  }
}

/**
 * Run `git worktree list --porcelain` in `dir` and parse the output.
 * The porcelain format groups each worktree as a block of `key value` lines
 * separated by blank lines. Keys we care about: worktree, HEAD, branch,
 * bare, detached.
 */
export async function listWorktrees(dir: string): Promise<ListResult> {
  await assertGitDir(dir);
  const { stdout } = await execFileAsync(
    GIT,
    ["worktree", "list", "--porcelain"],
    { cwd: dir, maxBuffer: 4 * 1024 * 1024 },
  );

  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> & { detached?: boolean } = {};
  const flush = () => {
    if (current.path && current.head) {
      worktrees.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head,
        isMain: worktrees.length === 0, // git lists the main worktree first
      });
    }
    current = {};
  };

  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") current.path = value;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") {
      // value is like `refs/heads/feature-x` — strip the prefix for display.
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (key === "detached") current.detached = true;
  }
  flush();

  return { worktrees };
}

/**
 * Probe HEAD + working-tree fingerprint for the live-reload poll. The
 * dirty digest is computed from `git status --porcelain=v2 -z` — the v2
 * format includes mode + sha + path for every tracked change, plus untracked
 * paths, so any edit (staged or unstaged) flips the hash. NUL-separated so
 * paths with spaces or newlines hash the same way they print.
 */
// Last-seen fingerprint per workspace. The /api/worktrees/state poll is the
// closest thing we have to a server-side file-watcher tick; when its result
// drifts, drop the code-graph cache + LSP clients for that workspace so the
// next graph request gets fresh references against the new content.
const lastFingerprint = new Map<string, string>();

export async function stateFor(worktreePath: string): Promise<WorktreeState> {
  await assertGitDir(worktreePath);
  const [sha, statusBuf] = await Promise.all([
    revParseHead(worktreePath),
    statusPorcelainV2(worktreePath),
  ]);
  const dirtyHash = statusBuf.length === 0
    ? null
    : createHash("sha1").update(statusBuf).digest("hex").slice(0, 16);
  const fingerprint = `${sha}:${dirtyHash ?? ""}`;
  const previous = lastFingerprint.get(worktreePath);
  if (previous !== undefined && previous !== fingerprint) {
    invalidateCodeGraphForWorkspace(worktreePath).catch((err) => {
      console.warn(`[worktrees] code-graph invalidation failed for ${worktreePath}:`, err);
    });
  }
  lastFingerprint.set(worktreePath, fingerprint);
  return dirtyHash === null
    ? { sha, dirty: false, dirtyHash: null }
    : { sha, dirty: true, dirtyHash };
}

async function revParseHead(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync(GIT, ["rev-parse", "HEAD"], {
    cwd: worktreePath,
  });
  return stdout.trim();
}

async function statusPorcelainV2(worktreePath: string): Promise<Buffer> {
  // `--porcelain=v2 -z` emits NUL-terminated entries with mode/sha/path,
  // covering staged + unstaged + untracked. Empty stdout = clean tree.
  const { stdout } = await execFileAsync(
    GIT,
    ["status", "--porcelain=v2", "-z", "--untracked-files=normal"],
    { cwd: worktreePath, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" },
  );
  return stdout;
}

/**
 * Return the latest commit on `path` (default HEAD) as a unified diff plus
 * metadata. Uses `git show --format=… --patch` and parses the trailing
 * metadata block we ask for.
 */
export async function changesetFor(
  worktreePath: string,
  ref: string = "HEAD",
): Promise<ChangesetResult> {
  await assertGitDir(worktreePath);
  validateRef(ref);

  // Use a delimiter that's vanishingly unlikely to occur in commit metadata
  // so we can split metadata from the diff body cleanly. %P is the
  // space-separated list of parent SHAs — empty for the very first commit
  // on a branch.
  const SEP = "<<<SHIPPABLE-WT-SEP>>>";
  const fmt = `%H%n%s%n%an <%ae>%n%aI%n%P%n${SEP}`;
  const { stdout } = await execFileAsync(
    GIT,
    ["show", `--format=${fmt}`, "--patch", "--end-of-options", ref],
    { cwd: worktreePath, maxBuffer: 32 * 1024 * 1024 },
  );

  const sepIdx = stdout.indexOf(SEP);
  if (sepIdx === -1) {
    throw new Error("git show output missing separator — unexpected format");
  }
  const meta = stdout.slice(0, sepIdx).split("\n");
  // Skip the newline that follows SEP.
  const diff = stdout.slice(sepIdx + SEP.length).replace(/^\n/, "");
  const [sha = "", subject = "", author = "", date = "", parentsRaw = ""] =
    meta;
  const firstParent = parentsRaw.trim().split(/\s+/).filter(Boolean)[0] ?? "";
  const parentSha = firstParent ? firstParent.slice(0, 7) : null;

  // Resolve the branch name for the worktree (best effort; detached heads
  // return an empty string).
  let branch: string | null = null;
  try {
    const { stdout: br } = await execFileAsync(
      GIT,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: worktreePath },
    );
    const trimmed = br.trim();
    branch = trimmed && trimmed !== "HEAD" ? trimmed : null;
  } catch {
    branch = null;
  }

  // Pull post-change content for markdown files in the diff so the frontend
  // preview can render them. Best effort: a single failure (e.g. deleted file
  // or oversized blob) is logged and skipped rather than aborting the whole
  // request.
  const fileContents: Record<string, string> = {};
  for (const p of extractRenderablePaths(diff)) {
    try {
      const { stdout: content } = await execFileAsync(
        GIT,
        ["show", "--end-of-options", `${sha}:${p}`],
        { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 },
      );
      fileContents[p] = content;
    } catch {
      // File may not exist at this ref (deleted) or content exceeds buffer —
      // omit and let the frontend fall back to raw-source view.
    }
  }

  const state = await stateFor(worktreePath);
  const commits = await listCommitsWithFiles(worktreePath, sha, ["-1"]).catch(
    () => undefined,
  );
  return {
    diff,
    sha,
    subject,
    author,
    date,
    branch,
    parentSha,
    fileContents,
    state,
    ...(commits && commits.length > 0 ? { commits } : {}),
  };
}

/**
 * "Branch view" of a worktree: cumulative diff of *all* the work this branch
 * represents — committed since divergence from main/upstream, plus tracked
 * uncommitted changes, plus untracked-but-not-ignored files. This is the
 * default for the LoadModal because reviewers thinking "what does this
 * worktree contain?" expect everything in flight, not just the latest commit.
 *
 * Base resolution attempts in order: `@{upstream}`, `origin/main`,
 * `origin/master`, `main`, `master`. When none resolve, the diff is empty
 * (branch is at parity and has no work-in-progress).
 *
 * Untracked files are synthesised as new-file diffs because `git diff
 * --no-index` doesn't always emit the `a/`/`b/` prefixes parseDiff expects;
 * synthesising keeps the diff parser predictable. Binary detection uses a
 * NUL-byte heuristic in the first 8KB.
 */
export async function branchChangeset(
  worktreePath: string,
): Promise<ChangesetResult> {
  await assertGitDir(worktreePath);

  const headSha = (
    await execFileAsync(GIT, ["rev-parse", "HEAD"], { cwd: worktreePath })
  ).stdout.trim();

  // Pull HEAD's metadata for display. Subject/author/date describe the latest
  // commit even when most of the diff is uncommitted — best we can do without
  // a richer "many commits + dirty tree" UI.
  const SEP = "<<<SHIPPABLE-WT-SEP>>>";
  const fmt = `%s%n%an <%ae>%n%aI%n${SEP}`;
  const { stdout: metaOut } = await execFileAsync(
    GIT,
    ["log", "-1", `--format=${fmt}`, "--end-of-options", headSha],
    { cwd: worktreePath },
  );
  const sepIdx = metaOut.indexOf(SEP);
  const meta = sepIdx >= 0 ? metaOut.slice(0, sepIdx).split("\n") : [];
  const [subject = "", author = "", date = ""] = meta;

  let branch: string | null = null;
  try {
    const { stdout: br } = await execFileAsync(
      GIT,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: worktreePath },
    );
    const trimmed = br.trim();
    branch = trimmed && trimmed !== "HEAD" ? trimmed : null;
  } catch {
    branch = null;
  }

  const baseRef = await resolveBaseRef(worktreePath);
  const mergeBase = baseRef ? await resolveMergeBase(worktreePath, baseRef, headSha) : null;
  const effectiveBase = mergeBase ?? null;

  // Tracked diff: cumulative committed-since-base + uncommitted-tracked.
  // `git diff <base>` (no `..HEAD`) compares base to working tree.
  let trackedDiff = "";
  if (effectiveBase) {
    trackedDiff = await safeGitDiff(
      ["diff", "--end-of-options", effectiveBase],
      worktreePath,
    );
  }

  // Untracked: synthesise new-file diffs so parseDiff handles them uniformly.
  let untrackedDiff = "";
  try {
    const { stdout: untrackedList } = await execFileAsync(
      GIT,
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 },
    );
    const files = untrackedList.split("\n").filter(Boolean);
    for (const rel of files) {
      try {
        const synth = await synthesiseNewFileDiff(worktreePath, rel);
        if (synth) untrackedDiff += synth;
      } catch {
        // Unreadable / binary / vanished — skip rather than fail the request.
      }
    }
  } catch {
    // ls-files failure is non-fatal; tracked diff is still useful.
  }

  const diff = trackedDiff + untrackedDiff;

  // Post-change content for markdown previews. Read from the working tree —
  // covers committed-changed, uncommitted-modified, and untracked-new in one
  // motion. Files that vanished are silently skipped.
  const fileContents: Record<string, string> = {};
  for (const p of extractRenderablePaths(diff)) {
    try {
      const content = await fs.readFile(path.join(worktreePath, p), "utf8");
      fileContents[p] = content;
    } catch {
      // missing / unreadable — frontend falls back to in-diff content
    }
  }

  // Topbar label for `<branch> → <base>`:
  //   - "working tree" when merge-base == HEAD (branch at parity, only
  //     uncommitted/untracked are interesting)
  //   - merge-base short-sha when the branch has diverged
  //   - null when no base could be resolved at all (no upstream/main/master)
  const baseLabel: string | null = effectiveBase
    ? effectiveBase === headSha
      ? "working tree"
      : effectiveBase.slice(0, 7)
    : null;

  const state = await stateFor(worktreePath);
  // Branch view: every commit since divergence from the resolved base. Skip
  // when no base could be resolved (orphan branch / no upstream) — there's no
  // meaningful "since" to walk.
  const commits = effectiveBase
    ? await listCommitsWithFiles(
        worktreePath,
        effectiveBase === headSha ? `${headSha}~..${headSha}` : `${effectiveBase}..${headSha}`,
      ).catch(() => undefined)
    : undefined;
  return {
    diff,
    sha: headSha,
    subject: subject || "(no commit subject)",
    author,
    date,
    branch,
    parentSha: baseLabel,
    fileContents,
    state,
    ...(commits && commits.length > 0 ? { commits } : {}),
  };
}

/**
 * Dirty-only changeset: `git diff HEAD` for the current working tree. Used
 * when the live-reload banner offers to refresh into the uncommitted state.
 * Synthesizes `dirty:<dirtyHash>` as the changeset id so the review state
 * machinery can distinguish two dirty snapshots.
 *
 * If the tree is clean by the time we run, returns an empty diff and lets
 * the caller decide whether to fall back to the regular changeset path.
 */
export async function dirtyChangesetFor(
  worktreePath: string,
): Promise<ChangesetResult> {
  await assertGitDir(worktreePath);

  const headSha = await revParseHead(worktreePath);

  // Tracked dirty diff via `git diff HEAD`. Exits 1 when changes are present
  // — that's not an error.
  const trackedDiff = await safeGitDiff(["diff", "HEAD"], worktreePath);

  // Untracked, synthesized as new-file diffs. Same treatment as branchChangeset.
  let untrackedDiff = "";
  try {
    const { stdout: untrackedList } = await execFileAsync(
      GIT,
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 },
    );
    const files = untrackedList.split("\n").filter(Boolean);
    for (const rel of files) {
      try {
        const synth = await synthesiseNewFileDiff(worktreePath, rel);
        if (synth) untrackedDiff += synth;
      } catch {
        // Skip unreadable/binary/vanished files.
      }
    }
  } catch {
    // ls-files failure is non-fatal.
  }

  const diff = trackedDiff + untrackedDiff;

  let branch: string | null = null;
  try {
    const { stdout: br } = await execFileAsync(
      GIT,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: worktreePath },
    );
    const trimmed = br.trim();
    branch = trimmed && trimmed !== "HEAD" ? trimmed : null;
  } catch {
    branch = null;
  }

  const fileContents: Record<string, string> = {};
  for (const p of extractRenderablePaths(diff)) {
    try {
      const content = await fs.readFile(path.join(worktreePath, p), "utf8");
      fileContents[p] = content;
    } catch {
      // missing / unreadable — frontend falls back to in-diff content
    }
  }

  const state = await stateFor(worktreePath);
  // Synthesize a stable id that changes with the tree. Falls back to the
  // HEAD sha when the tree is clean (race with a commit landing between
  // the client probe and this call).
  const sha = state.dirtyHash ? `dirty:${state.dirtyHash}` : headSha;

  return {
    diff,
    sha,
    subject: state.dirty ? "Uncommitted changes" : "(no uncommitted changes)",
    author: "(working tree)",
    date: new Date().toISOString(),
    branch,
    parentSha: headSha.slice(0, 7),
    fileContents,
    state,
  };
}

/**
 * Recent commits on `worktreePath` (HEAD-ward) for the range picker. Uses ASCII
 * unit/record separators so commit subjects can contain anything except 0x1e
 * — which is essentially nothing in real-world commit messages.
 */
export async function listCommits(
  worktreePath: string,
  limit = 50,
): Promise<CommitInfo[]> {
  await assertGitDir(worktreePath);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error(`limit must be an integer in [1, 500], got: ${limit}`);
  }

  const FS = "\x1f";
  const RS = "\x1e";
  const fmt = `%H${FS}%h${FS}%s${FS}%an <%ae>${FS}%aI${FS}%P${RS}`;
  const { stdout } = await execFileAsync(
    GIT,
    ["log", `-n${limit}`, `--format=${fmt}`, "--end-of-options", "HEAD"],
    { cwd: worktreePath, maxBuffer: 8 * 1024 * 1024 },
  );

  const commits: CommitInfo[] = [];
  for (const record of stdout.split(RS)) {
    const trimmed = record.replace(/^\n/, "");
    if (!trimmed) continue;
    const [sha = "", shortSha = "", subject = "", author = "", date = "", parentsRaw = ""] =
      trimmed.split(FS);
    if (!sha) continue;
    commits.push({
      sha,
      shortSha,
      subject,
      author,
      date,
      parents: parentsRaw.trim().split(/\s+/).filter(Boolean),
    });
  }
  return commits;
}

// Standard empty-tree sha; used as a fallback "parent" when the user picks the
// repo's first commit (which has no real parent) so `git diff` still works.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Cap the per-commit breakdown to keep responses bounded; the plan UI only
// renders this many anyway, with a "and N more" footer above this threshold.
const PER_COMMIT_LIMIT = 50;

/**
 * Walk a git log range and return per-commit metadata + body + name-only file
 * list for each commit. `range` is the standard rev-list spec — typically
 * `<exclusiveBase>..<inclusiveTip>`, or just `<sha>` (with a `-1` arg) for a
 * single commit.
 *
 * Uses ASCII unit/record separators to delimit fields and commits, the same
 * convention `listCommits` uses. The format ends with `%b<FS>` so the
 * --name-only file list (which appears between formatted records) lands as a
 * separate FS-delimited field rather than getting glued onto the body.
 */
async function listCommitsWithFiles(
  worktreePath: string,
  range: string,
  extraArgs: string[] = [],
): Promise<RangeCommit[]> {
  const FS = "\x1f";
  const RS = "\x1e";
  const fmt = `${RS}%H${FS}%h${FS}%s${FS}%an <%ae>${FS}%aI${FS}%P${FS}%b${FS}`;
  const { stdout } = await execFileAsync(
    GIT,
    [
      "log",
      `--format=${fmt}`,
      "--name-only",
      ...extraArgs,
      "--end-of-options",
      range,
    ],
    { cwd: worktreePath, maxBuffer: 32 * 1024 * 1024 },
  );

  const out: RangeCommit[] = [];
  for (const record of stdout.split(RS)) {
    if (out.length >= PER_COMMIT_LIMIT) break;
    if (!record.trim()) continue;
    const parts = record.split(FS);
    const [
      sha = "",
      shortSha = "",
      subject = "",
      author = "",
      date = "",
      parentsRaw = "",
      body = "",
      filesBlob = "",
    ] = parts;
    if (!sha) continue;
    const files = filesBlob
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({
      sha,
      shortSha,
      subject,
      body: body.replace(/^\n+|\n+$/g, ""),
      author,
      date,
      parents: parentsRaw.trim().split(/\s+/).filter(Boolean),
      files,
    });
  }
  return out;
}

/**
 * Diff a range `fromRef..toRef` (inclusive of `from`) plus, optionally, the
 * working tree when `toRef === "HEAD"`. Backs the range picker — single-commit
 * review falls out as `from === to`.
 */
export async function rangeChangeset(
  worktreePath: string,
  fromRef: string,
  toRef: string,
  includeDirty: boolean,
): Promise<ChangesetResult> {
  await assertGitDir(worktreePath);
  validateRef(fromRef);
  validateRef(toRef);

  const toSha = toRef === "HEAD"
    ? await revParseHead(worktreePath)
    : (await execFileAsync(
        GIT,
        ["rev-parse", "--verify", "--end-of-options", `${toRef}^{commit}`],
        { cwd: worktreePath },
      )).stdout.trim();

  const fromSha = (await execFileAsync(
    GIT,
    ["rev-parse", "--verify", "--end-of-options", `${fromRef}^{commit}`],
    { cwd: worktreePath },
  )).stdout.trim();

  // `from`'s parent — the diff base. If `from` is a root commit, fall back to
  // the empty-tree sha so the diff still resolves.
  let diffBase: string;
  try {
    const { stdout } = await execFileAsync(
      GIT,
      ["rev-parse", "--verify", "--end-of-options", `${fromSha}^`],
      { cwd: worktreePath },
    );
    diffBase = stdout.trim();
  } catch {
    diffBase = EMPTY_TREE_SHA;
  }

  const dirtyApplies = includeDirty && toRef === "HEAD";

  // When folding in the working tree, diff `diffBase` straight to it (no
  // `..toSha`) so committed range + uncommitted edits land in one diff per
  // file — same shape changesetFor uses. Concatenating `diffBase..toSha` with
  // `git diff HEAD` would emit a second `diff --git` block for every file
  // touched in both, with conflicting line numbers downstream.
  let trackedDiff = await safeGitDiff(
    dirtyApplies
      ? ["diff", "--end-of-options", diffBase]
      : ["diff", "--end-of-options", diffBase, toSha],
    worktreePath,
  );

  if (dirtyApplies) {
    try {
      const { stdout: untrackedList } = await execFileAsync(
        GIT,
        ["ls-files", "--others", "--exclude-standard"],
        { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 },
      );
      for (const rel of untrackedList.split("\n").filter(Boolean)) {
        try {
          const synth = await synthesiseNewFileDiff(worktreePath, rel);
          if (synth) trackedDiff += synth;
        } catch {
          // skip unreadable / vanished
        }
      }
    } catch {
      // ls-files failure non-fatal
    }
  }

  const SEP = "<<<SHIPPABLE-WT-SEP>>>";
  const fmt = `%s%n%an <%ae>%n%aI%n${SEP}`;
  const { stdout: metaOut } = await execFileAsync(
    GIT,
    ["log", "-1", `--format=${fmt}`, "--end-of-options", toSha],
    { cwd: worktreePath },
  );
  const sepIdx = metaOut.indexOf(SEP);
  const meta = sepIdx >= 0 ? metaOut.slice(0, sepIdx).split("\n") : [];
  const [subject = "", author = "", date = ""] = meta;

  let branch: string | null = null;
  try {
    const { stdout: br } = await execFileAsync(
      GIT,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: worktreePath },
    );
    const trimmed = br.trim();
    branch = trimmed && trimmed !== "HEAD" ? trimmed : null;
  } catch {
    branch = null;
  }

  const fileContents: Record<string, string> = {};
  for (const p of extractRenderablePaths(trackedDiff)) {
    try {
      if (dirtyApplies) {
        fileContents[p] = await fs.readFile(path.join(worktreePath, p), "utf8");
      } else {
        const { stdout: content } = await execFileAsync(
          GIT,
          ["show", "--end-of-options", `${toSha}:${p}`],
          { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 },
        );
        fileContents[p] = content;
      }
    } catch {
      // missing / oversized / deleted — frontend falls back to in-diff content
    }
  }

  const state = await stateFor(worktreePath);
  const sha = dirtyApplies && state.dirty ? `dirty:${state.dirtyHash}` : toSha;

  // Per-commit breakdown: every commit reachable from `toSha` but not from
  // `fromSha`'s parent. That spans the whole picked range, including `from`
  // itself. `diffBase === EMPTY_TREE_SHA` means `from` is a root commit; in
  // that case `git log` of just the tip gives us everything.
  const commits = await listCommitsWithFiles(
    worktreePath,
    diffBase === EMPTY_TREE_SHA ? toSha : `${diffBase}..${toSha}`,
  ).catch(() => undefined);

  return {
    diff: trackedDiff,
    sha,
    subject: subject || "(no commit subject)",
    author,
    date,
    branch,
    parentSha: fromSha.slice(0, 7),
    fileContents,
    state,
    ...(commits && commits.length > 0 ? { commits } : {}),
  };
}

async function resolveBaseRef(worktreePath: string): Promise<string | null> {
  const candidates = ["@{upstream}", "origin/main", "origin/master", "main", "master"];
  for (const c of candidates) {
    try {
      const { stdout } = await execFileAsync(
        GIT,
        ["rev-parse", "--verify", "--end-of-options", `${c}^{commit}`],
        { cwd: worktreePath },
      );
      const sha = stdout.trim();
      if (sha) return sha;
    } catch {
      // try next
    }
  }
  return null;
}

async function resolveMergeBase(
  worktreePath: string,
  base: string,
  ref: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      GIT,
      ["merge-base", "--end-of-options", base, ref],
      { cwd: worktreePath },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run git diff and tolerate exit code 1 (which `git diff` and
 * `git diff --no-index` use to signal "differences detected" — we want the
 * stdout in that case, not a thrown error).
 */
async function safeGitDiff(
  args: string[],
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(GIT, args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    if (err.code === 1 && typeof err.stdout === "string") return err.stdout;
    throw e;
  }
}

/**
 * Build a synthetic "new file" diff entry for an untracked file. Skips
 * files that look binary (NUL byte in first 8KB) and files larger than a
 * conservative cap — both kept out of the human-reviewable diff.
 */
async function synthesiseNewFileDiff(
  worktreePath: string,
  rel: string,
): Promise<string> {
  const abs = path.join(worktreePath, rel);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) return "";
  if (stat.size > 2 * 1024 * 1024) return ""; // conservative cap on huge new files
  const buf = await fs.readFile(abs);
  // Binary heuristic: NUL byte in the first 8KB.
  const probe = buf.subarray(0, Math.min(8192, buf.length));
  if (probe.includes(0)) return "";
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  // If the file ends with a trailing newline, split leaves an empty trailing
  // entry — drop it so the line count matches what reviewers expect.
  const hasTrailingNewline = text.endsWith("\n");
  if (hasTrailingNewline && lines[lines.length - 1] === "") lines.pop();
  const body = lines.map((l) => "+" + l).join("\n");
  const header =
    `diff --git a/${rel} b/${rel}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${rel}\n` +
    `@@ -0,0 +1,${lines.length} @@\n`;
  return header + body + (body.length > 0 ? "\n" : "");
}

/**
 * Return the contents of `file` at commit `sha` via `git show <sha>:<file>`.
 * Used by the live-reload "view at <sha7>" affordance on detached committed
 * comments. The path validation matches the rest of this module — same
 * `assertGitDir`, same `validateRef` rules — and `file` is required to be a
 * non-empty repo-relative path with no `..` segments and no leading `/`.
 *
 * Errors from git (missing blob, oversized output) propagate as exceptions;
 * the HTTP layer maps them onto a 4xx.
 */
export async function fileAt(
  worktreePath: string,
  sha: string,
  file: string,
): Promise<string> {
  await assertGitDir(worktreePath);
  validateRef(sha);
  validateRepoRelativePath(file);
  const { stdout } = await execFileAsync(
    GIT,
    ["show", "--end-of-options", `${sha}:${file}`],
    { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

function validateRepoRelativePath(p: string): void {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("file must be a non-empty string");
  }
  if (p.startsWith("/")) {
    throw new Error(`file must be repo-relative, got: ${p}`);
  }
  if (p.split("/").includes("..")) {
    throw new Error("file must not contain '..' segments");
  }
  // Reject obvious shell-meaningful bytes; git itself is safe (we're going
  // through execFile, not a shell), but rejecting them keeps surprises low.
  if (/\x00/.test(p)) {
    throw new Error("file must not contain NUL bytes");
  }
}

export async function repoGraphFor(
  worktreePath: string,
  ref: string = "HEAD",
): Promise<CodeGraph> {
  await assertGitDir(worktreePath);
  validateRef(ref);
  const request = await buildRepoGraphRequest(worktreePath, ref);
  const response = await resolveCodeGraph(request);
  return response.graph;
}

/**
 * Pull repo-relative paths of files we want to ship post-change content for
 * (currently any `.md` file added or modified in the diff). Skips deletions
 * by ignoring `/dev/null` on the `+++` line.
 */
function extractRenderablePaths(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    if (line.includes("/dev/null")) continue;
    const m = /^\+\+\+ b\/(.+?)(?:\t.*)?$/.exec(line);
    if (!m) continue;
    const path = m[1];
    if (path.endsWith(".md")) out.add(path);
  }
  return Array.from(out);
}

function validateRef(ref: string): void {
  if (ref.startsWith("-")) {
    throw new Error(`ref must not start with '-': ${ref}`);
  }
  if (!/^[A-Za-z0-9_./~^@-]{1,200}$/.test(ref)) {
    throw new Error(`invalid ref: ${ref}`);
  }
}
