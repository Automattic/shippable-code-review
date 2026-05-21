import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
  afterEach,
} from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

const execFileAsync = promisify(execFile);

// Defensive: index.ts no longer requires ANTHROPIC_API_KEY at import time
// (the check moved into main()), but set this anyway in case future edits
// reintroduce it.
process.env.ANTHROPIC_API_KEY = "test";

let server: Server;
let baseUrl: string;
let worktreePath: string;
let initDb: (env?: NodeJS.ProcessEnv) => Promise<void>;
let resetAuthStore: () => void;
let ixSeq = 0;

/**
 * Seed a pending agent-queue entry the way the client does now: upsert a
 * review interaction (client-authoritative id), then enqueue it to a worktree.
 * Replaces the removed `/api/agent/enqueue` flow. Returns the interaction id.
 */
async function seedPending(
  wtPath: string,
  over: { body?: string; commitSha?: string } = {},
): Promise<string> {
  const id = `int-test-ix-${++ixSeq}`;
  const up = await postJson(`${baseUrl}/api/interactions`, {
    id,
    changesetId: "cs-int-test",
    target: "block",
    intent: "comment",
    author: "you",
    authorRole: "user",
    body: over.body ?? "hello",
    anchorPath: "src/foo.ts",
    anchorLineNo: 10,
    originSha: over.commitSha ?? "abc123",
  });
  if (up.status !== 200) {
    throw new Error(`seed upsert failed: ${up.status} ${JSON.stringify(up.body)}`);
  }
  const enq = await postJson(`${baseUrl}/api/interactions/enqueue`, {
    id,
    worktreePath: wtPath,
  });
  if (enq.status !== 200) {
    throw new Error(`seed enqueue failed: ${enq.status} ${JSON.stringify(enq.body)}`);
  }
  return id;
}

interface JsonResponse {
  status: number;
  // We accept any shape because each endpoint returns a different one;
  // assertions in tests narrow as needed.
  body: any;
}

async function getJson(url: string): Promise<JsonResponse> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function postJson(url: string, body: unknown): Promise<JsonResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), "shippable-int-"));
  await execFileAsync("git", ["init"], { cwd: worktreePath });

  const indexMod = await import("./index.ts");
  const dbMod = await import("./db/index.ts");
  const authMod = await import("./auth/store.ts");
  initDb = dbMod.initDb;
  resetAuthStore = authMod.resetForTests;

  server = indexMod.createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server.address() not an object");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await fs.rm(worktreePath, { recursive: true, force: true });
});

beforeEach(async () => {
  // Fresh in-memory DB per test — isolates the agent-queue + /api/interactions
  // rows that several suites below depend on.
  ixSeq = 0;
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
  resetAuthStore();
});

describe("POST /api/agent/interactions", () => {
  it("status=unread returns the formatted envelope and drains the queue", async () => {
    await seedPending(worktreePath, { commitSha: "deadbeef", body: "hello" });
    const r = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "unread",
    });
    expect(r.status).toBe(200);
    expect(r.body.payload).toMatch(/^<reviewer-feedback /);
    expect(r.body.payload).toContain('commit="deadbeef"');
    expect(r.body.payload).toContain("hello");
    expect(Array.isArray(r.body.ids)).toBe(true);
    expect(r.body.ids).toHaveLength(1);

    // Drained: a second unread read finds nothing.
    const again = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "unread",
    });
    expect(again.body.ids).toHaveLength(0);
    expect(again.body.payload).toBe("");
  });

  it("status=unread first wins: a concurrent unread read returns an empty queue", async () => {
    await seedPending(worktreePath, { body: "x" });
    const [r1, r2] = await Promise.all([
      postJson(`${baseUrl}/api/agent/interactions`, { worktreePath, status: "unread" }),
      postJson(`${baseUrl}/api/agent/interactions`, { worktreePath, status: "unread" }),
    ]);
    const nonEmpty = [r1, r2].filter((r) => r.body.ids.length > 0);
    const empty = [r1, r2].filter((r) => r.body.ids.length === 0);
    expect(nonEmpty).toHaveLength(1);
    expect(empty).toHaveLength(1);
    expect(empty[0].body.payload).toBe("");
  });

  it("status=delivered returns delivered rows, read-only", async () => {
    await seedPending(worktreePath, { body: "shipped" });
    await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "unread",
    });

    const first = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "delivered",
    });
    expect(first.status).toBe(200);
    expect(first.body.ids).toHaveLength(1);
    expect(first.body.payload).toContain("shipped");

    // Read-only — calling again returns the same row.
    const second = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "delivered",
    });
    expect(second.body.ids).toHaveLength(1);
  });

  it("status=all returns pending + delivered without draining pending", async () => {
    await seedPending(worktreePath, { body: "first" });
    await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "unread",
    }); // first → delivered
    await seedPending(worktreePath, { body: "second" }); // stays pending

    const all = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "all",
    });
    expect(all.status).toBe(200);
    expect(all.body.ids).toHaveLength(2);
    expect(all.body.payload).toContain("first");
    expect(all.body.payload).toContain("second");

    // 'all' did not ack — 'second' is still pending and drainable.
    const drained = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "unread",
    });
    expect(drained.body.ids).toHaveLength(1);
    expect(drained.body.payload).toContain("second");
  });

  it("status=all includes agent-authored replies carrying their parentId", async () => {
    const reviewerId = await seedPending(worktreePath, { body: "please fix" });
    // Drain to delivered so the reply's parentId passes the delivered check.
    await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "unread",
    });
    const reply = await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath,
      parentId: reviewerId,
      body: "fixed it",
      intent: "accept",
    });
    expect(reply.status).toBe(200);

    const all = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "all",
    });
    expect(all.status).toBe(200);
    expect(all.body.payload).toContain("fixed it");
    expect(all.body.payload).toContain(`parentId="${reviewerId}"`);
  });

  it("status=unread surfaces a reviewer reply to an agent comment with its parent", async () => {
    // Agent posts a top-level finding.
    const post = await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath,
      file: "src/foo.ts",
      lines: "10",
      target: "line",
      body: "agent finding",
      intent: "comment",
    });
    expect(post.status).toBe(200);
    const agentCommentId = post.body.id as string;

    // Reviewer replies to that agent comment — the reply carries parentId.
    const upsert = await postJson(`${baseUrl}/api/interactions`, {
      id: "rev-reply-ctx",
      changesetId: "cs-int-test",
      target: "reply",
      intent: "comment",
      author: "you",
      authorRole: "user",
      body: "thanks, will fix",
      parentId: agentCommentId,
    });
    expect(upsert.status).toBe(200);
    await postJson(`${baseUrl}/api/interactions/enqueue`, {
      id: "rev-reply-ctx",
      worktreePath,
    });

    const unread = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "unread",
    });
    expect(unread.status).toBe(200);
    // Only the reply is drained — the parent rides along read-only.
    expect(unread.body.ids).toEqual(["rev-reply-ctx"]);
    // The reply links to the agent comment, and the agent comment's text
    // is included so the agent has the context it replied to.
    expect(unread.body.payload).toContain(`parentId="${agentCommentId}"`);
    expect(unread.body.payload).toContain("thanks, will fix");
    expect(unread.body.payload).toContain("agent finding");
  });

  it("rejects a missing status", async () => {
    const r = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
    });
    expect(r.status).toBe(400);
  });

  it("rejects an invalid status", async () => {
    const r = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "bogus",
    });
    expect(r.status).toBe(400);
  });

  it("rejects a missing worktreePath", async () => {
    const r = await postJson(`${baseUrl}/api/agent/interactions`, {
      status: "unread",
    });
    expect(r.status).toBe(400);
  });

  it("rejects a non-git worktreePath", async () => {
    const r = await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath: path.join(os.tmpdir(), `shippable-not-git-${Date.now()}`),
      status: "unread",
    });
    expect(r.status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/agent/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/agent/delivered", () => {
  it("rejects requests without ?path=", async () => {
    const r = await getJson(`${baseUrl}/api/agent/delivered`);
    expect(r.status).toBe(400);
  });

  it("returns delivered comments oldest-first", async () => {
    await seedPending(worktreePath, { body: "first" });
    await postJson(`${baseUrl}/api/agent/interactions`, { worktreePath, status: "unread" });
    await seedPending(worktreePath, { body: "second" });
    await postJson(`${baseUrl}/api/agent/interactions`, { worktreePath, status: "unread" });

    const r = await getJson(
      `${baseUrl}/api/agent/delivered?path=${encodeURIComponent(worktreePath)}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.delivered).toHaveLength(2);
    expect(r.body.delivered[0].body).toBe("first");
    expect(r.body.delivered[1].body).toBe("second");
  });

  it("round-trips a worktree path containing spaces through URL encoding", async () => {
    const spacedPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "shippable test "),
    );
    try {
      await execFileAsync("git", ["init"], { cwd: spacedPath });
      await seedPending(spacedPath, { body: "spaced" });
      await postJson(`${baseUrl}/api/agent/interactions`, { worktreePath: spacedPath, status: "unread" });

      const r = await getJson(
        `${baseUrl}/api/agent/delivered?path=${encodeURIComponent(spacedPath)}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.delivered).toHaveLength(1);
      expect(r.body.delivered[0].body).toBe("spaced");
    } finally {
      await fs.rm(spacedPath, { recursive: true, force: true });
    }
  });
});

describe("legacy endpoints are gone (slice 5 cleanup)", () => {
  // The slice-1 hook + inbox channel was removed in slice 5. Hitting any of
  // the four old endpoints should fall through the router and return 404
  // rather than the prior shapes — confirms the handlers are unreachable.
  it("GET /api/worktrees/hook-status returns 404", async () => {
    const r = await getJson(`${baseUrl}/api/worktrees/hook-status`);
    expect(r.status).toBe(404);
  });

  it("POST /api/worktrees/install-hook returns 404", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/install-hook`, {});
    expect(r.status).toBe(404);
  });

  it("POST /api/worktrees/inbox returns 404", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/inbox`, {
      path: worktreePath,
      message: "x",
    });
    expect(r.status).toBe(404);
  });

  it("POST /api/worktrees/inbox-status returns 404", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/inbox-status`, {
      path: worktreePath,
    });
    expect(r.status).toBe(404);
  });
});

describe("GET /api/worktrees/mcp-status (slice 5)", () => {
  // Regardless of whether the local user has `shippable` declared in their
  // ~/.claude config, the endpoint should return the `{ installed, installCommand }`
  // shape with no error. The mcp-status helper has its own unit tests for
  // detection logic and the install-command resolver; this just confirms the
  // route is wired and returns the right shape.
  it("returns { installed: boolean; installCommand: string }", async () => {
    const r = await getJson(`${baseUrl}/api/worktrees/mcp-status`);
    expect(r.status).toBe(200);
    expect(typeof r.body.installed).toBe("boolean");
    expect(typeof r.body.installCommand).toBe("string");
    expect(r.body.installCommand).toMatch(/^claude mcp add shippable -- /);
  });
});

describe("request body size cap", () => {
  it("rejects an oversized body with HTTP 413 and a useful error", async () => {
    // ~2 MiB of JSON-safe filler. Any endpoint that consumes a body will
    // trip the cap; pick the replies POST since it's the most recently
    // added one and the security review flagged it specifically.
    const huge = "x".repeat(2 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/agent/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worktreePath,
        parentId: "anything",
        body: huge,
        intent: "ack",
      }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: string };
    expect(String(body.error)).toMatch(/exceeds.*bytes/);
  });
});

describe("POST /api/agent/replies", () => {
  it("rejects an invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/agent/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects when worktreePath is missing", async () => {
    const r = await postJson(`${baseUrl}/api/agent/replies`, {
      parentId: "c1",
      body: "x",
      intent: "accept",
    });
    expect(r.status).toBe(400);
  });

  it("rejects when worktreePath is not a git dir", async () => {
    const r = await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath: "/tmp/this-does-not-exist-xyz-456",
      parentId: "c1",
      body: "x",
      intent: "accept",
    });
    expect(r.status).toBe(400);
  });

  it("rejects an invalid intent", async () => {
    const r = await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath,
      parentId: "c1",
      body: "x",
      intent: "made-up",
    });
    expect(r.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const r = await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath,
      parentId: "c1",
      body: "",
      intent: "accept",
    });
    expect(r.status).toBe(400);
  });

  it("rejects an unknown parentId (not in delivered set for this worktree)", async () => {
    const r = await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath,
      parentId: "no-such-id",
      body: "x",
      intent: "ack",
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/not a delivered interaction/);
  });

  it("returns { id } on success and persists via GET", async () => {
    // Seed + pull to mint a real delivered parentId — the post-reply
    // endpoint validates that parentId belongs to the worktree's
    // delivered set (defensive per spec § Data Flow).
    const realCommentId = await seedPending(worktreePath, { body: "hi" });
    await postJson(`${baseUrl}/api/agent/interactions`, { worktreePath, status: "unread" });

    const r = await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath,
      parentId: realCommentId,
      body: "fixed it",
      intent: "accept",
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.id).toBe("string");
    expect(r.body.id.length).toBeGreaterThan(0);

    const list = await getJson(
      `${baseUrl}/api/agent/replies?worktreePath=${encodeURIComponent(worktreePath)}`,
    );
    expect(list.status).toBe(200);
    expect(list.body.replies).toHaveLength(1);
    expect(list.body.replies[0].id).toBe(r.body.id);
    expect(list.body.replies[0].intent).toBe("accept");
    expect(list.body.replies[0].parentId).toBe(realCommentId);
    expect(list.body.replies[0].body).toBe("fixed it");
  });

  it("appends multiple replies to the same parentId", async () => {
    const realCommentId = await seedPending(worktreePath, { body: "hi" });
    await postJson(`${baseUrl}/api/agent/interactions`, { worktreePath, status: "unread" });

    await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath,
      parentId: realCommentId,
      body: "first",
      intent: "ack",
    });
    await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath,
      parentId: realCommentId,
      body: "second",
      intent: "accept",
    });
    const list = await getJson(
      `${baseUrl}/api/agent/replies?worktreePath=${encodeURIComponent(worktreePath)}`,
    );
    expect(list.body.replies).toHaveLength(2);
    expect(list.body.replies.map((r: { body: string }) => r.body)).toEqual([
      "first",
      "second",
    ]);
  });

  it("persists the full reply list (DB-backed, no in-memory cap)", async () => {
    const realCommentId = await seedPending(worktreePath, { body: "hi" });
    await postJson(`${baseUrl}/api/agent/interactions`, { worktreePath, status: "unread" });

    for (let i = 0; i < 30; i++) {
      await postJson(`${baseUrl}/api/agent/replies`, {
        worktreePath,
        parentId: realCommentId,
        body: `reply-${i}`,
        intent: "ack",
      });
    }
    const list = await getJson(
      `${baseUrl}/api/agent/replies?worktreePath=${encodeURIComponent(worktreePath)}`,
    );
    expect(list.body.replies).toHaveLength(30);
    expect(list.body.replies[0].body).toBe("reply-0");
    expect(list.body.replies[29].body).toBe("reply-29");
  });

  it("persists rationale/suggestedFix/confidence on a top-level post", async () => {
    const r = await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath,
      target: "line",
      file: "src/a.ts",
      lines: "12",
      body: "noticed this",
      intent: "request",
      rationale: "this leaks a handle",
      suggestedFix: "close(fd)",
      confidence: "high",
    });
    expect(r.status).toBe(200);

    const list = await getJson(
      `${baseUrl}/api/agent/replies?worktreePath=${encodeURIComponent(worktreePath)}`,
    );
    expect(list.body.replies).toHaveLength(1);
    expect(list.body.replies[0].rationale).toBe("this leaks a handle");
    expect(list.body.replies[0].suggestedFix).toBe("close(fd)");
    expect(list.body.replies[0].confidence).toBe("high");
  });

  it("rejects a top-level post with an out-of-enum confidence", async () => {
    const r = await postJson(`${baseUrl}/api/agent/replies`, {
      worktreePath,
      target: "line",
      file: "src/a.ts",
      lines: "12",
      body: "noticed this",
      intent: "request",
      rationale: "matters",
      confidence: "extreme",
    });
    expect(r.status).toBe(400);
  });
});

describe("GET /api/agent/replies", () => {
  it("rejects requests without ?worktreePath=", async () => {
    const r = await getJson(`${baseUrl}/api/agent/replies`);
    expect(r.status).toBe(400);
  });

  it("rejects when worktreePath is not a git dir", async () => {
    const r = await getJson(
      `${baseUrl}/api/agent/replies?worktreePath=${encodeURIComponent("/tmp/nope-xyz")}`,
    );
    expect(r.status).toBe(400);
  });

  it("returns { replies: [] } for a worktree with none", async () => {
    const r = await getJson(
      `${baseUrl}/api/agent/replies?worktreePath=${encodeURIComponent(worktreePath)}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.replies).toEqual([]);
  });

  it("reports `watching` true only after an interactions read tagged watch:true", async () => {
    const repliesUrl = `${baseUrl}/api/agent/replies?worktreePath=${encodeURIComponent(worktreePath)}`;

    const before = await getJson(repliesUrl);
    expect(before.body.watching).toBe(false);

    await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "unread",
    });
    const afterPlain = await getJson(repliesUrl);
    expect(afterPlain.body.watching).toBe(false);

    await postJson(`${baseUrl}/api/agent/interactions`, {
      worktreePath,
      status: "unread",
      watch: true,
    });
    const afterWatch = await getJson(repliesUrl);
    expect(afterWatch.body.watching).toBe(true);
  });
});

describe("legacy /api/agent/enqueue + /api/agent/unenqueue routes are gone", () => {
  // Replaced by /api/interactions + /api/interactions/enqueue (client-
  // authoritative ids). Both old routes fall through the router to 404.
  it("POST /api/agent/enqueue returns 404", async () => {
    const r = await postJson(`${baseUrl}/api/agent/enqueue`, {
      worktreePath,
      commitSha: "abc",
      interaction: { target: "block", intent: "comment", author: "you", authorRole: "user", file: "a.ts", body: "x" },
    });
    expect(r.status).toBe(404);
  });

  it("POST /api/agent/unenqueue returns 404", async () => {
    const r = await postJson(`${baseUrl}/api/agent/unenqueue`, {
      worktreePath,
      id: "anything",
    });
    expect(r.status).toBe(404);
  });
});

describe("POST /api/worktrees/file-at", () => {
  // Spin up a dedicated worktree with one commit so `git show <sha>:<file>`
  // has something to return. Kept self-contained so the surrounding test
  // suites don't have to know about its commit history.
  let viewWtPath: string;
  let viewSha: string;

  beforeAll(async () => {
    viewWtPath = await fs.mkdtemp(path.join(os.tmpdir(), "shippable-view-"));
    await execFileAsync("git", ["init"], { cwd: viewWtPath });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: viewWtPath });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: viewWtPath });
    await fs.writeFile(path.join(viewWtPath, "src.ts"), "line1\nline2\nline3\n");
    await execFileAsync("git", ["add", "."], { cwd: viewWtPath });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: viewWtPath });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: viewWtPath,
    });
    viewSha = stdout.trim();
  });

  afterAll(async () => {
    await fs.rm(viewWtPath, { recursive: true, force: true });
  });

  it("returns the file contents at the given sha", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/file-at`, {
      path: viewWtPath,
      sha: viewSha,
      file: "src.ts",
    });
    expect(r.status).toBe(200);
    expect(r.body.content).toBe("line1\nline2\nline3\n");
  });

  it("rejects when path/sha/file is missing", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/file-at`, {
      path: viewWtPath,
      sha: viewSha,
    });
    expect(r.status).toBe(400);
  });

  it("rejects an absolute file path", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/file-at`, {
      path: viewWtPath,
      sha: viewSha,
      file: "/etc/passwd",
    });
    expect(r.status).toBe(400);
  });

  it("rejects a file path with .. segments", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/file-at`, {
      path: viewWtPath,
      sha: viewSha,
      file: "../escape.ts",
    });
    expect(r.status).toBe(400);
  });

  it("rejects a sha argument that looks like a flag", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/file-at`, {
      path: viewWtPath,
      sha: "--upload-pack",
      file: "src.ts",
    });
    expect(r.status).toBe(400);
  });
});

describe("POST /api/worktrees/commits and range changeset", () => {
  let rangeWt: string;
  let firstSha: string;
  let secondSha: string;

  beforeAll(async () => {
    rangeWt = await fs.mkdtemp(path.join(os.tmpdir(), "shippable-range-"));
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: rangeWt });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: rangeWt });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: rangeWt });
    await fs.writeFile(path.join(rangeWt, "a.txt"), "alpha\n");
    await execFileAsync("git", ["add", "."], { cwd: rangeWt });
    await execFileAsync("git", ["commit", "-m", "first"], { cwd: rangeWt });
    firstSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rangeWt }))
      .stdout.trim();
    await fs.writeFile(path.join(rangeWt, "b.txt"), "beta\n");
    await execFileAsync("git", ["add", "."], { cwd: rangeWt });
    await execFileAsync("git", ["commit", "-m", "second"], { cwd: rangeWt });
    secondSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rangeWt }))
      .stdout.trim();
  });

  afterAll(async () => {
    await fs.rm(rangeWt, { recursive: true, force: true });
  });

  it("lists recent commits newest-first", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/commits`, {
      path: rangeWt,
    });
    expect(r.status).toBe(200);
    expect(r.body.commits).toHaveLength(2);
    expect(r.body.commits[0].sha).toBe(secondSha);
    expect(r.body.commits[1].sha).toBe(firstSha);
    expect(r.body.commits[0].subject).toBe("second");
  });

  it("rejects a missing path", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/commits`, {});
    expect(r.status).toBe(400);
  });

  it("routes fromRef+toRef through rangeChangeset", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/changeset`, {
      path: rangeWt,
      fromRef: secondSha,
      toRef: secondSha,
    });
    expect(r.status).toBe(200);
    expect(r.body.diff).toContain("+++ b/b.txt");
    expect(r.body.diff).not.toContain("+++ b/a.txt");
    expect(r.body.sha).toBe(secondSha);
  });

  it("legacy { path } still hits branchChangeset (regression)", async () => {
    // No upstream/origin in this temp repo, so branchChangeset returns an
    // empty diff with parentSha=null. We just verify the call shape works.
    const r = await postJson(`${baseUrl}/api/worktrees/changeset`, {
      path: rangeWt,
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.sha).toBe("string");
  });

  it("legacy { path, ref } still hits changesetFor (regression)", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/changeset`, {
      path: rangeWt,
      ref: firstSha,
    });
    expect(r.status).toBe(200);
    expect(r.body.sha).toBe(firstSha);
    expect(r.body.diff).toContain("+++ b/a.txt");
  });

  it("legacy { path, dirty: true } still hits dirtyChangesetFor (regression)", async () => {
    const r = await postJson(`${baseUrl}/api/worktrees/changeset`, {
      path: rangeWt,
      dirty: true,
    });
    expect(r.status).toBe(200);
    // Tree is clean; dirty changeset returns the HEAD sha and an empty diff.
    expect(r.body.sha).toBe(secondSha);
  });
});

describe("POST /api/auth/set", () => {
  it("sets an anthropic credential", async () => {
    const r = await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "anthropic" },
      value: "sk-test",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("sets a github credential", async () => {
    const r = await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "github", host: "github.com" },
      value: "ghp_test",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("rejects an invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/auth/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects when credential is missing", async () => {
    const r = await postJson(`${baseUrl}/api/auth/set`, {
      value: "sk-test",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_credential");
  });

  it("rejects when value is missing", async () => {
    const r = await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "anthropic" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("missing_value");
  });

  it("rejects a blocked github host", async () => {
    const r = await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "github", host: "localhost" },
      value: "ghp_x",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("host_blocked");
  });

  it("denies requests with an opaque origin", async () => {
    const res = await fetch(`${baseUrl}/api/auth/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "null" },
      body: JSON.stringify({
        credential: { kind: "github", host: "github.com" },
        value: "tok",
      }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/auth/clear", () => {
  it("clears a stored credential", async () => {
    await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "github", host: "github.com" },
      value: "ghp_test",
    });
    const clear = await postJson(`${baseUrl}/api/auth/clear`, {
      credential: { kind: "github", host: "github.com" },
    });
    expect(clear.status).toBe(200);
    expect(clear.body.ok).toBe(true);
    const listAfter = await fetch(`${baseUrl}/api/auth/list`);
    const listJson = (await listAfter.json()) as { credentials: unknown[] };
    expect(listJson.credentials).toEqual([]);
  });

  it("is a no-op for an unset credential", async () => {
    const r = await postJson(`${baseUrl}/api/auth/clear`, {
      credential: { kind: "github", host: "unknown.example.com" },
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("rejects when credential is missing", async () => {
    const r = await postJson(`${baseUrl}/api/auth/clear`, {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_credential");
  });
});

describe("GET /api/auth/list", () => {
  it("returns an empty list initially", async () => {
    const r = await getJson(`${baseUrl}/api/auth/list`);
    expect(r.status).toBe(200);
    expect(r.body.credentials).toEqual([]);
  });

  it("returns identifiers only — never the secret values", async () => {
    await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "anthropic" },
      value: "sk-secret",
    });
    await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "github", host: "github.com" },
      value: "ghp_secret",
    });
    const r = await getJson(`${baseUrl}/api/auth/list`);
    expect(r.status).toBe(200);
    expect(r.body.credentials).toEqual([
      { kind: "anthropic" },
      { kind: "github", host: "github.com" },
    ]);
    expect(JSON.stringify(r.body)).not.toContain("secret");
  });
});

describe("legacy /api/github/auth/* routes are gone", () => {
  it.each(["set", "has", "clear"] as const)(
    "POST /api/github/auth/%s returns 404",
    async (op) => {
      const r = await postJson(`${baseUrl}/api/github/auth/${op}`, {
        host: "github.com",
        token: "ghp",
      });
      expect(r.status).toBe(404);
    },
  );
});

describe("GET /api/health", () => {
  it("returns { ok: true, db: { status: 'ok' } } when DB is healthy", async () => {
    // beforeEach already called initDb({ SHIPPABLE_DB_PATH: ":memory:" })
    const r = await getJson(`${baseUrl}/api/health`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, db: { status: "ok" } });
  });

  describe("DB error path", () => {
    afterEach(async () => {
      // Re-init with a working DB so subsequent tests are not poisoned.
      await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
    });

    it("reflects db error in /api/health when DB failed to initialise", async () => {
      // Empty env has neither SHIPPABLE_DB_PATH nor HOME, so initDb captures
      // the failure instead of throwing — same pattern as db/index.test.ts.
      await initDb({});
      const r = await getJson(`${baseUrl}/api/health`);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.db.status).toBe("error");
      expect(typeof r.body.db.error).toBe("string");
      expect(r.body.db.error.length).toBeGreaterThan(0);
    });
  });
});

describe("AI endpoints consult auth-store for anthropic key", () => {
  it("POST /api/plan returns 503 anthropic_key_missing when not configured", async () => {
    const r = await postJson(`${baseUrl}/api/plan`, {
      changeset: { id: "x", files: [] },
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("anthropic_key_missing");
  });

  it("POST /api/plan stops 503ing once the anthropic credential is set", async () => {
    const planMod = await import("./plan.ts");
    const spy = vi
      .spyOn(planMod, "generatePlan")
      .mockResolvedValue({
        plan: {
          headline: "x",
          intent: [],
          map: { files: [], symbols: [] },
          entryPoints: [],
        },
        questions: [],
      });
    try {
      await postJson(`${baseUrl}/api/auth/set`, {
        credential: { kind: "anthropic" },
        value: "sk-test",
      });
      const r = await postJson(`${baseUrl}/api/plan`, {
        changeset: { id: "x", files: [] },
      });
      expect(r.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("POST /api/review returns 503 anthropic_key_missing when not configured", async () => {
    const res = await fetch(`${baseUrl}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("anthropic_key_missing");
  });

  it("POST /api/review stops 503ing once the anthropic credential is set", async () => {
    const reviewMod = await import("./review.ts");
    const spy = vi
      .spyOn(reviewMod, "streamReview")
      .mockImplementation(async (_body, _req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end("data: {}\n\n");
      });
    try {
      await postJson(`${baseUrl}/api/auth/set`, {
        credential: { kind: "anthropic" },
        value: "sk-test",
      });
      const res = await fetch(`${baseUrl}/api/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── POST /api/github/pr/load ─────────────────────────────────────────────

// Minimal GitHub API canned responses for pr/load integration tests.
const GH_PR_META = {
  title: "Test PR",
  body: "description",
  state: "open",
  merged: false,
  html_url: "https://github.com/owner/repo/pull/1",
  head: { sha: "headsha123", ref: "feature" },
  base: { sha: "basesha456", ref: "main" },
  user: { login: "dev" },
  changed_files: 1,
};
const GH_PR_FILES = [
  {
    filename: "src/hello.ts",
    status: "modified",
    patch: "@@ -1,2 +1,2 @@\n-old\n+new\n context",
  },
];

function makeGhResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Returns a fetch stub that routes github.com requests to canned responses
 * and forwards everything else to the real fetch (so the local test server
 * is still reachable).
 */
function makeSelectiveFetch(
  githubHandler: (url: string) => Response,
): typeof fetch {
  const realFetch = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.github.com")) {
      return Promise.resolve(githubHandler(url));
    }
    return realFetch(input, init);
  };
}

describe("POST /api/github/pr/load", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 for a missing prUrl", async () => {
    const r = await postJson(`${baseUrl}/api/github/pr/load`, {});
    expect(r.status).toBe(400);
  });

  it("returns 400 for a malformed URL — discriminator is invalid_pr_url", async () => {
    const r = await postJson(`${baseUrl}/api/github/pr/load`, {
      prUrl: "not-a-url",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_pr_url");
    expect(r.body.detail).toMatch(/invalid PR URL/);
  });

  it("returns 400 for a URL that is not a PR path — discriminator is invalid_pr_url", async () => {
    const r = await postJson(`${baseUrl}/api/github/pr/load`, {
      prUrl: "https://github.com/owner/repo/issues/1",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_pr_url");
    expect(r.body.detail).toMatch(/invalid PR URL/);
  });

  it("returns 400 invalid_pr_url for a file:// scheme URL", async () => {
    const r = await postJson(`${baseUrl}/api/github/pr/load`, {
      prUrl: "file:///owner/repo/pull/1",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_pr_url");
  });

  it("returns 400 invalid_pr_url for an http:// PR URL", async () => {
    const r = await postJson(`${baseUrl}/api/github/pr/load`, {
      prUrl: "http://github.com/owner/repo/pull/1",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_pr_url");
    expect(r.body.detail).toMatch(/scheme must be https/);
  });

  it("returns 401 github_token_required when no token is stored", async () => {
    const r = await postJson(`${baseUrl}/api/github/pr/load`, {
      prUrl: "https://github.com/owner/repo/pull/1",
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("github_token_required");
    expect(r.body.host).toBe("github.com");
  });

  it("returns 403 github_auth_failed (invalid-token) when GitHub rejects the stored PAT", async () => {
    // A token IS in the store; GitHub responds 401. The api-client maps
    // that to github_auth_failed with the invalid-token hint so the client
    // opens the modal in the rejection state instead of falling into the
    // first-time-prompt → cache-hit retry loop that caused the modal not
    // to display for users with a wrong saved PAT.
    await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "github", host: "github.com" },
      value: "ghp_bad",
    });

    vi.stubGlobal(
      "fetch",
      makeSelectiveFetch(() => ({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: () => Promise.resolve({ message: "Bad credentials" }),
      } as unknown as Response)),
    );

    const r = await postJson(`${baseUrl}/api/github/pr/load`, {
      prUrl: "https://github.com/owner/repo/pull/1",
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("github_auth_failed");
    expect(r.body.hint).toBe("invalid-token");
    expect(r.body.host).toBe("github.com");
  });

  it("returns { changeSet } on success", async () => {
    await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "github", host: "github.com" },
      value: "ghp_integration_test",
    });

    vi.stubGlobal(
      "fetch",
      makeSelectiveFetch((url) => {
        if (url.includes("/pulls/1/files")) return makeGhResponse(GH_PR_FILES);
        if (url.includes("/pulls/1/comments")) return makeGhResponse([]);
        if (url.includes("/issues/1/comments")) return makeGhResponse([]);
        if (url.includes("/pulls/1")) return makeGhResponse(GH_PR_META);
        return makeGhResponse({});
      }),
    );

    const r = await postJson(`${baseUrl}/api/github/pr/load`, {
      prUrl: "https://github.com/owner/repo/pull/1",
    });
    expect(r.status).toBe(200);
    expect(r.body.changeSet).toBeDefined();
    expect(r.body.changeSet.id).toBe("pr:github.com:owner:repo:1");
    expect(r.body.changeSet.prSource).toBeDefined();
    expect(r.body.changeSet.prSource.state).toBe("open");
    expect(r.body.changeSet.files).toHaveLength(1);
    expect(r.body.changeSet.prConversation).toEqual([]);
    expect(r.body.prInteractions).toEqual({});
    expect(r.body.prDetached).toEqual([]);
  });

  it("returns 403 github_auth_failed on upstream 403 rate-limit", async () => {
    await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "github", host: "github.com" },
      value: "ghp_integration_test",
    });

    vi.stubGlobal(
      "fetch",
      makeSelectiveFetch(() => ({
        ok: false,
        status: 403,
        headers: new Headers({ "X-RateLimit-Remaining": "0" }),
        json: () => Promise.resolve({ message: "rate limited" }),
      } as unknown as Response)),
    );

    const r = await postJson(`${baseUrl}/api/github/pr/load`, {
      prUrl: "https://github.com/owner/repo/pull/1",
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("github_auth_failed");
    expect(r.body.hint).toBe("rate-limit");
  });

  it("returns 404 github_pr_not_found on upstream 404", async () => {
    await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "github", host: "github.com" },
      value: "ghp_integration_test",
    });

    vi.stubGlobal(
      "fetch",
      makeSelectiveFetch(() => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: () => Promise.resolve({ message: "Not Found" }),
      } as unknown as Response)),
    );

    const r = await postJson(`${baseUrl}/api/github/pr/load`, {
      prUrl: "https://github.com/owner/repo/pull/1",
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("github_pr_not_found");
  });

  it("returns 502 github_upstream on 5xx from GitHub", async () => {
    await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "github", host: "github.com" },
      value: "ghp_integration_test",
    });

    vi.stubGlobal(
      "fetch",
      makeSelectiveFetch(() => ({
        ok: false,
        status: 503,
        headers: new Headers(),
        json: () => Promise.resolve({ message: "Service Unavailable" }),
      } as unknown as Response)),
    );

    const r = await postJson(`${baseUrl}/api/github/pr/load`, {
      prUrl: "https://github.com/owner/repo/pull/1",
    });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("github_upstream");
  });

  it("denies requests with an opaque origin", async () => {
    const res = await fetch(`${baseUrl}/api/github/pr/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "null" },
      body: JSON.stringify({ prUrl: "https://github.com/owner/repo/pull/1" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/github/pr/branch-lookup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setGithubToken() {
    await postJson(`${baseUrl}/api/auth/set`, {
      credential: { kind: "github", host: "github.com" },
      value: "ghp_branch_lookup_test",
    });
  }

  it("returns { matched: null } when no remotes are configured", async () => {
    await setGithubToken();
    vi.stubGlobal(
      "fetch",
      makeSelectiveFetch(() =>
        ({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve([]) } as unknown as Response),
      ),
    );
    const r = await postJson(`${baseUrl}/api/github/pr/branch-lookup`, {
      worktreePath,
    });
    expect(r.status).toBe(200);
    expect(r.body.matched).toBeNull();
  });

  it("returns { matched: PrMatch } for a worktree with a GitHub remote and open PR", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shippable-bl-int-"));
    try {
      await execFileAsync("git", ["init"], { cwd: dir });
      await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      await execFileAsync("git", ["config", "user.name", "T"], { cwd: dir });
      await fs.writeFile(path.join(dir, "a.txt"), "hello");
      await execFileAsync("git", ["add", "."], { cwd: dir });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
      await execFileAsync(
        "git",
        ["remote", "add", "origin", "https://github.com/owner/repo.git"],
        { cwd: dir },
      );

      await setGithubToken();
      vi.stubGlobal(
        "fetch",
        makeSelectiveFetch(() =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () =>
              Promise.resolve([
                {
                  number: 7,
                  title: "My PR",
                  state: "open",
                  merged: false,
                  html_url: "https://github.com/owner/repo/pull/7",
                },
              ]),
          } as unknown as Response),
        ),
      );

      const r = await postJson(`${baseUrl}/api/github/pr/branch-lookup`, {
        worktreePath: dir,
      });
      expect(r.status).toBe(200);
      expect(r.body.matched).not.toBeNull();
      expect(r.body.matched.number).toBe(7);
      expect(r.body.matched.title).toBe("My PR");
      expect(r.body.matched.host).toBe("github.com");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 401 github_token_required when no token is stored", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shippable-bl-int-"));
    try {
      await execFileAsync("git", ["init"], { cwd: dir });
      await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      await execFileAsync("git", ["config", "user.name", "T"], { cwd: dir });
      await fs.writeFile(path.join(dir, "a.txt"), "hello");
      await execFileAsync("git", ["add", "."], { cwd: dir });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
      await execFileAsync(
        "git",
        ["remote", "add", "origin", "https://github.com/owner/repo.git"],
        { cwd: dir },
      );

      // Ensure no token is set (resetAuthStore was called in beforeEach)
      const r = await postJson(`${baseUrl}/api/github/pr/branch-lookup`, {
        worktreePath: dir,
      });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("github_token_required");
      expect(r.body.host).toBe("github.com");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 400 and an error when worktreePath is missing", async () => {
    const r = await postJson(`${baseUrl}/api/github/pr/branch-lookup`, {});
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe("string");
  });

  it("returns 400 for an invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/github/pr/branch-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("denies requests with an opaque origin", async () => {
    const res = await fetch(`${baseUrl}/api/github/pr/branch-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "null" },
      body: JSON.stringify({ worktreePath }),
    });
    expect(res.status).toBe(403);
  });
});
