// Builds a throwaway git repo on disk so the worktree-ingest journeys can run
// against the real server's /api/worktrees/* endpoints instead of mocking
// them. The server shells out to `git worktree list --porcelain`, `git diff`,
// etc., so the fixture has to be a genuine repo — not a faked response.
//
// Layout matches `SAMPLE_WORKTREE` in docs/usability-test.md: a base commit on
// `main`, a `feat/x` branch with one extra commit, plus tracked uncommitted
// edits in two files and one untracked file. `greeting.ts` is intentionally
// long with its committed + uncommitted edits far apart, so the cumulative
// diff has separated hunks with collapsed context to expand.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FixtureRepo {
  /** Absolute path to the repo root — paste this into the scan input. */
  path: string;
  /** Remove the repo from disk. Call in afterAll/afterEach. */
  cleanup: () => void;
}

const GREETING_BASE = `export function greet(name: string): string {
  return \`hi, \${name}\`;
}

export function farewell(name: string): string {
  return \`bye, \${name}\`;
}

export const DEFAULT_NAME = "world";

export function greetAll(names: string[]): string[] {
  return names.map((n) => greet(n));
}

export function farewellAll(names: string[]): string[] {
  return names.map((n) => farewell(n));
}

export interface Greeter {
  greet(name: string): string;
  farewell(name: string): string;
}

export const formalGreeter: Greeter = {
  greet: (n) => \`Good day, \${n}\`,
  farewell: (n) => \`Farewell, \${n}\`,
};

export function isGreeter(x: unknown): x is Greeter {
  return typeof x === "object" && x !== null;
}
`;

// Committed on feat/x: a change near the top of the file.
const GREETING_COMMITTED = GREETING_BASE.replace(
  "  return `hi, ${name}`;",
  "  return `hello, ${name}`;",
);

// Tracked uncommitted: a change near the bottom — far enough from the
// committed one that the cumulative diff keeps them in separate hunks.
const GREETING_UNCOMMITTED = GREETING_COMMITTED.replace(
  "  farewell: (n) => `Farewell, ${n}`,",
  "  farewell: (n) => `Goodbye, ${n}`,",
);

const README_BASE = `# fixture

A throwaway repo for e2e worktree tests.
`;

const README_UNCOMMITTED = `# fixture

A throwaway repo for e2e worktree tests.

Edited, uncommitted.
`;

export function createWorktreeRepo(): FixtureRepo {
  // `realpathSync` resolves symlinks in the temp root so this matches what git
  // reports. On macOS `os.tmpdir()` lives under `/var/folders/...` and `/var`
  // is a symlink to `/private/var`; `git rev-parse --show-toplevel` (and the
  // server's `git worktree list`) return the canonical `/private/var/...` form.
  // Tests that POST to `/api/agent/interactions` with this path must use the
  // same string the UI adopts after scanning, or the worktree-keyed store
  // never matches. Linux CI has no such symlink, so this is a no-op there.
  const path = realpathSync(mkdtempSync(join(tmpdir(), "shippable-e2e-wt-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: path, stdio: "pipe" });

  git("init", "-b", "main");
  git("config", "user.email", "e2e@shippable.test");
  git("config", "user.name", "e2e");
  git("config", "commit.gpgsign", "false");

  writeFileSync(join(path, "greeting.ts"), GREETING_BASE);
  writeFileSync(join(path, "README.md"), README_BASE);
  git("add", ".");
  git("commit", "-m", "base commit");

  git("checkout", "-b", "feat/x");
  writeFileSync(join(path, "greeting.ts"), GREETING_COMMITTED);
  git("commit", "-am", "Friendlier greeting");

  // Tracked uncommitted edits in two files + one untracked file, so the
  // changeset shows committed + uncommitted + untracked work.
  writeFileSync(join(path, "greeting.ts"), GREETING_UNCOMMITTED);
  writeFileSync(join(path, "README.md"), README_UNCOMMITTED);
  writeFileSync(join(path, "notes.txt"), "untracked scratch\n");

  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export interface SplitRepo extends FixtureRepo {
  /** Land a follow-up commit on a new file. Moves HEAD (trips the sha-based
   *  live-reload poll) while leaving the uncommitted edit in dirty.ts intact,
   *  so the reload still sees a dirty tree. */
  landCommit: () => void;
}

/**
 * A repo whose committed change and uncommitted change live in DIFFERENT
 * files: `committed.ts` is edited in a commit on `feat/x`, `dirty.ts` only in
 * the working tree. Loading "last commit + uncommitted" shows both; a reload
 * that collapses to dirty-only would drop `committed.ts`, so its presence in
 * the sidebar is a clean assertion. Used by the reload-preserves-range test.
 */
export function createSplitRepo(): SplitRepo {
  const path = mkdtempSync(join(tmpdir(), "shippable-e2e-split-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: path, stdio: "pipe" });

  git("init", "-b", "main");
  git("config", "user.email", "e2e@shippable.test");
  git("config", "user.name", "e2e");
  git("config", "commit.gpgsign", "false");

  writeFileSync(join(path, "committed.ts"), "export const value = 1;\n");
  writeFileSync(join(path, "dirty.ts"), "export const draft = 1;\n");
  git("add", ".");
  git("commit", "-m", "base commit");

  git("checkout", "-b", "feat/x");
  writeFileSync(join(path, "committed.ts"), "export const value = 2;\n");
  git("commit", "-am", "Bump committed value");

  // Uncommitted edit in the OTHER file only — leaves the tree dirty so a
  // reload that collapses to dirty-only would drop committed.ts.
  writeFileSync(join(path, "dirty.ts"), "export const draft = 2;\n");

  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
    landCommit: () => {
      // Commit a NEW file (not dirty.ts) so HEAD moves — tripping the
      // sha-based live-reload poll — while the uncommitted edit survives.
      writeFileSync(join(path, "added.ts"), "export const added = 1;\n");
      git("add", "added.ts");
      git("commit", "-m", "Agent lands a follow-up commit");
    },
  };
}

/** Land a fresh commit in an existing fixture repo — used to trip the
 *  worktree live-reload poll mid-test. */
export function addCommit(repoPath: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoPath, stdio: "pipe" });
  writeFileSync(
    join(repoPath, "greeting.ts"),
    GREETING_UNCOMMITTED.replace(
      'export const DEFAULT_NAME = "world";',
      'export const DEFAULT_NAME = "everyone";',
    ),
  );
  git("commit", "-am", "Widen the default greeting");
}
