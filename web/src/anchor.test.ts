import { describe, expect, it } from "vitest";
import {
  buildReplyAnchor,
  captureAnchorContext,
  findAnchorInFile,
  hashAnchorWindow,
} from "./anchor";
import {
  blockCommentKey,
  lineNoteReplyKey,
  mintCommentId,
  userCommentKey,
} from "./types";
import type { ChangeSet, DiffLine, Hunk } from "./types";

function lines(...texts: string[]): DiffLine[] {
  return texts.map((text, i) => ({
    kind: "context" as const,
    text,
    oldNo: i + 1,
    newNo: i + 1,
  }));
}

function makeHunk(id: string, body: DiffLine[]): Hunk {
  return {
    id,
    header: `@@ ${id} @@`,
    oldStart: 1,
    oldCount: body.length,
    newStart: 1,
    newCount: body.length,
    lines: body,
  };
}

function makeChangeSet(hunkId: string, body: DiffLine[]): ChangeSet {
  return {
    id: "cs-1",
    title: "t",
    author: "a",
    branch: "feature",
    base: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "",
    files: [
      {
        id: "f0",
        path: "src/widget.ts",
        language: "ts",
        status: "modified",
        hunks: [makeHunk(hunkId, body)],
      },
    ],
    worktreeSource: {
      worktreePath: "/tmp/wt",
      commitSha: "abc1234",
      branch: "feature",
      dirty: false,
    },
  };
}

describe("hashAnchorWindow", () => {
  it("is deterministic for the same window content", () => {
    const ls = lines("a", "b", "c", "d", "e", "f", "g");
    expect(hashAnchorWindow(ls, 3)).toBe(hashAnchorWindow(ls.slice(), 3));
  });

  it("produces different hashes for different windows", () => {
    const ls = lines("a", "b", "c", "d", "e", "f", "g");
    expect(hashAnchorWindow(ls, 2)).not.toBe(hashAnchorWindow(ls, 3));
  });

  it("treats out-of-bounds lines as empty padding (stable near edges)", () => {
    const ls = lines("a", "b", "c");
    // Center 0 reaches indices -2..2 → ['', '', a, b, c]
    expect(hashAnchorWindow(ls, 0)).toBe(hashAnchorWindow([...ls, ...lines("d", "e")], 0));
  });

  it("incorporates line kind so an add line doesn't collide with a context line", () => {
    const ctx = lines("x", "y", "anchor", "z", "w");
    const withAdd: DiffLine[] = ctx.map((l, i) =>
      i === 2 ? { ...l, kind: "add" } : l,
    );
    expect(hashAnchorWindow(ctx, 2)).not.toBe(hashAnchorWindow(withAdd, 2));
  });
});

describe("captureAnchorContext", () => {
  it("captures up to 10 lines centered on the anchor", () => {
    const ls = lines("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11");
    const { context } = captureAnchorContext(ls, 6);
    expect(context.map((l) => l.text)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
    ]);
  });

  it("clips at the start of the hunk without padding", () => {
    const ls = lines("0", "1", "2");
    const { context } = captureAnchorContext(ls, 0);
    expect(context.map((l) => l.text)).toEqual(["0", "1", "2"]);
  });

  it("returns the same hash hashAnchorWindow does", () => {
    const ls = lines("a", "b", "c", "d", "e");
    const cap = captureAnchorContext(ls, 2);
    expect(cap.hash).toBe(hashAnchorWindow(ls, 2));
  });
});

describe("findAnchorInFile", () => {
  it("finds a match at the preferred position when hash still agrees", () => {
    const ls = lines("a", "b", "anchor", "c", "d");
    const target = hashAnchorWindow(ls, 2);
    const hunks: Hunk[] = [makeHunk("h1", ls)];
    expect(
      findAnchorInFile(hunks, target, { hunkIdx: 0, lineIdx: 2 }),
    ).toEqual({ hunkIdx: 0, lineIdx: 2 });
  });

  it("re-anchors elsewhere when the preferred line was rewritten", () => {
    const original = lines("a", "b", "anchor", "c", "d");
    const target = hashAnchorWindow(original, 2);
    // Same content moved by two lines (e.g. a few unrelated lines added above).
    const shifted = lines("noise1", "noise2", "a", "b", "anchor", "c", "d");
    const hunks: Hunk[] = [makeHunk("h1", shifted)];
    expect(
      findAnchorInFile(hunks, target, { hunkIdx: 0, lineIdx: 2 }),
    ).toEqual({ hunkIdx: 0, lineIdx: 4 });
  });

  it("returns null when no window matches", () => {
    const original = lines("a", "b", "anchor", "c", "d");
    const target = hashAnchorWindow(original, 2);
    const rewritten = lines("totally", "different", "lines", "now", "here");
    const hunks: Hunk[] = [makeHunk("h1", rewritten)];
    expect(findAnchorInFile(hunks, target)).toBeNull();
  });

  it("walks every hunk in order until it finds a match", () => {
    const target = hashAnchorWindow(lines("p", "q", "r", "s", "t"), 2);
    const hunks: Hunk[] = [
      makeHunk("h1", lines("a", "b", "c", "d", "e")),
      makeHunk("h2", lines("p", "q", "r", "s", "t")),
    ];
    expect(findAnchorInFile(hunks, target)).toEqual({
      hunkIdx: 1,
      lineIdx: 2,
    });
  });
});

describe("buildReplyAnchor", () => {
  const body = lines("a", "b", "anchor", "c", "d", "e", "f");
  const cs = makeChangeSet("h1", body);

  it("resolves the anchor for a per-comment line key (userCommentKey)", () => {
    const key = userCommentKey("h1", 2, mintCommentId());
    const anchor = buildReplyAnchor(key, cs);
    expect(anchor.anchorPath).toBe("src/widget.ts");
    expect(anchor.anchorLineNo).toBe(3);
  });

  it("resolves the anchor for a per-comment block key (blockCommentKey)", () => {
    const key = blockCommentKey("h1", 1, 3, mintCommentId());
    const anchor = buildReplyAnchor(key, cs);
    expect(anchor.anchorPath).toBe("src/widget.ts");
    expect(anchor.anchorLineNo).toBe(2);
  });

  it("still resolves a legacy note reply key", () => {
    const anchor = buildReplyAnchor(lineNoteReplyKey("h1", 2), cs);
    expect(anchor.anchorPath).toBe("src/widget.ts");
    expect(anchor.anchorLineNo).toBe(3);
  });

  it("returns an empty object when the hunk is absent from the changeset", () => {
    const anchor = buildReplyAnchor(userCommentKey("missing", 2, mintCommentId()), cs);
    expect(anchor).toEqual({});
  });
});
