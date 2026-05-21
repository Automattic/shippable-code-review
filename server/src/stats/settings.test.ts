import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, resetForTests } from "../db/index.ts";
import { getSetting, setSetting } from "./settings.ts";

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
});

afterEach(() => {
  resetForTests();
});

describe("settings store", () => {
  it("returns undefined for an absent key", () => {
    expect(getSetting("missing")).toBeUndefined();
  });

  it("round-trips a value", () => {
    setSetting("foo", "bar");
    expect(getSetting("foo")).toBe("bar");
  });

  it("overwrites an existing key", () => {
    setSetting("foo", "one");
    setSetting("foo", "two");
    expect(getSetting("foo")).toBe("two");
  });
});
