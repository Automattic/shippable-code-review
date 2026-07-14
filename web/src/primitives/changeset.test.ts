import { describe, expect, it } from "vitest";
import type { DiffFile } from "../types";
import { changeSetId, type ChangeSet, type ChangeSetSource } from "./changeset";

describe("ChangeSet", () => {
  it("derives a worktree id as worktree:{workdir}@{identifier}", () => {
    const src: ChangeSetSource = {
      type: "worktree",
      workdir: "/w/feat",
      branch: "feat",
      identifier: "abc123",
      dirty: false,
    };
    expect(changeSetId(src)).toBe("worktree:/w/feat@abc123");
  });

  it("a ChangeSet links to its parent on refresh", () => {
    const cs: ChangeSet = {
      id: "worktree:/w@sha2",
      parentChangesetId: "worktree:/w@sha1",
      source: {
        type: "worktree",
        workdir: "/w",
        branch: "main",
        identifier: "sha2",
        dirty: true,
      },
      files: [] as DiffFile[],
      ingestedAt: "t0",
    };
    expect(cs.parentChangesetId).toBe("worktree:/w@sha1");
  });
});
