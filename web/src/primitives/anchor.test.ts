import { describe, expect, it } from "vitest";
import { isInteractionAnchor, resolveRootAnchor, type Anchor } from "./anchor";

describe("Anchor", () => {
  it("isInteractionAnchor narrows only the interaction variant", () => {
    const reply: Anchor = { type: "interaction", interactionId: "i1" };
    const block: Anchor = {
      type: "block", file: "a.ts", lo: 3, hi: 3,
      origin: { type: "committed", sha: "abc" },
    };
    expect(isInteractionAnchor(reply)).toBe(true);
    expect(isInteractionAnchor(block)).toBe(false);
  });

  it("a single line is a block with lo === hi", () => {
    const line: Anchor = {
      type: "block", file: "a.ts", lo: 7, hi: 7,
      origin: { type: "dirty", hash: "fnv", context: [] },
    };
    expect(line.type === "block" && line.lo === line.hi).toBe(true);
  });

  it("changeset anchor carries no payload", () => {
    // @ts-expect-error — changeset variant has no file field
    const bad: Anchor = { type: "changeset", file: "a.ts" };
    void bad;
  });
});

describe("resolveRootAnchor", () => {
  const root: Anchor = { type: "file", file: "a.ts" };
  // i1 roots on a file; i2 replies to i1; i3 replies to i2
  const i1: Anchor = root;
  const i2: Anchor = { type: "interaction", interactionId: "i1" };
  const i3: Anchor = { type: "interaction", interactionId: "i2" };
  const anchors: Record<string, Anchor> = {
    i1,
    i2,
    i3,
  };
  const lookup = (id: string): Anchor | undefined => anchors[id];

  it("returns a code/changeset anchor unchanged", () => {
    expect(resolveRootAnchor(root, lookup)).toEqual(root);
  });

  it("walks a multi-level reply chain to the root", () => {
    expect(resolveRootAnchor(i3, lookup)).toEqual(root);
  });

  it("throws on a broken chain (missing parent)", () => {
    const orphan: Anchor = { type: "interaction", interactionId: "missing" };
    expect(() => resolveRootAnchor(orphan, lookup)).toThrow();
  });

  it("throws on a cyclic chain instead of looping", () => {
    const cyclic: Record<string, Anchor> = {
      a: { type: "interaction", interactionId: "b" },
      b: { type: "interaction", interactionId: "a" },
    };
    expect(() =>
      resolveRootAnchor({ type: "interaction", interactionId: "a" }, (id) => cyclic[id]),
    ).toThrow(/cycle/);
  });
});
