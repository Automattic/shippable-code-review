// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHOW_INSPECTOR,
  getStoredShowInspector,
  persistShowInspector,
} from "./inspectorVisibility";

afterEach(() => {
  localStorage.clear();
});

describe("inspectorVisibility", () => {
  it("getStoredShowInspector returns true (default) when storage is empty", () => {
    expect(getStoredShowInspector()).toBe(true);
  });

  it("getStoredShowInspector returns true (default) when storage holds garbage", () => {
    localStorage.setItem("shippable:show-inspector", "invalid-value");
    expect(getStoredShowInspector()).toBe(true);
  });

  it("round-trips true after persistShowInspector(true)", () => {
    persistShowInspector(true);
    expect(getStoredShowInspector()).toBe(true);
  });

  it("round-trips false after persistShowInspector(false)", () => {
    persistShowInspector(false);
    expect(getStoredShowInspector()).toBe(false);
  });

  it("DEFAULT_SHOW_INSPECTOR is true", () => {
    expect(DEFAULT_SHOW_INSPECTOR).toBe(true);
  });
});
