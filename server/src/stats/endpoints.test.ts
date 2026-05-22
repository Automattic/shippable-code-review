import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetForTests } from "../db/index.ts";
import {
  captureStats,
  startTestServer,
  type StatCapture,
  type TestServer,
} from "../test-helpers.ts";

// Integration tier: real createApp() via startTestServer. Consent defaults to
// undecided, so recorded stats land on the LogSink and are read back through
// the captured console.

let ts: TestServer;
let stats: StatCapture;

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  ts = await startTestServer();
  stats = captureStats();
});

afterEach(async () => {
  stats.restore();
  await ts.close();
  resetForTests();
});

describe("POST /api/stats/event", () => {
  it("accepts a known web-reportable stat with 204 and records it", async () => {
    const res = await post(`${ts.baseUrl}/api/stats/event`, {
      name: "review-completed",
    });
    expect(res.status).toBe(204);
    expect(stats.calls).toEqual([{ name: "review-completed", count: 1 }]);
  });

  it("rejects an unknown stat name with 400", async () => {
    const res = await post(`${ts.baseUrl}/api/stats/event`, { name: "bogus" });
    expect(res.status).toBe(400);
    expect(stats.calls).toEqual([]);
  });

  it("rejects a server-side stat name with 400 — the web cannot forge it", async () => {
    const res = await post(`${ts.baseUrl}/api/stats/event`, {
      name: "comment-posted-user",
    });
    expect(res.status).toBe(400);
    expect(stats.calls).toEqual([]);
  });

  it("dedupes by dedupKey — a repeat is 204 with no extra count", async () => {
    const first = await post(`${ts.baseUrl}/api/stats/event`, {
      name: "review-started",
      dedupKey: "cs-1",
    });
    const second = await post(`${ts.baseUrl}/api/stats/event`, {
      name: "review-started",
      dedupKey: "cs-1",
    });
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(stats.calls).toEqual([{ name: "review-started", count: 1 }]);
  });
});

describe("/api/stats/consent", () => {
  it("defaults to undecided", async () => {
    const res = await fetch(`${ts.baseUrl}/api/stats/consent`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consent: "undecided" });
  });

  it("persists a granted consent and reflects it on the next GET", async () => {
    const set = await post(`${ts.baseUrl}/api/stats/consent`, {
      consent: "granted",
    });
    expect(set.status).toBe(204);

    const get = await fetch(`${ts.baseUrl}/api/stats/consent`);
    expect(await get.json()).toEqual({ consent: "granted" });
  });

  it("rejects an invalid consent value with 400", async () => {
    const res = await post(`${ts.baseUrl}/api/stats/consent`, {
      consent: "denied",
    });
    expect(res.status).toBe(400);
  });
});
