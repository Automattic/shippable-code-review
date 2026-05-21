// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INLINE_COMMENTS,
  getStoredInlineComments,
  persistInlineComments,
} from "./inlineComments";

afterEach(() => {
  localStorage.clear();
});

describe("inlineComments", () => {
  it("getStoredInlineComments returns false (default) when storage is empty", () => {
    expect(getStoredInlineComments()).toBe(false);
  });

  it("getStoredInlineComments returns false (default) when storage holds garbage", () => {
    localStorage.setItem("shippable:inline-comments", "invalid-value");
    expect(getStoredInlineComments()).toBe(false);
  });

  it("round-trips true after persistInlineComments(true)", () => {
    persistInlineComments(true);
    expect(getStoredInlineComments()).toBe(true);
  });

  it("round-trips false after persistInlineComments(false)", () => {
    persistInlineComments(false);
    expect(getStoredInlineComments()).toBe(false);
  });

  it("DEFAULT_INLINE_COMMENTS is false", () => {
    expect(DEFAULT_INLINE_COMMENTS).toBe(false);
  });
});
