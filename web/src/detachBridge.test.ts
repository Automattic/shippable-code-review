// Unit tests for the parent-side detach bridge. The hook itself is
// tightly bound to React state + Tauri's event bus; here we cover the
// pieces that are pure functions of the snapshot shape:
//
//   - `buildSidebarViewModel` is deterministic — same inputs produce
//     structurally-identical output. This is the load-bearing assumption
//     behind the bridge's "don't emit on identity churn" gate.
//   - The full snapshot survives a JSON round-trip with no loss. The
//     Tauri event bus serialises payloads, so any Map/Set/Symbol/function
//     hiding in the snapshot would silently turn into {} on the wire.
//
// Action routing through the Tauri event bus is a one-line `switch` —
// covered by the manual UI exercise per the plan.

import { describe, expect, it } from "vitest";
import type { DiffFile, DiffLine, Cursor, Interaction } from "./types";
import { buildInspectorViewModel, buildSidebarViewModel } from "./view";
import type {
  InspectorSnapshot,
  SidebarSnapshot,
} from "./detachBridge";
import type { PromptRunView } from "./components/PromptRunsPanel";
import type { SymbolIndex } from "./symbols";

const files = [
  {
    id: "f-a",
    path: "src/a.ts",
    status: "modified" as const,
    hunks: [{ id: "cs/src/a.ts#h1", lines: [] }],
  },
  {
    id: "f-b",
    path: "src/b.ts",
    status: "added" as const,
    hunks: [{ id: "cs/src/b.ts#h1", lines: [] }],
  },
];

const interactions: Record<string, Interaction[]> = {};

function makeSnapshot(wide: boolean, runs: PromptRunView[]): SidebarSnapshot {
  return {
    viewModel: buildSidebarViewModel({
      files,
      currentFileId: "f-a",
      readLines: {},
      reviewedFiles: new Set(),
      interactions,
    }),
    runs,
    wide,
  };
}

describe("detach bridge — sidebar snapshot stability", () => {
  it("buildSidebarViewModel is deterministic for identical inputs", () => {
    const a = buildSidebarViewModel({
      files,
      currentFileId: "f-a",
      readLines: {},
      reviewedFiles: new Set(),
      interactions,
    });
    const b = buildSidebarViewModel({
      files,
      currentFileId: "f-a",
      readLines: {},
      reviewedFiles: new Set(),
      interactions,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("structural equality survives a JSON round-trip", () => {
    const snap = makeSnapshot(false, [
      { id: "r1", promptName: "x", text: "", status: "streaming" },
    ]);
    const wire = JSON.parse(JSON.stringify(snap));
    expect(wire).toEqual(snap);
  });

  it("differs when content differs (wide toggle)", () => {
    const a = makeSnapshot(false, []);
    const b = makeSnapshot(true, []);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("differs when runs change", () => {
    const a = makeSnapshot(false, []);
    const b = makeSnapshot(false, [
      { id: "r1", promptName: "x", text: "", status: "done" },
    ]);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

// ── Inspector snapshot stability ──────────────────────────────────────────

const inspectorLine: DiffLine = {
  kind: "context",
  text: "const x = 1;",
  oldNo: 1,
  newNo: 1,
};

const inspectorFile: DiffFile = {
  id: "f-i",
  path: "src/i.ts",
  language: "ts",
  status: "modified",
  hunks: [
    {
      id: "cs/src/i.ts#h1",
      header: "@@",
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [inspectorLine],
    },
  ],
};

const inspectorCursor: Cursor = {
  changesetId: "cs",
  fileId: "f-i",
  hunkId: "cs/src/i.ts#h1",
  lineIdx: 0,
};

const emptySymbols: SymbolIndex = new Map();

function makeInspectorSnapshot(
  draftingKey: string | null,
  commentCount: number,
): InspectorSnapshot {
  return {
    viewModel: buildInspectorViewModel({
      file: inspectorFile,
      hunk: inspectorFile.hunks[0],
      line: inspectorLine,
      cursor: inspectorCursor,
      symbols: emptySymbols,
      acked: new Set(),
      replies: {},
      draftingKey,
    }),
    commentCount,
    lineHasAiNote: false,
    agentContext: null,
  };
}

describe("detach bridge — inspector snapshot stability", () => {
  it("buildInspectorViewModel is deterministic for identical inputs", () => {
    const a = makeInspectorSnapshot(null, 0);
    const b = makeInspectorSnapshot(null, 0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("survives a JSON round-trip", () => {
    const snap = makeInspectorSnapshot(null, 3);
    const wire = JSON.parse(JSON.stringify(snap));
    expect(wire).toEqual(snap);
  });

  it("differs when commentCount changes", () => {
    const a = makeInspectorSnapshot(null, 0);
    const b = makeInspectorSnapshot(null, 1);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("differs when draftingKey changes (viewModel.isDrafting flips)", () => {
    const userKey = "user:cs/src/i.ts#h1:0";
    const a = makeInspectorSnapshot(null, 0);
    const b = makeInspectorSnapshot(userKey, 0);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});
