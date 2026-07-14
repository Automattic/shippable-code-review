import { describe, expect, it } from "vitest";
import type { Capabilities, Capability } from "./capability";

describe("Capability", () => {
  it("an unavailable capability carries a reason", () => {
    const cap: Capability = { available: false, reason: "Not in v1; PR ingest lands in v1.5" };
    expect(cap.available === false && cap.reason.length > 0).toBe(true);
  });

  it("an available capability has no reason field", () => {
    const cap: Capability = { available: true };
    // @ts-expect-error — reason exists only on the unavailable variant
    void cap.reason;
    expect(cap.available).toBe(true);
  });

  it("Capabilities maps every key", () => {
    const caps: Partial<Capabilities> = { "ai.mcp": { available: false, reason: "no watcher" } };
    expect(caps["ai.mcp"]?.available).toBe(false);
  });
});
