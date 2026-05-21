import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, resetForTests } from "../db/index.ts";
import { grantConsent, resetConsentForTests } from "./consent.ts";
import {
  recordStat,
  recordStatOnce,
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

let log: RecordingSink;
let mc: RecordingSink;

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
  resetConsentForTests();
  log = new RecordingSink();
  mc = new RecordingSink();
  setStatSinksForTests(log, mc);
});

afterEach(() => {
  resetForTests();
  resetConsentForTests();
  resetStatSinksForTests();
});

describe("recordStat routing", () => {
  it("routes to the log sink while consent is undecided", () => {
    recordStat("review-started");
    expect(log.calls).toEqual([{ name: "review-started", count: 1 }]);
    expect(mc.calls).toEqual([]);
  });

  it("routes to the MC sink once consent is granted", () => {
    grantConsent();
    recordStat("review-started");
    expect(mc.calls).toEqual([{ name: "review-started", count: 1 }]);
    expect(log.calls).toEqual([]);
  });

  it("flips routing live when consent is granted mid-session", () => {
    recordStat("review-started");
    grantConsent();
    recordStat("review-completed");
    expect(log.calls).toEqual([{ name: "review-started", count: 1 }]);
    expect(mc.calls).toEqual([{ name: "review-completed", count: 1 }]);
  });

  it("never throws when the sink throws", () => {
    const boom: StatSink = {
      record() {
        throw new Error("sink down");
      },
    };
    setStatSinksForTests(boom, boom);
    expect(() => recordStat("review-started")).not.toThrow();
  });
});

describe("recordStatOnce", () => {
  it("records the first call and ignores a repeat of the same key", () => {
    recordStatOnce("review-started", "cs-1");
    recordStatOnce("review-started", "cs-1");
    expect(log.calls).toEqual([{ name: "review-started", count: 1 }]);
  });

  it("records distinct keys separately", () => {
    recordStatOnce("review-started", "cs-1");
    recordStatOnce("review-started", "cs-2");
    expect(log.calls).toHaveLength(2);
  });
});
