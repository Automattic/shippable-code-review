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

    expect(snap.v).toBe(8);
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
        v: 8,
        cursor: { changesetId: "wt-clean", fileId: "x", hunkId: "y", lineIdx: 0 },
        readLines: {},
        hunkKeys: {},
        reviewedFiles: [],
        fileKeys: {},
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
        v: 8,
        cursor: { changesetId: "cs1", fileId: "cs1/f1", hunkId: "missing", lineIdx: 0 },
        readLines: {},
        hunkKeys: {},
        reviewedFiles: [],
        fileKeys: {},
        reviewedChangesets: {},
        dismissedGuides: [],
        drafts: {},
        quiz: { questions: {}, answers: {}, active: null, asked: [] },
      }),
    );

    expect(() => loadSession([cs])).not.toThrow();
    expect(loadSession([cs])).toEqual({ state: null, drafts: {} });
  });

  it("falls back to the first hunk-bearing file when files[0] is hunkless and the persisted cursor is unresolvable", () => {
    // Same shape as the boot crash: files[0] is a binary add, files[1]
    // has real hunks. defaultCursor used to bail at `file.hunks[0]` and
    // drop the entire session; it should seat the cursor on the next
    // reviewable file instead.
    const cs: ChangeSet = {
      ...makeChangeset(),
      files: [
        { id: "cs1/img.png", path: "img.png", language: "text", status: "added", hunks: [] },
        makeFile("cs1/text.ts", [makeHunk("cs1/text.ts#h1")]),
      ],
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 8,
        cursor: { changesetId: "cs1", fileId: "cs1/gone", hunkId: "gone", lineIdx: 0 },
        readLines: {},
        hunkKeys: {},
        reviewedFiles: [],
        fileKeys: {},
        reviewedChangesets: {},
        dismissedGuides: [],
        drafts: {},
        quiz: { questions: {}, answers: {}, active: null, asked: [] },
      }),
    );

    const hydrated = loadSession([cs]);
    expect(hydrated.state).not.toBeNull();
    expect(hydrated.state?.cursor.fileId).toBe("cs1/text.ts");
    expect(hydrated.state?.cursor.hunkId).toBe("cs1/text.ts#h1");
  });
});

describe("v:8 — read-state re-keys across changeset id churn", () => {
  // Worktree edits churn the changeset id (dirty-hash based), which churns
  // every file/hunk id. The snapshot stores a content key per read hunk /
  // reviewed file so hydration can follow unchanged content to its new ids.
  function csOf(csId: string, filesTexts: Record<string, string[]>): ChangeSet {
    const files = Object.entries(filesTexts).map(([path, texts]) => ({
      id: `${csId}/${path}`,
      path,
      language: "ts",
      status: "modified" as const,
      hunks: [
        {
          id: `${csId}/${path}#h1`,
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
    }));
    return { ...makeChangeset(), id: csId, title: csId, files };
  }

  it("buildSnapshot records content keys for read hunks and reviewed files", () => {
    const cs = csOf("wt-dirty:aaa", { "a.ts": ["a1", "a2", "a3"] });
    const state = {
      ...initialState([cs]),
      readLines: { "wt-dirty:aaa/a.ts#h1": new Set([0, 1]) },
      reviewedFiles: new Set(["wt-dirty:aaa/a.ts"]),
    };
    const snap = buildSnapshot(state, {});
    expect(snap.v).toBe(8);
    expect(snap.hunkKeys["wt-dirty:aaa/a.ts#h1"]).toMatch(/^[0-9a-f]{8}$/);
    expect(snap.fileKeys["wt-dirty:aaa/a.ts"]).toMatch(/^[0-9a-f]{8}$/);
  });

  it("re-keys readLines and reviewedFiles onto same-content hunks under new ids", () => {
    const csOld = csOf("wt-dirty:aaa", {
      "a.ts": ["a1", "a2", "a3"],
      "b.ts": ["b1", "b2", "b3"],
    });
    const state = {
      ...initialState([csOld]),
      readLines: {
        "wt-dirty:aaa/a.ts#h1": new Set([0, 1, 2]),
        "wt-dirty:aaa/b.ts#h1": new Set([0, 1, 2]),
      },
      reviewedFiles: new Set(["wt-dirty:aaa/a.ts", "wt-dirty:aaa/b.ts"]),
    };
    saveSession(state, {});

    // New load after an edit to b.ts only — new changeset id, all ids churned.
    const csNew = csOf("wt-dirty:bbb", {
      "a.ts": ["a1", "a2", "a3"],
      "b.ts": ["b1", "EDITED", "b3"],
    });
    const hydrated = loadSession([csNew]);
    expect(hydrated.state).not.toBeNull();
    expect(hydrated.state!.readLines["wt-dirty:bbb/a.ts#h1"]).toEqual(
      new Set([0, 1, 2]),
    );
    expect(hydrated.state!.readLines["wt-dirty:bbb/b.ts#h1"]).toBeUndefined();
    expect(hydrated.state!.reviewedFiles).toEqual(
      new Set(["wt-dirty:bbb/a.ts"]),
    );
  });

  it("re-keys the cursor onto the new ids when its hunk content survives", () => {
    const csOld = csOf("wt-dirty:aaa", { "a.ts": ["a1", "a2", "a3"] });
    const state = {
      ...initialState([csOld]),
      cursor: {
        changesetId: "wt-dirty:aaa",
        fileId: "wt-dirty:aaa/a.ts",
        hunkId: "wt-dirty:aaa/a.ts#h1",
        lineIdx: 2,
      },
      readLines: { "wt-dirty:aaa/a.ts#h1": new Set([0, 1, 2]) },
    };
    saveSession(state, {});

    const csNew = csOf("wt-dirty:bbb", { "a.ts": ["a1", "a2", "a3"] });
    const hydrated = loadSession([csNew]);
    expect(hydrated.state?.cursor).toEqual({
      changesetId: "wt-dirty:bbb",
      fileId: "wt-dirty:bbb/a.ts",
      hunkId: "wt-dirty:bbb/a.ts#h1",
      lineIdx: 2,
    });
  });

  it("still keeps entries whose ids match the loaded changeset directly", () => {
    const cs = csOf("cs-same", { "a.ts": ["a1", "a2"] });
    const state = {
      ...initialState([cs]),
      readLines: { "cs-same/a.ts#h1": new Set([0, 1]) },
      reviewedFiles: new Set(["cs-same/a.ts"]),
    };
    saveSession(state, {});
    const hydrated = loadSession([cs]);
    expect(hydrated.state!.readLines["cs-same/a.ts#h1"]).toEqual(new Set([0, 1]));
    expect(hydrated.state!.reviewedFiles).toEqual(new Set(["cs-same/a.ts"]));
  });
});

describe("v:8 quiz persistence", () => {
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
    expect(snap.v).toBe(8);
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
    // A v:8 snapshot is otherwise valid but quiz is missing inner fields.
    // The reducer would crash on first read of quiz.questions / quiz.asked,
    // so isPersistedSnapshot must reject before we hand it back.
    localStorage.setItem(
      "shippable:review:v1",
      JSON.stringify({
        v: 8, cursor: {}, readLines: {}, hunkKeys: {}, reviewedFiles: [],
        fileKeys: {}, reviewedChangesets: {}, dismissedGuides: [], drafts: {}, quiz: {},
      }),
    );
    const hydrated = loadSession([]);
    expect(hydrated.state).toBeNull();
    localStorage.clear();
  });
});
