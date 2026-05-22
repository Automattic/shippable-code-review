import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, resetForTests } from "../db/index.ts";
import { consentGranted, grantConsent } from "./consent.ts";
import { getSetting, setSetting } from "./settings.ts";

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
});

afterEach(() => {
  resetForTests();
});

describe("consent", () => {
  it("defaults to not granted", () => {
    expect(consentGranted()).toBe(false);
  });

  it("grantConsent persists the row and reads back as granted", () => {
    grantConsent();
    expect(consentGranted()).toBe(true);
    expect(getSetting("stats_mc_consent")).toBe("granted");
  });

  it("reflects a granted row written straight through the settings store", () => {
    setSetting("stats_mc_consent", "granted");
    expect(consentGranted()).toBe(true);
  });
});
