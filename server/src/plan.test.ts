import { describe, expect, it } from "vitest";

import { assemblePlan, buildUserMessage, elideReason } from "./plan.ts";
import { buildStructureMap } from "../../web/src/plan.ts";
import type {
  ChangeSet,
  DiffFile,
  Hunk,
  StructureMap,
} from "../../web/src/types.ts";

describe("elideReason", () => {
  it("elides known lockfiles by basename, anywhere in the tree", () => {
    expect(elideReason("package-lock.json")).toBe("auto-generated lockfile");
    expect(elideReason("apps/web/package-lock.json")).toBe(
      "auto-generated lockfile",
    );
    expect(elideReason("yarn.lock")).toBe("auto-generated lockfile");
    expect(elideReason("Cargo.lock")).toBe("auto-generated lockfile");
    expect(elideReason("go.sum")).toBe("auto-generated lockfile");
  });

  it("elides files with common binary extensions, case-insensitive", () => {
    expect(elideReason("docs/diagram.png")).toBe("binary (.png)");
    expect(elideReason("ICON.PNG")).toBe("binary (.png)");
    expect(elideReason("fonts/inter.woff2")).toBe("binary (.woff2)");
  });

  it("returns null for normal source files", () => {
    expect(elideReason("src/index.ts")).toBeNull();
    expect(elideReason("README.md")).toBeNull();
    expect(elideReason("package.json")).toBeNull();
    expect(elideReason("Cargo.toml")).toBeNull();
  });

  it("does not match lockfile-like names that aren't the exact basename", () => {
    // Guard against an over-eager substring/regex match.
    expect(elideReason("src/package-lock-utils.ts")).toBeNull();
    expect(elideReason("docs/yarn.lock.md")).toBeNull();
  });
});

// A small, deterministic ChangeSet exercising both kinds of symbols
// (exported + non-exported) and a real-looking diff section. Used as the
// fixture for the byte-budget snapshot below.
function fixtureChangeSet(): ChangeSet {
  const hunk = (
    id: string,
    addedLines: string[],
    defines: string[],
    exported: string[],
    references: string[] = [],
  ): Hunk => ({
    id,
    header: `@@ ${id} @@`,
    oldStart: 1,
    oldCount: 0,
    newStart: 1,
    newCount: addedLines.length,
    lines: addedLines.map((text) => ({ kind: "add" as const, text })),
    definesSymbols: defines,
    exportedSymbols: exported,
    referencesSymbols: references,
  });
  const file = (path: string, hunks: Hunk[]): DiffFile => ({
    id: `fixture/${path}`,
    path,
    language: "ts",
    status: "added",
    hunks,
  });
  return {
    id: "fixture",
    title: "Add Api helpers and internal math",
    author: "test",
    branch: "feat/fixture",
    base: "main",
    createdAt: "2026-05-14T00:00:00Z",
    description: "Adds the Api surface for consumers plus internal helpers.",
    files: [
      file("api.ts", [
        hunk(
          "api.ts#h1",
          [
            "export interface Api {",
            "  fetch(id: string): Promise<Result>;",
            "}",
            "export interface Result { value: number }",
            "export function ApiHelper(api: Api) {",
            "  return api;",
            "}",
            "function internalUsed() { return 1 }",
            "function internalUnused() { return 2 }",
          ],
          ["Api", "Result", "ApiHelper", "internalUsed", "internalUnused"],
          ["Api", "Result", "ApiHelper"],
        ),
      ]),
      file("math.ts", [
        hunk(
          "math.ts#h1",
          [
            "function mathHelper(n: number) { return n * 2 }",
            "function scratchA() { return 0 }",
            "function scratchB() { return 0 }",
          ],
          ["mathHelper", "scratchA", "scratchB"],
          [],
        ),
      ]),
      file("consumer.ts", [
        hunk(
          "consumer.ts#h1",
          [
            "import { Api } from './api';",
            "export function use(api: Api) {",
            "  return mathHelper(internalUsed());",
            "}",
          ],
          ["use"],
          ["use"],
          ["Api", "mathHelper", "internalUsed"],
        ),
      ]),
    ],
  };
}

describe("buildUserMessage byte budget", () => {
  it("matches the recorded byte count for the fixture", () => {
    const cs = fixtureChangeSet();
    const map = buildStructureMap(cs);
    const message = buildUserMessage(cs, map);

    // Inline snapshot pins the byte count for a fixed input. It fails when
    // the prompt payload grows (or shrinks) unintentionally. If the change
    // is intentional — e.g., you added a useful new section to the map —
    // re-run vitest with `-u` to record the new number alongside the change.
    expect(message.length).toMatchInlineSnapshot(`2219`);
  });

  it("drops non-exported zero-ref symbols from the serialised map section", () => {
    const cs = fixtureChangeSet();
    const map = buildStructureMap(cs);
    const message = buildUserMessage(cs, map);

    const structureSection = message.slice(
      message.indexOf("## StructureMap"),
      message.indexOf("## Diff"),
    );
    expect(structureSection).toContain("Api");
    expect(structureSection).toContain("mathHelper");
    expect(structureSection).not.toContain("internalUnused");
    expect(structureSection).not.toContain("scratchA");
    expect(structureSection).not.toContain("scratchB");
  });
});

describe("assemblePlan question validation", () => {
  const cs = {
    id: "cs-1",
    title: "x",
    description: "d",
    branch: "f",
    base: "main",
    author: "u",
    files: [
      {
        id: "cs-1/a.ts",
        path: "a.ts",
        language: "ts",
        status: "modified",
        hunks: [
          {
            id: "h-a-1",
            header: "@@",
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            lines: [],
          },
        ],
      },
    ],
  } as unknown as ChangeSet;
  const map: StructureMap = {
    files: [
      {
        fileId: "cs-1/a.ts",
        path: "a.ts",
        status: "modified",
        added: 1,
        removed: 0,
        isTest: false,
      },
    ],
    symbols: [
      { name: "foo", definedIn: "a.ts", referencedIn: [], exported: true },
    ],
  };

  it("keeps resolvable questions across all target kinds", () => {
    const parsed = {
      intent: [],
      entryPoints: [],
      questions: [
        {
          id: "q-1",
          type: "q1" as const,
          target: { kind: "file" as const, path: "a.ts" },
          prompt: "what?",
          claudeAnswer: "answer",
        },
        {
          id: "q-2",
          type: "q2" as const,
          target: { kind: "hunk" as const, hunkId: "h-a-1" },
          prompt: "what if?",
          claudeAnswer: "...",
        },
        {
          id: "q-3",
          type: "q1" as const,
          target: { kind: "symbol" as const, name: "foo", definedIn: "a.ts" },
          prompt: "what does foo do?",
          claudeAnswer: "...",
        },
      ],
    };
    const result = assemblePlan(cs, map, parsed);
    expect(result.questions.map((q) => q.id)).toEqual(["q-1", "q-2", "q-3"]);
  });

  it("drops unresolvable questions and keeps the rest", () => {
    const parsed = {
      intent: [],
      entryPoints: [],
      questions: [
        {
          id: "q-good",
          type: "q1" as const,
          target: { kind: "file" as const, path: "a.ts" },
          prompt: "p",
          claudeAnswer: "a",
        },
        {
          id: "q-bad-path",
          type: "q1" as const,
          target: { kind: "file" as const, path: "ghost.ts" },
          prompt: "p",
          claudeAnswer: "a",
        },
        {
          id: "q-bad-hunk",
          type: "q2" as const,
          target: { kind: "hunk" as const, hunkId: "h-ghost" },
          prompt: "p",
          claudeAnswer: "a",
        },
        {
          id: "q-bad-sym",
          type: "q1" as const,
          target: { kind: "symbol" as const, name: "ghost", definedIn: "a.ts" },
          prompt: "p",
          claudeAnswer: "a",
        },
      ],
    };
    const result = assemblePlan(cs, map, parsed);
    expect(result.questions.map((q) => q.id)).toEqual(["q-good"]);
  });

  it("returns an empty array when every question is unresolvable", () => {
    const parsed = {
      intent: [],
      entryPoints: [],
      questions: [
        {
          id: "q-bad",
          type: "q1" as const,
          target: { kind: "file" as const, path: "ghost.ts" },
          prompt: "p",
          claudeAnswer: "a",
        },
      ],
    };
    const result = assemblePlan(cs, map, parsed);
    expect(result.questions).toEqual([]);
  });

  it("always accepts changeset-target questions", () => {
    const parsed = {
      intent: [],
      entryPoints: [],
      questions: [
        {
          id: "q-cs",
          type: "q1" as const,
          target: { kind: "changeset" as const },
          prompt: "p",
          claudeAnswer: "a",
        },
      ],
    };
    const result = assemblePlan(cs, map, parsed);
    expect(result.questions.map((q) => q.id)).toEqual(["q-cs"]);
  });
});
