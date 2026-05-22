import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

import { initDb, resetForTests } from "./db/index.ts";
import { captureStats, type StatCapture } from "./test-helpers.ts";

// streamReview reads the Anthropic credential and constructs the SDK client.
// Stub both so the test exercises the stat wiring without a network call.
vi.mock("./auth/store.ts", () => ({
  getCredential: () => "sk-test",
}));

class MockAnthropic {
  messages = {
    stream: () =>
      (async function* () {
        yield {
          type: "message_start",
          message: { usage: { input_tokens: 5, output_tokens: 0 } },
        };
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "looks good" },
        };
        yield {
          type: "message_delta",
          usage: { output_tokens: 3 },
          delta: { stop_reason: "end_turn" },
        };
      })(),
  };
}

vi.mock("@anthropic-ai/sdk", () => ({ default: MockAnthropic }));

function mockRes(): ServerResponse {
  const res = new EventEmitter() as unknown as ServerResponse & {
    writableEnded: boolean;
    destroyed: boolean;
  };
  res.setHeader = (() => res) as ServerResponse["setHeader"];
  res.writeHead = (() => res) as ServerResponse["writeHead"];
  res.flushHeaders = () => {};
  res.write = (() => true) as ServerResponse["write"];
  res.writableEnded = false;
  res.destroyed = false;
  res.end = (() => {
    res.writableEnded = true;
    return res;
  }) as ServerResponse["end"];
  return res;
}

// Consent defaults to undecided, so recorded stats land on the LogSink and are
// read back through the captured console.
let stats: StatCapture;

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
  stats = captureStats();
});

afterEach(() => {
  stats.restore();
  resetForTests();
  vi.restoreAllMocks();
});

describe("streamReview stats", () => {
  it("records ai-review-request and comment-posted-ai on a completed stream", async () => {
    const { streamReview } = await import("./review.ts");
    await streamReview(
      JSON.stringify({ text: "review this" }),
      {} as IncomingMessage,
      mockRes(),
    );
    expect(stats.names()).toContain("ai-review-request");
    expect(stats.names()).toContain("comment-posted-ai");
  });

  it("records ai-review-request but not comment-posted-ai on an invalid body", async () => {
    const { streamReview } = await import("./review.ts");
    await streamReview("not json", {} as IncomingMessage, mockRes());
    expect(stats.names()).toContain("ai-review-request");
    expect(stats.names()).not.toContain("comment-posted-ai");
  });
});
