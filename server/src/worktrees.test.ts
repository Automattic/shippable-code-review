import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listCommits, rangeChangeset, stateFor } from "./worktrees.ts";

const execFileAsync = promisify(execFile);

let repo: string;

async function git(args: string[], cwd = repo): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function commit(file: string, body: string, message: string): Promise<string> {
  await fs.writeFile(path.join(repo, file), body);
  await git(["add", file]);
  await git(["commit", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "shippable-wt-"));
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("listCommits", () => {
  it("returns commits newest-first with empty parents on a root", async () => {
    const sha = await commit("a.txt", "alpha\n", "add a");
    const out = await listCommits(repo);
    expect(out).toHaveLength(1);
    expect(out[0]!.sha).toBe(sha);
    expect(out[0]!.shortSha).toBe(sha.slice(0, 7));
    expect(out[0]!.subject).toBe("add a");
    expect(out[0]!.author).toContain("test@example.com");
    expect(out[0]!.parents).toEqual([]);
  });

  it("clamps results to limit, newest first", async () => {
    const a = await commit("a.txt", "a", "first");
    const b = await commit("b.txt", "b", "second");
    const c = await commit("c.txt", "c", "third");
    const out = await listCommits(repo, 2);
    expect(out.map((c) => c.sha)).toEqual([c, b]);
    expect(a).not.toBe(b); // sanity
  });

  it("populates parents on merge commits", async () => {
    const root = await commit("a.txt", "a", "root");
    await git(["checkout", "-b", "feat"]);
    const featSha = await commit("b.txt", "b", "feat");
    await git(["checkout", "main"]);
    const mainSha = await commit("c.txt", "c", "main side");
    await git(["merge", "--no-ff", "feat", "-m", "merge"]);
    const mergeSha = await git(["rev-parse", "HEAD"]);
    const out = await listCommits(repo);
    const merge = out.find((c) => c.sha === mergeSha)!;
    expect(merge.parents.sort()).toEqual([mainSha, featSha].sort());
    expect(root).toBeTruthy();
  });

  it("rejects an out-of-range limit", async () => {
    await commit("a.txt", "a", "init");
    await expect(listCommits(repo, 0)).rejects.toThrow(/limit/);
    await expect(listCommits(repo, 501)).rejects.toThrow(/limit/);
    await expect(listCommits(repo, 1.5)).rejects.toThrow(/limit/);
  });
});

describe("rangeChangeset", () => {
  it("from===to on a non-root commit matches git show's body", async () => {
    const a = await commit("a.txt", "a\n", "add a");
    const b = await commit("b.txt", "b\n", "add b");
    const out = await rangeChangeset(repo, b, b, false);
    expect(out.diff).toContain("+++ b/b.txt");
    expect(out.diff).not.toContain("+++ b/a.txt");
    expect(out.sha).toBe(b);
    expect(out.parentSha).toBe(b.slice(0, 7));
    expect(a).toBeTruthy();
  });

  it("falls back to the empty-tree sha when from is a root commit", async () => {
    const root = await commit("a.txt", "a\n", "root");
    const out = await rangeChangeset(repo, root, root, false);
    // Root commit's diff against the empty tree is the file being added.
    expect(out.diff).toContain("+++ b/a.txt");
    expect(out.diff).toContain("+a");
    expect(out.sha).toBe(root);
  });

  it("a range covers every commit in the inclusive interval", async () => {
    const a = await commit("a.txt", "a\n", "add a");
    const b = await commit("b.txt", "b\n", "add b");
    const c = await commit("c.txt", "c\n", "add c");
    const out = await rangeChangeset(repo, b, c, false);
    expect(out.diff).toContain("+++ b/b.txt");
    expect(out.diff).toContain("+++ b/c.txt");
    expect(out.diff).not.toContain("+++ b/a.txt");
    expect(out.sha).toBe(c);
    expect(a).toBeTruthy();
  });

  it("includeDirty appends working-tree + untracked when toRef is HEAD", async () => {
    const a = await commit("a.txt", "a\n", "add a");
    await fs.writeFile(path.join(repo, "a.txt"), "a\nedited\n");
    await fs.writeFile(path.join(repo, "new.txt"), "fresh\n");
    const out = await rangeChangeset(repo, a, "HEAD", true);
    expect(out.diff).toContain("+edited");
    expect(out.diff).toContain("+++ b/new.txt");
    expect(out.state.dirty).toBe(true);
    expect(out.sha.startsWith("dirty:")).toBe(true);
  });

  it("emits one block for a file changed in both the range and the working tree", async () => {
    const a = await commit("f.txt", "one\ntwo\nthree\n", "add f");
    await commit("f.txt", "one\nTWO\nthree\n", "edit f line 2");
    await fs.writeFile(path.join(repo, "f.txt"), "one\nTWO\nthree\nFOUR\n");
    const out = await rangeChangeset(repo, a, "HEAD", true);
    const blocks = out.diff.match(/^diff --git a\/f\.txt /gm) ?? [];
    expect(blocks).toHaveLength(1);
    expect(out.diff).toContain("+TWO");
    expect(out.diff).toContain("+FOUR");
  });

  it("ignores includeDirty when toRef is a specific sha (not HEAD)", async () => {
    const a = await commit("a.txt", "a\n", "add a");
    const b = await commit("b.txt", "b\n", "add b");
    await fs.writeFile(path.join(repo, "a.txt"), "a\nedited\n");
    await fs.writeFile(path.join(repo, "untracked.txt"), "x\n");
    const out = await rangeChangeset(repo, b, b, true);
    expect(out.diff).not.toContain("+edited");
    expect(out.diff).not.toContain("+++ b/untracked.txt");
    expect(out.sha).toBe(b);
    expect(a).toBeTruthy();
  });

  it("returns per-commit breakdown with body and files", async () => {
    const a = await commit("a.txt", "a\n", "add a");
    await fs.writeFile(path.join(repo, "b.txt"), "b\n");
    await git(["add", "b.txt"]);
    await git([
      "commit",
      "-m",
      "add b",
      "-m",
      "Body line one.\nBody line two.",
    ]);
    const b = await git(["rev-parse", "HEAD"]);
    const out = await rangeChangeset(repo, a, b, false);
    expect(out.commits).toBeDefined();
    expect(out.commits!.map((c) => c.sha)).toEqual([b, a]);
    const bCommit = out.commits!.find((c) => c.sha === b)!;
    expect(bCommit.subject).toBe("add b");
    expect(bCommit.body).toBe("Body line one.\nBody line two.");
    expect(bCommit.files).toEqual(["b.txt"]);
    const aCommit = out.commits!.find((c) => c.sha === a)!;
    expect(aCommit.subject).toBe("add a");
    expect(aCommit.body).toBe("");
    expect(aCommit.files).toEqual(["a.txt"]);
  });
});

describe("stateFor dirtyHash", () => {
  it("is null and dirty:false on a clean tree", async () => {
    await commit("a.txt", "a\n", "add a");
    const state = await stateFor(repo);
    expect(state.dirty).toBe(false);
    expect(state.dirtyHash).toBeNull();
  });

  it("flips when an already-modified file is edited again", async () => {
    await commit("a.txt", "one\n", "add a");
    await fs.writeFile(path.join(repo, "a.txt"), "two\n");
    const first = await stateFor(repo);
    await fs.writeFile(path.join(repo, "a.txt"), "three-longer\n");
    const second = await stateFor(repo);
    expect(first.dirtyHash).not.toBeNull();
    expect(second.dirtyHash).not.toBe(first.dirtyHash);
  });

  it("flips on a same-length edit via mtime, not just size", async () => {
    await commit("a.txt", "orig\n", "add a");
    const file = path.join(repo, "a.txt");
    await fs.writeFile(file, "AAAA\n");
    await fs.utimes(file, new Date(1000), new Date(1000));
    const first = await stateFor(repo);
    await fs.writeFile(file, "BBBB\n"); // same length, different content
    await fs.utimes(file, new Date(2000), new Date(2000));
    const second = await stateFor(repo);
    expect(second.dirtyHash).not.toBe(first.dirtyHash);
  });

  it("flips when an already-untracked file is edited again", async () => {
    await commit("a.txt", "a\n", "add a");
    await fs.writeFile(path.join(repo, "new.txt"), "one\n");
    const first = await stateFor(repo);
    await fs.writeFile(path.join(repo, "new.txt"), "two-longer\n");
    const second = await stateFor(repo);
    expect(first.dirtyHash).not.toBeNull();
    expect(second.dirtyHash).not.toBe(first.dirtyHash);
  });
});
