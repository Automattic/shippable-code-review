import { describe, it, expect } from "vitest";
import { eligibleQuestionsForFile, pickRandomQuestion } from "./quiz";
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

describe("pickRandomQuestion", () => {
  it("picks deterministically given an rng", () => {
    const qs = [q("q-1", { kind: "changeset" }), q("q-2", { kind: "changeset" }), q("q-3", { kind: "changeset" })];
    expect(pickRandomQuestion(qs, () => 0)?.id).toBe("q-1");
    expect(pickRandomQuestion(qs, () => 0.5)?.id).toBe("q-2");
    expect(pickRandomQuestion(qs, () => 0.99)?.id).toBe("q-3");
  });

  it("returns null when given an empty array", () => {
    expect(pickRandomQuestion([], Math.random)).toBeNull();
  });
});
