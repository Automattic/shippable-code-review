import { describe, expect, it } from "vitest";
import { isInteractionAnchor, type Anchor } from "./anchor";

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
