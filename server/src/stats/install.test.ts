import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, resetForTests } from "../db/index.ts";
import { getSetting } from "./settings.ts";
import { installId, recordInstallStats } from "./install.ts";
import {
  resetStatSinksForTests,
  setStatSinksForTests,
} from "./record.ts";
import type { StatSink } from "./sink.ts";

class RecordingSink implements StatSink {
  calls: Array<{ name: string; count: number }> = [];
  record(name: string, count: number): void {
    this.calls.push({ name, count });
  }
}

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
});

afterEach(() => {
  resetForTests();
  resetStatSinksForTests();
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
  it("fires install-new and install-active once each on first startup", () => {
    const sink = new RecordingSink();
    setStatSinksForTests(sink, sink);

    recordInstallStats();

    const names = sink.calls.map((c) => c.name);
    expect(names.filter((n) => n === "install-new")).toHaveLength(1);
    expect(names.filter((n) => n === "install-active")).toHaveLength(1);
  });

  it("fires neither again on a second startup the same day", () => {
    const sink = new RecordingSink();
    setStatSinksForTests(sink, sink);

    recordInstallStats();
    sink.calls.length = 0;
    recordInstallStats();

    expect(sink.calls).toEqual([]);
  });
});
