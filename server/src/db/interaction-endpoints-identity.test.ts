import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, resetForTests } from "./index.ts";
import { handleInteractionsUpsert } from "./interaction-endpoints.ts";
import { getInteractionsByChangeset } from "./interaction-store.ts";
import { attachRequestIdentity } from "../identity.ts";

// Handler-level tests for the POST /api/interactions author_id wiring.
// Deliberately bypasses the HTTP server (startTestServer hangs in this
// sandbox — it can't bind a port) and instead builds the minimal req/res
// surface handleInteractionsUpsert actually touches: a readable body stream
// for readJson, and a writeHead/end/setHeader stub for writeJson.
//
// getRequestIdentity(req) is keyed by req object identity (a WeakMap in
// identity.ts) — attachRequestIdentity must be called on the exact object
// passed to the handler, or lookups silently return null.

function makeReq(body: unknown): IncomingMessage {
  return Readable.from([
    Buffer.from(JSON.stringify(body)),
  ]) as unknown as IncomingMessage;
}

function makeRes(): {
  res: ServerResponse;
  status: () => number;
  json: () => any;
} {
  let status = 0;
  let bodyStr = "";
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: string) => {
      if (chunk) bodyStr = chunk;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, json: () => JSON.parse(bodyStr) };
}

function makeInteractionBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "ix-identity-1",
    changesetId: "cs-identity",
    target: "line",
    intent: "comment",
    author: "alice",
    authorRole: "user",
    body: "looks good",
    ...overrides,
  };
}

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
});

afterEach(() => {
  resetForTests();
});

describe("handleInteractionsUpsert — author_id wiring", () => {
  it("stamps author_id from the request identity when present", async () => {
    const req = makeReq(makeInteractionBody({ id: "ix-with-identity" }));
    attachRequestIdentity(req, { userId: "u-romina", role: "human" });
    const { res, status } = makeRes();

    await handleInteractionsUpsert(req, res, null);

    expect(status()).toBe(200);
    const [row] = getInteractionsByChangeset("cs-identity");
    expect(row.authorId).toBe("u-romina");
  });

  it("leaves author_id null when the request carries no identity", async () => {
    const req = makeReq(makeInteractionBody({ id: "ix-no-identity" }));
    // No attachRequestIdentity call — mirrors a request with no auth headers.
    const { res, status } = makeRes();

    await handleInteractionsUpsert(req, res, null);

    expect(status()).toBe(200);
    const [row] = getInteractionsByChangeset("cs-identity");
    expect(row.authorId).toBeNull();
  });

  it("ignores a client-supplied authorId in the body — identity is server-resolved only", async () => {
    const req = makeReq(
      makeInteractionBody({ id: "ix-spoofed", authorId: "someone-else" }),
    );
    // No identity attached for this request.
    const { res, status } = makeRes();

    await handleInteractionsUpsert(req, res, null);

    expect(status()).toBe(200);
    const [row] = getInteractionsByChangeset("cs-identity");
    expect(row.authorId).toBeNull();
  });
});
