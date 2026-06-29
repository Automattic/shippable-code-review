#!/usr/bin/env node
// Fake third-party upstream for the e2e suite. The real `server/` is pointed
// here instead of the live Anthropic + GitHub APIs:
//
//   ANTHROPIC_BASE_URL        -> POST /v1/messages   (plan + streaming review)
//   SHIPPABLE_GITHUB_API_BASE -> GET  /repos/...     (PR ingest)
//
// So the full browser -> vite -> real server -> upstream path runs for real;
// only the network hop to the actual third party is faked. This is closer to
// true e2e than page.route()-ing /api/* in the browser, and it exercises the
// server's own request building, response parsing, and error mapping.

import { createServer } from "node:http";

function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i >= 0) {
    const p = Number.parseInt(argv[i + 1], 10);
    if (!Number.isFinite(p)) throw new Error(`bad --port: ${argv[i + 1]}`);
    return p;
  }
  return Number.parseInt(process.env.E2E_UPSTREAM_PORT ?? "3002", 10);
}

const port = parsePort(process.argv.slice(2));

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// ── Anthropic ────────────────────────────────────────────────────────────────
//
// `messages.parse()` (used by /api/plan) JSON-parses `content[0].text` against
// the caller's zod schema — so the non-streaming response just needs a text
// block whose text is the structured JSON. plan.ts's PlanResponseSchema is
// { intent, entryPoints, questions }; the claim carries {kind:"description"}
// evidence, which survives assemblePlan's evidence check because cs-42 has a
// description. `questions` is required (added with the comprehension-quiz
// feature), so it must be present even though we leave it empty here — the
// quiz path has its own coverage in journey-quiz.spec.ts, which mocks
// /api/plan directly. An empty array keeps the J5 plan assertions
// deterministic (no quiz overlay is triggered off the back of this response).

const PLAN_OUTPUT = {
  intent: [
    {
      text: "FAKE-PLAN: introduces a user preferences panel backed by localStorage.",
      // A file evidence ref (cs-42 has this file) so the e2e suite can click
      // the reference and assert the cursor jumps. assemblePlan keeps refs
      // that validate against the changeset.
      evidence: [
        { kind: "description" },
        { kind: "file", path: "src/utils/storage.ts" },
      ],
    },
  ],
  entryPoints: [],
  questions: [],
};

function anthropicJsonResponse() {
  return {
    id: "msg_fake_plan",
    type: "message",
    role: "assistant",
    model: "claude-fake",
    content: [{ type: "text", text: JSON.stringify(PLAN_OUTPUT) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

// Standard Anthropic SSE event sequence — the SDK's MessageStream keys on the
// `event:` line, review.ts reads `type`/`delta`/`usage` off the parsed data.
function streamAnthropic(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const send = (event, data) =>
    res.write(
      `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`,
    );
  send("message_start", {
    message: {
      id: "msg_fake_review",
      type: "message",
      role: "assistant",
      model: "claude-fake",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send("content_block_start", {
    index: 0,
    content_block: { type: "text", text: "" },
  });
  send("content_block_delta", {
    index: 0,
    delta: { type: "text_delta", text: "FAKE-REVIEW: no issues spotted." },
  });
  send("content_block_stop", { index: 0 });
  send("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 8 },
  });
  send("message_stop", {});
  res.end();
}

async function handleAnthropic(req, res) {
  const body = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return json(res, 400, { error: "fake-upstream: bad JSON" });
  }
  if (parsed.stream === true) return streamAnthropic(res);
  return json(res, 200, anthropicJsonResponse());
}

// ── GitHub ───────────────────────────────────────────────────────────────────
//
// pr-load.ts fans out to four endpoints: pull meta, files, line comments, and
// issue comments. The fake serves a one-file PR with no comments — enough for
// the J3 happy path. Any Bearer token is accepted.

const PR_PATCH = `@@ -1,3 +1,4 @@
 export interface Prefs {
   theme: string;
+  density: "compact" | "cozy";
 }`;

function prMeta(owner, repo, number) {
  return {
    title: "Add preferences density toggle",
    body: "Adds a density toggle to the preferences panel.",
    state: "open",
    merged: false,
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    head: {
      sha: "head00000000000000000000000000000000aaaa",
      ref: "feat/density",
    },
    base: {
      sha: "base00000000000000000000000000000000bbbb",
      ref: "main",
    },
    user: { login: "octocat" },
    changed_files: 1,
  };
}

function handleGithub(req, res, url) {
  // /repos/:owner/:repo/pulls/:number(/files|/comments)?
  const pull = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(\/files|\/comments)?$/.exec(
    url.pathname,
  );
  if (pull) {
    const [, owner, repo, number, sub] = pull;
    // Owner-keyed trigger: lets a test exercise the rejected-token path.
    if (owner === "rejected-token") {
      return json(res, 401, { message: "Bad credentials" });
    }
    if (sub === "/files") {
      return json(res, 200, [
        { filename: "src/prefs.ts", status: "modified", patch: PR_PATCH },
      ]);
    }
    if (sub === "/comments") {
      // One multi-line review comment anchored to the patch — drives the
      // `L{a}–L{b}` line-range label.
      return json(res, 200, [
        {
          id: 9001,
          user: { login: "reviewer" },
          body: "Should this be a union type?",
          path: "src/prefs.ts",
          line: 3,
          original_line: 3,
          start_line: 2,
          original_start_line: 2,
          side: "RIGHT",
          diff_hunk: PR_PATCH,
          original_commit_id: "head00000000000000000000000000000000aaaa",
          html_url: `https://github.com/${owner}/${repo}/pull/${number}#discussion_r9001`,
        },
      ]);
    }
    return json(res, 200, prMeta(owner, repo, Number(number)));
  }
  // /repos/:owner/:repo/issues/:number/comments — issue-level conversation
  if (/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.test(url.pathname)) {
    return json(res, 200, [
      {
        id: 8001,
        user: { login: "maintainer" },
        body: "Thanks — can you add a test for the cozy mode?",
        created_at: "2026-05-01T12:00:00Z",
        html_url: "https://github.com/acme/widgets/pull/7#issuecomment-8001",
      },
    ]);
  }
  return json(res, 404, { message: "fake-upstream: no GitHub route" });
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    void handleAnthropic(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/repos/")) {
    handleGithub(req, res, url);
    return;
  }
  req.resume();
  json(res, 404, { error: `fake-upstream: ${req.method} ${url.pathname}` });
});

server.on("listening", () =>
  console.log(`[fake-upstream] listening on :${port}`),
);
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`[fake-upstream] :${port} already in use; assuming a sibling`);
    process.exit(0);
  }
  console.error("[fake-upstream] error", err);
  process.exit(1);
});
server.listen(port, "127.0.0.1");

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
