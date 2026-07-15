import { describe, expect, it } from "vitest";
import { changeSetId, type ChangeSetSource } from "./changeset";

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
});
