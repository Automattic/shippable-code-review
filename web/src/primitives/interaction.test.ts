import { describe, expect, it } from "vitest";
import type { AgentInteraction, Interaction } from "./interaction";
import { validateInteractionWrite } from "./interaction";
import type { Checks } from "./checks";

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

const fullChecks: Checks = {
  "reproduced": { result: "yes", note: "x" },
  "tests-run": { result: "yes", note: "x" },
  "tests-pass": { result: "no", note: "x" },
  "traced-the-code": { result: "yes", note: "x" },
  "confirmed-by-second-agent": { result: "no", note: "x" },
};

describe("validateInteractionWrite", () => {
  it("accepts a human ask rooted on code", () => {
    expect(validateInteractionWrite({
      anchor: { type: "file", file: "a.ts" }, intent: "comment",
      role: "human", parentExists: false,
    })).toEqual({ ok: true });
  });

  it("rejects an ask anchored on an interaction", () => {
    const r = validateInteractionWrite({
      anchor: { type: "interaction", interactionId: "i1" }, intent: "blocker",
      role: "human", parentExists: true,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a response NOT anchored on an interaction", () => {
    const r = validateInteractionWrite({
      anchor: { type: "file", file: "a.ts" }, intent: "accept",
      role: "human", parentExists: false,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a reply whose parent does not exist", () => {
    const r = validateInteractionWrite({
      anchor: { type: "interaction", interactionId: "gone" }, intent: "accept",
      role: "human", parentExists: false,
    });
    expect(r.ok).toBe(false);
  });

  it("requires complete checks + rationale for ai authors", () => {
    const missing = validateInteractionWrite({
      anchor: { type: "file", file: "a.ts" }, intent: "comment",
      role: "ai", parentExists: false,
    });
    expect(missing.ok).toBe(false);
    const ok = validateInteractionWrite({
      anchor: { type: "file", file: "a.ts" }, intent: "comment",
      role: "ai", checks: fullChecks, rationale: "why", parentExists: false,
    });
    expect(ok).toEqual({ ok: true });
  });

  it("rejects AI-only fields on a human author", () => {
    const r = validateInteractionWrite({
      anchor: { type: "file", file: "a.ts" }, intent: "comment",
      role: "human", checks: fullChecks, parentExists: false,
    });
    expect(r.ok).toBe(false);
  });
});
