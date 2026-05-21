import { describe, expect, it } from "vitest";
import {
  blockCommentKey,
  blockFileCommentKey,
  mintCommentId,
  parseReplyKey,
  userCommentKey,
  userFileCommentKey,
} from "./types";

describe("thread-key helpers", () => {
  it("userCommentKey carries the id segment", () => {
    expect(userCommentKey("h", 4, "abc")).toBe("user:h:4:abc");
  });

  it("blockCommentKey carries the id segment", () => {
    expect(blockCommentKey("h", 3, 7, "abc")).toBe("block:h:3-7:abc");
  });

  it("mintCommentId returns distinct values on successive calls", () => {
    const ids = new Set([mintCommentId(), mintCommentId(), mintCommentId()]);
    expect(ids.size).toBe(3);
  });
});

describe("parseReplyKey", () => {
  it("parses note:hunkId:lineIdx", () => {
    expect(parseReplyKey("note:h1:3")).toEqual({
      kind: "note",
      hunkId: "h1",
      lineIdx: 3,
    });
  });

  it("parses user:hunkId:lineIdx:id", () => {
    expect(parseReplyKey("user:h:4:abc")).toEqual({
      kind: "user",
      hunkId: "h",
      lineIdx: 4,
      id: "abc",
    });
  });

  it("parses block:hunkId:lo-hi:id and exposes lineIdx=lo", () => {
    expect(parseReplyKey("block:pr:gh:o:r:9:3-7:abc")).toEqual({
      kind: "block",
      hunkId: "pr:gh:o:r:9",
      lo: 3,
      hi: 7,
      lineIdx: 3,
      id: "abc",
    });
  });

  it("parses hunkSummary:hunkId", () => {
    expect(parseReplyKey("hunkSummary:h1")).toEqual({
      kind: "hunkSummary",
      hunkId: "h1",
      lineIdx: 0,
    });
  });

  it("parses teammate:hunkId", () => {
    expect(parseReplyKey("teammate:h1")).toEqual({
      kind: "teammate",
      hunkId: "h1",
      lineIdx: 0,
    });
  });

  it("returns null for malformed input", () => {
    expect(parseReplyKey("bogus")).toBeNull();
    expect(parseReplyKey("note:")).toBeNull();
    expect(parseReplyKey("user:h:4")).toBeNull();
    expect(parseReplyKey("block:h:3-7")).toBeNull();
  });

  it("preserves colons inside the hunk id (PR csIds carry them)", () => {
    expect(parseReplyKey("note:pr:github.com:foo:bar:42#h1:3")).toEqual({
      kind: "note",
      hunkId: "pr:github.com:foo:bar:42#h1",
      lineIdx: 3,
    });
  });

  it("round-trips user/block keys built by the helpers", () => {
    const u = userCommentKey("pr:gh:o:r:9#h1", 12, "xyz");
    expect(parseReplyKey(u)).toEqual({
      kind: "user",
      hunkId: "pr:gh:o:r:9#h1",
      lineIdx: 12,
      id: "xyz",
    });
    const b = blockCommentKey("pr:gh:o:r:9#h1", 2, 5, "qrs");
    expect(parseReplyKey(b)).toEqual({
      kind: "block",
      hunkId: "pr:gh:o:r:9#h1",
      lo: 2,
      hi: 5,
      lineIdx: 2,
      id: "qrs",
    });
  });
});

describe("userFileCommentKey + blockFileCommentKey", () => {
  it("round-trips userFile:fileId:newNo through parseReplyKey", () => {
    const key = userFileCommentKey("f1", 42);
    expect(key).toBe("userFile:f1:42");
    expect(parseReplyKey(key)).toEqual({
      kind: "userFile",
      fileId: "f1",
      newNo: 42,
      lineIdx: 0,
    });
  });

  it("round-trips blockFile:fileId:lo-hi through parseReplyKey", () => {
    const key = blockFileCommentKey("f1", 12, 18);
    expect(key).toBe("blockFile:f1:12-18");
    expect(parseReplyKey(key)).toEqual({
      kind: "blockFile",
      fileId: "f1",
      lo: 12,
      hi: 18,
      lineIdx: 0,
    });
  });

  it("preserves colons inside fileId (PR-shaped ids)", () => {
    const fileId = "pr:github.com:foo:bar:42#path/to/file.ts";
    expect(parseReplyKey(userFileCommentKey(fileId, 7))).toEqual({
      kind: "userFile",
      fileId,
      newNo: 7,
      lineIdx: 0,
    });
    expect(parseReplyKey(blockFileCommentKey(fileId, 3, 9))).toEqual({
      kind: "blockFile",
      fileId,
      lo: 3,
      hi: 9,
      lineIdx: 0,
    });
  });

  it("returns null for malformed file-line keys", () => {
    expect(parseReplyKey("userFile:")).toBeNull();
    expect(parseReplyKey("userFile:f1")).toBeNull();
    expect(parseReplyKey("userFile:f1:abc")).toBeNull();
    expect(parseReplyKey("blockFile:f1:5")).toBeNull();
    expect(parseReplyKey("blockFile:f1:5-abc")).toBeNull();
  });
});
