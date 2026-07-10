import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCommentStops,
  changesetCoverage,
  fileCoverage,
  firstTargetForKey,
  hunkCoverage,
  initialState,
  mergeInteractionMaps,
  reducer,
  replyTarget,
  reviewedFilesCount,
  selectAckedNotes,
} from "./state";
import type { Action } from "./state";
import { captureAnchorContext } from "./anchor";
import type {
  ChangeSet,
  DetachedInteraction,
  DiffFile,
  DiffLine,
  Hunk,
  Interaction,
  PrConversationItem,
  PrSource,
  Question,
  QuestionTarget,
  ReviewState,
  WorktreeSource,
} from "./types";

// ── Test fixtures shaped as user-Interaction literals ───────────────────
// Tests author user-authored Interactions through this minimal literal —
// the helper fills in the bookkeeping (target, intent="comment",
// authorRole="user") so each test stays focused on the behaviour it
// exercises. `isFirst=true` keeps the head's target as "line"/"block".
interface UserInteractionLiteral {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  agentQueueStatus?: "pending" | "delivered" | null;
  enqueueError?: boolean;
  originSha?: string;
  originType?: "committed" | "dirty";
  anchorPath?: string;
  anchorContext?: DiffLine[];
  anchorHash?: string;
  anchorLineNo?: number;
  external?: { source: "pr"; htmlUrl: string };
}

function mkUserInteraction(
  threadKey: string,
  isFirst: boolean,
  literal: UserInteractionLiteral,
): Interaction {
  return {
    id: literal.id,
    threadKey,
    target: isFirst ? firstTargetForKey(threadKey) : replyTarget(),
    intent: "comment",
    author: literal.author,
    authorRole: "user",
    body: literal.body,
    createdAt: literal.createdAt,
    agentQueueStatus: literal.agentQueueStatus,
    enqueueError: literal.enqueueError,
    anchorPath: literal.anchorPath,
    anchorHash: literal.anchorHash,
    anchorContext: literal.anchorContext,
    anchorLineNo: literal.anchorLineNo,
    originSha: literal.originSha,
    originType: literal.originType,
    external: literal.external,
  };
}

function mkUserInteractionMap(
  literals: Record<string, UserInteractionLiteral[]>,
): Record<string, Interaction[]> {
  const out: Record<string, Interaction[]> = {};
  for (const [key, list] of Object.entries(literals)) {
    out[key] = list.map((l, i) => mkUserInteraction(key, i === 0, l));
  }
  return out;
}

function mkDetachedInteractions(
  detached: Array<{ literal: UserInteractionLiteral; threadKey: string }>,
): DetachedInteraction[] {
  return detached.map(({ literal, threadKey }) => ({
    interaction: mkUserInteraction(threadKey, true, literal),
    threadKey,
  }));
}

// ── Assertion helpers ────────────────────────────────────────────────────
// Projections over `state.interactions` for legibility — tests assert
// against legacy reply-shaped objects (with agent responses re-nested as
// `agentReplies`) to keep diffs small. The legacy types are gone
// from production code; these local types carry the shape the tests use.
interface LegacyAgentReply {
  id: string;
  body: string;
  outcome: "addressed" | "declined" | "noted";
  postedAt: string;
}
interface LegacyReply extends UserInteractionLiteral {
  agentReplies?: LegacyAgentReply[];
}
interface LegacyDetached {
  reply: LegacyReply;
  threadKey: string;
}

function legacyReplyFromInteraction(ix: Interaction): LegacyReply {
  return {
    id: ix.id,
    author: ix.author,
    body: ix.body,
    createdAt: ix.createdAt,
    agentQueueStatus: ix.agentQueueStatus,
    enqueueError: ix.enqueueError,
    anchorPath: ix.anchorPath,
    anchorHash: ix.anchorHash,
    anchorContext: ix.anchorContext,
    anchorLineNo: ix.anchorLineNo,
    originSha: ix.originSha,
    originType: ix.originType,
    external: ix.external,
  };
}
function legacyAgentReplyFromInteraction(ix: Interaction): LegacyAgentReply {
  const outcome: LegacyAgentReply["outcome"] =
    ix.intent === "accept"
      ? "addressed"
      : ix.intent === "reject"
        ? "declined"
        : "noted";
  return { id: ix.id, body: ix.body, outcome, postedAt: ix.createdAt };
}
function viewReplies(s: ReviewState): Record<string, LegacyReply[]> {
  const out: Record<string, LegacyReply[]> = {};
  for (const [key, list] of Object.entries(s.interactions)) {
    const userReplies: LegacyReply[] = [];
    const agentReplies: LegacyAgentReply[] = [];
    for (const ix of list) {
      if (
        ix.authorRole === "user" &&
        (ix.intent === "comment" ||
          ix.intent === "question" ||
          ix.intent === "request" ||
          ix.intent === "blocker")
      ) {
        userReplies.push(legacyReplyFromInteraction(ix));
      } else if (ix.authorRole === "agent") {
        agentReplies.push(legacyAgentReplyFromInteraction(ix));
      }
    }
    if (userReplies.length === 0 && agentReplies.length === 0) continue;
    if (userReplies.length > 0 && agentReplies.length > 0) {
      userReplies[0] = { ...userReplies[0], agentReplies };
    }
    out[key] = userReplies;
  }
  return out;
}
function viewDetached(s: ReviewState): LegacyDetached[] {
  const out: LegacyDetached[] = [];
  for (const d of s.detachedInteractions) {
    if (d.interaction.authorRole !== "user") continue;
    out.push({
      reply: legacyReplyFromInteraction(d.interaction),
      threadKey: d.threadKey,
    });
  }
  return out;
}
function ackedSet(s: ReviewState): Set<string> {
  return selectAckedNotes(s);
}
function addReplyAction(
  s: ReviewState,
  targetKey: string,
  literal: UserInteractionLiteral,
): Action {
  const isFirst = (s.interactions[targetKey]?.length ?? 0) === 0;
  return {
    type: "ADD_INTERACTION",
    targetKey,
    interaction: mkUserInteraction(targetKey, isFirst, literal),
  };
}
import {
  blockCommentKey,
  lineNoteReplyKey,
  noteKey,
  parseReplyKey,
  userCommentKey,
  userFileCommentKey,
} from "./types";

// ── Fixtures ───────────────────────────────────────────────────────────────
// Tiny hand-built ChangeSets keep these tests isolated from the gallery
// fixtures (which exist for design work, not behavior tests).

function makeLines(n: number, kind: DiffLine["kind"] = "context"): DiffLine[] {
  return Array.from({ length: n }, (_, i) => {
    if (kind === "context") return { kind, text: `l${i}`, oldNo: i + 1, newNo: i + 1 };
    if (kind === "add") return { kind, text: `l${i}`, newNo: i + 1 };
    return { kind, text: `l${i}`, oldNo: i + 1 };
  });
}

function makeHunk(id: string, lineCount: number): Hunk {
  return {
    id,
    header: `@@ -1,${lineCount} +1,${lineCount} @@`,
    oldStart: 1,
    oldCount: lineCount,
    newStart: 1,
    newCount: lineCount,
    lines: makeLines(lineCount),
  };
}

function makeFile(id: string, hunks: Hunk[]): DiffFile {
  return { id, path: `${id}.ts`, language: "ts", status: "modified", hunks };
}

function makeChangeset(id: string, files: DiffFile[]): ChangeSet {
  return {
    id,
    title: id,
    author: "tester",
    branch: "head",
    base: "base",
    createdAt: "2026-04-30T00:00:00.000Z",
    description: "",
    files,
  };
}

// Default fixture: one ChangeSet "cs1" with two files; file1 has two hunks of
// 3 lines each, file2 has one hunk of 2 lines. Lets us exercise within-hunk,
// cross-hunk, and cross-file movement without ceremony.
function defaultChangeset(): ChangeSet {
  return makeChangeset("cs1", [
    makeFile("cs1/f1", [makeHunk("cs1/f1#h1", 3), makeHunk("cs1/f1#h2", 3)]),
    makeFile("cs1/f2", [makeHunk("cs1/f2#h1", 2)]),
  ]);
}

let s0: ReviewState;
beforeEach(() => {
  s0 = initialState([defaultChangeset()]);
});

// ── initialState ───────────────────────────────────────────────────────────

describe("initialState", () => {
  it("places the cursor on the first changeset / file / hunk / line", () => {
    expect(s0.cursor).toEqual({
      changesetId: "cs1",
      fileId: "cs1/f1",
      hunkId: "cs1/f1#h1",
      lineIdx: 0,
    });
  });

  it("marks the first line as read in readLines", () => {
    expect(s0.readLines["cs1/f1#h1"]).toEqual(new Set([0]));
  });

  it("starts with empty review-tracking sets and zero expand levels", () => {
    expect(s0.reviewedFiles).toEqual(new Set());
    expect(s0.dismissedGuides).toEqual(new Set());
    expect(ackedSet(s0)).toEqual(new Set());
    expect(s0.fullExpandedFiles).toEqual(new Set());
    expect(s0.previewedFiles).toEqual(new Set());
    expect(s0.expandLevelAbove).toEqual({});
    expect(s0.expandLevelBelow).toEqual({});
    expect(s0.selection).toBeNull();
  });

  it("retains the seed changesets in order", () => {
    const a = makeChangeset("a", [makeFile("a/f", [makeHunk("a/f#h1", 1)])]);
    const b = makeChangeset("b", [makeFile("b/f", [makeHunk("b/f#h1", 1)])]);
    const s = initialState([a, b]);
    expect(s.changesets.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("skips a hunkless first file and seats the cursor on the next file with hunks", () => {
    // Repro for the boot-time blank-screen crash: a persisted recent
    // pointed at a worktree whose alphabetically-first file was a binary
    // add (hunks: []). initialState used to read `files[0].hunks[0].id`
    // and throw, unmounting the whole React tree.
    const cs = makeChangeset("bin", [
      makeFile("bin/image.png", []),
      makeFile("bin/text.ts", [makeHunk("bin/text.ts#h1", 2)]),
    ]);
    const s = initialState([cs]);
    expect(s.cursor.changesetId).toBe("bin");
    expect(s.cursor.fileId).toBe("bin/text.ts");
    expect(s.cursor.hunkId).toBe("bin/text.ts#h1");
    expect(s.readLines["bin/text.ts#h1"]).toEqual(new Set([0]));
  });

  it("returns the welcome shape when no file in the seed has hunks", () => {
    const cs = makeChangeset("only-binary", [makeFile("only-binary/a.png", [])]);
    const s = initialState([cs]);
    expect(s.changesets).toEqual([]);
    expect(s.cursor).toEqual({ changesetId: "", fileId: "", hunkId: "", lineIdx: 0 });
  });
});

// ── MOVE_LINE ──────────────────────────────────────────────────────────────

describe("MOVE_LINE", () => {
  it("steps within a hunk and marks the new line as read", () => {
    const s = reducer(s0, { type: "MOVE_LINE", delta: 1 });
    expect(s.cursor.lineIdx).toBe(1);
    expect(s.readLines["cs1/f1#h1"]).toEqual(new Set([0, 1]));
  });

  it("clamps backward movement at the first line of the first hunk", () => {
    const s = reducer(s0, { type: "MOVE_LINE", delta: -1 });
    expect(s.cursor.lineIdx).toBe(0);
    expect(s.cursor.hunkId).toBe("cs1/f1#h1");
  });

  it("crosses forward to the next hunk's first line when stepping past the end", () => {
    // Cursor is at line 0 of a 3-line hunk. delta=3 takes it past the end.
    const s = reducer(s0, { type: "MOVE_LINE", delta: 3 });
    expect(s.cursor.hunkId).toBe("cs1/f1#h2");
    expect(s.cursor.lineIdx).toBe(0);
  });

  it("crosses backward to the previous hunk's last line when stepping below 0", () => {
    const atH2 = reducer(s0, {
      type: "SET_CURSOR",
      cursor: { changesetId: "cs1", fileId: "cs1/f1", hunkId: "cs1/f1#h2", lineIdx: 0 },
    });
    const s = reducer(atH2, { type: "MOVE_LINE", delta: -1 });
    expect(s.cursor.hunkId).toBe("cs1/f1#h1");
    expect(s.cursor.lineIdx).toBe(2); // last line of a 3-line hunk
  });

  it("clamps forward at the last line of the last hunk in the last file", () => {
    // Walk to last file, last hunk, last line.
    const atEnd = reducer(s0, {
      type: "SET_CURSOR",
      cursor: { changesetId: "cs1", fileId: "cs1/f2", hunkId: "cs1/f2#h1", lineIdx: 1 },
    });
    const s = reducer(atEnd, { type: "MOVE_LINE", delta: 1 });
    expect(s.cursor).toEqual(atEnd.cursor);
  });

  it("extend=true within the same hunk creates a selection from the prior cursor", () => {
    const s = reducer(s0, { type: "MOVE_LINE", delta: 1, extend: true });
    expect(s.selection).toEqual({ hunkId: "cs1/f1#h1", anchor: 0, head: 1 });
  });

  it("extend=true again grows the head while keeping the anchor", () => {
    const s1 = reducer(s0, { type: "MOVE_LINE", delta: 1, extend: true });
    const s2 = reducer(s1, { type: "MOVE_LINE", delta: 1, extend: true });
    expect(s2.selection).toEqual({ hunkId: "cs1/f1#h1", anchor: 0, head: 2 });
  });

  it("crossing a hunk boundary collapses the selection even if extend=true", () => {
    const sel = reducer(s0, { type: "MOVE_LINE", delta: 1, extend: true });
    const s = reducer(sel, { type: "MOVE_LINE", delta: 5, extend: true });
    expect(s.cursor.hunkId).toBe("cs1/f1#h2");
    expect(s.selection).toBeNull();
  });

  it("plain delta=0 within the same hunk collapses an existing selection", () => {
    const sel = reducer(s0, { type: "MOVE_LINE", delta: 1, extend: true });
    const s = reducer(sel, { type: "MOVE_LINE", delta: 1 });
    expect(s.selection).toBeNull();
  });

  it("preserveSelection keeps the existing selection through a same-hunk move", () => {
    const sel = reducer(s0, { type: "MOVE_LINE", delta: 1, extend: true });
    const s = reducer(sel, { type: "MOVE_LINE", delta: 1, preserveSelection: true });
    expect(s.selection).toEqual({ hunkId: "cs1/f1#h1", anchor: 0, head: 1 });
    expect(s.cursor.lineIdx).toBe(2);
  });
});

// ── MOVE_HUNK ──────────────────────────────────────────────────────────────

describe("MOVE_HUNK", () => {
  it("advances to the first line of the next hunk in the same file", () => {
    const s = reducer(s0, { type: "MOVE_HUNK", delta: 1 });
    expect(s.cursor.hunkId).toBe("cs1/f1#h2");
    expect(s.cursor.lineIdx).toBe(0);
  });

  it("clamps at the first hunk", () => {
    const s = reducer(s0, { type: "MOVE_HUNK", delta: -1 });
    expect(s).toBe(s0);
  });

  it("clamps at the last hunk in the file (does not cross into the next file)", () => {
    const atH2 = reducer(s0, { type: "MOVE_HUNK", delta: 1 });
    const s = reducer(atH2, { type: "MOVE_HUNK", delta: 1 });
    expect(s).toBe(atH2);
  });

  it("collapses selection on hunk move", () => {
    const sel = reducer(s0, { type: "MOVE_LINE", delta: 1, extend: true });
    const s = reducer(sel, { type: "MOVE_HUNK", delta: 1 });
    expect(s.selection).toBeNull();
  });
});

// ── MOVE_FILE ──────────────────────────────────────────────────────────────

describe("MOVE_FILE", () => {
  it("lands on the first hunk's first line of the next file", () => {
    const s = reducer(s0, { type: "MOVE_FILE", delta: 1 });
    expect(s.cursor.fileId).toBe("cs1/f2");
    expect(s.cursor.hunkId).toBe("cs1/f2#h1");
    expect(s.cursor.lineIdx).toBe(0);
  });

  it("clamps at the first file", () => {
    const s = reducer(s0, { type: "MOVE_FILE", delta: -1 });
    expect(s).toBe(s0);
  });

  it("clamps at the last file", () => {
    const last = reducer(s0, { type: "MOVE_FILE", delta: 1 });
    const s = reducer(last, { type: "MOVE_FILE", delta: 1 });
    expect(s).toBe(last);
  });

  it("collapses selection on file move", () => {
    const sel = reducer(s0, { type: "MOVE_LINE", delta: 1, extend: true });
    const s = reducer(sel, { type: "MOVE_FILE", delta: 1 });
    expect(s.selection).toBeNull();
  });
});

// ── MOVE_TO_COMMENT ────────────────────────────────────────────────────────
// A "comment stop" is any line with an AI note OR with a user/block comment
// reply. Hand-built fixtures keep the assertions readable; the helper itself
// is also covered directly via buildCommentStops.

function csWithComments(): {
  cs: ChangeSet;
  interactions: Record<string, Interaction[]>;
} {
  // f1#h1 lines: [ctx, AI@1, ctx], f1#h2 lines: [ctx, ctx, ctx]
  // f2#h1 lines: [ctx, ctx]; user comment at f2#h1:0; block at f1#h2:1-2.
  const f1h1: Hunk = {
    ...makeHunk("cs1/f1#h1", 3),
    lines: [
      { kind: "context", text: "a", oldNo: 1, newNo: 1 },
      { kind: "context", text: "b", oldNo: 2, newNo: 2 },
      { kind: "context", text: "c", oldNo: 3, newNo: 3 },
    ],
  };
  const cs = makeChangeset("cs1", [
    makeFile("cs1/f1", [f1h1, makeHunk("cs1/f1#h2", 3)]),
    makeFile("cs1/f2", [makeHunk("cs1/f2#h1", 2)]),
  ]);
  const dummyReply = (id: string): UserInteractionLiteral => ({
    id,
    author: "you",
    body: "x",
    createdAt: "2026-04-30T00:00:00.000Z",
  });
  // Seed an AI note on f1#h1 line 1; user/block comments come via replies.
  const aiNoteKey = lineNoteReplyKey("cs1/f1#h1", 1);
  const interactions = mergeInteractionMaps(
    {
      [aiNoteKey]: [
        {
          id: `ai:${aiNoteKey}`,
          threadKey: aiNoteKey,
          target: "line",
          intent: "comment",
          author: "ai",
          authorRole: "ai",
          body: "n",
          createdAt: "0001-01-01T00:00:00.000Z",
        },
      ],
    },
    mkUserInteractionMap({
      [userCommentKey("cs1/f2#h1", 0, "c1")]: [dummyReply("r1")],
      [blockCommentKey("cs1/f1#h2", 1, 2, "c1")]: [dummyReply("r2")],
      // Empty array — should be ignored (no actual comment).
      [userCommentKey("cs1/f1#h1", 2, "c1")]: [],
    }),
  );
  return { cs, interactions };
}

describe("firstTargetForKey", () => {
  it("maps file-line keys to their base target", () => {
    expect(firstTargetForKey(userFileCommentKey("cs1/f1", 2))).toBe("line");
    expect(firstTargetForKey("blockFile:cs1/f1:2-4")).toBe("block");
    expect(firstTargetForKey(userCommentKey("cs1/f1#h1", 0, "c1"))).toBe("line");
    expect(firstTargetForKey("note:cs1/f1#h1:0")).toBe("reply");
  });
});

describe("buildCommentStops", () => {
  it("orders stops by file → hunk → lineIdx and merges AI + user sources", () => {
    const { cs, interactions } = csWithComments();
    expect(buildCommentStops(cs, interactions)).toEqual([
      { fileId: "cs1/f1", hunkId: "cs1/f1#h1", lineIdx: 1 }, // AI note
      { fileId: "cs1/f1", hunkId: "cs1/f1#h2", lineIdx: 1 }, // block start
      { fileId: "cs1/f2", hunkId: "cs1/f2#h1", lineIdx: 0 }, // user comment
    ]);
  });

  it("ignores reply keys whose array is empty", () => {
    const { cs, interactions } = csWithComments();
    const stops = buildCommentStops(cs, interactions);
    // The empty user:cs1/f1#h1:2 must NOT appear.
    expect(stops.some((s) => s.hunkId === "cs1/f1#h1" && s.lineIdx === 2)).toBe(false);
  });

  it("adds a stop on the first hunk of a file that only has a detached thread", () => {
    // f1 has no live comments; f2 has one at h1:0.
    const cs = makeChangeset("cs1", [
      makeFile("cs1/f1", [makeHunk("cs1/f1#h1", 3)]),
      makeFile("cs1/f2", [makeHunk("cs1/f2#h1", 2)]),
    ]);
    const interactions = mkUserInteractionMap({
      [userCommentKey("cs1/f2#h1", 0, "c1")]: [
        { id: "r1", author: "you", body: "x", createdAt: "2026-04-30T00:00:00.000Z" },
      ],
    });
    const detached = mkDetachedInteractions([
      {
        literal: {
          id: "d1",
          author: "you",
          body: "orphaned",
          createdAt: "2026-04-30T00:00:00.000Z",
          anchorPath: "cs1/f1.ts",
          anchorLineNo: 2,
        },
        threadKey: "user:cs1/f1#hGONE:1:c1",
      },
    ]);
    expect(buildCommentStops(cs, interactions, detached)).toEqual([
      { fileId: "cs1/f1", hunkId: "cs1/f1#h1", lineIdx: 0 }, // detached-only file
      { fileId: "cs1/f2", hunkId: "cs1/f2#h1", lineIdx: 0 }, // live comment
    ]);
  });

  it("dedups a detached stop that coincides with a live comment", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [makeHunk("cs1/f1#h1", 3)])]);
    const interactions = mkUserInteractionMap({
      [userCommentKey("cs1/f1#h1", 0, "c1")]: [
        { id: "r1", author: "you", body: "x", createdAt: "2026-04-30T00:00:00.000Z" },
      ],
    });
    const detached = mkDetachedInteractions([
      {
        literal: {
          id: "d1",
          author: "you",
          body: "orphaned",
          createdAt: "2026-04-30T00:00:00.000Z",
          anchorPath: "cs1/f1.ts",
        },
        threadKey: "user:cs1/f1#hGONE:1:c1",
      },
    ]);
    // Live comment already sits at h1:0; the detached stop dedups into it.
    expect(buildCommentStops(cs, interactions, detached)).toEqual([
      { fileId: "cs1/f1", hunkId: "cs1/f1#h1", lineIdx: 0 },
    ]);
  });

  it("adds a file stop for a userFile thread (anchored outside hunks)", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [makeHunk("cs1/f1#h1", 3)])]);
    const interactions = mkUserInteractionMap({
      [userFileCommentKey("cs1/f1", 2)]: [
        { id: "u1", author: "you", body: "x", createdAt: "2026-04-30T00:00:00.000Z" },
      ],
    });
    expect(buildCommentStops(cs, interactions)).toEqual([
      { fileId: "cs1/f1", hunkId: "cs1/f1#h1", lineIdx: 0 },
    ]);
  });

  it("skips detached threads that are anchorless or point at a missing file", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [makeHunk("cs1/f1#h1", 3)])]);
    const detached = mkDetachedInteractions([
      {
        literal: { id: "d1", author: "you", body: "no path", createdAt: "2026-04-30T00:00:00.000Z" },
        threadKey: "user:cs1/f1#hGONE:1:c1",
      },
      {
        literal: {
          id: "d2",
          author: "you",
          body: "gone file",
          createdAt: "2026-04-30T00:00:00.000Z",
          anchorPath: "cs1/deleted.ts",
        },
        threadKey: "user:cs1/deleted#h1:1:c1",
      },
    ]);
    expect(buildCommentStops(cs, {}, detached)).toEqual([]);
  });
});

describe("MOVE_TO_COMMENT", () => {
  it("jumps from initial cursor to the first comment", () => {
    const { cs, interactions } = csWithComments();
    const seeded: ReviewState = {
      ...initialState([cs]),
      interactions,
    };
    const s = reducer(seeded, { type: "MOVE_TO_COMMENT", delta: 1 });
    expect(s.cursor).toEqual({
      changesetId: "cs1",
      fileId: "cs1/f1",
      hunkId: "cs1/f1#h1",
      lineIdx: 1,
    });
  });

  it("walks across files in order", () => {
    const { cs, interactions } = csWithComments();
    const seeded: ReviewState = { ...initialState([cs]), interactions };
    const a = reducer(seeded, { type: "MOVE_TO_COMMENT", delta: 1 });
    const b = reducer(a, { type: "MOVE_TO_COMMENT", delta: 1 });
    const c = reducer(b, { type: "MOVE_TO_COMMENT", delta: 1 });
    expect(b.cursor.hunkId).toBe("cs1/f1#h2");
    expect(b.cursor.lineIdx).toBe(1);
    expect(c.cursor.fileId).toBe("cs1/f2");
    expect(c.cursor.lineIdx).toBe(0);
  });

  it("wraps forward from the last comment back to the first", () => {
    const { cs, interactions } = csWithComments();
    const seeded: ReviewState = { ...initialState([cs]), interactions };
    // Three stops; walk to the last one, then one more wraps to the first.
    let s = seeded;
    for (let i = 0; i < 3; i++) s = reducer(s, { type: "MOVE_TO_COMMENT", delta: 1 });
    // On the last stop now (f2#h1:0). Next wraps.
    expect(s.cursor).toMatchObject({ fileId: "cs1/f2", hunkId: "cs1/f2#h1", lineIdx: 0 });
    const wrapped = reducer(s, { type: "MOVE_TO_COMMENT", delta: 1 });
    expect(wrapped.cursor).toMatchObject({
      fileId: "cs1/f1",
      hunkId: "cs1/f1#h1",
      lineIdx: 1,
    });
  });

  it("wraps backward from the first comment to the last", () => {
    const { cs, interactions } = csWithComments();
    const seeded: ReviewState = { ...initialState([cs]), interactions };
    // Land on the first comment, then prev wraps to the last.
    const first = reducer(seeded, { type: "MOVE_TO_COMMENT", delta: 1 });
    expect(first.cursor).toMatchObject({ hunkId: "cs1/f1#h1", lineIdx: 1 });
    const wrapped = reducer(first, { type: "MOVE_TO_COMMENT", delta: -1 });
    expect(wrapped.cursor).toMatchObject({
      fileId: "cs1/f2",
      hunkId: "cs1/f2#h1",
      lineIdx: 0,
    });
  });

  it("reaches a detached comment whose file is still in the diff", () => {
    const { cs, interactions } = csWithComments();
    // A thread that failed to re-anchor, anchored to file f2 (path cs1/f2.ts).
    const detachedInteractions = mkDetachedInteractions([
      {
        literal: {
          id: "d1",
          author: "you",
          body: "still relevant",
          createdAt: "2026-04-30T00:00:00.000Z",
          anchorPath: "cs1/f2.ts",
          anchorLineNo: 2,
        },
        threadKey: "user:cs1/f2#hGONE:1:c1",
      },
    ]);
    const seeded: ReviewState = {
      ...initialState([cs]),
      interactions,
      detachedInteractions,
    };
    // f2 already has a live comment at h1:0, so the detached stop dedups into
    // it — landing the cursor on f2 surfaces the Inspector's Detached section.
    // Add a detached-only file to prove a brand-new stop appears.
    const stops = buildCommentStops(cs, interactions, detachedInteractions);
    expect(stops).toContainEqual({
      fileId: "cs1/f2",
      hunkId: "cs1/f2#h1",
      lineIdx: 0,
    });
    // Walking forward eventually seats on f2 (where the detached thread lives).
    let s = seeded;
    for (let i = 0; i < 3; i++) s = reducer(s, { type: "MOVE_TO_COMMENT", delta: 1 });
    expect(s.cursor.fileId).toBe("cs1/f2");
  });

  it("walks backwards", () => {
    const { cs, interactions } = csWithComments();
    const seeded: ReviewState = { ...initialState([cs]), interactions };
    const last = reducer(
      reducer(reducer(seeded, { type: "MOVE_TO_COMMENT", delta: 1 }), {
        type: "MOVE_TO_COMMENT",
        delta: 1,
      }),
      { type: "MOVE_TO_COMMENT", delta: 1 },
    );
    const prev = reducer(last, { type: "MOVE_TO_COMMENT", delta: -1 });
    expect(prev.cursor.fileId).toBe("cs1/f1");
    expect(prev.cursor.hunkId).toBe("cs1/f1#h2");
    expect(prev.cursor.lineIdx).toBe(1);
  });

  it("is a no-op when there are no comments", () => {
    const s = reducer(s0, { type: "MOVE_TO_COMMENT", delta: 1 });
    expect(s).toBe(s0);
  });
});

// ── SET_CURSOR / COLLAPSE_SELECTION ────────────────────────────────────────

describe("SET_CURSOR", () => {
  it("sets the cursor and marks the line as read", () => {
    const s = reducer(s0, {
      type: "SET_CURSOR",
      cursor: { changesetId: "cs1", fileId: "cs1/f2", hunkId: "cs1/f2#h1", lineIdx: 1 },
    });
    expect(s.cursor.fileId).toBe("cs1/f2");
    expect(s.readLines["cs1/f2#h1"]).toEqual(new Set([1]));
  });

  it("applies an explicit selection when provided", () => {
    const sel = { hunkId: "cs1/f1#h1", anchor: 0, head: 2 } as const;
    const s = reducer(s0, {
      type: "SET_CURSOR",
      cursor: { changesetId: "cs1", fileId: "cs1/f1", hunkId: "cs1/f1#h1", lineIdx: 2 },
      selection: sel,
    });
    expect(s.selection).toEqual(sel);
  });

  it("collapses the selection when none is passed (default)", () => {
    const sel = reducer(s0, { type: "MOVE_LINE", delta: 1, extend: true });
    const s = reducer(sel, {
      type: "SET_CURSOR",
      cursor: { changesetId: "cs1", fileId: "cs1/f1", hunkId: "cs1/f1#h1", lineIdx: 0 },
    });
    expect(s.selection).toBeNull();
  });
});

describe("COLLAPSE_SELECTION", () => {
  it("clears an active selection", () => {
    const sel = reducer(s0, { type: "MOVE_LINE", delta: 1, extend: true });
    const s = reducer(sel, { type: "COLLAPSE_SELECTION" });
    expect(s.selection).toBeNull();
  });

  it("returns the same state reference when already collapsed", () => {
    const s = reducer(s0, { type: "COLLAPSE_SELECTION" });
    expect(s).toBe(s0);
  });
});

// ── SWITCH_CHANGESET ───────────────────────────────────────────────────────

describe("SWITCH_CHANGESET", () => {
  it("moves the cursor to the new changeset's first file/hunk/line", () => {
    const second = makeChangeset("cs2", [
      makeFile("cs2/x", [makeHunk("cs2/x#h1", 1)]),
    ]);
    const s = reducer(initialState([defaultChangeset(), second]), {
      type: "SWITCH_CHANGESET",
      changesetId: "cs2",
    });
    expect(s.cursor).toEqual({
      changesetId: "cs2",
      fileId: "cs2/x",
      hunkId: "cs2/x#h1",
      lineIdx: 0,
    });
    expect(s.selection).toBeNull();
    expect(s.readLines["cs2/x#h1"]).toEqual(new Set([0]));
  });

  it("returns the same state when the changeset id is unknown", () => {
    const s = reducer(s0, { type: "SWITCH_CHANGESET", changesetId: "missing" });
    expect(s).toBe(s0);
  });
});

// ── LOAD_CHANGESET ─────────────────────────────────────────────────────────

describe("LOAD_CHANGESET", () => {
  it("appends a fresh changeset and moves the cursor to it", () => {
    const fresh = makeChangeset("new", [makeFile("new/f", [makeHunk("new/f#h1", 1)])]);
    const s = reducer(s0, { type: "LOAD_CHANGESET", changeset: fresh });
    expect(s.changesets.map((c) => c.id)).toEqual(["cs1", "new"]);
    expect(s.cursor.changesetId).toBe("new");
  });

  it("replaces an existing changeset in place when ids collide", () => {
    const replacement = makeChangeset("cs1", [
      makeFile("cs1/replaced", [makeHunk("cs1/replaced#h1", 1)]),
    ]);
    const s = reducer(s0, { type: "LOAD_CHANGESET", changeset: replacement });
    expect(s.changesets).toHaveLength(1);
    expect(s.changesets[0].files[0].id).toBe("cs1/replaced");
  });

  it("returns the same state if the loaded changeset has no files", () => {
    const empty = makeChangeset("empty", []);
    const s = reducer(s0, { type: "LOAD_CHANGESET", changeset: empty });
    expect(s).toBe(s0);
  });

  it("returns the same state if no file in the loaded changeset has any hunks", () => {
    const noHunks = makeChangeset("nh", [makeFile("nh/f", [])]);
    const s = reducer(s0, { type: "LOAD_CHANGESET", changeset: noHunks });
    expect(s).toBe(s0);
  });

  it("skips a hunkless first file (e.g. binary add) and seats the cursor on the first file with hunks", () => {
    // Binary adds, pure renames, etc. land in cs.files with hunks: [].
    // The cursor has to anchor on a real hunk, so the reducer should advance
    // state and put the cursor on the next file that has one.
    const withBinaryFirst = makeChangeset("bin", [
      makeFile("bin/image.png", []),
      makeFile("bin/text.ts", [makeHunk("bin/text.ts#h1", 2)]),
    ]);
    const s = reducer(s0, { type: "LOAD_CHANGESET", changeset: withBinaryFirst });
    expect(s.changesets.map((c) => c.id)).toEqual(["cs1", "bin"]);
    expect(s.cursor.changesetId).toBe("bin");
    expect(s.cursor.fileId).toBe("bin/text.ts");
    expect(s.cursor.hunkId).toBe("bin/text.ts#h1");
    expect(s.cursor.lineIdx).toBe(0);
  });

  // ── Cursor preservation on same-id reload (C2) ─────────────────────────

  it("preserves the cursor when the same changeset reloads and the target hunk still exists", () => {
    // Move to line 2 of h1
    const atLine2 = reducer(s0, { type: "MOVE_LINE", delta: 2 });
    expect(atLine2.cursor.lineIdx).toBe(2);
    expect(atLine2.cursor.hunkId).toBe("cs1/f1#h1");

    // Reload the same changeset id — same files/hunks
    const reloaded = defaultChangeset();
    const s = reducer(atLine2, { type: "LOAD_CHANGESET", changeset: reloaded });
    expect(s.cursor.changesetId).toBe("cs1");
    expect(s.cursor.fileId).toBe("cs1/f1");
    expect(s.cursor.hunkId).toBe("cs1/f1#h1");
    expect(s.cursor.lineIdx).toBe(2);
  });

  it("resets the cursor to line 0 of file 0 when the target file disappears on reload", () => {
    // Move to file 2
    const atF2 = reducer(s0, { type: "MOVE_FILE", delta: 1 });
    expect(atF2.cursor.fileId).toBe("cs1/f2");

    // Reload with only the first file — f2 is gone
    const smallerCs = makeChangeset("cs1", [
      makeFile("cs1/f1", [makeHunk("cs1/f1#h1", 3)]),
    ]);
    const s = reducer(atF2, { type: "LOAD_CHANGESET", changeset: smallerCs });
    expect(s.cursor.fileId).toBe("cs1/f1");
    expect(s.cursor.hunkId).toBe("cs1/f1#h1");
    expect(s.cursor.lineIdx).toBe(0);
  });

  it("does not preserve cursor when loading a different changeset id (new CS resets)", () => {
    const atLine2 = reducer(s0, { type: "MOVE_LINE", delta: 2 });
    const fresh = makeChangeset("cs2", [makeFile("cs2/f", [makeHunk("cs2/f#h1", 2)])]);
    const s = reducer(atLine2, { type: "LOAD_CHANGESET", changeset: fresh });
    // New changeset → cursor goes to file 0 line 0 of the new CS
    expect(s.cursor.changesetId).toBe("cs2");
    expect(s.cursor.lineIdx).toBe(0);
  });
});

// ── RELOAD_CHANGESET ────────────────────────────────────────────────────────

describe("RELOAD_CHANGESET", () => {
  // The reload pass uses the anchorHash to find a 5-line window. Build hunks
  // with line text we can vary to exercise re-anchor / detach paths.
  function makeReloadFile(
    id: string,
    path: string,
    hunkId: string,
    texts: string[],
  ): DiffFile {
    return {
      id,
      path,
      language: "ts",
      status: "modified",
      hunks: [
        {
          id: hunkId,
          header: "@@",
          oldStart: 1,
          oldCount: texts.length,
          newStart: 1,
          newCount: texts.length,
          lines: texts.map((t, i) => ({
            kind: "context" as const,
            text: t,
            oldNo: i + 1,
            newNo: i + 1,
          })),
        },
      ],
    };
  }

  function startWithReply(
    csId: string,
    fileId: string,
    filePath: string,
    hunkId: string,
    texts: string[],
    lineIdx: number,
  ): { state: ReviewState; key: string } {
    const file = makeReloadFile(fileId, filePath, hunkId, texts);
    const cs = makeChangeset(csId, [file]);
    let s = initialState([cs]);
    const key = userCommentKey(hunkId, lineIdx, "c1");
    const cap = captureAnchorContext(file.hunks[0].lines, lineIdx);
    s = reducer(
      s,
      addReplyAction(s, key, {
        id: "r1",
        author: "you",
        body: "yo",
        createdAt: "t",
        anchorPath: filePath,
        anchorContext: cap.context,
        anchorHash: cap.hash,
        originSha: csId,
        originType: "committed",
      }),
    );
    return { state: s, key };
  }

  it("keeps the reply inline at the same logical position when the line is unchanged", () => {
    const { state } = startWithReply(
      "cs-old",
      "f1",
      "f1.ts",
      "f1#h1",
      ["a", "b", "anchor", "c", "d"],
      2,
    );
    // Reload: same content, but new ChangeSet id (sha bumped) and a new hunk id.
    const reloadFile = makeReloadFile("f1-new", "f1.ts", "f1-new#h1", [
      "a", "b", "anchor", "c", "d",
    ]);
    const reloaded = makeChangeset("cs-new", [reloadFile]);
    const s = reducer(state, {
      type: "RELOAD_CHANGESET",
      prevChangesetId: "cs-old",
      changeset: reloaded,
    });
    expect(Object.keys(viewReplies(s))).toEqual([`user:f1-new#h1:2:c1`]);
    expect(viewReplies(s)[`user:f1-new#h1:2:c1`]).toHaveLength(1);
    expect(viewDetached(s)).toEqual([]);
    // Cursor moved to the new changeset (file 0 since the file path matched).
    expect(s.cursor.changesetId).toBe("cs-new");
    expect(s.cursor.fileId).toBe("f1-new");
  });

  it("re-anchors the reply when the matching window has shifted within the file", () => {
    const { state } = startWithReply(
      "cs-old",
      "f1",
      "f1.ts",
      "f1#h1",
      ["a", "b", "anchor", "c", "d"],
      2,
    );
    const reloadFile = makeReloadFile("f1-new", "f1.ts", "f1-new#h1", [
      "noise1", "noise2", "a", "b", "anchor", "c", "d",
    ]);
    const reloaded = makeChangeset("cs-new", [reloadFile]);
    const s = reducer(state, {
      type: "RELOAD_CHANGESET",
      prevChangesetId: "cs-old",
      changeset: reloaded,
    });
    expect(Object.keys(viewReplies(s))).toEqual([`user:f1-new#h1:4:c1`]);
    expect(viewDetached(s)).toEqual([]);
  });

  it("detaches the reply when its anchor is rewritten beyond recognition", () => {
    const { state } = startWithReply(
      "cs-old",
      "f1",
      "f1.ts",
      "f1#h1",
      ["a", "b", "anchor", "c", "d"],
      2,
    );
    const reloadFile = makeReloadFile("f1-new", "f1.ts", "f1-new#h1", [
      "totally", "different", "lines", "here", "now",
    ]);
    const reloaded = makeChangeset("cs-new", [reloadFile]);
    const s = reducer(state, {
      type: "RELOAD_CHANGESET",
      prevChangesetId: "cs-old",
      changeset: reloaded,
    });
    expect(viewReplies(s)).toEqual({});
    expect(viewDetached(s)).toHaveLength(1);
    expect(viewDetached(s)[0].reply.id).toBe("r1");
    expect(viewDetached(s)[0].threadKey).toBe(`user:f1#h1:2:c1`);
  });

  it("detaches when the file the reply was anchored to no longer exists", () => {
    const { state } = startWithReply(
      "cs-old",
      "f1",
      "f1.ts",
      "f1#h1",
      ["a", "b", "anchor", "c", "d"],
      2,
    );
    const otherFile = makeReloadFile("f2", "f2.ts", "f2#h1", ["x", "y", "z"]);
    const reloaded = makeChangeset("cs-new", [otherFile]);
    const s = reducer(state, {
      type: "RELOAD_CHANGESET",
      prevChangesetId: "cs-old",
      changeset: reloaded,
    });
    expect(viewReplies(s)).toEqual({});
    expect(viewDetached(s)).toHaveLength(1);
  });

  it("falls back to file 0 when the cursor's previous file is gone", () => {
    const { state } = startWithReply(
      "cs-old",
      "f1",
      "f1.ts",
      "f1#h1",
      ["a", "b", "anchor", "c", "d"],
      2,
    );
    const otherFile = makeReloadFile("f2", "f2.ts", "f2#h1", ["x", "y", "z"]);
    const reloaded = makeChangeset("cs-new", [otherFile]);
    const s = reducer(state, {
      type: "RELOAD_CHANGESET",
      prevChangesetId: "cs-old",
      changeset: reloaded,
    });
    expect(s.cursor.fileId).toBe("f2");
  });

  it("is a no-op when prevChangesetId is unknown", () => {
    const reloadFile = makeReloadFile("f1-new", "f1.ts", "f1-new#h1", ["a"]);
    const reloaded = makeChangeset("cs-new", [reloadFile]);
    const s = reducer(s0, {
      type: "RELOAD_CHANGESET",
      prevChangesetId: "no-such-cs",
      changeset: reloaded,
    });
    expect(s).toBe(s0);
  });

  // PR-imported replies (external.source === "pr") are not special-cased: they
  // ride the same anchor pass as locally-authored replies. A future change
  // that exempted them ("PR threads have GitHub-side identity, skip
  // anchoring") would silently break this contract.
  it("re-routes PR-sourced replies through the same anchor pass as local replies", () => {
    const oldFile = makeReloadFile("f1", "f1.ts", "f1#h1", [
      "a", "b", "anchor", "c", "d",
    ]);
    const oldCs = makeChangeset("cs-old", [oldFile]);
    const key = userCommentKey("f1#h1", 2, "c1");
    const prReply: UserInteractionLiteral = {
      id: "pr-comment:42",
      author: "external-reviewer",
      body: "from the PR",
      createdAt: "2026-05-06T00:00:00.000Z",
      external: {
        source: "pr",
        htmlUrl: "https://github.com/x/y/pull/1#42",
      },
    };
    const seeded = {
      ...initialState([oldCs]),
      interactions: mkUserInteractionMap({ [key]: [prReply] }),
    };
    // Same content, fresh hunk id (typical "new fetch of the same commit").
    const reloadFile = makeReloadFile("f1-new", "f1.ts", "f1-new#h1", [
      "a", "b", "anchor", "c", "d",
    ]);
    const reloaded = makeChangeset("cs-new", [reloadFile]);
    const s = reducer(seeded, {
      type: "RELOAD_CHANGESET",
      prevChangesetId: "cs-old",
      changeset: reloaded,
    });
    expect(Object.keys(viewReplies(s))).toEqual([`user:f1-new#h1:2:c1`]);
    expect(viewReplies(s)[`user:f1-new#h1:2:c1`]).toEqual([prReply]);
    expect(viewDetached(s)).toEqual([]);
  });
});

// ── HYDRATE_FILE ───────────────────────────────────────────────────────────

describe("HYDRATE_FILE", () => {
  it("populates fullContent and per-hunk expand blocks from post-change text", () => {
    const fileText = [
      "// header",
      "",
      "function alpha() {",
      "  return 1;",
      "}",
      "",
      "function beta() {",
      "  return 2;",
      "}",
      "",
      "// footer",
    ].join("\n");
    // Hunk targets line 7-9 (`function beta() { ... }`); plenty of room
    // above and below in the post-change file.
    const cs: ChangeSet = makeChangeset("cs-h", [
      {
        id: "cs-h/x.ts",
        path: "x.ts",
        language: "ts",
        status: "modified",
        hunks: [
          {
            id: "cs-h/x.ts#h1",
            header: "@@ -7,3 +7,3 @@",
            oldStart: 7,
            oldCount: 3,
            newStart: 7,
            newCount: 3,
            lines: [
              { kind: "context", text: "function beta() {", oldNo: 7, newNo: 7 },
              { kind: "context", text: "  return 2;", oldNo: 8, newNo: 8 },
              { kind: "context", text: "}", oldNo: 9, newNo: 9 },
            ],
          },
        ],
      },
    ]);
    const s = reducer(initialState([cs]), {
      type: "HYDRATE_FILE",
      changesetId: "cs-h",
      fileId: "cs-h/x.ts",
      postChangeText: fileText,
    });
    const f = s.changesets[0].files[0];
    expect(f.fullContent).toBeDefined();
    expect(f.fullContent!.length).toBeGreaterThan(0);
    expect(f.hunks[0].expandAbove?.length ?? 0).toBeGreaterThan(0);
    expect(f.hunks[0].expandBelow?.length ?? 0).toBeGreaterThan(0);
  });

  it("is a no-op when the file already has fullContent", () => {
    const cs = defaultChangeset();
    cs.files[0].fullContent = [{ kind: "context", text: "x", oldNo: 1, newNo: 1 }];
    const before = initialState([cs]);
    const s = reducer(before, {
      type: "HYDRATE_FILE",
      changesetId: "cs1",
      fileId: "cs1/f1",
      postChangeText: "irrelevant",
    });
    expect(s).toBe(before);
  });

  it("is a no-op when the changeset id doesn't match", () => {
    const s = reducer(s0, {
      type: "HYDRATE_FILE",
      changesetId: "no-such-cs",
      fileId: "cs1/f1",
      postChangeText: "irrelevant",
    });
    expect(s).toBe(s0);
  });

  it("is a no-op when the file id doesn't match", () => {
    const s = reducer(s0, {
      type: "HYDRATE_FILE",
      changesetId: "cs1",
      fileId: "cs1/no-such-file",
      postChangeText: "irrelevant",
    });
    expect(s).toBe(s0);
  });
});

// ── DISMISS_GUIDE ──────────────────────────────────────────────────────────

describe("DISMISS_GUIDE", () => {
  it("adds the guideId to dismissedGuides", () => {
    const s = reducer(s0, { type: "DISMISS_GUIDE", guideId: "g1" });
    expect(s.dismissedGuides.has("g1")).toBe(true);
  });

  it("is idempotent — dismissing twice keeps a single entry", () => {
    const s1 = reducer(s0, { type: "DISMISS_GUIDE", guideId: "g1" });
    const s2 = reducer(s1, { type: "DISMISS_GUIDE", guideId: "g1" });
    expect(s2.dismissedGuides.size).toBe(1);
  });
});

// ── TOGGLE_ACK ─────────────────────────────────────────────────────────────

describe("TOGGLE_ACK", () => {
  it("adds the noteKey when not already acked", () => {
    const s = reducer(s0, { type: "TOGGLE_ACK", hunkId: "cs1/f1#h1", lineIdx: 2 });
    expect(ackedSet(s).has(noteKey("cs1/f1#h1", 2))).toBe(true);
  });

  it("removes the noteKey on second toggle", () => {
    const s1 = reducer(s0, { type: "TOGGLE_ACK", hunkId: "cs1/f1#h1", lineIdx: 2 });
    const s2 = reducer(s1, { type: "TOGGLE_ACK", hunkId: "cs1/f1#h1", lineIdx: 2 });
    expect(ackedSet(s2).has(noteKey("cs1/f1#h1", 2))).toBe(false);
  });
});

// ── ADD_REPLY / DELETE_REPLY ───────────────────────────────────────────────

describe("ADD_REPLY", () => {
  it("creates a fresh thread for an unseen targetKey", () => {
    const reply = { id: "r1", author: "a", body: "hi", createdAt: "now" };
    const s = reducer(s0, addReplyAction(s0, "k", reply));
    expect(viewReplies(s)["k"]).toEqual([reply]);
  });

  it("appends to an existing thread", () => {
    const r1 = { id: "r1", author: "a", body: "hi", createdAt: "t1" };
    const r2 = { id: "r2", author: "b", body: "yo", createdAt: "t2" };
    let s = reducer(s0, addReplyAction(s0, "k", r1));
    s = reducer(s, addReplyAction(s, "k", r2));
    expect(viewReplies(s)["k"]).toEqual([r1, r2]);
  });

  it("preserves an Interaction's agentQueueStatus on add", () => {
    // The reducer just spreads the interaction, so a producer-supplied
    // `agentQueueStatus` passes through verbatim.
    const reply = {
      id: "r1",
      author: "a",
      body: "hi",
      createdAt: "now",
      agentQueueStatus: "pending" as const,
    };
    const s = reducer(s0, addReplyAction(s0, "k", reply));
    expect(viewReplies(s)["k"][0].agentQueueStatus).toBe("pending");
  });
});

// ── SET_REPLY_ENQUEUE_ERROR ────────────────────────────────────────────────

describe("SET_REPLY_ENQUEUE_ERROR", () => {
  it("sets enqueueError = true on the matching reply", () => {
    const reply = {
      id: "r1",
      author: "a",
      body: "hi",
      createdAt: "now",
    };
    const s1 = reducer(s0, addReplyAction(s0, "k", reply));
    const s2 = reducer(s1, {
      type: "SET_INTERACTION_ENQUEUE_ERROR",
      targetKey: "k",
      interactionId: "r1",
      error: true,
    });
    expect(viewReplies(s2)["k"][0].enqueueError).toBe(true);
  });

  it("clears enqueueError back to false on success", () => {
    const reply = {
      id: "r1",
      author: "a",
      body: "hi",
      createdAt: "now",
      enqueueError: true,
    };
    const s1 = reducer(s0, addReplyAction(s0, "k", reply));
    const s2 = reducer(s1, {
      type: "SET_INTERACTION_ENQUEUE_ERROR",
      targetKey: "k",
      interactionId: "r1",
      error: false,
    });
    expect(viewReplies(s2)["k"][0].enqueueError).toBe(false);
  });

  it("is a no-op when the targetKey is unknown", () => {
    const s = reducer(s0, {
      type: "SET_INTERACTION_ENQUEUE_ERROR",
      targetKey: "missing",
      interactionId: "r1",
      error: true,
    });
    expect(s).toBe(s0);
  });

  it("is a no-op when the replyId does not match", () => {
    const reply = {
      id: "r1",
      author: "a",
      body: "hi",
      createdAt: "now",
    };
    const s1 = reducer(s0, addReplyAction(s0, "k", reply));
    const s2 = reducer(s1, {
      type: "SET_INTERACTION_ENQUEUE_ERROR",
      targetKey: "k",
      interactionId: "nope",
      error: true,
    });
    expect(s2).toBe(s1);
  });

  it("returns the same state when the flag is already at the requested value", () => {
    // Idempotency keeps unrelated subscribers from re-rendering when nothing
    // observably changed. The reducer treats "absent" and `false` as the
    // same starting state for this comparison.
    const reply = {
      id: "r1",
      author: "a",
      body: "hi",
      createdAt: "now",
    };
    const s1 = reducer(s0, addReplyAction(s0, "k", reply));
    const s2 = reducer(s1, {
      type: "SET_INTERACTION_ENQUEUE_ERROR",
      targetKey: "k",
      interactionId: "r1",
      error: false,
    });
    expect(s2).toBe(s1);
  });
});

describe("DELETE_REPLY", () => {
  it("removes a reply by id from the thread", () => {
    const r1 = { id: "r1", author: "a", body: "hi", createdAt: "t1" };
    const r2 = { id: "r2", author: "b", body: "yo", createdAt: "t2" };
    let s = reducer(s0, addReplyAction(s0, "k", r1));
    s = reducer(s, addReplyAction(s, "k", r2));
    s = reducer(s, { type: "DELETE_INTERACTION", targetKey: "k", interactionId: "r1" });
    expect(viewReplies(s)["k"]).toEqual([r2]);
  });

  it("drops the targetKey entirely when the last reply is removed", () => {
    const r1 = { id: "r1", author: "a", body: "hi", createdAt: "t1" };
    let s = reducer(s0, addReplyAction(s0, "k", r1));
    s = reducer(s, { type: "DELETE_INTERACTION", targetKey: "k", interactionId: "r1" });
    expect(Object.prototype.hasOwnProperty.call(viewReplies(s), "k")).toBe(false);
  });

  it("returns the same state when the targetKey is unknown", () => {
    const s = reducer(s0, { type: "DELETE_INTERACTION", targetKey: "missing", interactionId: "x" });
    expect(s).toBe(s0);
  });

  it("returns the same state when the replyId does not match", () => {
    const r1 = { id: "r1", author: "a", body: "hi", createdAt: "t1" };
    const s1 = reducer(s0, addReplyAction(s0, "k", r1));
    const s2 = reducer(s1, { type: "DELETE_INTERACTION", targetKey: "k", interactionId: "nope" });
    expect(s2).toBe(s1);
  });
});

// ── MERGE_AGENT_REPLIES ────────────────────────────────────────────────────

describe("MERGE_AGENT_REPLIES", () => {
  function withReply(
    state: ReviewState,
    targetKey: string,
    replyId = "r1",
  ): ReviewState {
    return reducer(
      state,
      addReplyAction(state, targetKey, {
        id: replyId,
        author: "you",
        body: "x",
        createdAt: "2026-04-30T00:00:00Z",
      }),
    );
  }

  // Builds an Interaction-shaped polled-reply entry. `parentId` is the
  // client-authoritative interaction id the agent replied to — the reducer
  // matches it against each interaction's own `id`. Maps outcome → intent
  // (addressed → accept, declined → reject, noted → ack).
  function polled(args: {
    id: string;
    parentId: string;
    body: string;
    outcome: "addressed" | "declined" | "noted";
    postedAt: string;
  }): import("./state").PolledAgentReply {
    const intent: "ack" | "accept" | "reject" =
      args.outcome === "addressed"
        ? "accept"
        : args.outcome === "declined"
          ? "reject"
          : "ack";
    return {
      id: args.id,
      parentId: args.parentId,
      body: args.body,
      intent,
      author: "agent",
      authorRole: "agent",
      target: "reply",
      postedAt: args.postedAt,
    };
  }

  it("attaches a polled agent entry to the matching reviewer Interaction by id", () => {
    const s1 = withReply(s0, "k");
    const s2 = reducer(s1, {
      type: "MERGE_AGENT_REPLIES",
      polled: [
        polled({
          id: "ar1",
          parentId: "r1",
          body: "fixed",
          outcome: "addressed",
          postedAt: "2026-04-30T00:01:00Z",
        }),
      ],
    });
    expect(viewReplies(s2)["k"][0].agentReplies).toEqual([
      {
        id: "ar1",
        body: "fixed",
        outcome: "addressed",
        postedAt: "2026-04-30T00:01:00Z",
      },
    ]);
  });

  it("sorts by postedAt ascending after the merge", () => {
    const s1 = withReply(s0, "k");
    const s2 = reducer(s1, {
      type: "MERGE_AGENT_REPLIES",
      polled: [
        polled({
          id: "b",
          parentId: "r1",
          body: "B",
          outcome: "addressed",
          postedAt: "2026-04-30T00:02:00Z",
        }),
        polled({
          id: "a",
          parentId: "r1",
          body: "A",
          outcome: "noted",
          postedAt: "2026-04-30T00:01:00Z",
        }),
      ],
    });
    expect(viewReplies(s2)["k"][0].agentReplies!.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("updates existing entries in place (matched by id) and appends new ones", () => {
    const s1 = withReply(s0, "k");
    const s2 = reducer(s1, {
      type: "MERGE_AGENT_REPLIES",
      polled: [
        polled({
          id: "ar1",
          parentId: "r1",
          body: "first",
          outcome: "noted",
          postedAt: "2026-04-30T00:01:00Z",
        }),
      ],
    });
    const s3 = reducer(s2, {
      type: "MERGE_AGENT_REPLIES",
      polled: [
        // Same id with updated body should overwrite.
        polled({
          id: "ar1",
          parentId: "r1",
          body: "first (edited)",
          outcome: "addressed",
          postedAt: "2026-04-30T00:01:00Z",
        }),
        polled({
          id: "ar2",
          parentId: "r1",
          body: "second",
          outcome: "addressed",
          postedAt: "2026-04-30T00:02:00Z",
        }),
      ],
    });
    const replies = viewReplies(s3)["k"][0].agentReplies!;
    expect(replies).toHaveLength(2);
    expect(replies[0].body).toBe("first (edited)");
    expect(replies[0].outcome).toBe("addressed");
    expect(replies[1].id).toBe("ar2");
  });

  it("is a no-op when no Interaction matches the polled parentId", () => {
    const s1 = withReply(s0, "k");
    const s2 = reducer(s1, {
      type: "MERGE_AGENT_REPLIES",
      polled: [
        polled({
          id: "ar1",
          parentId: "r_other",
          body: "orphan",
          outcome: "noted",
          postedAt: "2026-04-30T00:01:00Z",
        }),
      ],
    });
    expect(s2).toBe(s1);
  });

  it("is idempotent — repeated merges of the same data leave state unchanged", () => {
    const s1 = withReply(s0, "k");
    const batch = [
      polled({
        id: "ar1",
        parentId: "r1",
        body: "x",
        outcome: "addressed",
        postedAt: "2026-04-30T00:01:00Z",
      }),
    ];
    const s2 = reducer(s1, { type: "MERGE_AGENT_REPLIES", polled: batch });
    const s3 = reducer(s2, { type: "MERGE_AGENT_REPLIES", polled: batch });
    expect(s3).toBe(s2);
  });

  it("groups polled entries across multiple parentIds onto distinct Replies", () => {
    let s = withReply(s0, "k1", "r1");
    s = withReply(s, "k2", "r2");
    const merged = reducer(s, {
      type: "MERGE_AGENT_REPLIES",
      polled: [
        polled({
          id: "ar_a",
          parentId: "r1",
          body: "a",
          outcome: "noted",
          postedAt: "2026-04-30T00:01:00Z",
        }),
        polled({
          id: "ar_b",
          parentId: "r2",
          body: "b",
          outcome: "addressed",
          postedAt: "2026-04-30T00:01:00Z",
        }),
      ],
    });
    expect(viewReplies(merged)["k1"][0].agentReplies!.map((r) => r.id)).toEqual([
      "ar_a",
    ]);
    expect(viewReplies(merged)["k2"][0].agentReplies!.map((r) => r.id)).toEqual([
      "ar_b",
    ]);
  });
});

// ── MERGE_AGENT_REPLIES — top-level (anchor-shaped) entries ───────────────
// The same action handles agent-started top-level interactions. The reducer
// resolves (file, lines) against the active changeset to a hunk + lineIdx,
// then files the Interaction under the matching user:/block: thread key.
// Unresolvable entries land in `detachedInteractions`.

describe("MERGE_AGENT_REPLIES — top-level entries", () => {
  function csForTopLevel(): ChangeSet {
    // f1 path = "src/foo.ts" with one hunk covering lines 5-10 (newNo).
    const lines: DiffLine[] = [
      { kind: "context", text: "a", oldNo: 5, newNo: 5 },
      { kind: "context", text: "b", oldNo: 6, newNo: 6 },
      { kind: "context", text: "c", oldNo: 7, newNo: 7 },
      { kind: "context", text: "d", oldNo: 8, newNo: 8 },
      { kind: "context", text: "e", oldNo: 9, newNo: 9 },
      { kind: "context", text: "f", oldNo: 10, newNo: 10 },
    ];
    const hunk: Hunk = {
      id: "cs1/f1#h1",
      header: "@@",
      oldStart: 5,
      oldCount: 6,
      newStart: 5,
      newCount: 6,
      lines,
    };
    const file: DiffFile = {
      id: "cs1/f1",
      path: "src/foo.ts",
      language: "ts",
      status: "modified",
      hunks: [hunk],
    };
    return {
      id: "cs1",
      title: "t",
      author: "tester",
      branch: "h",
      base: "b",
      createdAt: "2026-04-30T00:00:00.000Z",
      description: "",
      files: [file],
    };
  }

  function topLevel(args: {
    id: string;
    file: string;
    lines: string;
    body?: string;
    intent?: "comment" | "question" | "request" | "blocker";
    target?: "line" | "block";
    postedAt?: string;
    rationale?: string;
    suggestedFix?: string;
    confidence?: "low" | "medium" | "high";
  }): import("./state").PolledAgentReply {
    return {
      id: args.id,
      file: args.file,
      lines: args.lines,
      body: args.body ?? `b-${args.id}`,
      intent: args.intent ?? "comment",
      author: "agent",
      authorRole: "agent",
      target: args.target ?? (args.lines.includes("-") ? "block" : "line"),
      postedAt: args.postedAt ?? "2026-04-30T00:01:00Z",
      rationale: args.rationale,
      suggestedFix: args.suggestedFix,
      confidence: args.confidence,
    };
  }

  it("resolves a single-line top-level entry to the matching user: thread key", () => {
    const s = initialState([csForTopLevel()]);
    const merged = reducer(s, {
      type: "MERGE_AGENT_REPLIES",
      polled: [topLevel({ id: "ag_1", file: "src/foo.ts", lines: "7" })],
    });
    // The thread key carries a freshly-minted id segment — locate it by
    // parsing rather than reconstructing the literal.
    const keys = Object.keys(merged.interactions);
    expect(keys).toHaveLength(1);
    const key = keys[0];
    const parsed = parseReplyKey(key);
    expect(parsed).toMatchObject({ kind: "user", hunkId: "cs1/f1#h1", lineIdx: 2 });
    expect(merged.interactions[key]).toHaveLength(1);
    expect(merged.interactions[key][0]).toMatchObject({
      id: "ag_1",
      authorRole: "agent",
      target: "line",
      threadKey: key,
    });
  });

  it("resolves a block-shaped top-level entry to the matching block: thread key", () => {
    const s = initialState([csForTopLevel()]);
    const merged = reducer(s, {
      type: "MERGE_AGENT_REPLIES",
      polled: [topLevel({ id: "ag_2", file: "src/foo.ts", lines: "6-8" })],
    });
    const keys = Object.keys(merged.interactions);
    expect(keys).toHaveLength(1);
    const key = keys[0];
    expect(parseReplyKey(key)).toMatchObject({
      kind: "block",
      hunkId: "cs1/f1#h1",
      lo: 1,
      hi: 3,
    });
    expect(merged.interactions[key]).toHaveLength(1);
    expect(merged.interactions[key][0]).toMatchObject({
      id: "ag_2",
      target: "block",
    });
  });

  it("places top-level entries whose file isn't in the diff into detachedInteractions", () => {
    const s = initialState([csForTopLevel()]);
    const merged = reducer(s, {
      type: "MERGE_AGENT_REPLIES",
      polled: [topLevel({ id: "ag_3", file: "src/other.ts", lines: "1" })],
    });
    expect(merged.detachedInteractions).toHaveLength(1);
    expect(merged.detachedInteractions[0].interaction.id).toBe("ag_3");
    expect(merged.detachedInteractions[0].interaction.authorRole).toBe("agent");
  });

  it("places top-level entries whose line is outside any hunk into detachedInteractions", () => {
    const s = initialState([csForTopLevel()]);
    const merged = reducer(s, {
      type: "MERGE_AGENT_REPLIES",
      polled: [topLevel({ id: "ag_4", file: "src/foo.ts", lines: "99" })],
    });
    expect(merged.detachedInteractions).toHaveLength(1);
    expect(merged.detachedInteractions[0].interaction.id).toBe("ag_4");
  });

  // With full file content available, a line outside every hunk but present in
  // the file anchors to a userFile thread instead of detaching — this is how AI
  // findings on unchanged lines stay first-class.
  function csWithFullContent(): ChangeSet {
    const cs = csForTopLevel();
    const file = cs.files[0];
    const fullContent: DiffLine[] = Array.from({ length: 12 }, (_, i) => ({
      kind: "context",
      text: `L${i + 1}`,
      oldNo: i + 1,
      newNo: i + 1,
    }));
    return { ...cs, files: [{ ...file, fullContent }] };
  }

  it("anchors an unchanged-line agent comment (outside hunks, in full content) to a userFile thread", () => {
    const s = initialState([csWithFullContent()]);
    const merged = reducer(s, {
      type: "MERGE_AGENT_REPLIES",
      polled: [topLevel({ id: "ag_fl", file: "src/foo.ts", lines: "2" })],
    });
    expect(merged.detachedInteractions).toHaveLength(0);
    const keys = Object.keys(merged.interactions);
    expect(keys).toHaveLength(1);
    expect(parseReplyKey(keys[0])).toMatchObject({
      kind: "userFile",
      fileId: "cs1/f1",
      newNo: 2,
    });
    expect(merged.interactions[keys[0]][0]).toMatchObject({
      id: "ag_fl",
      authorRole: "agent",
      anchorPath: "src/foo.ts",
      anchorLineNo: 2,
    });
  });

  it("still detaches an agent comment whose line is absent from full content", () => {
    const s = initialState([csWithFullContent()]);
    const merged = reducer(s, {
      type: "MERGE_AGENT_REPLIES",
      polled: [topLevel({ id: "ag_gone", file: "src/foo.ts", lines: "999" })],
    });
    expect(merged.detachedInteractions).toHaveLength(1);
    expect(Object.keys(merged.interactions)).toHaveLength(0);
  });

  it("still resolves an in-hunk agent comment to a user: thread when full content exists", () => {
    const s = initialState([csWithFullContent()]);
    const merged = reducer(s, {
      type: "MERGE_AGENT_REPLIES",
      polled: [topLevel({ id: "ag_inhunk", file: "src/foo.ts", lines: "7" })],
    });
    const keys = Object.keys(merged.interactions);
    expect(keys).toHaveLength(1);
    expect(parseReplyKey(keys[0])).toMatchObject({ kind: "user", hunkId: "cs1/f1#h1" });
  });

  it("deduplicates detached entries by id across repeated polls", () => {
    const s = initialState([csForTopLevel()]);
    const dup = topLevel({ id: "ag_5", file: "missing.ts", lines: "1" });
    const s1 = reducer(s, { type: "MERGE_AGENT_REPLIES", polled: [dup] });
    const s2 = reducer(s1, { type: "MERGE_AGENT_REPLIES", polled: [dup] });
    expect(s2.detachedInteractions).toHaveLength(1);
  });

  it("keeps a resolved top-level entry idempotent across repeated polls", () => {
    const s = initialState([csForTopLevel()]);
    const dup = topLevel({ id: "ag_6", file: "src/foo.ts", lines: "7" });
    const s1 = reducer(s, { type: "MERGE_AGENT_REPLIES", polled: [dup] });
    const s2 = reducer(s1, { type: "MERGE_AGENT_REPLIES", polled: [dup] });
    const keys = Object.keys(s2.interactions);
    expect(keys).toHaveLength(1);
    expect(s2.interactions[keys[0]]).toHaveLength(1);
  });

  it("carries rationale/suggestedFix/confidence onto the merged Interaction", () => {
    const s = initialState([csForTopLevel()]);
    const merged = reducer(s, {
      type: "MERGE_AGENT_REPLIES",
      polled: [
        topLevel({
          id: "ag_7",
          file: "src/foo.ts",
          lines: "7",
          rationale: "this leaks a handle",
          suggestedFix: "close(fd)",
          confidence: "high",
        }),
      ],
    });
    // The thread key carries a freshly-minted id segment — locate it by
    // discovery rather than reconstructing the literal.
    const keys = Object.keys(merged.interactions);
    expect(keys).toHaveLength(1);
    expect(merged.interactions[keys[0]][0]).toMatchObject({
      id: "ag_7",
      rationale: "this leaks a handle",
      suggestedFix: "close(fd)",
      confidence: "high",
    });
  });
});

// ── SET_EXPAND_LEVEL ───────────────────────────────────────────────────────

describe("SET_EXPAND_LEVEL", () => {
  it("sets the level under expandLevelAbove for dir=above", () => {
    const s = reducer(s0, {
      type: "SET_EXPAND_LEVEL",
      hunkId: "h",
      dir: "above",
      level: 2,
    });
    expect(s.expandLevelAbove["h"]).toBe(2);
    expect(s.expandLevelBelow["h"]).toBeUndefined();
  });

  it("sets the level under expandLevelBelow for dir=below", () => {
    const s = reducer(s0, {
      type: "SET_EXPAND_LEVEL",
      hunkId: "h",
      dir: "below",
      level: 3,
    });
    expect(s.expandLevelBelow["h"]).toBe(3);
  });

  it("clamps negative levels to 0", () => {
    const s = reducer(s0, {
      type: "SET_EXPAND_LEVEL",
      hunkId: "h",
      dir: "above",
      level: -5,
    });
    expect(s.expandLevelAbove["h"]).toBe(0);
  });
});

// ── TOGGLE_EXPAND_FILE / TOGGLE_PREVIEW_FILE ───────────────────────────────

describe("TOGGLE_EXPAND_FILE", () => {
  it("adds the fileId on first toggle and removes on second", () => {
    const s1 = reducer(s0, { type: "TOGGLE_EXPAND_FILE", fileId: "cs1/f1" });
    expect(s1.fullExpandedFiles.has("cs1/f1")).toBe(true);
    const s2 = reducer(s1, { type: "TOGGLE_EXPAND_FILE", fileId: "cs1/f1" });
    expect(s2.fullExpandedFiles.has("cs1/f1")).toBe(false);
  });

  it("turning on full-expand removes the file from previewedFiles (mutually exclusive)", () => {
    const previewing = reducer(s0, { type: "TOGGLE_PREVIEW_FILE", fileId: "cs1/f1" });
    const s = reducer(previewing, { type: "TOGGLE_EXPAND_FILE", fileId: "cs1/f1" });
    expect(s.previewedFiles.has("cs1/f1")).toBe(false);
    expect(s.fullExpandedFiles.has("cs1/f1")).toBe(true);
  });
});

describe("TOGGLE_PREVIEW_FILE", () => {
  it("adds the fileId on first toggle and removes on second", () => {
    const s1 = reducer(s0, { type: "TOGGLE_PREVIEW_FILE", fileId: "cs1/f1" });
    expect(s1.previewedFiles.has("cs1/f1")).toBe(true);
    const s2 = reducer(s1, { type: "TOGGLE_PREVIEW_FILE", fileId: "cs1/f1" });
    expect(s2.previewedFiles.has("cs1/f1")).toBe(false);
  });

  it("turning on preview removes the file from fullExpandedFiles", () => {
    const expanded = reducer(s0, { type: "TOGGLE_EXPAND_FILE", fileId: "cs1/f1" });
    const s = reducer(expanded, { type: "TOGGLE_PREVIEW_FILE", fileId: "cs1/f1" });
    expect(s.fullExpandedFiles.has("cs1/f1")).toBe(false);
    expect(s.previewedFiles.has("cs1/f1")).toBe(true);
  });
});

// ── TOGGLE_FILE_REVIEWED ───────────────────────────────────────────────────

describe("TOGGLE_FILE_REVIEWED", () => {
  it("adds the fileId on first toggle and removes on second", () => {
    const s1 = reducer(s0, { type: "TOGGLE_FILE_REVIEWED", fileId: "cs1/f1" });
    expect(s1.reviewedFiles.has("cs1/f1")).toBe(true);
    const s2 = reducer(s1, { type: "TOGGLE_FILE_REVIEWED", fileId: "cs1/f1" });
    expect(s2.reviewedFiles.has("cs1/f1")).toBe(false);
  });
});

// ── Coverage helpers ───────────────────────────────────────────────────────

describe("coverage helpers", () => {
  it("hunkCoverage returns seen / total", () => {
    const hunk = { id: "h", lines: [0, 1, 2, 3] }; // 4 lines
    const lines = { h: new Set([0, 2]) };
    expect(hunkCoverage(hunk, lines)).toBeCloseTo(0.5);
  });

  it("hunkCoverage returns 0 for an empty hunk", () => {
    expect(hunkCoverage({ id: "h", lines: [] }, {})).toBe(0);
  });

  it("hunkCoverage returns 0 when the hunk has no entry in readLines", () => {
    expect(hunkCoverage({ id: "h", lines: [0, 1] }, {})).toBe(0);
  });

  it("fileCoverage averages across all hunks weighted by line count", () => {
    const file = {
      hunks: [
        { id: "h1", lines: [0, 1] }, // 2 lines, 1 seen → 50%
        { id: "h2", lines: [0, 1, 2, 3] }, // 4 lines, 4 seen → 100%
      ],
    };
    const lines = { h1: new Set([0]), h2: new Set([0, 1, 2, 3]) };
    // 5 of 6 lines seen
    expect(fileCoverage(file, lines)).toBeCloseTo(5 / 6);
  });

  it("fileCoverage returns 0 for a file with no lines", () => {
    expect(fileCoverage({ hunks: [] }, {})).toBe(0);
  });

  it("changesetCoverage sums across all files in the changeset", () => {
    const cs = defaultChangeset(); // f1 has 2 hunks of 3 lines, f2 has 1 hunk of 2 lines = 8 lines
    const lines = {
      "cs1/f1#h1": new Set([0, 1, 2]),
      "cs1/f1#h2": new Set([0]),
      "cs1/f2#h1": new Set<number>(),
    };
    expect(changesetCoverage(cs, lines)).toBeCloseTo(4 / 8);
  });

  it("reviewedFilesCount counts files in the changeset that are in the reviewed set", () => {
    const cs = defaultChangeset();
    const reviewed = new Set(["cs1/f1", "other/file"]);
    expect(reviewedFilesCount(cs, reviewed)).toBe(1);
  });
});

// ── Mouse-driven actions ───────────────────────────────────────────────────

describe("SET_SELECTION_RANGE", () => {
  it("sets a line-range selection without moving the cursor", () => {
    const s1 = reducer(s0, {
      type: "SET_SELECTION_RANGE",
      hunkId: "cs1/f1#h1",
      anchor: 0,
      head: 2,
    });
    expect(s1.cursor).toEqual(s0.cursor);
    expect(s1.selection).toEqual({ hunkId: "cs1/f1#h1", anchor: 0, head: 2 });
  });

  it("drops charRange when anchor !== head", () => {
    const s1 = reducer(s0, {
      type: "SET_SELECTION_RANGE",
      hunkId: "cs1/f1#h1",
      anchor: 0,
      head: 2,
      charRange: { lineIdx: 0, fromCol: 0, toCol: 3 },
    });
    expect(s1.selection?.charRange).toBeUndefined();
  });

  it("preserves charRange when anchor === head", () => {
    const s1 = reducer(s0, {
      type: "SET_SELECTION_RANGE",
      hunkId: "cs1/f1#h1",
      anchor: 0,
      head: 0,
      charRange: { lineIdx: 0, fromCol: 1, toCol: 2 },
    });
    expect(s1.selection?.charRange).toEqual({ lineIdx: 0, fromCol: 1, toCol: 2 });
  });

  it("ignores moves to a different hunk than the cursor's", () => {
    const s1 = reducer(s0, {
      type: "SET_SELECTION_RANGE",
      hunkId: "cs1/f1#h2",
      anchor: 0,
      head: 1,
    });
    expect(s1).toBe(s0);
  });
});

describe("SET_LINE_CHAR_RANGE", () => {
  it("sets a single-line selection with a charRange", () => {
    const s1 = reducer(s0, {
      type: "SET_LINE_CHAR_RANGE",
      hunkId: "cs1/f1#h1",
      lineIdx: 1,
      fromCol: 2,
      toCol: 5,
    });
    expect(s1.selection).toEqual({
      hunkId: "cs1/f1#h1",
      anchor: 1,
      head: 1,
      charRange: { lineIdx: 1, fromCol: 2, toCol: 5 },
    });
  });

  it("is a no-op when fromCol >= toCol", () => {
    const s1 = reducer(s0, {
      type: "SET_LINE_CHAR_RANGE",
      hunkId: "cs1/f1#h1",
      lineIdx: 0,
      fromCol: 3,
      toCol: 3,
    });
    expect(s1).toBe(s0);
  });

  it("ignores out-of-cursor-hunk events", () => {
    const s1 = reducer(s0, {
      type: "SET_LINE_CHAR_RANGE",
      hunkId: "cs1/f1#h2",
      lineIdx: 0,
      fromCol: 0,
      toCol: 1,
    });
    expect(s1).toBe(s0);
  });
});

describe("MARK_LINES_READ / MARK_LINES_UNREAD", () => {
  it("MARK_LINES_READ adds every idx in the inclusive range", () => {
    const s1 = reducer(s0, {
      type: "MARK_LINES_READ",
      hunkId: "cs1/f1#h1",
      loLineIdx: 0,
      hiLineIdx: 2,
    });
    expect(Array.from(s1.readLines["cs1/f1#h1"]).sort()).toEqual([0, 1, 2]);
  });

  it("MARK_LINES_READ leaves cursor and selection untouched", () => {
    const s1 = reducer(s0, {
      type: "MARK_LINES_READ",
      hunkId: "cs1/f1#h1",
      loLineIdx: 1,
      hiLineIdx: 2,
    });
    expect(s1.cursor).toEqual(s0.cursor);
    expect(s1.selection).toEqual(s0.selection);
  });

  it("MARK_LINES_UNREAD removes the range and drops the key when empty", () => {
    const seeded = reducer(s0, {
      type: "MARK_LINES_READ",
      hunkId: "cs1/f1#h1",
      loLineIdx: 0,
      hiLineIdx: 2,
    });
    const cleared = reducer(seeded, {
      type: "MARK_LINES_UNREAD",
      hunkId: "cs1/f1#h1",
      loLineIdx: 0,
      hiLineIdx: 2,
    });
    expect(cleared.readLines["cs1/f1#h1"]).toBeUndefined();
  });

  it("MARK_LINES_UNREAD is a no-op when nothing in the range was read", () => {
    const seeded = reducer(s0, {
      type: "MARK_LINES_READ",
      hunkId: "cs1/f1#h1",
      loLineIdx: 0,
      hiLineIdx: 0,
    });
    const next = reducer(seeded, {
      type: "MARK_LINES_UNREAD",
      hunkId: "cs1/f1#h1",
      loLineIdx: 1,
      hiLineIdx: 2,
    });
    expect(next).toBe(seeded);
  });
});

describe("charRange invariants under existing actions", () => {
  it("MOVE_LINE { extend: true } produces a selection without charRange", () => {
    const seeded = reducer(s0, {
      type: "SET_LINE_CHAR_RANGE",
      hunkId: "cs1/f1#h1",
      lineIdx: 0,
      fromCol: 0,
      toCol: 2,
    });
    expect(seeded.selection?.charRange).toBeDefined();
    const after = reducer(seeded, { type: "MOVE_LINE", delta: 1, extend: true });
    expect(after.selection).toEqual({
      hunkId: "cs1/f1#h1",
      anchor: 0,
      head: 1,
    });
    expect(after.selection?.charRange).toBeUndefined();
  });

  it("plain MOVE_LINE clears charRange", () => {
    const seeded = reducer(s0, {
      type: "SET_LINE_CHAR_RANGE",
      hunkId: "cs1/f1#h1",
      lineIdx: 0,
      fromCol: 0,
      toCol: 2,
    });
    const after = reducer(seeded, { type: "MOVE_LINE", delta: 1 });
    expect(after.selection).toBeNull();
  });

  it("COLLAPSE_SELECTION clears charRange", () => {
    const seeded = reducer(s0, {
      type: "SET_LINE_CHAR_RANGE",
      hunkId: "cs1/f1#h1",
      lineIdx: 0,
      fromCol: 0,
      toCol: 2,
    });
    const after = reducer(seeded, { type: "COLLAPSE_SELECTION" });
    expect(after.selection).toBeNull();
  });
});

// ── MERGE_PR_OVERLAY ───────────────────────────────────────────────────────

const MOCK_PR_SOURCE: PrSource = {
  host: "github.com",
  owner: "owner",
  repo: "repo",
  number: 42,
  htmlUrl: "https://github.com/owner/repo/pull/42",
  headSha: "headsha",
  baseSha: "basesha",
  state: "open",
  title: "My PR",
  body: "",
  baseRef: "main",
  headRef: "feat/branch",
  lastFetchedAt: new Date().toISOString(),
};

const MOCK_PR_CONVERSATION: PrConversationItem[] = [
  {
    id: 1,
    author: "alice",
    createdAt: "2026-04-30T00:00:00Z",
    body: "Looks good!",
    htmlUrl: "https://github.com/owner/repo/pull/42#issuecomment-1",
  },
];

const MOCK_WORKTREE_SOURCE: WorktreeSource = {
  worktreePath: "/workspace/test",
  commitSha: "abc123",
  branch: "feat/branch",
};

describe("MERGE_PR_OVERLAY", () => {
  function makeWorktreeChangeset(): ChangeSet {
    const cs = defaultChangeset();
    return { ...cs, worktreeSource: MOCK_WORKTREE_SOURCE };
  }

  it("sets prSource and prConversation on the target changeset", () => {
    const cs = makeWorktreeChangeset();
    const state = initialState([cs]);
    const next = reducer(state, {
      type: "MERGE_PR_OVERLAY",
      changesetId: "cs1",
      prSource: MOCK_PR_SOURCE,
      prConversation: MOCK_PR_CONVERSATION,
    });
    const nextCs = next.changesets.find((c) => c.id === "cs1")!;
    expect(nextCs.prSource).toEqual(MOCK_PR_SOURCE);
    expect(nextCs.prConversation).toEqual(MOCK_PR_CONVERSATION);
  });

  it("preserves worktreeSource on the changeset", () => {
    const cs = makeWorktreeChangeset();
    const state = initialState([cs]);
    const next = reducer(state, {
      type: "MERGE_PR_OVERLAY",
      changesetId: "cs1",
      prSource: MOCK_PR_SOURCE,
      prConversation: MOCK_PR_CONVERSATION,
    });
    const nextCs = next.changesets.find((c) => c.id === "cs1")!;
    expect(nextCs.worktreeSource).toEqual(MOCK_WORKTREE_SOURCE);
  });

  it("preserves the diff structure (files/hunks/lines count unchanged)", () => {
    const cs = makeWorktreeChangeset();
    const state = initialState([cs]);
    const next = reducer(state, {
      type: "MERGE_PR_OVERLAY",
      changesetId: "cs1",
      prSource: MOCK_PR_SOURCE,
      prConversation: MOCK_PR_CONVERSATION,
    });
    const origCs = state.changesets.find((c) => c.id === "cs1")!;
    const nextCs = next.changesets.find((c) => c.id === "cs1")!;
    expect(nextCs.files.length).toBe(origCs.files.length);
    for (let i = 0; i < origCs.files.length; i++) {
      expect(nextCs.files[i].hunks.length).toBe(origCs.files[i].hunks.length);
      for (let j = 0; j < origCs.files[i].hunks.length; j++) {
        expect(nextCs.files[i].hunks[j].lines.length).toBe(
          origCs.files[i].hunks[j].lines.length,
        );
      }
    }
  });

  it("is a no-op for an unknown changesetId", () => {
    const state = initialState([defaultChangeset()]);
    const next = reducer(state, {
      type: "MERGE_PR_OVERLAY",
      changesetId: "nonexistent",
      prSource: MOCK_PR_SOURCE,
      prConversation: MOCK_PR_CONVERSATION,
    });
    expect(next).toBe(state);
  });
});

// ── MERGE_PR_REPLIES ───────────────────────────────────────────────────────

describe("MERGE_PR_REPLIES", () => {
  function makePrReply(id: string, body = "external"): UserInteractionLiteral {
    return {
      id,
      author: "external-reviewer",
      body,
      createdAt: "2026-05-06T00:00:00.000Z",
      external: { source: "pr", htmlUrl: `https://github.com/x/y/pull/1#${id}` },
    };
  }

  it("installs new external replies under the given keys", () => {
    const state = initialState([defaultChangeset()]);
    const key = userCommentKey("cs1/f1#h1", 0, "c1");
    const next = reducer(state, {
      type: "MERGE_PR_INTERACTIONS",
      changesetId: "cs1",
      prInteractions: mkUserInteractionMap({ [key]: [makePrReply("pr-comment:1")] }),
      prDetached: [],
    });
    expect(viewReplies(next)[key]).toHaveLength(1);
    expect(viewReplies(next)[key][0].id).toBe("pr-comment:1");
  });

  it("preserves user replies on the same key", () => {
    const cs = defaultChangeset();
    const key = userCommentKey("cs1/f1#h1", 0, "c1");
    const userReply: UserInteractionLiteral = {
      id: "u1",
      author: "luiz",
      body: "mine",
      createdAt: "2026-05-06T00:00:00.000Z",
    };
    const state = {
      ...initialState([cs]),
      interactions: mkUserInteractionMap({ [key]: [userReply] }),
    };
    const next = reducer(state, {
      type: "MERGE_PR_INTERACTIONS",
      changesetId: "cs1",
      prInteractions: mkUserInteractionMap({ [key]: [makePrReply("pr-comment:1")] }),
      prDetached: [],
    });
    expect(viewReplies(next)[key]).toHaveLength(2);
    expect(viewReplies(next)[key].map((r) => r.id)).toEqual(["u1", "pr-comment:1"]);
  });

  it("removes prior PR-sourced replies before installing new ones (refresh idempotent)", () => {
    const cs = defaultChangeset();
    const key = userCommentKey("cs1/f1#h1", 0, "c1");
    const stale = makePrReply("pr-comment:OLD", "stale upstream comment");
    const state = {
      ...initialState([cs]),
      interactions: mkUserInteractionMap({ [key]: [stale] }),
    };
    const next = reducer(state, {
      type: "MERGE_PR_INTERACTIONS",
      changesetId: "cs1",
      prInteractions: mkUserInteractionMap({ [key]: [makePrReply("pr-comment:NEW")] }),
      prDetached: [],
    });
    expect(viewReplies(next)[key]).toHaveLength(1);
    expect(viewReplies(next)[key][0].id).toBe("pr-comment:NEW");
  });

  it("merges in detached replies and strips prior PR-sourced detached entries", () => {
    const cs = defaultChangeset();
    const stalePrDetached = {
      literal: makePrReply("pr-comment:STALE"),
      threadKey: "pr-detached:STALE",
    };
    const userDetached = {
      literal: {
        id: "u-d",
        author: "luiz",
        body: "stranded",
        createdAt: "2026-05-06T00:00:00.000Z",
      },
      threadKey: "user:cs1/f1#h1:0",
    };
    const state = {
      ...initialState([cs]),
      detachedInteractions: mkDetachedInteractions([stalePrDetached, userDetached]),
    };
    const newPrDetached = {
      literal: {
        ...makePrReply("pr-comment:NEW"),
        anchorPath: "src/foo.ts",
        anchorLineNo: 10,
        anchorContext: [],
        originType: "committed" as const,
      },
      threadKey: "pr-detached:NEW",
    };
    const next = reducer(state, {
      type: "MERGE_PR_INTERACTIONS",
      changesetId: "cs1",
      prInteractions: {},
      prDetached: mkDetachedInteractions([newPrDetached]),
    });
    // User detached preserved, stale PR-detached removed, new PR-detached installed.
    expect(viewDetached(next)).toHaveLength(2);
    const ids = viewDetached(next).map((d) => d.reply.id);
    expect(ids).toContain("u-d");
    expect(ids).toContain("pr-comment:NEW");
    expect(ids).not.toContain("pr-comment:STALE");
  });
});

describe("quiz", () => {
  const sampleQuestion = (id: string, target: QuestionTarget): Question => ({
    id,
    type: "q1",
    target,
    prompt: `Q ${id}`,
    claudeAnswer: `Claude says ${id}`,
  });

  function buildSampleChangeset(): ChangeSet {
    return {
      id: "cs-1", title: "x", description: "", branch: "f", base: "main", author: "u",
      createdAt: "2026-01-01T00:00:00Z",
      files: [{
        id: "cs-1/a.ts", path: "a.ts", language: "ts", status: "modified",
        hunks: [{ id: "h-a-1", header: "@@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] }],
      }],
    } as ChangeSet;
  }
  function withChangeset(cs: ChangeSet): ReviewState {
    return initialState([cs], {});
  }

  it("STORE_QUESTIONS lands questions under the changeset id", () => {
    const initial = initialState([], {});
    const q1 = sampleQuestion("q-1", { kind: "file", path: "a.ts" });
    const q2 = sampleQuestion("q-2", { kind: "changeset" });
    const next = reducer(initial, {
      type: "STORE_QUESTIONS",
      changesetId: "cs-1",
      questions: [q1, q2],
    });
    expect(next.quiz.questions["cs-1"]).toEqual([q1, q2]);
  });

  it("TRIGGER_QUIZ_FOR_FILE no-ops when no questions for changeset", () => {
    const initial = withChangeset(buildSampleChangeset());
    const next = reducer(initial, {
      type: "TRIGGER_QUIZ_FOR_FILE",
      changesetId: "cs-1",
      fileId: "cs-1/a.ts",
    });
    expect(next.quiz.active).toBeNull();
  });

  it("TRIGGER_QUIZ_FOR_FILE no-ops when active is already set", () => {
    const cs = buildSampleChangeset();
    const q = sampleQuestion("q-1", { kind: "file", path: "a.ts" });
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: {
        questions: { "cs-1": [q] },
        answers: {},
        active: { questionId: "q-1", mode: "single" },
        asked: [],
      },
    };
    const next = reducer(initial, {
      type: "TRIGGER_QUIZ_FOR_FILE",
      changesetId: "cs-1",
      fileId: "cs-1/a.ts",
    });
    expect(next.quiz.active).toEqual({ questionId: "q-1", mode: "single" });
  });

  it("TRIGGER_QUIZ_FOR_FILE sets active with mode 'single' to the head of the eligible queue", () => {
    const cs = buildSampleChangeset();
    const qs = [
      sampleQuestion("q-1", { kind: "file", path: "a.ts" }),
      sampleQuestion("q-2", { kind: "hunk", hunkId: "h-a-1" }),
    ];
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: { questions: { "cs-1": qs }, answers: {}, active: null, asked: [] },
    };
    const next = reducer(initial, {
      type: "TRIGGER_QUIZ_FOR_FILE",
      changesetId: "cs-1",
      fileId: "cs-1/a.ts",
    });
    expect(next.quiz.active).toEqual({ questionId: "q-1", mode: "single" });
  });

  it("TRIGGER_QUIZ_FOR_FILE skips asked questions", () => {
    const cs = buildSampleChangeset();
    const qs = [
      sampleQuestion("q-1", { kind: "file", path: "a.ts" }),
      sampleQuestion("q-2", { kind: "hunk", hunkId: "h-a-1" }),
    ];
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: { questions: { "cs-1": qs }, answers: {}, active: null, asked: ["q-1"] },
    };
    const next = reducer(initial, {
      type: "TRIGGER_QUIZ_FOR_FILE",
      changesetId: "cs-1",
      fileId: "cs-1/a.ts",
    });
    expect(next.quiz.active).toEqual({ questionId: "q-2", mode: "single" });
  });

  it("TRIGGER_QUIZ_FOR_FILE no-ops when nothing eligible (e.g., changeset-only question)", () => {
    const cs = buildSampleChangeset();
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: {
        questions: { "cs-1": [sampleQuestion("q-cs", { kind: "changeset" })] },
        answers: {},
        active: null,
        asked: [],
      },
    };
    const next = reducer(initial, {
      type: "TRIGGER_QUIZ_FOR_FILE",
      changesetId: "cs-1",
      fileId: "cs-1/a.ts",
    });
    expect(next.quiz.active).toBeNull();
  });

  it("TRIGGER_QUIZ_FOR_CHANGESET prefers a changeset-level question", () => {
    const cs = buildSampleChangeset();
    const qs = [
      sampleQuestion("q-file", { kind: "file", path: "a.ts" }),
      sampleQuestion("q-cs", { kind: "changeset" }),
    ];
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: { questions: { "cs-1": qs }, answers: {}, active: null, asked: [] },
    };
    const next = reducer(initial, {
      type: "TRIGGER_QUIZ_FOR_CHANGESET",
      changesetId: "cs-1",
    });
    expect(next.quiz.active).toEqual({ questionId: "q-cs", mode: "sequence" });
  });

  it("TRIGGER_QUIZ_FOR_CHANGESET falls back to any unanswered question when the changeset Q is asked", () => {
    const cs = buildSampleChangeset();
    const qs = [
      sampleQuestion("q-cs", { kind: "changeset" }),
      sampleQuestion("q-file", { kind: "file", path: "a.ts" }),
    ];
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: { questions: { "cs-1": qs }, answers: {}, active: null, asked: ["q-cs"] },
    };
    const next = reducer(initial, {
      type: "TRIGGER_QUIZ_FOR_CHANGESET",
      changesetId: "cs-1",
    });
    expect(next.quiz.active).toEqual({ questionId: "q-file", mode: "sequence" });
  });

  it("TRIGGER_QUIZ_FOR_CHANGESET no-ops when everything is asked", () => {
    const cs = buildSampleChangeset();
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: {
        questions: { "cs-1": [sampleQuestion("q-cs", { kind: "changeset" })] },
        answers: {},
        active: null,
        asked: ["q-cs"],
      },
    };
    const next = reducer(initial, {
      type: "TRIGGER_QUIZ_FOR_CHANGESET",
      changesetId: "cs-1",
    });
    expect(next.quiz.active).toBeNull();
  });

  it("SUBMIT_QUIZ_ANSWER stores answer, adds to asked, keeps active (same mode)", () => {
    const cs = buildSampleChangeset();
    const q = sampleQuestion("q-1", { kind: "file", path: "a.ts" });
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: {
        questions: { "cs-1": [q] },
        answers: {},
        active: { questionId: "q-1", mode: "single" },
        asked: [],
      },
    };
    const next = reducer(initial, {
      type: "SUBMIT_QUIZ_ANSWER",
      questionId: "q-1",
      answer: "my answer",
      now: 5000,
    });
    expect(next.quiz.answers["q-1"]).toEqual({
      answer: "my answer",
      submittedAt: 5000,
      selfEval: null,
    });
    expect(next.quiz.asked).toEqual(["q-1"]);
    expect(next.quiz.active).toEqual({ questionId: "q-1", mode: "single" });
  });

  it("DISMISS_QUIZ in 'single' mode clears active and adds to asked", () => {
    const cs = buildSampleChangeset();
    const q = sampleQuestion("q-1", { kind: "file", path: "a.ts" });
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: {
        questions: { "cs-1": [q] },
        answers: {},
        active: { questionId: "q-1", mode: "single" },
        asked: [],
      },
    };
    const next = reducer(initial, { type: "DISMISS_QUIZ" });
    expect(next.quiz.active).toBeNull();
    expect(next.quiz.asked).toEqual(["q-1"]);
  });

  it("DISMISS_QUIZ in 'sequence' mode advances to the next unanswered question", () => {
    const cs = buildSampleChangeset();
    const qs = [
      sampleQuestion("q-cs", { kind: "changeset" }),
      sampleQuestion("q-file", { kind: "file", path: "a.ts" }),
    ];
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: {
        questions: { "cs-1": qs },
        answers: {},
        active: { questionId: "q-cs", mode: "sequence" },
        asked: [],
      },
    };
    const next = reducer(initial, { type: "DISMISS_QUIZ" });
    expect(next.quiz.active).toEqual({ questionId: "q-file", mode: "sequence" });
    expect(next.quiz.asked).toEqual(["q-cs"]);
  });

  it("DISMISS_QUIZ in 'sequence' mode clears active when nothing remains", () => {
    const cs = buildSampleChangeset();
    const q = sampleQuestion("q-cs", { kind: "changeset" });
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: {
        questions: { "cs-1": [q] },
        answers: {},
        active: { questionId: "q-cs", mode: "sequence" },
        asked: [],
      },
    };
    const next = reducer(initial, { type: "DISMISS_QUIZ" });
    expect(next.quiz.active).toBeNull();
    expect(next.quiz.asked).toEqual(["q-cs"]);
  });

  it("SET_QUIZ_SELF_EVAL writes the bucket without touching active", () => {
    const cs = buildSampleChangeset();
    const q = sampleQuestion("q-1", { kind: "file", path: "a.ts" });
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: {
        questions: { "cs-1": [q] },
        answers: { "q-1": { answer: "x", submittedAt: 100, selfEval: null } },
        active: { questionId: "q-1", mode: "single" },
        asked: ["q-1"],
      },
    };
    const next = reducer(initial, {
      type: "SET_QUIZ_SELF_EVAL",
      questionId: "q-1",
      selfEval: "got_it",
    });
    expect(next.quiz.answers["q-1"].selfEval).toBe("got_it");
    expect(next.quiz.active).toEqual({ questionId: "q-1", mode: "single" });
  });

  it("CLEAR_QUIZ_ACTIVE clears active without touching asked", () => {
    const cs = buildSampleChangeset();
    const q = sampleQuestion("q-1", { kind: "file", path: "a.ts" });
    const initial: ReviewState = {
      ...withChangeset(cs),
      quiz: { questions: { "cs-1": [q] }, answers: {}, active: { questionId: "q-1", mode: "single" }, asked: [] },
    };
    const next = reducer(initial, { type: "CLEAR_QUIZ_ACTIVE" });
    expect(next.quiz.active).toBeNull();
    expect(next.quiz.asked).toEqual([]);
  });
});
