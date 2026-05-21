// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HIDE_NON_ACTIVE_COMMENTS,
  getStoredHideNonActiveComments,
  persistHideNonActiveComments,
} from "./commentVisibility";

afterEach(() => {
  localStorage.clear();
});

describe("commentVisibility", () => {
  it("getStoredHideNonActiveComments returns false (default) when storage is empty", () => {
    expect(getStoredHideNonActiveComments()).toBe(false);
  });

  it("getStoredHideNonActiveComments returns false (default) when storage holds garbage", () => {
    localStorage.setItem("shippable:hide-non-active-comments", "invalid-value");
    expect(getStoredHideNonActiveComments()).toBe(false);
  });

  it("round-trips true after persistHideNonActiveComments(true)", () => {
    persistHideNonActiveComments(true);
    expect(getStoredHideNonActiveComments()).toBe(true);
  });

  it("round-trips false after persistHideNonActiveComments(false)", () => {
    persistHideNonActiveComments(false);
    expect(getStoredHideNonActiveComments()).toBe(false);
  });

  it("DEFAULT_HIDE_NON_ACTIVE_COMMENTS is false", () => {
    expect(DEFAULT_HIDE_NON_ACTIVE_COMMENTS).toBe(false);
  });
});
