import { describe, expect, it } from "vitest";
import { initialState, reducer, type Action } from "./state";
import type {
  ChangeSet,
  Cursor,
  DiffFile,
  DiffLine,
  Hunk,
  ReviewState,
} from "./types";

// Invariants the review-state reducer must uphold across ANY action sequence.
// These are properties of the machine, not specific outcomes — each test loops
// many random walks (or, where exhaustive, every action variant) and checks
// the property holds at every step.
//
// Why property-style for this module: the reducer is one of the few pieces of
// shippable state where a regression would be silent — the UI keeps rendering
// against subtly broken state for many keystrokes before anyone notices. A
// targeted "after action X, cursor === Y" test guards a single transition;
// these guard the shape of every reachable state.

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeLines(n: number): DiffLine[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "context" as const,
    text: `l${i}`,
    oldNo: i + 1,
    newNo: i + 1,
  }));
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

// Two changesets with varied file/hunk/line counts so the walker exercises
// cross-hunk, cross-file, and cross-changeset movement.
function buildSeed(): ChangeSet[] {
  return [
    makeChangeset("cs1", [
      makeFile("cs1/f1", [makeHunk("cs1/f1#h1", 3), makeHunk("cs1/f1#h2", 2)]),
      makeFile("cs1/f2", [makeHunk("cs1/f2#h1", 4)]),
    ]),
    makeChangeset("cs2", [
      makeFile("cs2/f1", [makeHunk("cs2/f1#h1", 2)]),
    ]),
  ];
}

// A changeset the walker can LOAD_CHANGESET to, replacing cs1 in place.
function replacementCs1(): ChangeSet {
  return makeChangeset("cs1", [
    makeFile("cs1/f1-new", [makeHunk("cs1/f1-new#h1", 1)]),
  ]);
}

// A fresh changeset for the walker to append.
function freshCs(): ChangeSet {
  return makeChangeset("cs3", [
    makeFile("cs3/f1", [makeHunk("cs3/f1#h1", 2)]),
  ]);
}

// ── Seedable PRNG (mulberry32) ────────────────────────────────────────────
// Random walks need deterministic seeds — an intermittent failure with no
// reproducer is worse than no test at all.

function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function int(rand: () => number, lo: number, hi: number): number {
  return Math.floor(rand() * (hi - lo + 1)) + lo;
}

// ── Random action generator ───────────────────────────────────────────────
// Generates only actions the UI could plausibly dispatch — SET_CURSOR points
// at a real position, replies use known targetKeys. The reducer trusts these
// inputs (e.g. moveLine uses non-null assertions on find), so feeding garbage
// would crash for reasons unrelated to the invariants under test.

function randomCursor(rand: () => number, state: ReviewState): Cursor {
  const cs = pick(rand, state.changesets);
  const file = pick(rand, cs.files);
  const hunk = pick(rand, file.hunks);
  return {
    changesetId: cs.id,
    fileId: file.id,
    hunkId: hunk.id,
    lineIdx: int(rand, 0, hunk.lines.length - 1),
  };
}

function randomFileId(rand: () => number, state: ReviewState): string {
  const cs = pick(rand, state.changesets);
  return pick(rand, cs.files).id;
}

function randomChangesetId(rand: () => number, state: ReviewState): string {
  return pick(rand, state.changesets).id;
}

function randomHunkRef(
  rand: () => number,
  state: ReviewState,
): { hunkId: string; lineIdx: number } {
  const cs = pick(rand, state.changesets);
  const file = pick(rand, cs.files);
  const hunk = pick(rand, file.hunks);
  return { hunkId: hunk.id, lineIdx: int(rand, 0, hunk.lines.length - 1) };
}

const REPLY_KEYS = ["k1", "k2", "k3"];
const GUIDE_IDS = ["g1", "g2", "g3"];

function nextAction(rand: () => number, state: ReviewState): Action {
  const r = rand();
  // Bias toward movement — that's most of what the UI dispatches and the
  // densest source of invariant violations historically.
  if (r < 0.18) return { type: "MOVE_LINE", delta: int(rand, -4, 4) };
  if (r < 0.26)
    return { type: "MOVE_LINE", delta: int(rand, -2, 2), extend: true };
  if (r < 0.32)
    return {
      type: "MOVE_LINE",
      delta: int(rand, -2, 2),
      preserveSelection: true,
    };
  if (r < 0.4) return { type: "MOVE_HUNK", delta: int(rand, -2, 2) };
  if (r < 0.46) return { type: "MOVE_FILE", delta: int(rand, -2, 2) };
  if (r < 0.5) return { type: "COLLAPSE_SELECTION" };
  if (r < 0.56)
    return { type: "SET_CURSOR", cursor: randomCursor(rand, state) };
  if (r < 0.6)
    return { type: "SWITCH_CHANGESET", changesetId: pick(rand, state.changesets).id };
  if (r < 0.62)
    return { type: "LOAD_CHANGESET", changeset: replacementCs1() };
  if (r < 0.64)
    return { type: "LOAD_CHANGESET", changeset: freshCs() };
  if (r < 0.7) {
    const ref = randomHunkRef(rand, state);
    return { type: "TOGGLE_ACK", hunkId: ref.hunkId, lineIdx: ref.lineIdx };
  }
  if (r < 0.74)
    return { type: "DISMISS_GUIDE", guideId: pick(rand, GUIDE_IDS) };
  if (r < 0.8) {
    const targetKey = pick(rand, REPLY_KEYS);
    const interactionId = `r${int(rand, 0, 9)}`;
    return {
      type: "ADD_INTERACTION",
      targetKey,
      interaction: {
        id: interactionId,
        threadKey: targetKey,
        target: "reply",
        intent: "comment",
        author: "a",
        authorRole: "user",
        body: "x",
        createdAt: "t",
      },
    };
  }
  if (r < 0.84) {
    const targetKey = pick(rand, REPLY_KEYS);
    const interactionId = `r${int(rand, 0, 9)}`;
    return { type: "DELETE_INTERACTION", targetKey, interactionId };
  }
  if (r < 0.9) {
    const ref = randomHunkRef(rand, state);
    return {
      type: "SET_EXPAND_LEVEL",
      hunkId: ref.hunkId,
      dir: rand() < 0.5 ? "above" : "below",
      // Include negative levels so the >= 0 clamp is exercised.
      level: int(rand, -3, 5),
    };
  }
  if (r < 0.93)
    return {
      type: "TOGGLE_CHANGESET_REVIEWED",
      changesetId: randomChangesetId(rand, state),
    };
  if (r < 0.96)
    return { type: "TOGGLE_EXPAND_FILE", fileId: randomFileId(rand, state) };
  if (r < 0.98)
    return { type: "TOGGLE_PREVIEW_FILE", fileId: randomFileId(rand, state) };
  return { type: "TOGGLE_FILE_REVIEWED", fileId: randomFileId(rand, state) };
}

// ── Walker ────────────────────────────────────────────────────────────────

interface WalkContext {
  steps: number;
  prev: ReviewState;
  next: ReviewState;
  action: Action;
}

function walk(
  seed: number,
  steps: number,
  check: (ctx: WalkContext) => void,
  startState: ReviewState = initialState(buildSeed()),
): void {
  const rand = rng(seed);
  let state = startState;
  for (let i = 0; i < steps; i++) {
    const action = nextAction(rand, state);
    const next = reducer(state, action);
    try {
      check({ steps: i, prev: state, next, action });
    } catch (e) {
      // Surface which action and which seed reproduced the failure.
      const detail = `seed=${seed} step=${i} action=${JSON.stringify(action)}`;
      if (e instanceof Error) e.message = `${e.message}\n  at ${detail}`;
      throw e;
    }
    state = next;
  }
}

const SEEDS = [1, 7, 42, 1337, 99991];

// ── Invariants ────────────────────────────────────────────────────────────

describe("invariant: cursor points to an existing changeset / file / hunk / line", () => {
  // Silently breaks: subsequent moveLine/moveHunk/moveFile crash because they
  // use non-null assertions on .find(); LOAD_CHANGESET was the historic culprit.
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      walk(seed, 400, ({ next }) => {
        if (next.changesets.length === 0) return;
        const cs = next.changesets.find((c) => c.id === next.cursor.changesetId);
        expect(cs, "cursor.changesetId resolves").toBeDefined();
        const file = cs!.files.find((f) => f.id === next.cursor.fileId);
        expect(file, "cursor.fileId resolves").toBeDefined();
        const hunk = file!.hunks.find((h) => h.id === next.cursor.hunkId);
        expect(hunk, "cursor.hunkId resolves").toBeDefined();
        expect(next.cursor.lineIdx).toBeGreaterThanOrEqual(0);
        expect(next.cursor.lineIdx).toBeLessThan(hunk!.lines.length);
      });
    });
  }
});

describe("invariant: cursor's current line is recorded in readLines", () => {
  // Silently breaks: the gutter "visited" rail and coverage % stop reflecting
  // where the reviewer actually is — the read-tracking signal goes dark.
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      walk(seed, 400, ({ next }) => {
        if (next.changesets.length === 0) return;
        const seen = next.readLines[next.cursor.hunkId];
        expect(seen, "readLines has an entry for the cursor's hunk").toBeDefined();
        expect(seen!.has(next.cursor.lineIdx)).toBe(true);
      });
    });
  }
});

describe("invariant: readLines is monotonic — never loses a key or a line", () => {
  // Silently breaks: scrolling away from a hunk un-reads it; coverage
  // oscillates; "I already saw this" memory becomes unreliable mid-session.
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      walk(seed, 400, ({ prev, next }) => {
        for (const [hunkId, prevSet] of Object.entries(prev.readLines)) {
          const nextSet = next.readLines[hunkId];
          expect(nextSet, `key ${hunkId} retained`).toBeDefined();
          for (const idx of prevSet) {
            expect(nextSet!.has(idx), `line ${hunkId}:${idx} retained`).toBe(true);
          }
        }
      });
    });
  }
});

describe("invariant: fullExpandedFiles and previewedFiles are mutually exclusive", () => {
  // Silently breaks: a markdown file renders twice (raw expanded + preview),
  // or the toggle that "loses" is silently ignored by the renderer.
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      walk(seed, 400, ({ next }) => {
        for (const id of next.fullExpandedFiles) {
          expect(next.previewedFiles.has(id), `${id} in both sets`).toBe(false);
        }
      });
    });
  }
});

describe("invariant: dismissedGuides is monotonic — once dismissed, always dismissed", () => {
  // Silently breaks: dismissed onboarding guides re-appear after unrelated
  // actions, eroding trust in "don't show me again" gestures.
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      walk(seed, 400, ({ prev, next }) => {
        for (const id of prev.dismissedGuides) {
          expect(next.dismissedGuides.has(id), `${id} retained`).toBe(true);
        }
      });
    });
  }
});

describe("invariant: expand levels are never negative", () => {
  // Silently breaks: a negative count flows into slice math downstream and
  // either crashes the diff renderer or shows the wrong number of context lines.
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      walk(seed, 400, ({ next }) => {
        for (const [hunkId, lvl] of Object.entries(next.expandLevelAbove)) {
          expect(lvl, `above:${hunkId}`).toBeGreaterThanOrEqual(0);
        }
        for (const [hunkId, lvl] of Object.entries(next.expandLevelBelow)) {
          expect(lvl, `below:${hunkId}`).toBeGreaterThanOrEqual(0);
        }
      });
    });
  }
});

describe("invariant: interactions has no empty thread arrays", () => {
  // Silently breaks: persisted snapshots accumulate junk targetKeys forever
  // and the inspector renders empty "0 replies" placeholders instead of
  // falling through to its empty state.
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      walk(seed, 400, ({ next }) => {
        for (const [key, list] of Object.entries(next.interactions)) {
          expect(list.length, `interactions[${key}] non-empty`).toBeGreaterThan(0);
        }
      });
    });
  }
});

describe("invariant: welcome mode (no changesets) ignores everything except LOAD_CHANGESET", () => {
  // Silently breaks: a stray dispatch on the welcome screen mutates state and
  // the next render crashes on the sentinel cursor's empty IDs (moveLine et al
  // do `cs.files.find(...)!.hunks.find(...)!` which throws on the empty cursor).
  // Exhaustive over every non-LOAD action — random walks would mostly waste
  // steps since the welcome state has no real positions to target.
  const empty = initialState([]);
  const someFile = "cs1/f1";
  const someHunk = "cs1/f1#h1";
  const someCursor: Cursor = {
    changesetId: "cs1",
    fileId: someFile,
    hunkId: someHunk,
    lineIdx: 0,
  };
  const cases: Action[] = [
    { type: "MOVE_LINE", delta: 1 },
    { type: "MOVE_LINE", delta: -1, extend: true },
    { type: "MOVE_LINE", delta: 1, preserveSelection: true },
    { type: "MOVE_HUNK", delta: 1 },
    { type: "MOVE_FILE", delta: 1 },
    { type: "COLLAPSE_SELECTION" },
    { type: "SET_CURSOR", cursor: someCursor },
    { type: "SWITCH_CHANGESET", changesetId: "cs1" },
    { type: "DISMISS_GUIDE", guideId: "g1" },
    { type: "TOGGLE_ACK", hunkId: someHunk, lineIdx: 0 },
    {
      type: "ADD_INTERACTION",
      targetKey: "k",
      interaction: {
        id: "r",
        threadKey: "k",
        target: "reply",
        intent: "comment",
        author: "a",
        authorRole: "user",
        body: "b",
        createdAt: "t",
      },
    },
    { type: "DELETE_INTERACTION", targetKey: "k", interactionId: "r" },
    { type: "SET_EXPAND_LEVEL", hunkId: someHunk, dir: "above", level: 2 },
    { type: "TOGGLE_EXPAND_FILE", fileId: someFile },
    { type: "TOGGLE_PREVIEW_FILE", fileId: someFile },
    { type: "TOGGLE_FILE_REVIEWED", fileId: someFile },
  ];
  for (const action of cases) {
    it(`${action.type} returns the same reference`, () => {
      expect(reducer(empty, action)).toBe(empty);
    });
  }
  it("LOAD_CHANGESET is the one action that escapes welcome mode", () => {
    const loaded = reducer(empty, {
      type: "LOAD_CHANGESET",
      changeset: freshCs(),
    });
    expect(loaded).not.toBe(empty);
    expect(loaded.changesets).toHaveLength(1);
  });
});
