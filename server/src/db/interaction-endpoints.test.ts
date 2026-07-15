import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetForTests } from "./index.ts";
import {
  captureStats,
  startTestServer,
  type StatCapture,
  type TestServer,
} from "../test-helpers.ts";

// Integration-tier: real createApp() in-process, DB isolated to :memory:.
// Each test gets a fresh server + DB — beforeEach boots, afterEach tears down.

let ts: TestServer;
let baseUrl: string;

// Minimal valid interaction body for POST /api/interactions.
function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: "ix-001",
    changesetId: "cs-abc",
    target: "line",
    intent: "comment",
    author: "alice",
    authorRole: "user",
    body: "looks good",
    ...overrides,
  };
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function deleteJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: "DELETE" });
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  ts = await startTestServer();
  baseUrl = ts.baseUrl;
});

afterEach(async () => {
  await ts.close();
  resetForTests();
});

// ─── GET /api/interactions ───────────────────────────────────────────────────

describe("GET /api/interactions", () => {
  it("returns 400 when changesetId is missing", async () => {
    const r = await getJson(`${baseUrl}/api/interactions`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBeDefined();
  });

  it("returns empty interactions array for unknown changesetId", async () => {
    const r = await getJson(
      `${baseUrl}/api/interactions?changesetId=unknown`,
    );
    expect(r.status).toBe(200);
    expect(r.body.interactions).toEqual([]);
  });

  it("returns stored interactions for a changeset", async () => {
    // Seed via POST first.
    await postJson(`${baseUrl}/api/interactions`, makeInteraction());
    const r = await getJson(
      `${baseUrl}/api/interactions?changesetId=cs-abc`,
    );
    expect(r.status).toBe(200);
    expect(r.body.interactions).toHaveLength(1);
    expect(r.body.interactions[0].id).toBe("ix-001");
    expect(r.body.interactions[0].body).toBe("looks good");
  });

  it("only returns interactions for the requested changeset", async () => {
    await postJson(`${baseUrl}/api/interactions`, makeInteraction({ id: "ix-a", changesetId: "cs-1" }));
    await postJson(`${baseUrl}/api/interactions`, makeInteraction({ id: "ix-b", changesetId: "cs-2" }));
    const r = await getJson(`${baseUrl}/api/interactions?changesetId=cs-1`);
    expect(r.status).toBe(200);
    expect(r.body.interactions).toHaveLength(1);
    expect(r.body.interactions[0].id).toBe("ix-a");
  });
});

// ─── POST /api/interactions ──────────────────────────────────────────────────

describe("POST /api/interactions", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/api/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when id is missing", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ id: undefined }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("returns 400 when changesetId is missing", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ changesetId: undefined }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/changesetId/i);
  });

  it("returns 400 when author is missing", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ author: undefined }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/author/i);
  });

  it("returns 400 when body is missing", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ body: undefined }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/body/i);
  });

  it("returns 400 when target is invalid", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ target: "not-a-target" }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/target/i);
  });

  it("returns 400 when intent is invalid", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ intent: "not-an-intent" }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/intent/i);
  });

  it("returns 400 when authorRole is invalid", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ authorRole: "superadmin" }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/authorRole/i);
  });

  it("returns 400 for invalid (target, intent) pair (line + ack)", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ target: "line", intent: "ack" }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/pair/i);
  });

  it("returns 200 and ok:true on valid upsert", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction(),
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("upserts: second POST with same id updates the row", async () => {
    await postJson(`${baseUrl}/api/interactions`, makeInteraction());
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ body: "updated comment" }),
    );
    expect(r.status).toBe(200);
    // Confirm only one row exists and it has the updated body.
    const get = await getJson(
      `${baseUrl}/api/interactions?changesetId=cs-abc`,
    );
    expect(get.body.interactions).toHaveLength(1);
    expect(get.body.interactions[0].body).toBe("updated comment");
  });

  it("passes optional payload fields through to storage", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ anchorPath: "src/foo.ts", anchorLineNo: 42 }),
    );
    expect(r.status).toBe(200);
    const get = await getJson(
      `${baseUrl}/api/interactions?changesetId=cs-abc`,
    );
    expect(get.body.interactions[0].payload.anchorPath).toBe("src/foo.ts");
    expect(get.body.interactions[0].payload.anchorLineNo).toBe(42);
  });

  it("accepts reply target with a response intent", async () => {
    const r = await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ target: "reply", intent: "ack" }),
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

// ─── POST /api/interactions/enqueue ─────────────────────────────────────────

describe("POST /api/interactions/enqueue", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/api/interactions/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when id is missing", async () => {
    const r = await postJson(`${baseUrl}/api/interactions/enqueue`, {
      worktreePath: "/tmp/some-path",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("returns 400 when worktreePath is missing", async () => {
    const r = await postJson(`${baseUrl}/api/interactions/enqueue`, {
      id: "ix-001",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/worktreePath/i);
  });

  it("returns 404 when interaction id does not exist", async () => {
    const r = await postJson(`${baseUrl}/api/interactions/enqueue`, {
      id: "does-not-exist",
      worktreePath: "/tmp/some-path",
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBeDefined();
  });

  it("returns 200 and ok:true when the row exists", async () => {
    await postJson(`${baseUrl}/api/interactions`, makeInteraction());
    const r = await postJson(`${baseUrl}/api/interactions/enqueue`, {
      id: "ix-001",
      worktreePath: "/tmp/my-worktree",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

// ─── POST /api/interactions/unenqueue ───────────────────────────────────────

describe("POST /api/interactions/unenqueue", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/api/interactions/unenqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when id is missing", async () => {
    const r = await postJson(`${baseUrl}/api/interactions/unenqueue`, {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("returns 404 when interaction is not pending (id not found)", async () => {
    const r = await postJson(`${baseUrl}/api/interactions/unenqueue`, {
      id: "does-not-exist",
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBeDefined();
  });

  it("returns 200 and ok:true when a pending row is unenqueued", async () => {
    await postJson(`${baseUrl}/api/interactions`, makeInteraction());
    await postJson(`${baseUrl}/api/interactions/enqueue`, {
      id: "ix-001",
      worktreePath: "/tmp/my-worktree",
    });
    const r = await postJson(`${baseUrl}/api/interactions/unenqueue`, {
      id: "ix-001",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("returns 404 when row exists but is not pending (already delivered or not enqueued)", async () => {
    // Create interaction but don't enqueue — agent_queue_status is null.
    await postJson(`${baseUrl}/api/interactions`, makeInteraction());
    const r = await postJson(`${baseUrl}/api/interactions/unenqueue`, {
      id: "ix-001",
    });
    expect(r.status).toBe(404);
  });
});

// ─── DELETE /api/interactions ────────────────────────────────────────────────

describe("DELETE /api/interactions", () => {
  it("returns 400 when id is missing", async () => {
    const r = await deleteJson(`${baseUrl}/api/interactions`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("returns 200 with deleted:false when id not found", async () => {
    const r = await deleteJson(
      `${baseUrl}/api/interactions?id=does-not-exist`,
    );
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(false);
  });

  it("returns 200 with deleted:true when row is removed", async () => {
    await postJson(`${baseUrl}/api/interactions`, makeInteraction());
    const r = await deleteJson(`${baseUrl}/api/interactions?id=ix-001`);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(true);
    // Confirm it's gone.
    const get = await getJson(
      `${baseUrl}/api/interactions?changesetId=cs-abc`,
    );
    expect(get.body.interactions).toHaveLength(0);
  });

  // Bulk delete backs the review-reset flow: reset must clear the DB rows
  // for the changeset, or the next fetch resurrects every comment.
  it("deletes every interaction for a changesetId and reports the count", async () => {
    await postJson(`${baseUrl}/api/interactions`, makeInteraction({ id: "ix-1" }));
    await postJson(`${baseUrl}/api/interactions`, makeInteraction({ id: "ix-2" }));
    await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ id: "ix-other", changesetId: "cs-other" }),
    );

    const r = await deleteJson(
      `${baseUrl}/api/interactions?changesetId=cs-abc`,
    );
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(2);

    const gone = await getJson(`${baseUrl}/api/interactions?changesetId=cs-abc`);
    expect(gone.body.interactions).toHaveLength(0);
    // Other changesets untouched.
    const kept = await getJson(`${baseUrl}/api/interactions?changesetId=cs-other`);
    expect(kept.body.interactions).toHaveLength(1);
  });

  it("returns deleted:0 for an unknown changesetId", async () => {
    const r = await deleteJson(
      `${baseUrl}/api/interactions?changesetId=never-seen`,
    );
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(0);
  });
});

// ─── comment-posted-user stat ────────────────────────────────────────────────

describe("POST /api/interactions stat wiring", () => {
  let stats: StatCapture;

  beforeEach(() => {
    stats = captureStats();
  });

  afterEach(() => {
    stats.restore();
  });

  it("counts comment-posted-user once for a user ask interaction", async () => {
    await postJson(`${baseUrl}/api/interactions`, makeInteraction());

    expect(
      stats.names().filter((n) => n === "comment-posted-user"),
    ).toHaveLength(1);
  });

  it("does not re-count when the same interaction id is re-saved", async () => {
    await postJson(`${baseUrl}/api/interactions`, makeInteraction());
    await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ body: "edited" }),
    );

    expect(
      stats.names().filter((n) => n === "comment-posted-user"),
    ).toHaveLength(1);
  });

  it("does not count an agent-authored interaction", async () => {
    await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ authorRole: "agent" }),
    );

    expect(stats.names()).not.toContain("comment-posted-user");
  });

  it("does not count a user interaction with a non-ask intent", async () => {
    // A valid user reply (target "reply" accepts response intents) with the
    // non-ask intent "ack" — reaches the stat gate but fails its isAskIntent
    // half, so it must not count.
    await postJson(
      `${baseUrl}/api/interactions`,
      makeInteraction({ target: "reply", intent: "ack", authorRole: "user" }),
    );

    expect(stats.names()).not.toContain("comment-posted-user");
  });
});
