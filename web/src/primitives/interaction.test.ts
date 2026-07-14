import { describe, expect, it } from "vitest";
import type { AgentInteraction, Interaction } from "./interaction";

describe("Interaction", () => {
  it("a base human interaction has no AI-only fields", () => {
    const i: Interaction = {
      id: "i1", changesetId: "cs1",
      anchor: { type: "file", file: "a.ts" },
      authorId: "u1", intent: "comment", body: "looks off",
      createdAt: "t0", updatedAt: "t0",
    };
    // @ts-expect-error — checks is not on the base Interaction
    void i.checks;
    expect(i.intent).toBe("comment");
  });

  it("an AgentInteraction requires checks and rationale", () => {
    const a: AgentInteraction = {
      id: "i2", changesetId: "cs1",
      anchor: { type: "block", file: "a.ts", lo: 1, hi: 1, origin: { type: "committed", sha: "s" } },
      authorId: "ai1", intent: "blocker", body: "null deref",
      createdAt: "t0", updatedAt: "t0",
      checks: {
        "reproduced": { result: "yes", note: "x" },
        "tests-run": { result: "yes", note: "x" },
        "tests-pass": { result: "no", note: "x" },
        "traced-the-code": { result: "yes", note: "x" },
        "confirmed-by-second-agent": { result: "no", note: "x" },
      },
      rationale: "decode returns null on empty token",
    };
    expect(a.rationale).toContain("decode");
  });
});
