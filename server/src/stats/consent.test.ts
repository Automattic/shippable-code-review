import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, resetForTests } from "../db/index.ts";
import { consentGranted, grantConsent, resetConsentForTests } from "./consent.ts";
import { getSetting, setSetting } from "./settings.ts";

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
  resetConsentForTests();
});

afterEach(() => {
  resetForTests();
  resetConsentForTests();
});

describe("consent", () => {
  it("defaults to not granted", () => {
    expect(consentGranted()).toBe(false);
  });

  it("grantConsent flips the cache and persists the row", () => {
    grantConsent();
    expect(consentGranted()).toBe(true);
    expect(getSetting("stats_mc_consent")).toBe("granted");
  });

  it("restores granted from the DB after the cache is dropped", () => {
    setSetting("stats_mc_consent", "granted");
    resetConsentForTests();
    expect(consentGranted()).toBe(true);
  });
});
