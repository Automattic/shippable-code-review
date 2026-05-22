import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initDb, resetForTests } from "../db/index.ts";
import { captureStats, type StatCapture } from "../test-helpers.ts";
import { grantConsent } from "./consent.ts";
import { recordStat, recordStatOnce } from "./record.ts";

// Real sinks, no injection: LogSink writes to the console (captured here) and
// McSink GETs the wp.com pixel (fetch stubbed). Consent defaults to undecided,
// so recordStat routes to the LogSink unless a test grants it.

let stats: StatCapture;

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
  stats = captureStats();
});

afterEach(() => {
  stats.restore();
  resetForTests();
  vi.unstubAllGlobals();
});

describe("recordStat routing", () => {
  it("routes to the log sink while consent is undecided", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    recordStat("review-started");

    expect(stats.calls).toEqual([{ name: "review-started", count: 1 }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes to McSink once consent is granted", () => {
    const fetchSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchSpy);

    grantConsent();
    recordStat("review-started");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(stats.calls).toEqual([]);
  });

  it("flips routing live when consent is granted mid-session", () => {
    const fetchSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchSpy);

    recordStat("review-started");
    grantConsent();
    recordStat("review-completed");

    expect(stats.calls).toEqual([{ name: "review-started", count: 1 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never throws when the sink throws", () => {
    // LogSink writes via console.log — make that throw to drive the failure.
    stats.restore();
    const boom = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink down");
    });
    expect(() => recordStat("review-started")).not.toThrow();
    boom.mockRestore();
  });
});

describe("recordStatOnce", () => {
  it("records the first call and ignores a repeat of the same key", () => {
    recordStatOnce("review-started", "cs-1");
    recordStatOnce("review-started", "cs-1");
    expect(stats.calls).toEqual([{ name: "review-started", count: 1 }]);
  });

  it("records distinct keys separately", () => {
    recordStatOnce("review-started", "cs-1");
    recordStatOnce("review-started", "cs-2");
    expect(stats.calls).toHaveLength(2);
  });
});
