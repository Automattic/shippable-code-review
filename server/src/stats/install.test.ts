import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, resetForTests } from "../db/index.ts";
import { captureStats, type StatCapture } from "../test-helpers.ts";
import { getSetting } from "./settings.ts";
import { installId, recordInstallStats } from "./install.ts";

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
});

afterEach(() => {
  resetForTests();
});

describe("installId", () => {
  it("generates and persists a UUID on first call", () => {
    const id = installId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(getSetting("install_id")).toBe(id);
  });

  it("returns the same value on later calls", () => {
    expect(installId()).toBe(installId());
  });

  it("returns the stored id when the row already exists", () => {
    const first = installId();
    // A later read — stateless, so it must come back from the DB row.
    expect(installId()).toBe(first);
  });
});

describe("recordInstallStats", () => {
  let stats: StatCapture;

  beforeEach(() => {
    stats = captureStats();
  });

  afterEach(() => {
    stats.restore();
  });

  it("fires install-new and install-active once each on first startup", () => {
    recordInstallStats();

    expect(stats.names().filter((n) => n === "install-new")).toHaveLength(1);
    expect(stats.names().filter((n) => n === "install-active")).toHaveLength(1);
  });

  it("fires neither again on a second startup the same day", () => {
    recordInstallStats();
    stats.calls.length = 0;
    recordInstallStats();

    expect(stats.calls).toEqual([]);
  });
});
