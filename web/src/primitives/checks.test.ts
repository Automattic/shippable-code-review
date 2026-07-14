import { describe, expect, it } from "vitest";
import { CHECK_KEYS, isCompleteChecks, type Checks } from "./checks";

const complete: Checks = {
  "reproduced": { result: "yes", note: "auth.test.ts:42 throws" },
  "tests-run": { result: "yes", note: "npm test -- auth" },
  "tests-pass": { result: "no", note: "3 failures after the change" },
  "traced-the-code": { result: "yes", note: "validateToken -> null deref" },
  "confirmed-by-second-agent": { result: "no", note: "no second agent consulted" },
};

describe("Checks", () => {
  it("CHECK_KEYS lists all five labels", () => {
    expect([...CHECK_KEYS].sort()).toEqual(
      ["confirmed-by-second-agent", "reproduced", "tests-pass", "tests-run", "traced-the-code"],
    );
  });

  it("accepts a complete rubric", () => {
    expect(isCompleteChecks(complete)).toBe(true);
  });

  it("rejects a missing label", () => {
    const { "tests-pass": _omit, ...partial } = complete;
    void _omit;
    expect(isCompleteChecks(partial)).toBe(false);
  });

  it("rejects an empty note even when result is yes", () => {
    const bad = { ...complete, "reproduced": { result: "yes", note: "" } };
    expect(isCompleteChecks(bad)).toBe(false);
  });

  it("a Checks literal missing a key does not compile", () => {
    // @ts-expect-error — Record<CheckKey,…> requires every key
    const missing: Checks = { "reproduced": { result: "yes", note: "x" } };
    void missing;
  });
});
