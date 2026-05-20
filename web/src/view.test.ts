import { describe, expect, it } from "vitest";
import { buildSidebarViewModel, buildStatusBarViewModel } from "./view";
import type { BuildStatusBarViewModelArgs } from "./view";
import type { Interaction } from "./types";
import {
  blockCommentKey,
  hunkSummaryReplyKey,
  lineNoteReplyKey,
  teammateReplyKey,
  userCommentKey,
} from "./types";

function reply(id: string): Interaction {
  return {
    id,
    threadKey: "user:cs1/web/src/state.ts#h1:0",
    target: "reply",
    intent: "comment",
    author: "me",
    authorRole: "user",
    body: "x",
    createdAt: "2026-05-11T00:00:00Z",
  };
}

// Two files: one with a "normal" csId, one with a PR csId that contains
// colons (the regression case — see server/src/github/pr-load.ts:189).
const NORMAL_HUNK = "cs1/web/src/state.ts#h1";
const PR_HUNK = "pr:github.com:owner:repo:123/web/src/view.ts#h1";

const files = [
  {
    id: "f-normal",
    path: "web/src/state.ts",
    status: "modified" as const,
    hunks: [{ id: NORMAL_HUNK, lines: [] }],
  },
  {
    id: "f-pr",
    path: "web/src/view.ts",
    status: "modified" as const,
    hunks: [{ id: PR_HUNK, lines: [] }],
  },
];

function commentCountByFileId(
  interactions: Record<string, Interaction[]>,
): Map<string, number> {
  const vm = buildSidebarViewModel({
    files,
    currentFileId: "f-normal",
    readLines: {},
    reviewedFiles: new Set(),
    interactions,
  });
  return new Map(vm.files.map((f) => [f.fileId, f.commentCount]));
}

describe("buildSidebarViewModel commentCount", () => {
  it("counts every reply kind against its file", () => {
    const counts = commentCountByFileId({
      [userCommentKey(NORMAL_HUNK, 0)]: [reply("a")],
      [lineNoteReplyKey(NORMAL_HUNK, 1)]: [reply("b"), reply("c")],
      [blockCommentKey(NORMAL_HUNK, 2, 4)]: [reply("d")],
      [hunkSummaryReplyKey(NORMAL_HUNK)]: [reply("e")],
      [teammateReplyKey(NORMAL_HUNK)]: [reply("f")],
    });
    expect(counts.get("f-normal")).toBe(6);
    expect(counts.get("f-pr")).toBe(0);
  });

  it("counts replies whose hunkId contains colons (PR csId regression)", () => {
    // Pre-fix this returned 0: the parser split on the first two colons and
    // treated `hunkId` as the literal string `"pr"`, missing every PR file.
    const counts = commentCountByFileId({
      [userCommentKey(PR_HUNK, 0)]: [reply("a")],
      [lineNoteReplyKey(PR_HUNK, 1)]: [reply("b")],
      [blockCommentKey(PR_HUNK, 2, 3)]: [reply("c")],
      [hunkSummaryReplyKey(PR_HUNK)]: [reply("d")],
      [teammateReplyKey(PR_HUNK)]: [reply("e")],
    });
    expect(counts.get("f-pr")).toBe(5);
    expect(counts.get("f-normal")).toBe(0);
  });

  it("ignores replies whose hunk no longer exists", () => {
    const counts = commentCountByFileId({
      [userCommentKey("missing-hunk", 0)]: [reply("a")],
      [hunkSummaryReplyKey("also-missing")]: [reply("b")],
    });
    expect(counts.get("f-normal")).toBe(0);
    expect(counts.get("f-pr")).toBe(0);
  });

  it("ignores malformed keys", () => {
    const counts = commentCountByFileId({
      "no-colon-anywhere": [reply("a")],
      "user:": [reply("b")],
      "unknown:kind:5": [reply("c")],
    });
    expect(counts.get("f-normal")).toBe(0);
    expect(counts.get("f-pr")).toBe(0);
  });
});

describe("buildStatusBarViewModel defaultHint", () => {
  function args(
    overrides: Partial<BuildStatusBarViewModelArgs> = {},
  ): BuildStatusBarViewModelArgs {
    return {
      totalFiles: 3,
      fileIdx: 0,
      totalHunks: 2,
      hunkIdx: 0,
      totalLines: 10,
      lineIdx: 0,
      readCoverage: 0,
      reviewedFiles: 0,
      selection: null,
      lineHasAiNote: false,
      lineNoteAcked: false,
      currentFileReadFraction: 0,
      currentFileReviewed: false,
      currentChangesetSignedOff: false,
      ...overrides,
    };
  }

  it("nudges ⇧S once the whole changeset is read but unsigned", () => {
    const vm = buildStatusBarViewModel(
      args({ readCoverage: 1, currentChangesetSignedOff: false }),
    );
    expect(vm.defaultHint).toContain("⇧S sign off changeset");
  });

  it("skips the ⇧S nudge when no stable token is available", () => {
    const vm = buildStatusBarViewModel(
      args({ readCoverage: 1, currentChangesetSignedOff: null }),
    );
    expect(vm.defaultHint).not.toContain("⇧S");
  });

  it("prefers the ⇧S nudge over the per-file ⇧M nudge when both conditions hold", () => {
    const vm = buildStatusBarViewModel(
      args({
        readCoverage: 1,
        currentFileReadFraction: 1,
        currentFileReviewed: false,
        currentChangesetSignedOff: false,
      }),
    );
    expect(vm.defaultHint).toContain("⇧S sign off changeset");
    expect(vm.defaultHint).not.toContain("⇧M");
  });
});
