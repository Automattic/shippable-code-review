import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resetForTests } from "./db/index.ts";
import { getUser } from "./db/user-store.ts";
import {
  upsertInteraction,
  listAllForWorktree,
  type StoredInteraction,
} from "./db/interaction-store.ts";
import { startTestServer, type TestServer } from "./test-helpers.ts";

const execFileAsync = promisify(execFile);

// End-to-end proof that identity headers flow through the real app:
// header -> users upsert (role from the header, not the route) -> author_id
// stamped on the interaction/reply row -> surfaced on GET. Mirrors
// db/interaction-endpoints.test.ts's socket-level style (startTestServer,
// fresh :memory: db per test); adds a throwaway git dir because
// POST /api/agent/replies validates worktreePath against a real repo.

let ts: TestServer;
let baseUrl: string;
let worktreePath: string;

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: "ix-e2e-human",
    changesetId: "cs-e2e",
    target: "line",
    intent: "comment",
    author: "romina",
    authorRole: "user",
    body: "looks good",
    ...overrides,
  };
}

function legacyRow(overrides: Partial<StoredInteraction> = {}): StoredInteraction {
  return {
    id: "ix-e2e-legacy",
    threadKey: null,
    target: "line",
    intent: "comment",
    author: "legacy",
    authorRole: "user",
    body: "pre-migration row",
    createdAt: new Date().toISOString(),
    changesetId: "cs-e2e",
    worktreePath: null,
    agentQueueStatus: null,
    authorId: null,
    payload: {},
    ...overrides,
  };
}

beforeEach(async () => {
  ts = await startTestServer();
  baseUrl = ts.baseUrl;
  worktreePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "shippable-identity-e2e-"),
  );
  await execFileAsync("git", ["init"], { cwd: worktreePath });
});

afterEach(async () => {
  await ts.close();
  resetForTests();
  await fs.rm(worktreePath, { recursive: true, force: true });
});

describe("identity flow: request headers -> users table -> author_id", () => {
  it("POST /api/interactions with X-Shippable-User-Id (no role header) upserts a human user and stamps author_id", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction(),
      { "X-Shippable-User-Id": "uuid-h" },
    );
    expect(r.status).toBe(200);

    const user = getUser("uuid-h");
    expect(user?.role).toBe("human");

    const get = await getJson(
      `${baseUrl}/api/interactions?changesetId=cs-e2e`,
    );
    expect(get.body.interactions[0].authorId).toBe("uuid-h");
  });

  it("POST /api/agent/replies with id+role headers upserts an ai user and stamps author_id", async () => {
    const r = await postJson(
      `${baseUrl}/api/agent/replies`,
      {
        worktreePath,
        file: "src/foo.ts",
        lines: "10",
        target: "line",
        body: "consider extracting this",
        intent: "comment",
      },
      { "X-Shippable-User-Id": "uuid-a", "X-Shippable-User-Role": "ai" },
    );
    expect(r.status).toBe(200);

    const user = getUser("uuid-a");
    expect(user?.role).toBe("ai");

    const [row] = listAllForWorktree(worktreePath);
    expect(row.authorId).toBe("uuid-a");
  });

  it("a second request with the same id but a different role header does not flip the stored role", async () => {
    await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ id: "ix-e2e-flip", body: "first" }),
      { "X-Shippable-User-Id": "uuid-flip" },
    );
    expect(getUser("uuid-flip")?.role).toBe("human");

    await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ id: "ix-e2e-flip", body: "second" }),
      { "X-Shippable-User-Id": "uuid-flip", "X-Shippable-User-Role": "ai" },
    );
    expect(getUser("uuid-flip")?.role).toBe("human");
  });

  it("GET /api/interactions returns authorId populated for the new row and null for a row inserted directly via the store", async () => {
    await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ id: "ix-e2e-populated" }),
      { "X-Shippable-User-Id": "uuid-populated" },
    );
    upsertInteraction(legacyRow());

    const get = await getJson(
      `${baseUrl}/api/interactions?changesetId=cs-e2e`,
    );
    const populated = get.body.interactions.find(
      (i: any) => i.id === "ix-e2e-populated",
    );
    const legacy = get.body.interactions.find(
      (i: any) => i.id === "ix-e2e-legacy",
    );
    expect(populated.authorId).toBe("uuid-populated");
    expect(legacy.authorId).toBeNull();
  });
});
