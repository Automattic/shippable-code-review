// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  fetchInteractions,
  upsertInteraction,
  deleteInteraction,
  deleteInteractionsForChangeset,
  enqueueInteraction,
  unenqueueInteraction,
} from "./interactionClient";
import { ApiError } from "./apiClient";

vi.mock("./apiUrl", () => ({
  apiUrl: (path: string) => Promise.resolve(path),
}));

function makeFetch(ok: boolean, status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

// ─── fetchInteractions ────────────────────────────────────────────────────────

describe("fetchInteractions", () => {
  it("sends GET to /api/interactions?changesetId=<id>", async () => {
    const stub = makeFetch(true, 200, { interactions: [] });
    vi.stubGlobal("fetch", stub);

    await fetchInteractions("cs-1");

    expect(stub).toHaveBeenCalledOnce();
    const [url] = stub.mock.calls[0] as [string];
    expect(url).toBe("/api/interactions?changesetId=cs-1");
  });

  it("returns an empty array when server returns no interactions", async () => {
    vi.stubGlobal("fetch", makeFetch(true, 200, { interactions: [] }));
    const result = await fetchInteractions("cs-1");
    expect(result).toEqual([]);
  });

  it("flattens payload fields onto the Interaction and drops storage-only columns", async () => {
    const serverRow = {
      id: "ix-1",
      threadKey: "note:abc",
      target: "line",
      intent: "comment",
      author: "alice",
      authorRole: "user",
      body: "looks good",
      createdAt: "2026-01-01T00:00:00.000Z",
      changesetId: "cs-1",       // storage-only — must be dropped
      worktreePath: "/tmp/wt",   // storage-only — must be dropped
      agentQueueStatus: "pending", // preserved — the pip reads it
      payload: {
        anchorPath: "src/foo.ts",
        anchorHash: "abc123",
        anchorLineNo: 42,
        external: { source: "pr", htmlUrl: "https://github.com/o/r/pull/1#discussion_r1" },
      },
    };

    vi.stubGlobal("fetch", makeFetch(true, 200, { interactions: [serverRow] }));
    const [ix] = await fetchInteractions("cs-1");

    // Hot fields pass through.
    expect(ix.id).toBe("ix-1");
    expect(ix.threadKey).toBe("note:abc");
    expect(ix.target).toBe("line");
    expect(ix.intent).toBe("comment");
    expect(ix.author).toBe("alice");
    expect(ix.authorRole).toBe("user");
    expect(ix.body).toBe("looks good");
    expect(ix.createdAt).toBe("2026-01-01T00:00:00.000Z");

    // Payload fields flattened to top level.
    expect(ix.anchorPath).toBe("src/foo.ts");
    expect(ix.anchorHash).toBe("abc123");
    expect(ix.anchorLineNo).toBe(42);
    expect(ix.external).toEqual({ source: "pr", htmlUrl: "https://github.com/o/r/pull/1#discussion_r1" });

    // agentQueueStatus is preserved — the pip needs it.
    expect(ix.agentQueueStatus).toBe("pending");

    // The other storage-only columns are absent.
    expect(ix).not.toHaveProperty("changesetId");
    expect(ix).not.toHaveProperty("worktreePath");
    expect(ix).not.toHaveProperty("payload");
  });

  it("handles an empty payload (no optional fields)", async () => {
    const serverRow = {
      id: "ix-2",
      threadKey: "note:xyz",
      target: "line",
      intent: "comment",
      author: "bob",
      authorRole: "user",
      body: "nit",
      createdAt: "2026-01-02T00:00:00.000Z",
      changesetId: "cs-1",
      worktreePath: null,
      agentQueueStatus: null,
      payload: {},
    };

    vi.stubGlobal("fetch", makeFetch(true, 200, { interactions: [serverRow] }));
    const [ix] = await fetchInteractions("cs-1");

    expect(ix.id).toBe("ix-2");
    expect(ix.anchorPath).toBeUndefined();
    expect(ix.external).toBeUndefined();
  });

  it("coerces null threadKey to empty string", async () => {
    const serverRow = {
      id: "ix-3",
      threadKey: null,
      target: "line",
      intent: "comment",
      author: "carol",
      authorRole: "user",
      body: "test",
      createdAt: "2026-01-03T00:00:00.000Z",
      changesetId: "cs-1",
      worktreePath: null,
      agentQueueStatus: null,
      payload: {},
    };

    vi.stubGlobal("fetch", makeFetch(true, 200, { interactions: [serverRow] }));
    const [ix] = await fetchInteractions("cs-1");
    expect(ix.threadKey).toBe("");
  });

  it("encodes a PR-style changesetId containing colons in the URL", async () => {
    const stub = makeFetch(true, 200, { interactions: [] });
    vi.stubGlobal("fetch", stub);

    await fetchInteractions("pr:github.com:owner:repo:42");

    const [url] = stub.mock.calls[0] as [string];
    expect(url).toBe(
      "/api/interactions?changesetId=pr%3Agithub.com%3Aowner%3Arepo%3A42",
    );
  });

  it("throws ApiError on non-2xx", async () => {
    vi.stubGlobal("fetch", makeFetch(false, 400, { error: "missing required query param: changesetId" }));
    await expect(fetchInteractions("")).rejects.toBeInstanceOf(ApiError);
  });
});

// ─── upsertInteraction ────────────────────────────────────────────────────────

describe("upsertInteraction", () => {
  it("sends POST to /api/interactions with flat body including changesetId", async () => {
    const stub = makeFetch(true, 200, { ok: true });
    vi.stubGlobal("fetch", stub);

    const ix = {
      id: "ix-1",
      threadKey: "note:abc",
      target: "line" as const,
      intent: "comment" as const,
      author: "alice",
      authorRole: "user" as const,
      body: "looks good",
      createdAt: "2026-01-01T00:00:00.000Z",
      anchorPath: "src/foo.ts",
    };

    await upsertInteraction(ix, "cs-1");

    expect(stub).toHaveBeenCalledOnce();
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/interactions");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.id).toBe("ix-1");
    expect(sent.changesetId).toBe("cs-1");
    expect(sent.anchorPath).toBe("src/foo.ts");
  });

  it("includes worktreePath in the body when the changeset is worktree-backed", async () => {
    const stub = makeFetch(true, 200, { ok: true });
    vi.stubGlobal("fetch", stub);

    const ix = {
      id: "ix-1",
      threadKey: "note:abc",
      target: "line" as const,
      intent: "comment" as const,
      author: "alice",
      authorRole: "user" as const,
      body: "looks good",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    await upsertInteraction(ix, "cs-1", "/Users/me/wt");

    const [, init] = stub.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.worktreePath).toBe("/Users/me/wt");
  });

  it("omits worktreePath for a non-worktree changeset", async () => {
    const stub = makeFetch(true, 200, { ok: true });
    vi.stubGlobal("fetch", stub);

    const ix = {
      id: "ix-1",
      threadKey: "note:abc",
      target: "line" as const,
      intent: "comment" as const,
      author: "alice",
      authorRole: "user" as const,
      body: "looks good",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    await upsertInteraction(ix, "cs-1");

    const [, init] = stub.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).not.toHaveProperty("worktreePath");
  });

  it("resolves to void on success", async () => {
    vi.stubGlobal("fetch", makeFetch(true, 200, { ok: true }));
    const ix = {
      id: "ix-1",
      threadKey: "note:abc",
      target: "line" as const,
      intent: "comment" as const,
      author: "alice",
      authorRole: "user" as const,
      body: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await expect(upsertInteraction(ix, "cs-1")).resolves.toBeUndefined();
  });

  it("throws ApiError on non-2xx", async () => {
    vi.stubGlobal("fetch", makeFetch(false, 400, { error: "invalid target" }));
    const ix = {
      id: "ix-1",
      threadKey: "note:abc",
      target: "line" as const,
      intent: "comment" as const,
      author: "alice",
      authorRole: "user" as const,
      body: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await expect(upsertInteraction(ix, "cs-1")).rejects.toBeInstanceOf(ApiError);
  });
});

// ─── deleteInteraction ────────────────────────────────────────────────────────

describe("deleteInteraction", () => {
  it("sends DELETE to /api/interactions?id=<id>", async () => {
    const stub = makeFetch(true, 200, { deleted: true });
    vi.stubGlobal("fetch", stub);

    await deleteInteraction("ix-1");

    expect(stub).toHaveBeenCalledOnce();
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/interactions?id=ix-1");
    expect(init.method).toBe("DELETE");
  });

  it("returns true when the server reports deleted: true", async () => {
    vi.stubGlobal("fetch", makeFetch(true, 200, { deleted: true }));
    expect(await deleteInteraction("ix-1")).toBe(true);
  });

  it("returns false when the server reports deleted: false", async () => {
    vi.stubGlobal("fetch", makeFetch(true, 200, { deleted: false }));
    expect(await deleteInteraction("ix-missing")).toBe(false);
  });

  it("encodes a colon-containing id in the URL", async () => {
    const stub = makeFetch(true, 200, { deleted: true });
    vi.stubGlobal("fetch", stub);

    await deleteInteraction("pr:github.com:owner:repo:42");

    const [url] = stub.mock.calls[0] as [string];
    expect(url).toBe("/api/interactions?id=pr%3Agithub.com%3Aowner%3Arepo%3A42");
  });

  it("throws ApiError on non-2xx", async () => {
    vi.stubGlobal("fetch", makeFetch(false, 400, { error: "missing required query param: id" }));
    await expect(deleteInteraction("")).rejects.toBeInstanceOf(ApiError);
  });
});

// ─── deleteInteractionsForChangeset ───────────────────────────────────────────

describe("deleteInteractionsForChangeset", () => {
  it("sends DELETE to /api/interactions?changesetId=<id>", async () => {
    const stub = makeFetch(true, 200, { deleted: 3 });
    vi.stubGlobal("fetch", stub);

    await deleteInteractionsForChangeset("wt-abc123");

    expect(stub).toHaveBeenCalledOnce();
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/interactions?changesetId=wt-abc123");
    expect(init.method).toBe("DELETE");
  });

  it("returns the deleted row count", async () => {
    vi.stubGlobal("fetch", makeFetch(true, 200, { deleted: 3 }));
    expect(await deleteInteractionsForChangeset("wt-abc123")).toBe(3);
  });

  it("encodes a dirty-hash changesetId containing a colon", async () => {
    const stub = makeFetch(true, 200, { deleted: 0 });
    vi.stubGlobal("fetch", stub);

    await deleteInteractionsForChangeset("wt-dirty:ab12cd");

    const [url] = stub.mock.calls[0] as [string];
    expect(url).toBe("/api/interactions?changesetId=wt-dirty%3Aab12cd");
  });

  it("throws ApiError on non-2xx", async () => {
    vi.stubGlobal("fetch", makeFetch(false, 500, { error: "db unavailable" }));
    await expect(deleteInteractionsForChangeset("wt-x")).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

// ─── enqueueInteraction ───────────────────────────────────────────────────────

describe("enqueueInteraction", () => {
  it("sends POST to /api/interactions/enqueue with { id, worktreePath }", async () => {
    const stub = makeFetch(true, 200, { ok: true });
    vi.stubGlobal("fetch", stub);

    await enqueueInteraction("ix-1", "/tmp/wt");

    expect(stub).toHaveBeenCalledOnce();
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/interactions/enqueue");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toEqual({ id: "ix-1", worktreePath: "/tmp/wt" });
  });

  it("resolves to void on success", async () => {
    vi.stubGlobal("fetch", makeFetch(true, 200, { ok: true }));
    await expect(enqueueInteraction("ix-1", "/tmp/wt")).resolves.toBeUndefined();
  });

  it("throws ApiError with status 404 when id is not found", async () => {
    vi.stubGlobal("fetch", makeFetch(false, 404, { error: "interaction not found" }));
    await expect(enqueueInteraction("missing", "/tmp/wt")).rejects.toSatisfy(
      (err: unknown) => err instanceof ApiError && err.status === 404,
    );
  });
});

// ─── unenqueueInteraction ─────────────────────────────────────────────────────

describe("unenqueueInteraction", () => {
  it("sends POST to /api/interactions/unenqueue with { id }", async () => {
    const stub = makeFetch(true, 200, { ok: true });
    vi.stubGlobal("fetch", stub);

    await unenqueueInteraction("ix-1");

    expect(stub).toHaveBeenCalledOnce();
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/interactions/unenqueue");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toEqual({ id: "ix-1" });
  });

  it("resolves to void on success", async () => {
    vi.stubGlobal("fetch", makeFetch(true, 200, { ok: true }));
    await expect(unenqueueInteraction("ix-1")).resolves.toBeUndefined();
  });

  it("throws ApiError with status 404 when no pending row found", async () => {
    vi.stubGlobal("fetch", makeFetch(false, 404, { error: "no pending interaction found for that id" }));
    await expect(unenqueueInteraction("ix-1")).rejects.toSatisfy(
      (err: unknown) => err instanceof ApiError && err.status === 404,
    );
  });
});
