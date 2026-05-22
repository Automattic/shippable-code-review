// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildSnapshot, loadSession, peekSession, saveSession } from "./persist";
import { initialState } from "./state";
import type { ChangeSet, DiffFile, DiffLine, Hunk, ReviewState } from "./types";

const STORAGE_KEY = "shippable:review:v1";

function makeLines(n: number): DiffLine[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "context" as const,
    text: `l${i}`,
    oldNo: i + 1,
    newNo: i + 1,
  }));
}
function makeHunk(id: string, n = 3): Hunk {
  return {
    id,
    header: `@@ -1,${n} +1,${n} @@`,
    oldStart: 1,
    oldCount: n,
    newStart: 1,
    newCount: n,
    lines: makeLines(n),
  };
}
function makeFile(id: string, hunks: Hunk[]): DiffFile {
  return { id, path: `${id}.ts`, language: "ts", status: "modified", hunks };
}
function makeChangeset(): ChangeSet {
  return {
    id: "cs1",
    title: "cs1",
    author: "tester",
    branch: "head",
    base: "base",
    createdAt: "2026-04-30T00:00:00.000Z",
    description: "",
    files: [makeFile("cs1/f1", [makeHunk("cs1/f1#h1")])],
  };
}

afterEach(() => {
  localStorage.clear();
});

describe("persist v5 — snapshot shape only contains progress fields", () => {
  it("buildSnapshot serializes cursor, readLines, reviewedFiles, reviewedChangesets, dismissedGuides, drafts (no interactions)", () => {
    const cs = makeChangeset();
    const state = initialState([cs]);
    const snap = buildSnapshot(state, { "some:key": "draft text" });

    expect(snap.v).toBe(7);
    expect(snap.cursor).toEqual(state.cursor);
    expect(snap.readLines).toBeDefined();
    expect(snap.reviewedFiles).toBeDefined();
    expect(snap.reviewedChangesets).toBeDefined();
    expect(snap.dismissedGuides).toBeDefined();
    expect(snap.drafts).toEqual({ "some:key": "draft text" });
    // No interaction fields
    expect("interactions" in snap).toBe(false);
    expect("detachedInteractions" in snap).toBe(false);
  });

  it("round-trips cursor, readLines, reviewedFiles, dismissedGuides, drafts", () => {
    const cs = makeChangeset();
    const state = {
      ...initialState([cs]),
      reviewedFiles: new Set(["cs1/f1"]),
      dismissedGuides: new Set(["guide-a"]),
      readLines: { "cs1/f1#h1": new Set([0, 1, 2]) },
    };
    const draftKey = "note:cs1/f1#h1:0";
    saveSession(state, { [draftKey]: "my draft" });

    const hydrated = loadSession([cs]);
    expect(hydrated.state).not.toBeNull();
    expect(hydrated.state!.reviewedFiles).toEqual(new Set(["cs1/f1"]));
    expect(hydrated.state!.dismissedGuides).toEqual(new Set(["guide-a"]));
    expect(hydrated.state!.readLines["cs1/f1#h1"]).toEqual(new Set([0, 1, 2]));
    expect(hydrated.drafts).toEqual({ [draftKey]: "my draft" });
  });

  it("hydrated state has no interactions or detachedInteractions fields", () => {
    const cs = makeChangeset();
    saveSession(initialState([cs]), {});

    const hydrated = loadSession([cs]);
    expect(hydrated.state).not.toBeNull();
    expect("interactions" in hydrated.state!).toBe(false);
    expect("detachedInteractions" in hydrated.state!).toBe(false);
  });
});

describe("persist v5 — fails closed on non-v5 snapshots", () => {
  it("peekSession returns null for v < 5 (old v3 snapshot)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 3,
        cursor: { changesetId: "cs", fileId: "f", hunkId: "h", lineIdx: 0 },
        readLines: {},
        reviewedFiles: [],
        dismissedGuides: [],
        interactions: {},
        detachedInteractions: [],
        drafts: {},
      }),
    );
    expect(peekSession()).toBeNull();
  });

  it("loadSession returns empty hydration for a v3 snapshot (old format rejected)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 3,
        cursor: { changesetId: "cs1", fileId: "cs1/f1", hunkId: "cs1/f1#h1", lineIdx: 0 },
        readLines: {},
        reviewedFiles: [],
        dismissedGuides: [],
        interactions: {},
        detachedInteractions: [],
        drafts: {},
      }),
    );
    expect(loadSession([])).toEqual({ state: null, drafts: {} });
  });

  it("loadSession returns empty hydration for a v4 snapshot (predates reviewedChangesets)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 4,
        cursor: { changesetId: "cs", fileId: "f", hunkId: "h", lineIdx: 0 },
        readLines: {},
        reviewedFiles: [],
        dismissedGuides: [],
        drafts: {},
      }),
    );
    expect(loadSession([])).toEqual({ state: null, drafts: {} });
  });

  it("loadSession returns empty hydration for v > 5", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 999,
        cursor: { changesetId: "cs", fileId: "f", hunkId: "h", lineIdx: 0 },
        readLines: {},
        reviewedFiles: [],
        dismissedGuides: [],
        drafts: {},
      }),
    );
    expect(loadSession([])).toEqual({ state: null, drafts: {} });
  });

  it("loadSession returns empty hydration for malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{ not json");
    expect(loadSession([])).toEqual({ state: null, drafts: {} });
  });
});

describe("persist v5 — hunk-validity filtering for drafts", () => {
  it("drops drafts whose hunkId no longer exists in the loaded changeset", () => {
    const cs = makeChangeset();
    const state = initialState([cs]);
    saveSession(state, {
      "note:cs1/f1#h1:0": "keep me",
      "note:cs1/f1#deleted:0": "drop me",
    });

    const hydrated = loadSession([cs]);
    expect(hydrated.drafts).toEqual({ "note:cs1/f1#h1:0": "keep me" });
  });
});

describe("persist v5 — empty / unusable changeset boot path", () => {
  // Repro for the blank-screen crash: a clean worktree reload produced a
  // ChangeSet with `files: []`, recents persisted it, the next boot rehydrated
  // it, and defaultCursor crashed reading `files[0].hunks[0]`.
  it("returns empty hydration when the only changeset has no files", () => {
    const emptyCs: ChangeSet = {
      id: "wt-clean",
      title: "empty changeset",
      author: "tester",
      branch: "head",
      base: "base",
      createdAt: "2026-05-13T00:00:00.000Z",
      description: "",
      files: [],
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 7,
        cursor: { changesetId: "wt-clean", fileId: "x", hunkId: "y", lineIdx: 0 },
        readLines: {},
        reviewedFiles: [],
        reviewedChangesets: {},
        dismissedGuides: [],
        drafts: {},
        quiz: { questions: {}, answers: {}, active: null, asked: [] },
      }),
    );

    expect(() => loadSession([emptyCs])).not.toThrow();
    expect(loadSession([emptyCs])).toEqual({ state: null, drafts: {} });
  });

  it("returns empty hydration when the only file has no hunks", () => {
    const cs: ChangeSet = {
      ...makeChangeset(),
      files: [
        { id: "cs1/f1", path: "cs1/f1.ts", language: "ts", status: "modified", hunks: [] },
      ],
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 7,
        cursor: { changesetId: "cs1", fileId: "cs1/f1", hunkId: "missing", lineIdx: 0 },
        readLines: {},
        reviewedFiles: [],
        reviewedChangesets: {},
        dismissedGuides: [],
        drafts: {},
        quiz: { questions: {}, answers: {}, active: null, asked: [] },
      }),
    );

    expect(() => loadSession([cs])).not.toThrow();
    expect(loadSession([cs])).toEqual({ state: null, drafts: {} });
  });
});

describe("v:7 quiz persistence", () => {
  it("round-trips the quiz slice", () => {
    const cs: ChangeSet = {
      id: "cs-1", title: "x", description: "", branch: "f", base: "main", author: "u",
      createdAt: "2026-01-01T00:00:00Z",
      files: [{
        id: "cs-1/a.ts", path: "a.ts", language: "ts", status: "modified",
        hunks: [{ id: "h-a-1", header: "@@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] }],
      }],
    } as ChangeSet;
    const state = initialState([cs], {});
    const stateWithQuiz: ReviewState = {
      ...state,
      quiz: {
        questions: {
          "cs-1": [
            { id: "q-1", type: "q1", target: { kind: "file", path: "a.ts" },
              prompt: "what?", claudeAnswer: "answer" },
          ],
        },
        answers: {
          "q-1": { answer: "my take", submittedAt: 123, selfEval: "got_it" },
        },
        active: null,
        asked: ["q-1"],
      },
    };
    const snap = buildSnapshot(stateWithQuiz, {});
    expect(snap.v).toBe(7);
    const wire = JSON.parse(JSON.stringify(snap));
    localStorage.setItem("shippable:review:v1", JSON.stringify(wire));
    const hydrated = loadSession([cs]);
    expect(hydrated.state).not.toBeNull();
    expect(hydrated.state!.quiz).toEqual(stateWithQuiz.quiz);
    localStorage.clear();
  });

  it("boots empty when snapshot is v:6", () => {
    localStorage.setItem(
      "shippable:review:v1",
      JSON.stringify({ v: 6, cursor: {}, readLines: {}, reviewedFiles: [],
        reviewedChangesets: {}, dismissedGuides: [], drafts: {},
        quiz: { questions: {}, answers: {}, active: null, lastQuizAt: null, asked: [] } }),
    );
    const hydrated = loadSession([]);
    expect(hydrated.state).toBeNull();
    localStorage.clear();
  });

  it("rejects a snapshot with a malformed quiz blob", () => {
    // A v:7 snapshot is otherwise valid but quiz is missing inner fields.
    // The reducer would crash on first read of quiz.questions / quiz.asked,
    // so isPersistedSnapshot must reject before we hand it back.
    localStorage.setItem(
      "shippable:review:v1",
      JSON.stringify({
        v: 7, cursor: {}, readLines: {}, reviewedFiles: [],
        reviewedChangesets: {}, dismissedGuides: [], drafts: {}, quiz: {},
      }),
    );
    const hydrated = loadSession([]);
    expect(hydrated.state).toBeNull();
    localStorage.clear();
  });
});
