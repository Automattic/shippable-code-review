import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PORT,
  handleCheckReviewComments,
  handlePostReviewComment,
} from "./handler.js";

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(response: Response | Promise<Response> | Error): {
  fetchFn: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleCheckReviewComments", () => {
  it("returns the payload when the server has pending comments", async () => {
    const payload =
      "<reviewer-feedback from=\"shippable\" commit=\"abc\"><comment id=\"c1\" file=\"x.ts\" lines=\"1\" kind=\"block\">hi</comment></reviewer-feedback>";
    const { fetchFn } = makeFetch(jsonResponse({ payload, ids: ["a", "b"] }));

    const result = await handleCheckReviewComments(
      { worktreePath: "/repo", status: "unread" },
      { fetchFn },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: payload }]);
  });

  it("returns 'No pending comments.' when payload is empty", async () => {
    const { fetchFn } = makeFetch(jsonResponse({ payload: "", ids: [] }));

    const result = await handleCheckReviewComments(
      { worktreePath: "/repo", status: "unread" },
      { fetchFn },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "No pending comments." },
    ]);
  });

  it("falls back to deps.cwd() when worktreePath is absent", async () => {
    const { fetchFn, calls } = makeFetch(
      jsonResponse({ payload: "", ids: [] }),
    );

    await handleCheckReviewComments(
      { status: "unread" },
      { fetchFn, cwd: () => "/tmp/x" },
    );

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.worktreePath).toBe("/tmp/x");
  });

  it("explicit worktreePath wins over deps.cwd()", async () => {
    const { fetchFn, calls } = makeFetch(
      jsonResponse({ payload: "", ids: [] }),
    );

    await handleCheckReviewComments(
      { worktreePath: "/tmp/y", status: "unread" },
      { fetchFn, cwd: () => "/tmp/x" },
    );

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.worktreePath).toBe("/tmp/y");
  });

  it("posts the status to /api/agent/interactions for each status value", async () => {
    for (const status of ["unread", "delivered", "all"] as const) {
      const { fetchFn, calls } = makeFetch(
        jsonResponse({ payload: "", ids: [] }),
      );
      await handleCheckReviewComments(
        { worktreePath: "/repo", status },
        { fetchFn, port: 4000 },
      );
      expect(calls[0]!.url).toBe(
        "http://127.0.0.1:4000/api/agent/interactions",
      );
      const body = JSON.parse(String(calls[0]!.init?.body));
      expect(body.status).toBe(status);
      expect(body.worktreePath).toBe("/repo");
    }
  });

  it("returns an error result on HTTP 500 with port and status in the message", async () => {
    const { fetchFn } = makeFetch(
      new Response("oops", { status: 500 }),
    );

    const result = await handleCheckReviewComments(
      { worktreePath: "/repo", status: "unread" },
      { fetchFn, port: 4242 },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("4242");
    expect(result.content[0]!.text).toContain("500");
  });

  it("returns an error result when the response body is not valid JSON", async () => {
    const { fetchFn } = makeFetch(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await handleCheckReviewComments(
      { worktreePath: "/repo", status: "unread" },
      { fetchFn, port: 5151 },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/JSON|parse/i);
  });

  it("returns an error result without throwing on fetch rejection", async () => {
    const { fetchFn } = makeFetch(new Error("ECONNREFUSED"));

    const result = await handleCheckReviewComments(
      { worktreePath: "/repo", status: "unread" },
      { fetchFn, port: 7777 },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("ECONNREFUSED");
    expect(result.content[0]!.text).toContain("7777");
  });

  it("honors deps.port when provided", async () => {
    const { fetchFn, calls } = makeFetch(
      jsonResponse({ payload: "", ids: [] }),
    );

    await handleCheckReviewComments(
      { worktreePath: "/repo", status: "unread" },
      { fetchFn, port: 4000 },
    );

    expect(calls[0]!.url).toBe("http://127.0.0.1:4000/api/agent/interactions");
  });

  it("honors SHIPPABLE_PORT env when deps.port is absent", async () => {
    vi.stubEnv("SHIPPABLE_PORT", "5000");
    const { fetchFn, calls } = makeFetch(
      jsonResponse({ payload: "", ids: [] }),
    );

    await handleCheckReviewComments(
      { worktreePath: "/repo", status: "unread" },
      { fetchFn },
    );

    expect(calls[0]!.url).toBe("http://127.0.0.1:5000/api/agent/interactions");
  });

  it("falls back to DEFAULT_PORT when env is empty and discovery returns null", async () => {
    vi.stubEnv("SHIPPABLE_PORT", "");
    const { fetchFn, calls } = makeFetch(
      jsonResponse({ payload: "", ids: [] }),
    );

    await handleCheckReviewComments(
      { worktreePath: "/repo", status: "unread" },
      { fetchFn, discoverPortFn: async () => null },
    );

    expect(DEFAULT_PORT).toBe(3001);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:${DEFAULT_PORT}/api/agent/interactions`);
  });

  it("uses the discovered sidecar port when env is empty and discovery succeeds", async () => {
    vi.stubEnv("SHIPPABLE_PORT", "");
    const { fetchFn, calls } = makeFetch(
      jsonResponse({ payload: "", ids: [] }),
    );

    await handleCheckReviewComments(
      { worktreePath: "/repo", status: "unread" },
      { fetchFn, discoverPortFn: async () => 54118 },
    );

    expect(calls[0]!.url).toBe("http://127.0.0.1:54118/api/agent/interactions");
  });

  it("prefers SHIPPABLE_PORT over discovery", async () => {
    vi.stubEnv("SHIPPABLE_PORT", "5000");
    const { fetchFn, calls } = makeFetch(
      jsonResponse({ payload: "", ids: [] }),
    );
    // Discovery would point us at 54118 — env wins.
    await handleCheckReviewComments(
      { worktreePath: "/repo", status: "unread" },
      { fetchFn, discoverPortFn: async () => 54118 },
    );

    expect(calls[0]!.url).toBe("http://127.0.0.1:5000/api/agent/interactions");
  });
});

describe("handlePostReviewComment — reply mode", () => {
  it("POSTs to /api/agent/replies with parentInteractionId and returns the assigned id", async () => {
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "reply-1" }));

    const result = await handlePostReviewComment(
      {
        worktreePath: "/repo",
        parentInteractionId: "c1",
        replyText: "fixed it",
        intent: "accept",
      },
      { fetchFn },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("reply-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/api\/agent\/replies$/);
    // MCP boundary translates: `parentInteractionId` → `parentId` and
    // `replyText` → `body` on the way to the HTTP wire. Server-side
    // names stay unchanged.
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      worktreePath: "/repo",
      parentId: "c1",
      body: "fixed it",
      intent: "accept",
    });
  });

  it("falls back to deps.cwd() when worktreePath is absent", async () => {
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "x" }));

    await handlePostReviewComment(
      { parentInteractionId: "c1", replyText: "x", intent: "ack" },
      { fetchFn, cwd: () => "/tmp/cwd" },
    );

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.worktreePath).toBe("/tmp/cwd");
  });

  it("returns an error result on HTTP 500 with port and status in the message", async () => {
    const { fetchFn } = makeFetch(new Response("oops", { status: 500 }));

    const result = await handlePostReviewComment(
      {
        worktreePath: "/repo",
        parentInteractionId: "c1",
        replyText: "x",
        intent: "accept",
      },
      { fetchFn, port: 4242 },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("4242");
    expect(result.content[0]!.text).toContain("500");
  });

  it("returns an error result without throwing on fetch rejection", async () => {
    const { fetchFn } = makeFetch(new Error("ECONNREFUSED"));

    const result = await handlePostReviewComment(
      {
        worktreePath: "/repo",
        parentInteractionId: "c1",
        replyText: "x",
        intent: "reject",
      },
      { fetchFn, port: 7777 },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("ECONNREFUSED");
    expect(result.content[0]!.text).toContain("7777");
  });

  it("honors SHIPPABLE_PORT env when deps.port is absent", async () => {
    vi.stubEnv("SHIPPABLE_PORT", "5050");
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "x" }));

    await handlePostReviewComment(
      {
        worktreePath: "/repo",
        parentInteractionId: "c1",
        replyText: "x",
        intent: "ack",
      },
      { fetchFn },
    );

    expect(calls[0]!.url).toBe("http://127.0.0.1:5050/api/agent/replies");
  });

  it("returns an error result when the response body is not valid JSON", async () => {
    const { fetchFn } = makeFetch(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await handlePostReviewComment(
      {
        worktreePath: "/repo",
        parentInteractionId: "c1",
        replyText: "x",
        intent: "accept",
      },
      { fetchFn, port: 5151 },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/JSON|parse/i);
  });

  it("rejects reply intents that aren't ack/accept/reject", async () => {
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "x" }));
    const result = await handlePostReviewComment(
      {
        worktreePath: "/repo",
        parentInteractionId: "c1",
        replyText: "x",
        intent: "comment",
      },
      { fetchFn },
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("handlePostReviewComment — top-level mode", () => {
  it("POSTs with target+file+lines and returns the assigned id", async () => {
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "tl-1" }));

    const result = await handlePostReviewComment(
      {
        worktreePath: "/repo",
        target: "line",
        file: "src/foo.ts",
        lines: "42",
        replyText: "noticed this",
        intent: "request",
      },
      { fetchFn },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("tl-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/api\/agent\/replies$/);
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      worktreePath: "/repo",
      target: "line",
      file: "src/foo.ts",
      lines: "42",
      body: "noticed this",
      intent: "request",
    });
  });

  it("rejects top-level intents that aren't comment/question/request/blocker", async () => {
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "x" }));
    const result = await handlePostReviewComment(
      {
        worktreePath: "/repo",
        target: "block",
        file: "src/foo.ts",
        lines: "1-3",
        replyText: "x",
        intent: "ack",
      },
      { fetchFn },
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects requests that set both parentInteractionId and anchor fields", async () => {
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "x" }));
    const result = await handlePostReviewComment(
      {
        worktreePath: "/repo",
        parentInteractionId: "c1",
        target: "line",
        file: "src/foo.ts",
        lines: "1",
        replyText: "x",
        intent: "comment",
      },
      { fetchFn },
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects requests that set neither parentInteractionId nor anchor fields", async () => {
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "x" }));
    const result = await handlePostReviewComment(
      { worktreePath: "/repo", replyText: "x", intent: "comment" },
      { fetchFn },
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
