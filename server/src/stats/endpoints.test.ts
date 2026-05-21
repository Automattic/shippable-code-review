import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { Server } from "node:http";

import { createApp } from "../index.ts";
import { initDb } from "../db/index.ts";
import { resetConsentForTests } from "./consent.ts";
import { resetStatSinksForTests, setStatSinksForTests } from "./record.ts";
import type { StatSink } from "./sink.ts";

class RecordingSink implements StatSink {
  calls: Array<{ name: string; count: number }> = [];
  record(name: string, count: number): void {
    this.calls.push({ name, count });
  }
}

let server: Server;
let baseUrl: string;
let sink: RecordingSink;

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
  resetConsentForTests();
  sink = new RecordingSink();
  // One sink for both roles — counts land in one place regardless of consent.
  setStatSinksForTests(sink, sink);
});

afterEach(() => {
  resetConsentForTests();
  resetStatSinksForTests();
});

describe("POST /api/stats/event", () => {
  it("accepts a known web-reportable stat with 204 and records it", async () => {
    const res = await post(`${baseUrl}/api/stats/event`, {
      name: "review-completed",
    });
    expect(res.status).toBe(204);
    expect(sink.calls).toEqual([{ name: "review-completed", count: 1 }]);
  });

  it("rejects an unknown stat name with 400", async () => {
    const res = await post(`${baseUrl}/api/stats/event`, { name: "bogus" });
    expect(res.status).toBe(400);
    expect(sink.calls).toEqual([]);
  });

  it("rejects a server-side stat name with 400 — the web cannot forge it", async () => {
    const res = await post(`${baseUrl}/api/stats/event`, {
      name: "comment-posted-user",
    });
    expect(res.status).toBe(400);
    expect(sink.calls).toEqual([]);
  });

  it("dedupes by dedupKey — a repeat is 204 with no extra count", async () => {
    const first = await post(`${baseUrl}/api/stats/event`, {
      name: "review-started",
      dedupKey: "cs-1",
    });
    const second = await post(`${baseUrl}/api/stats/event`, {
      name: "review-started",
      dedupKey: "cs-1",
    });
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(sink.calls).toEqual([{ name: "review-started", count: 1 }]);
  });
});

describe("/api/stats/consent", () => {
  it("defaults to undecided", async () => {
    const res = await fetch(`${baseUrl}/api/stats/consent`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consent: "undecided" });
  });

  it("persists a granted consent and reflects it on the next GET", async () => {
    const set = await post(`${baseUrl}/api/stats/consent`, {
      consent: "granted",
    });
    expect(set.status).toBe(204);

    const get = await fetch(`${baseUrl}/api/stats/consent`);
    expect(await get.json()).toEqual({ consent: "granted" });
  });

  it("rejects an invalid consent value with 400", async () => {
    const res = await post(`${baseUrl}/api/stats/consent`, {
      consent: "denied",
    });
    expect(res.status).toBe(400);
  });
});
