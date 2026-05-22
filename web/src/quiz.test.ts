import { describe, it, expect } from "vitest";
import {
  eligibleQuestionsForFile,
  pickNextForFile,
  pickNextForChangeset,
} from "./quiz";
import type { ChangeSet, Question, QuestionTarget } from "./types";

function q(id: string, target: QuestionTarget): Question {
  return { id, type: "q1", target, prompt: "p", claudeAnswer: "c" };
}

const fileA = {
  id: "cs-1/a.ts",
  path: "a.ts",
  language: "ts",
  status: "modified" as const,
  hunks: [{ id: "h-a-1", header: "@@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] }],
};
const fileB = {
  id: "cs-1/b.ts",
  path: "b.ts",
  language: "ts",
  status: "modified" as const,
  hunks: [{ id: "h-b-1", header: "@@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] }],
};
const cs: ChangeSet = {
  id: "cs-1",
  title: "x",
  description: "",
  branch: "f",
  base: "main",
  createdAt: "2026-01-01T00:00:00Z",
  author: "u",
  files: [fileA, fileB],
};

describe("eligibleQuestionsForFile", () => {
  it("matches by file path", () => {
    const all = [
      q("q-file-a", { kind: "file", path: "a.ts" }),
      q("q-file-b", { kind: "file", path: "b.ts" }),
    ];
    expect(eligibleQuestionsForFile(all, cs, fileA.id, []).map((x) => x.id)).toEqual(["q-file-a"]);
  });

  it("matches by hunk id within the file", () => {
    const all = [
      q("q-hunk", { kind: "hunk", hunkId: "h-a-1" }),
      q("q-other", { kind: "hunk", hunkId: "h-b-1" }),
    ];
    expect(eligibleQuestionsForFile(all, cs, fileA.id, []).map((x) => x.id)).toEqual(["q-hunk"]);
  });

  it("matches by symbol definedIn path", () => {
    const all = [q("q-sym", { kind: "symbol", name: "foo", definedIn: "a.ts" })];
    expect(eligibleQuestionsForFile(all, cs, fileA.id, []).map((x) => x.id)).toEqual(["q-sym"]);
  });

  it("excludes changeset-target questions", () => {
    const all = [q("q-cs", { kind: "changeset" })];
    expect(eligibleQuestionsForFile(all, cs, fileA.id, [])).toEqual([]);
  });

  it("excludes questions already in `asked`", () => {
    const all = [q("q-1", { kind: "file", path: "a.ts" })];
    expect(eligibleQuestionsForFile(all, cs, fileA.id, ["q-1"])).toEqual([]);
  });
});

describe("pickNextForFile", () => {
  it("returns the head of the eligible queue in emission order", () => {
    const all = [
      q("q-file", { kind: "file", path: "a.ts" }),
      q("q-hunk", { kind: "hunk", hunkId: "h-a-1" }),
    ];
    expect(pickNextForFile(all, cs, fileA.id, [])?.id).toBe("q-file");
  });

  it("skips asked questions", () => {
    const all = [
      q("q-file", { kind: "file", path: "a.ts" }),
      q("q-hunk", { kind: "hunk", hunkId: "h-a-1" }),
    ];
    expect(pickNextForFile(all, cs, fileA.id, ["q-file"])?.id).toBe("q-hunk");
  });

  it("returns null when nothing eligible remains", () => {
    const all = [q("q-cs", { kind: "changeset" })];
    expect(pickNextForFile(all, cs, fileA.id, [])).toBeNull();
  });
});

describe("pickNextForChangeset", () => {
  it("prefers the changeset-level question first", () => {
    const all = [
      q("q-file", { kind: "file", path: "a.ts" }),
      q("q-cs", { kind: "changeset" }),
      q("q-hunk", { kind: "hunk", hunkId: "h-a-1" }),
    ];
    expect(pickNextForChangeset(all, [])?.id).toBe("q-cs");
  });

  it("falls back to the first remaining non-changeset question", () => {
    const all = [
      q("q-cs", { kind: "changeset" }),
      q("q-file", { kind: "file", path: "a.ts" }),
      q("q-hunk", { kind: "hunk", hunkId: "h-a-1" }),
    ];
    expect(pickNextForChangeset(all, ["q-cs"])?.id).toBe("q-file");
  });

  it("returns null when everything is asked", () => {
    const all = [q("q-cs", { kind: "changeset" })];
    expect(pickNextForChangeset(all, ["q-cs"])).toBeNull();
  });
});
