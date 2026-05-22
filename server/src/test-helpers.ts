import type { Server } from "node:http";
import { vi } from "vitest";

import { initDb } from "./db/index.ts";

// Shared scaffolding for server tests. The integration tier from
// docs/plans/test-strategy.md — boot a real createApp() in-process — without
// each test file hand-rolling listen()/address() boilerplate.

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Boots createApp() on an ephemeral loopback port with a fresh in-memory DB. */
export async function startTestServer(): Promise<TestServer> {
  // Imported lazily so test files that only need captureStats don't pull in
  // index.ts (and its @anthropic-ai/sdk import) at module-eval time, which
  // would race a hoisted vi.mock of the SDK.
  const { createApp } = await import("./index.ts");
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
  const server: Server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

export interface StatCapture {
  /** Stat bumps observed on the LogSink, in order. */
  calls: Array<{ name: string; count: number }>;
  names: () => string[];
  restore: () => void;
}

/**
 * Spies `console.log` and collects LogSink bumps — the real-sink way to assert
 * a stat fired, with no test-only injection in production code. Use with
 * undecided consent (the default) so `recordStat` routes to the LogSink;
 * call `restore()` in an afterEach.
 */
export function captureStats(): StatCapture {
  const calls: Array<{ name: string; count: number }> = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    const m = /^\[stat] (\S+) \+(\d+)$/.exec(String(args[0]));
    if (m) calls.push({ name: m[1], count: Number(m[2]) });
  });
  return {
    calls,
    names: () => calls.map((c) => c.name),
    restore: () => spy.mockRestore(),
  };
}
