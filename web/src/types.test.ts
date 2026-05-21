import { describe, expect, it } from "vitest";
import { parseReplyKey, userFileCommentKey, blockFileCommentKey } from "./types";

describe("parseReplyKey", () => {
  it("parses note:hunkId:lineIdx", () => {
    expect(parseReplyKey("note:h1:3")).toEqual({
      kind: "note",
      hunkId: "h1",
      lineIdx: 3,
    });
  });

  it("parses user:hunkId:lineIdx", () => {
    expect(parseReplyKey("user:h1:7")).toEqual({
      kind: "user",
      hunkId: "h1",
      lineIdx: 7,
    });
  });

  it("parses block:hunkId:lo-hi and exposes lineIdx=lo", () => {
    expect(parseReplyKey("block:h1:5-9")).toEqual({
      kind: "block",
      hunkId: "h1",
      lo: 5,
      hi: 9,
      lineIdx: 5,
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
  });

  it("preserves colons inside the hunk id (PR csIds carry them)", () => {
    expect(parseReplyKey("note:pr:github.com:foo:bar:42#h1:3")).toEqual({
      kind: "note",
      hunkId: "pr:github.com:foo:bar:42#h1",
      lineIdx: 3,
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
