import { describe, it, expect } from "vitest";
import { identityFrom } from "./identity.ts";

describe("identityFrom", () => {
  it("returns null when the id header is absent", () => {
    expect(identityFrom({})).toBeNull();
  });

  it("returns null when the id header is empty", () => {
    expect(identityFrom({ "x-shippable-user-id": "" })).toBeNull();
  });

  it("returns null when the id header is whitespace-only", () => {
    expect(identityFrom({ "x-shippable-user-id": "   " })).toBeNull();
  });

  it("returns null when the id header exceeds 128 chars", () => {
    expect(identityFrom({ "x-shippable-user-id": "a".repeat(129) })).toBeNull();
  });

  it("accepts an id header exactly 128 chars", () => {
    const id = "a".repeat(128);
    expect(identityFrom({ "x-shippable-user-id": id })).toEqual({
      userId: id,
      role: "human",
    });
  });

  it("defaults role to human when the role header is absent", () => {
    expect(identityFrom({ "x-shippable-user-id": "u1" })).toEqual({
      userId: "u1",
      role: "human",
    });
  });

  it("sets role to ai when the role header is exactly 'ai' (case-insensitive)", () => {
    expect(
      identityFrom({ "x-shippable-user-id": "u1", "x-shippable-user-role": "AI" }),
    ).toEqual({ userId: "u1", role: "ai" });
  });

  it("defaults role to human for any other role header value", () => {
    expect(
      identityFrom({ "x-shippable-user-id": "u1", "x-shippable-user-role": "bot" }),
    ).toEqual({ userId: "u1", role: "human" });
  });

  it("uses the first value when a header is an array", () => {
    expect(
      identityFrom({
        "x-shippable-user-id": ["u1", "u2"],
        "x-shippable-user-role": ["ai", "human"],
      }),
    ).toEqual({ userId: "u1", role: "ai" });
  });

  it("returns null when an array id header's first value is empty", () => {
    expect(identityFrom({ "x-shippable-user-id": ["", "u2"] })).toBeNull();
  });
});
