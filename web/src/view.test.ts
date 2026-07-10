import { describe, expect, it } from "vitest";
import {
  buildDiffViewModel,
  buildInspectorViewModel,
  buildLineThreadsProjection,
  buildSidebarViewModel,
  buildStatusBarViewModel,
  filterActiveLineThreads,
} from "./view";
import type { BuildStatusBarViewModelArgs } from "./view";
import type { Cursor, DiffFile, DiffLine, Hunk, Interaction, QuizState } from "./types";
import {
  blockCommentKey,
  hunkSummaryReplyKey,
  lineNoteReplyKey,
  teammateReplyKey,
  userCommentKey,
  userFileCommentKey,
} from "./types";

function reply(id: string): Interaction {
  return {
    id,
    threadKey: "user:cs1/web/src/state.ts#h1:0:c1",
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

const EMPTY_QUIZ: QuizState = {
  questions: {},
  answers: {},
  active: null,
  asked: [],
};

function commentCountByFileId(
  interactions: Record<string, Interaction[]>,
): Map<string, number> {
  const vm = buildSidebarViewModel({
    files,
    currentFileId: "f-normal",
    changesetId: "cs1",
    readLines: {},
    reviewedFiles: new Set(),
    quiz: EMPTY_QUIZ,
    interactions,
  });
  return new Map(vm.files.map((f) => [f.fileId, f.commentCount]));
}

describe("buildSidebarViewModel commentCount", () => {
  it("counts every reply kind against its file", () => {
    const counts = commentCountByFileId({
      [userCommentKey(NORMAL_HUNK, 0, "c1")]: [reply("a")],
      [lineNoteReplyKey(NORMAL_HUNK, 1)]: [reply("b"), reply("c")],
      [blockCommentKey(NORMAL_HUNK, 2, 4, "c1")]: [reply("d")],
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
      [userCommentKey(PR_HUNK, 0, "c1")]: [reply("a")],
      [lineNoteReplyKey(PR_HUNK, 1)]: [reply("b")],
      [blockCommentKey(PR_HUNK, 2, 3, "c1")]: [reply("c")],
      [hunkSummaryReplyKey(PR_HUNK)]: [reply("d")],
      [teammateReplyKey(PR_HUNK)]: [reply("e")],
    });
    expect(counts.get("f-pr")).toBe(5);
    expect(counts.get("f-normal")).toBe(0);
  });

  it("ignores replies whose hunk no longer exists", () => {
    const counts = commentCountByFileId({
      [userCommentKey("missing-hunk", 0, "c1")]: [reply("a")],
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

describe("buildInspectorViewModel userCommentRows", () => {
  const HUNK_ID = "cs1/web/src/state.ts#h1";
  const diffLine: DiffLine = { kind: "add", text: "x", newNo: 10 };
  const hunk: Hunk = {
    id: HUNK_ID,
    header: "@@",
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 3,
    lines: [diffLine, diffLine, diffLine],
  };
  const file: DiffFile = {
    id: "f1",
    path: "web/src/state.ts",
    language: "ts",
    status: "modified",
    hunks: [hunk],
  };
  const cursor: Cursor = {
    changesetId: "cs1",
    fileId: "f1",
    hunkId: HUNK_ID,
    lineIdx: 0,
  };

  function inspectorRows(replies: Record<string, Interaction[]>) {
    return buildInspectorViewModel({
      file,
      hunk,
      line: diffLine,
      cursor,
      symbols: new Map(),
      acked: new Set(),
      replies,
      draftingKey: null,
    }).userCommentRows;
  }

  it("emits one row per user thread when two share a line", () => {
    const k1 = userCommentKey(HUNK_ID, 1, "aaa");
    const k2 = userCommentKey(HUNK_ID, 1, "bbb");
    const rows = inspectorRows({
      [k1]: [reply("a")],
      [k2]: [reply("b")],
    });
    const userRows = rows.filter((r) => r.rangeHiLineIdx === undefined);
    expect(userRows).toHaveLength(2);
    expect(new Set(userRows.map((r) => r.threadKey))).toEqual(
      new Set([k1, k2]),
    );
    expect(userRows.every((r) => r.lineIdx === 1)).toBe(true);
  });

  it("emits a single row for a block thread", () => {
    const bk = blockCommentKey(HUNK_ID, 0, 2, "ccc");
    const rows = inspectorRows({ [bk]: [reply("c")] });
    const blockRows = rows.filter((r) => r.rangeHiLineIdx !== undefined);
    expect(blockRows).toHaveLength(1);
    expect(blockRows[0].threadKey).toBe(bk);
    expect(blockRows[0].rangeHiLineIdx).toBe(2);
  });
});

describe("buildLineThreadsProjection", () => {
  const HUNK_A = "cs1/web/src/state.ts#hA";
  const HUNK_B = "cs1/web/src/state.ts#hB";
  const diffLine: DiffLine = { kind: "add", text: "x", newNo: 10 };
  const hunks = [
    { id: HUNK_A, lines: [diffLine, diffLine, diffLine] },
    { id: HUNK_B, lines: [diffLine, diffLine] },
  ];
  const cursor: Cursor = {
    changesetId: "cs1",
    fileId: "f1",
    hunkId: HUNK_A,
    lineIdx: 0,
  };

  function project(
    replies: Record<string, Interaction[]>,
    signals?: Parameters<typeof buildLineThreadsProjection>[0]["signals"],
  ) {
    return buildLineThreadsProjection({
      hunks,
      cursor,
      acked: new Set(),
      replies,
      draftingKey: null,
      signals,
    });
  }

  it("buckets user-comment threads under their own line, across all hunks", () => {
    const onA1 = userCommentKey(HUNK_A, 1, "aaa");
    const onB0 = userCommentKey(HUNK_B, 0, "bbb");
    const entries = project({
      [onA1]: [reply("a")],
      [onB0]: [reply("b")],
    });
    const a1 = entries.find((e) => e.hunkId === HUNK_A && e.lineIdx === 1);
    const b0 = entries.find((e) => e.hunkId === HUNK_B && e.lineIdx === 0);
    expect(a1?.userCommentRows.map((r) => r.threadKey)).toEqual([onA1]);
    expect(b0?.userCommentRows.map((r) => r.threadKey)).toEqual([onB0]);
  });

  it("emits two rows when two comment threads share a line", () => {
    const k1 = userCommentKey(HUNK_A, 2, "aaa");
    const k2 = userCommentKey(HUNK_A, 2, "bbb");
    const entries = project({ [k1]: [reply("a")], [k2]: [reply("b")] });
    const line2 = entries.find((e) => e.hunkId === HUNK_A && e.lineIdx === 2);
    expect(new Set(line2?.userCommentRows.map((r) => r.threadKey))).toEqual(
      new Set([k1, k2]),
    );
  });

  it("marks the cursor line's entry isCursor and others not", () => {
    const entries = project({
      [userCommentKey(HUNK_A, 0, "c")]: [reply("a")],
      [userCommentKey(HUNK_A, 1, "d")]: [reply("b")],
    });
    expect(
      entries.find((e) => e.hunkId === HUNK_A && e.lineIdx === 0)?.isCursor,
    ).toBe(true);
    expect(
      entries.find((e) => e.hunkId === HUNK_A && e.lineIdx === 1)?.isCursor,
    ).toBe(false);
  });

  it("buckets AI notes from ingest signals onto their line", () => {
    const entries = project(
      {},
      {
        aiNoteByLine: {
          [`${HUNK_B}:1`]: { severity: "warning", summary: "watch out" },
        },
        aiSummaryByHunk: {},
        teammateByHunk: {},
      },
    );
    const b1 = entries.find((e) => e.hunkId === HUNK_B && e.lineIdx === 1);
    expect(b1?.aiNoteRows.map((r) => r.summary)).toEqual(["watch out"]);
  });

  it("omits lines that have no threads", () => {
    const entries = project({
      [userCommentKey(HUNK_A, 1, "c")]: [reply("a")],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].lineIdx).toBe(1);
  });

  it("skips an empty new-comment draft on the cursor line", () => {
    const draftKey = userCommentKey(HUNK_A, 0, "draft");
    const entries = buildLineThreadsProjection({
      hunks,
      cursor,
      acked: new Set(),
      replies: { [draftKey]: [] },
      draftingKey: draftKey,
    });
    expect(entries).toHaveLength(0);
  });

  it("keeps a draft once it has replies", () => {
    const draftKey = userCommentKey(HUNK_A, 0, "draft");
    const entries = buildLineThreadsProjection({
      hunks,
      cursor,
      acked: new Set(),
      replies: { [draftKey]: [reply("a")] },
      draftingKey: draftKey,
    });
    const line0 = entries.find((e) => e.hunkId === HUNK_A && e.lineIdx === 0);
    expect(line0?.userCommentRows.map((r) => r.threadKey)).toEqual([draftKey]);
  });

  it("keeps an empty draft anchored off the cursor line", () => {
    const draftKey = userCommentKey(HUNK_A, 2, "draft");
    const entries = buildLineThreadsProjection({
      hunks,
      cursor,
      acked: new Set(),
      replies: { [draftKey]: [] },
      draftingKey: draftKey,
    });
    const line2 = entries.find((e) => e.hunkId === HUNK_A && e.lineIdx === 2);
    expect(line2?.userCommentRows.map((r) => r.threadKey)).toEqual([draftKey]);
  });

  it("buckets a block thread under its last line (hi), not its first (lo)", () => {
    const blockKey = blockCommentKey(HUNK_A, 0, 2, "blk");
    const entries = project({ [blockKey]: [reply("a")] });
    const atHi = entries.find((e) => e.hunkId === HUNK_A && e.lineIdx === 2);
    const atLo = entries.find((e) => e.hunkId === HUNK_A && e.lineIdx === 0);
    expect(atHi?.userCommentRows.map((r) => r.threadKey)).toEqual([blockKey]);
    expect(atLo?.userCommentRows ?? []).toEqual([]);
  });
});

describe("filterActiveLineThreads", () => {
  const HUNK_A = "cs1/web/src/state.ts#hA";
  const diffLine: DiffLine = { kind: "add", text: "x", newNo: 10 };
  // 4 lines so a block can span 0..3 with the cursor strictly mid-range.
  const hunks = [
    { id: HUNK_A, lines: [diffLine, diffLine, diffLine, diffLine] },
  ];

  it("keeps an in-range block when the cursor is mid-range, drops a non-active line comment", () => {
    // Block thread spans lines 0..3; cursor sits on line 1 — strictly inside
    // the range, neither lo (0) nor hi (3). A separate line comment lives on
    // line 2, which the cursor is not on.
    const blockKey = blockCommentKey(HUNK_A, 0, 3, "blk");
    const lineKey = userCommentKey(HUNK_A, 2, "lc");
    const cursor: Cursor = {
      changesetId: "cs1",
      fileId: "f1",
      hunkId: HUNK_A,
      lineIdx: 1,
    };
    const projection = buildLineThreadsProjection({
      hunks,
      cursor,
      acked: new Set(),
      replies: { [blockKey]: [reply("a")], [lineKey]: [reply("b")] },
      draftingKey: null,
    });

    // The block row's isCurrent is true (cursor within range); the line
    // comment's isCurrent is false (cursor not on line 2).
    const blockEntry = projection.find((e) => e.lineIdx === 3);
    const lineEntry = projection.find((e) => e.lineIdx === 2);
    expect(blockEntry?.userCommentRows[0]?.isCurrent).toBe(true);
    expect(lineEntry?.userCommentRows[0]?.isCurrent).toBe(false);

    const filtered = filterActiveLineThreads(projection);

    // The block entry survives, still anchored at its hi line (3), still
    // carrying the block row. The non-active line-comment entry is dropped.
    expect(filtered.map((e) => e.lineIdx)).toEqual([3]);
    const kept = filtered[0];
    expect(kept.hunkId).toBe(HUNK_A);
    expect(kept.userCommentRows.map((r) => r.threadKey)).toEqual([blockKey]);
  });

  it("drops entries whose only rows are non-active", () => {
    const lineKey = userCommentKey(HUNK_A, 2, "lc");
    const cursor: Cursor = {
      changesetId: "cs1",
      fileId: "f1",
      hunkId: HUNK_A,
      lineIdx: 0,
    };
    const projection = buildLineThreadsProjection({
      hunks,
      cursor,
      acked: new Set(),
      replies: { [lineKey]: [reply("b")] },
      draftingKey: null,
    });
    expect(filterActiveLineThreads(projection)).toEqual([]);
  });
});

describe("buildDiffViewModel — full-file comment threads", () => {
  function fileWithFullContent(): DiffFile {
    const hunk: Hunk = {
      id: "f1#h1",
      header: "@@",
      oldStart: 5,
      oldCount: 3,
      newStart: 5,
      newCount: 3,
      lines: [
        { kind: "context", text: "e", oldNo: 5, newNo: 5 },
        { kind: "add", text: "f", newNo: 6 },
        { kind: "context", text: "g", oldNo: 6, newNo: 7 },
      ],
    };
    const fullContent: DiffLine[] = Array.from({ length: 8 }, (_, i) => ({
      kind: "context",
      text: `L${i + 1}`,
      oldNo: i + 1,
      newNo: i + 1,
    }));
    return { id: "f1", path: "a.ts", language: "ts", status: "modified", hunks: [hunk], fullContent };
  }

  function agentReply(id: string): Interaction {
    return {
      id,
      threadKey: "x",
      target: "line",
      intent: "comment",
      author: "claude",
      authorRole: "agent",
      body: "issue here",
      createdAt: "2026-05-11T00:00:00Z",
    };
  }

  it("attaches userFile and hunk-anchored threads to full-file lines by newNo", () => {
    const file = fileWithFullContent();
    const vm = buildDiffViewModel({
      file,
      currentHunkId: "f1#h1",
      cursorLineIdx: 0,
      read: {},
      isFileReviewed: false,
      acked: new Set(),
      replies: {
        [userFileCommentKey("f1", 2)]: [agentReply("ag_fl")],
        [userCommentKey("f1#h1", 1, "c1")]: [reply("u1")],
      },
      expandLevelAbove: {},
      expandLevelBelow: {},
      fileFullyExpanded: true,
      filePreviewing: false,
    });

    const byNewNo = new Map(vm.fullFileLines.map((l) => [l.newNo, l]));
    // userFile thread on the unchanged line 2.
    expect(byNewNo.get(2)!.threads.map((t) => t.threadKey)).toEqual([
      userFileCommentKey("f1", 2),
    ]);
    expect(byNewNo.get(2)!.threads[0].messages[0]).toMatchObject({
      author: "claude",
      authorRole: "agent",
    });
    // Hunk-anchored user comment on hunk line idx 1 → newNo 6.
    expect(byNewNo.get(6)!.threads.map((t) => t.threadKey)).toEqual([
      userCommentKey("f1#h1", 1, "c1"),
    ]);
    // A line with no comment has an empty threads array.
    expect(byNewNo.get(1)!.threads).toEqual([]);
  });

  it("emits no full-file threads when not fully expanded", () => {
    const file = fileWithFullContent();
    const vm = buildDiffViewModel({
      file,
      currentHunkId: "f1#h1",
      cursorLineIdx: 0,
      read: {},
      isFileReviewed: false,
      acked: new Set(),
      replies: { [userFileCommentKey("f1", 2)]: [agentReply("ag_fl")] },
      expandLevelAbove: {},
      expandLevelBelow: {},
      fileFullyExpanded: false,
      filePreviewing: false,
    });
    expect(vm.fullFileLines).toEqual([]);
  });
});
