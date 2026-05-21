import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PORT,
  WATCH_DELIVERED_HINT,
  WATCH_IDLE_HINT,
  handleCheckReviewComments,
  handlePostReviewComment,
  handleWatchReviewComments,
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

/**
 * A fetch stub that walks `responses` one entry per call, repeating the last
 * entry once exhausted — so a watch loop that polls more than expected stays
 * deterministic. An `Error` entry is thrown to model a fetch rejection.
 */
function makeSequenceFetch(responses: Array<Response | Error>): {
  fetchFn: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const entry = responses[Math.min(i, responses.length - 1)]!;
    i++;
    if (entry instanceof Error) throw entry;
    // Clone — a Response body reads once, and a watch loop re-polls the
    // last entry, so each call needs its own readable body.
    return entry.clone();
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** A `nowFn` that walks `values` once per call, holding on the last entry. */
function steppingNow(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
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

  it("ignores rationale/suggestedFix/confidence on reply-mode posts", async () => {
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "reply-2" }));

    await handlePostReviewComment(
      {
        worktreePath: "/repo",
        parentInteractionId: "c1",
        replyText: "fixed it",
        intent: "accept",
        rationale: "should not appear",
        suggestedFix: "should not appear",
        confidence: "high",
      },
      { fetchFn },
    );

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      worktreePath: "/repo",
      parentId: "c1",
      body: "fixed it",
      intent: "accept",
    });
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
        rationale: "this matters because",
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
      rationale: "this matters because",
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

  it("rejects a top-level post that omits rationale", async () => {
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "x" }));
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
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/rationale/i);
    expect(calls).toHaveLength(0);
  });

  it("forwards rationale/suggestedFix/confidence as flat keys in the payload", async () => {
    const { fetchFn, calls } = makeFetch(jsonResponse({ id: "tl-2" }));

    const result = await handlePostReviewComment(
      {
        worktreePath: "/repo",
        target: "line",
        file: "src/foo.ts",
        lines: "42",
        replyText: "noticed this",
        intent: "request",
        rationale: "this leaks a handle",
        suggestedFix: "close(fd)",
        confidence: "high",
      },
      { fetchFn },
    );

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      worktreePath: "/repo",
      target: "line",
      file: "src/foo.ts",
      lines: "42",
      body: "noticed this",
      intent: "request",
      rationale: "this leaks a handle",
      suggestedFix: "close(fd)",
      confidence: "high",
    });
  });
});

describe("handleWatchReviewComments", () => {
  const ENVELOPE =
    '<reviewer-feedback from="shippable" commit="abc"><interaction id="c1" file="x.ts">hi</interaction></reviewer-feedback>';

  it("returns the envelope plus the delivered hint when the first pull is non-empty", async () => {
    const { fetchFn } = makeSequenceFetch([
      jsonResponse({ payload: ENVELOPE, ids: ["c1"] }),
    ]);
    const sleepFn = vi.fn(async () => {});

    const result = await handleWatchReviewComments(
      { worktreePath: "/repo" },
      { fetchFn, port: 4000, sleepFn, nowFn: () => 0 },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe(`${ENVELOPE}\n\n${WATCH_DELIVERED_HINT}`);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("loops past empty pulls and returns once comments arrive", async () => {
    const { fetchFn, calls } = makeSequenceFetch([
      jsonResponse({ payload: "", ids: [] }),
      jsonResponse({ payload: "", ids: [] }),
      jsonResponse({ payload: ENVELOPE, ids: ["c1"] }),
    ]);
    const sleepFn = vi.fn(async () => {});

    const result = await handleWatchReviewComments(
      { worktreePath: "/repo" },
      { fetchFn, port: 4000, sleepFn, nowFn: () => 0 },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe(`${ENVELOPE}\n\n${WATCH_DELIVERED_HINT}`);
    expect(calls).toHaveLength(3);
    // One sleep between each pair of pulls — never after the delivering pull.
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("polls /api/agent/interactions with status unread and watch: true", async () => {
    const { fetchFn, calls } = makeSequenceFetch([
      jsonResponse({ payload: "", ids: [] }),
      jsonResponse({ payload: ENVELOPE, ids: ["c1"] }),
    ]);

    await handleWatchReviewComments(
      { worktreePath: "/repo" },
      { fetchFn, port: 4000, sleepFn: async () => {}, nowFn: () => 0 },
    );

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("http://127.0.0.1:4000/api/agent/interactions");
      const body = JSON.parse(String(call.init?.body));
      expect(body.watch).toBe(true);
      expect(body.status).toBe("unread");
      expect(body.worktreePath).toBe("/repo");
    }
  });

  it("returns the idle message and hint once the deadline passes with nothing pending", async () => {
    const { fetchFn, calls } = makeSequenceFetch([
      jsonResponse({ payload: "", ids: [] }),
    ]);
    // Default 60s window → deadline 60000. Clock stays at 0 for three polls
    // then jumps past the deadline.
    const result = await handleWatchReviewComments(
      { worktreePath: "/repo" },
      {
        fetchFn,
        port: 4000,
        sleepFn: async () => {},
        nowFn: steppingNow([0, 0, 0, 0, 70_000]),
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain(WATCH_IDLE_HINT);
    expect(result.content[0]!.text).toContain("No reviewer comments arrived");
    expect(calls.length).toBeGreaterThan(1);
  });

  it("clamps timeoutSeconds below MIN_TIMEOUT_SECONDS up to the minimum", async () => {
    const { fetchFn, calls } = makeSequenceFetch([
      jsonResponse({ payload: "", ids: [] }),
    ]);
    // timeoutSeconds 0 → clamped to 1s → deadline 1000. A clamp-free run would
    // set deadline 0 and return idle after a single poll; the clamp forces a
    // second poll before the clock (1001) crosses the deadline.
    const result = await handleWatchReviewComments(
      { worktreePath: "/repo", timeoutSeconds: 0 },
      {
        fetchFn,
        port: 4000,
        sleepFn: async () => {},
        nowFn: steppingNow([0, 0, 1001]),
      },
    );

    expect(result.content[0]!.text).toContain(WATCH_IDLE_HINT);
    expect(calls).toHaveLength(2);
  });

  it("clamps timeoutSeconds above MAX_TIMEOUT_SECONDS down to the maximum", async () => {
    const { fetchFn, calls } = makeSequenceFetch([
      jsonResponse({ payload: "", ids: [] }),
    ]);
    // timeoutSeconds 400 → clamped to 300s → deadline 300000. The clock reads
    // 350000 on the first check, already past the clamped deadline, so the
    // loop returns after one poll. Without the clamp (deadline 400000) it
    // would poll again.
    const result = await handleWatchReviewComments(
      { worktreePath: "/repo", timeoutSeconds: 400 },
      {
        fetchFn,
        port: 4000,
        sleepFn: async () => {},
        nowFn: steppingNow([0, 350_000, 450_000]),
      },
    );

    expect(result.content[0]!.text).toContain(WATCH_IDLE_HINT);
    expect(calls).toHaveLength(1);
  });

  it("falls back to deps.cwd() when worktreePath is absent, explicit path wins", async () => {
    const absent = makeSequenceFetch([
      jsonResponse({ payload: ENVELOPE, ids: ["c1"] }),
    ]);
    await handleWatchReviewComments(
      {},
      { fetchFn: absent.fetchFn, port: 4000, cwd: () => "/tmp/cwd", sleepFn: async () => {}, nowFn: () => 0 },
    );
    expect(JSON.parse(String(absent.calls[0]!.init?.body)).worktreePath).toBe(
      "/tmp/cwd",
    );

    const present = makeSequenceFetch([
      jsonResponse({ payload: ENVELOPE, ids: ["c1"] }),
    ]);
    await handleWatchReviewComments(
      { worktreePath: "/tmp/explicit" },
      { fetchFn: present.fetchFn, port: 4000, cwd: () => "/tmp/cwd", sleepFn: async () => {}, nowFn: () => 0 },
    );
    expect(JSON.parse(String(present.calls[0]!.init?.body)).worktreePath).toBe(
      "/tmp/explicit",
    );
  });

  it("returns a structured error and exits the loop on a fetch rejection", async () => {
    const { fetchFn, calls } = makeSequenceFetch([new Error("ECONNREFUSED")]);

    const result = await handleWatchReviewComments(
      { worktreePath: "/repo" },
      { fetchFn, port: 7777, sleepFn: async () => {}, nowFn: () => 0 },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("ECONNREFUSED");
    expect(result.content[0]!.text).toContain("7777");
    expect(calls).toHaveLength(1);
  });

  it("returns a structured error and exits the loop on a non-2xx response", async () => {
    const { fetchFn, calls } = makeSequenceFetch([
      new Response("oops", { status: 500 }),
    ]);

    const result = await handleWatchReviewComments(
      { worktreePath: "/repo" },
      { fetchFn, port: 4242, sleepFn: async () => {}, nowFn: () => 0 },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("4242");
    expect(result.content[0]!.text).toContain("500");
    expect(calls).toHaveLength(1);
  });
});
