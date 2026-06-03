import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { getDefinitionCapabilities, resolveDefinition } from "./definitions.ts";
import { resolveCodeGraph, type CodeGraphRequest } from "./codeGraph.ts";
import { generatePlan } from "./plan.ts";
import * as library from "./library.ts";
import * as prompts from "./prompts.ts";
import { streamReview } from "./review.ts";
import * as worktrees from "./worktrees.ts";
import * as agentContext from "./agent-context.ts";
import * as mcpStatus from "./mcp-status.ts";
import * as agentQueue from "./agent-queue.ts";
import type {
  AgentResponseIntent,
  AskIntent,
  Interaction,
} from "./agent-queue.ts";
import { removePortFile, writePortFile } from "./port-file.ts";
import { serveStatic } from "./static-serve.ts";
import { getCredential, hasCredential } from "./auth/store.ts";
import {
  handleAuthSet,
  handleAuthClear,
  handleAuthList,
} from "./auth/endpoints.ts";
import {
  handleInteractionsGet,
  handleInteractionsUpsert,
  handleInteractionsEnqueue,
  handleInteractionsUnenqueue,
  handleInteractionsDelete,
} from "./db/interaction-endpoints.ts";
import { initDb, getDbStatus } from "./db/index.ts";
import {
  handleStatsEvent,
  handleStatsConsentGet,
  handleStatsConsentSet,
} from "./stats/endpoints.ts";
import { recordInstallStats } from "./stats/install.ts";
import { recordStat } from "./stats/record.ts";
import {
  RequestBodyTooLargeError,
  readBody,
  writeCorsHeaders,
} from "./http.ts";
import { parsePrUrl } from "./github/url.ts";
import { loadPr } from "./github/pr-load.ts";
import { GithubApiError } from "./github/api-client.ts";
import { lookupPrForBranch } from "./github/branch-lookup.ts";
import { assertGitDir } from "./worktree-validation.ts";
import type { ChangeSet } from "../../web/src/types.ts";
import type { DefinitionRequest } from "../../web/src/definitionTypes.ts";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = "127.0.0.1";
// When set, the server also serves the built web bundle from this directory, so
// `npm start` runs the whole app on one port. Unset in dev and in the Tauri
// sidecar, where the bundle is served elsewhere.
const WEB_DIST = process.env.SHIPPABLE_WEB_DIST;
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const ALLOWED_ORIGINS = loadAllowedOrigins();

// Server factory. The `.listen()` happens only in `main()` below — when the
// module is imported by tests we want to bind on an ephemeral port instead
// of the default 3001.
export function createApp(): Server {
  return createServer(async (req, res) => {
  let origin: string | null = null;
  try {
    const check = classifyRequestOrigin(req.headers.origin);
    const fetchSite = classifyFetchSite(req.headers["sec-fetch-site"]);
    origin = check.kind === "value" ? check.origin : null;
    if (req.method === "OPTIONS") {
      if (!isRequestAllowed(check, fetchSite)) {
        res.writeHead(403).end();
        return;
      }
      writeCorsHeaders(res, origin);
      res.writeHead(204).end();
      return;
    }
    if (!isRequestAllowed(check, fetchSite)) {
      console.warn(
        `[server] denied: origin=${JSON.stringify(req.headers.origin)} parsed=${JSON.stringify(check)} fetch-site=${fetchSite}`,
      );
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request not allowed" }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/plan") {
      return await handlePlan(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/review") {
      return await handleReview(req, res, origin);
    }
    if (req.method === "GET" && req.url === "/api/definition/capabilities") {
      return await handleDefinitionCapabilities(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/definition") {
      return await handleDefinition(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/code-graph") {
      return await handleCodeGraph(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/library/refresh") {
      return await handleLibraryRefresh(req, res, origin);
    }
    if (req.method === "GET" && req.url === "/api/library/prompts") {
      return await handleListPrompts(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/worktrees/list") {
      return await handleWorktreesList(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/worktrees/pick-directory") {
      return await handleWorktreesPickDirectory(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/worktrees/changeset") {
      return await handleWorktreesChangeset(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/worktrees/commits") {
      return await handleWorktreesCommits(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/worktrees/state") {
      return handleWorktreesState(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/worktrees/file-at") {
      return handleWorktreesFileAt(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/worktrees/graph") {
      return await handleWorktreesGraph(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/worktrees/sessions") {
      return await handleWorktreesSessions(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/worktrees/agent-context") {
      return await handleWorktreesAgentContext(req, res, origin);
    }
    if (req.method === "GET" && req.url === "/api/worktrees/mcp-status") {
      return await handleWorktreesMcpStatus(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/auth/set") {
      return await handleAuthSet(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/auth/clear") {
      return await handleAuthClear(req, res, origin);
    }
    if (req.method === "GET" && req.url === "/api/auth/list") {
      return await handleAuthList(req, res, origin);
    }
    if (req.method === "GET" && (req.url === "/api/interactions" || req.url?.startsWith("/api/interactions?"))) {
      return await handleInteractionsGet(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/interactions") {
      return await handleInteractionsUpsert(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/interactions/enqueue") {
      return await handleInteractionsEnqueue(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/interactions/unenqueue") {
      return await handleInteractionsUnenqueue(req, res, origin);
    }
    if (req.method === "DELETE" && (req.url === "/api/interactions" || req.url?.startsWith("/api/interactions?"))) {
      return await handleInteractionsDelete(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/github/pr/load") {
      return await handleGithubPrLoad(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/github/pr/branch-lookup") {
      return await handleGithubPrBranchLookup(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/agent/interactions") {
      return await handleAgentInteractions(req, res, origin);
    }
    if (
      req.method === "GET" &&
      req.url &&
      req.url.startsWith("/api/agent/delivered")
    ) {
      return await handleAgentDelivered(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/agent/replies") {
      return await handleAgentPostReply(req, res, origin);
    }
    if (
      req.method === "GET" &&
      req.url &&
      req.url.startsWith("/api/agent/replies")
    ) {
      return await handleAgentListReplies(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/stats/event") {
      return await handleStatsEvent(req, res, origin);
    }
    if (req.method === "GET" && req.url === "/api/stats/consent") {
      return await handleStatsConsentGet(req, res, origin);
    }
    if (req.method === "POST" && req.url === "/api/stats/consent") {
      return await handleStatsConsentSet(req, res, origin);
    }
    if (req.method === "GET" && req.url === "/api/health") {
      writeCorsHeaders(res, origin);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, db: getDbStatus() }));
      return;
    }
    // Static serving never shadows the API namespace: an unmatched /api GET
    // (with or without a query string) must fall through to the JSON 404, not
    // the SPA shell. Match on the path alone so `/api?x=1` is reserved too.
    const reqPath = req.url?.split(/[?#]/, 1)[0];
    const isApi = reqPath === "/api" || reqPath?.startsWith("/api/");
    if (WEB_DIST && req.method === "GET" && req.url && !isApi) {
      if (await serveStatic(WEB_DIST, req.url, res)) return;
    }
    writeCorsHeaders(res, origin);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      // Map oversized-body rejections from `readBody` to a real
      // 413 instead of a generic 500 — clients can recover, ops can
      // grep for it, and the security signal isn't lost in the noise.
      // CORS headers matter here: without them the browser drops the
      // response and fetch surfaces a generic "Load failed", hiding the
      // real reason from the UI.
      if (!res.headersSent) {
        writeCorsHeaders(res, origin);
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    console.error("[server] unhandled error:", err);
    if (!res.headersSent) {
      writeCorsHeaders(res, origin);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal server error" }));
    }
  }
  });
}

async function handlePlan(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  if (!hasCredential({ kind: "anthropic" })) {
    writeCorsHeaders(res, origin);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "anthropic_key_missing" }));
    return;
  }
  const body = await readBody(req);
  let parsed: { changeset?: ChangeSet };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const cs = parsed.changeset;
  if (!cs || typeof cs !== "object" || !("files" in cs)) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected { changeset: ChangeSet }" }));
    return;
  }

  const started = Date.now();
  console.log(`[server] /api/plan cs=${cs.id} files=${cs.files.length}`);
  try {
    const { plan, questions } = await generatePlan(cs);
    const ms = Date.now() - started;
    console.log(
      `[server]   → ok in ${ms}ms: ${plan.intent.length} claims, ${plan.entryPoints.length} entry points, ${questions.length} questions`,
    );
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ plan, questions }));
  } catch (err) {
    const ms = Date.now() - started;
    console.error(`[server]   → err in ${ms}ms:`, err);
    const message = err instanceof Error ? err.message : String(err);
    writeCorsHeaders(res, origin);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

// Per-IP fixed-window limiter on the streaming endpoint. Defaults to 30 requests per minute as a check against accidental/local spam; tune with:
const REVIEW_RATE_LIMIT = Number(process.env.SHIPPABLE_REVIEW_RATE_LIMIT ?? 30);
const REVIEW_RATE_WINDOW_MS = 60_000;
const reviewRequestLog = new Map<string, number[]>();

function checkReviewRateLimit(ip: string): { allowed: true } | { allowed: false; resetSec: number } {
  const now = Date.now();
  const live = (reviewRequestLog.get(ip) ?? []).filter(
    (t) => now - t < REVIEW_RATE_WINDOW_MS,
  );
  if (live.length >= REVIEW_RATE_LIMIT) {
    reviewRequestLog.set(ip, live);
    const resetSec = Math.ceil((REVIEW_RATE_WINDOW_MS - (now - live[0])) / 1000);
    return { allowed: false, resetSec };
  }
  live.push(now);
  reviewRequestLog.set(ip, live);
  return { allowed: true };
}

async function handleReview(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  if (!hasCredential({ kind: "anthropic" })) {
    writeCorsHeaders(res, origin);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "anthropic_key_missing" }));
    return;
  }
  const ip = req.socket.remoteAddress ?? "unknown";
  const gate = checkReviewRateLimit(ip);
  if (!gate.allowed) {
    writeCorsHeaders(res, origin);
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": gate.resetSec.toString(),
    });
    res.end(
      JSON.stringify({
        error: `rate limit exceeded — try again in ${gate.resetSec}s (${REVIEW_RATE_LIMIT} requests / 60s)`,
      }),
    );
    return;
  }
  const body = await readBody(req);
  writeCorsHeaders(res, origin);
  await streamReview(body, req, res);
}

async function handleDefinitionCapabilities(
  _req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  writeCorsHeaders(res, origin);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(getDefinitionCapabilities()));
}

async function handleDefinition(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: DefinitionRequest;
  try {
    parsed = JSON.parse(body) as DefinitionRequest;
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const result = await resolveDefinition(parsed);
  writeCorsHeaders(res, origin);
  res.writeHead(result.status === "error" ? 502 : 200, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(result));
}

async function handleCodeGraph(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: CodeGraphRequest;
  try {
    parsed = JSON.parse(body) as CodeGraphRequest;
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  try {
    const result = await resolveCodeGraph(parsed);
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[server] /api/code-graph err: ${message}`);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleListPrompts(
  _req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  try {
    const list = await prompts.list();
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ prompts: list }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[server] /api/library/prompts err:", err);
    writeCorsHeaders(res, origin);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleLibraryRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const adminToken = process.env.SHIPPABLE_ADMIN_TOKEN?.trim();
  const devMode = process.env.SHIPPABLE_DEV_MODE === "1";
  if (!devMode) {
    if (!adminToken) {
      writeCorsHeaders(res, origin);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "library refresh requires SHIPPABLE_ADMIN_TOKEN" }));
      return;
    }
    const provided = req.headers["x-admin-token"];
    if (provided !== adminToken) {
      writeCorsHeaders(res, origin);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid admin token" }));
      return;
    }
  }

  const started = Date.now();
  try {
    const source = await library.sync();
    const ms = Date.now() - started;
    const ref = source.kind === "git" ? await library.currentRef() : null;
    console.log(
      `[server] /api/library/refresh kind=${source.kind} root=${source.root} ms=${ms}`,
    );
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        kind: source.kind,
        root: source.root,
        ref,
      }),
    );
  } catch (err) {
    const ms = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] /api/library/refresh err in ${ms}ms:`, err);
    writeCorsHeaders(res, origin);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleWorktreesList(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: { dir?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const dir = typeof parsed.dir === "string" ? parsed.dir : "";
  if (!dir) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected { dir: string }" }));
    return;
  }
  try {
    const result = await worktrees.listWorktrees(dir);
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[server] /api/worktrees/list err: ${message}`);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleWorktreesChangeset(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: {
    path?: unknown;
    ref?: unknown;
    dirty?: unknown;
    fromRef?: unknown;
    toRef?: unknown;
    includeDirty?: unknown;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const wtPath = typeof parsed.path === "string" ? parsed.path : "";
  const ref =
    typeof parsed.ref === "string" && parsed.ref.length > 0 ? parsed.ref : null;
  const dirty = parsed.dirty === true;
  const fromRef =
    typeof parsed.fromRef === "string" && parsed.fromRef.length > 0
      ? parsed.fromRef
      : null;
  const toRef =
    typeof parsed.toRef === "string" && parsed.toRef.length > 0
      ? parsed.toRef
      : null;
  const includeDirty = parsed.includeDirty === true;
  if (!wtPath) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "expected { path: string, ref?: string, dirty?: boolean, fromRef?: string, toRef?: string, includeDirty?: boolean }",
      }),
    );
    return;
  }
  try {
    // Routing precedence: range > dirty > single-ref > cumulative branch view.
    // Strict superset of the original contract — legacy callers (no fromRef/toRef)
    // still hit the dirty/ref/branch paths unchanged.
    const result =
      fromRef && toRef
        ? await worktrees.rangeChangeset(wtPath, fromRef, toRef, includeDirty)
        : dirty
          ? await worktrees.dirtyChangesetFor(wtPath)
          : ref
            ? await worktrees.changesetFor(wtPath, ref)
            : await worktrees.branchChangeset(wtPath);
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[server] /api/worktrees/changeset err: ${message}`);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleWorktreesCommits(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: { path?: unknown; limit?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const wtPath = typeof parsed.path === "string" ? parsed.path : "";
  const limit = typeof parsed.limit === "number" ? parsed.limit : undefined;
  if (!wtPath) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "expected { path: string, limit?: number }" }),
    );
    return;
  }
  try {
    const commits = await worktrees.listCommits(wtPath, limit);
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ commits }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[server] /api/worktrees/commits err: ${message}`);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleWorktreesState(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: { path?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const wtPath = typeof parsed.path === "string" ? parsed.path : "";
  if (!wtPath) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected { path: string }" }));
    return;
  }
  try {
    const state = await worktrees.stateFor(wtPath);
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 404 on missing/non-git paths so the client can stop polling cleanly
    // without a banner-spamming log of generic 400s.
    const status = /does not exist|not a directory|no \.git entry/.test(message)
      ? 404
      : 400;
    writeCorsHeaders(res, origin);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleWorktreesFileAt(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: { path?: unknown; sha?: unknown; file?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const wtPath = typeof parsed.path === "string" ? parsed.path : "";
  const sha = typeof parsed.sha === "string" ? parsed.sha : "";
  const file = typeof parsed.file === "string" ? parsed.file : "";
  if (!wtPath || !sha || !file) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "expected { path: string, sha: string, file: string }",
      }),
    );
    return;
  }
  try {
    const content = await worktrees.fileAt(wtPath, sha, file);
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[server] /api/worktrees/file-at err: ${message}`);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleWorktreesGraph(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: { path?: unknown; ref?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const wtPath = typeof parsed.path === "string" ? parsed.path : "";
  const ref = typeof parsed.ref === "string" && parsed.ref.length > 0 ? parsed.ref : "HEAD";
  if (!wtPath) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected { path: string, ref?: string }" }));
    return;
  }
  try {
    const graph = await worktrees.repoGraphFor(wtPath, ref);
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ graph }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[server] /api/worktrees/graph err: ${message}`);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleWorktreesSessions(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: { path?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const wtPath = typeof parsed.path === "string" ? parsed.path : "";
  if (!wtPath) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected { path: string }" }));
    return;
  }
  try {
    const sessions = await agentContext.listSessionsForWorktree(wtPath);
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[server] /api/worktrees/sessions err: ${message}`);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleWorktreesPickDirectory(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: { startPath?: unknown } = {};
  if (body.trim().length > 0) {
    try {
      parsed = JSON.parse(body);
    } catch {
      writeCorsHeaders(res, origin);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
  }
  const startPath =
    typeof parsed.startPath === "string" && parsed.startPath.length > 0
      ? parsed.startPath
      : undefined;
  try {
    const result = await worktrees.pickDirectory(startPath);
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[server] /api/worktrees/pick-directory err: ${message}`);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleWorktreesAgentContext(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: {
    path?: unknown;
    sessionFilePath?: unknown;
    commitSha?: unknown;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const wtPath = typeof parsed.path === "string" ? parsed.path : "";
  const sessionFilePath =
    typeof parsed.sessionFilePath === "string" ? parsed.sessionFilePath : "";
  const commitSha =
    typeof parsed.commitSha === "string" && parsed.commitSha.length > 0
      ? parsed.commitSha
      : null;
  if (!wtPath || !sessionFilePath) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "expected { path: string, sessionFilePath: string, commitSha?: string }",
      }),
    );
    return;
  }
  try {
    const slice = await agentContext.agentContextForCommit({
      worktreePath: wtPath,
      sessionFilePath,
      commitSha,
    });
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ slice }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[server] /api/worktrees/agent-context err: ${message}`);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

async function handleWorktreesMcpStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  // Errors here can only come from the helper itself (it already swallows
  // missing/malformed config files); surface them as 500 so the panel falls
  // back to the install affordance rather than wedging in a "loading" state.
  try {
    const status = await mcpStatus.checkMcpStatus();
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeCorsHeaders(res, origin);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

const ASK_INTENTS: readonly AskIntent[] = [
  "comment",
  "question",
  "request",
  "blocker",
];

const RESPONSE_INTENTS_FOR_AGENT: readonly AgentResponseIntent[] = [
  "ack",
  "accept",
  "reject",
];

async function handleGithubPrLoad(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: { prUrl?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (typeof parsed.prUrl !== "string" || !parsed.prUrl) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected { prUrl: string }" }));
    return;
  }

  let coords: ReturnType<typeof parsePrUrl>;
  try {
    coords = parsePrUrl(parsed.prUrl);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_pr_url", detail }));
    return;
  }

  const token = getCredential({ kind: "github", host: coords.host });
  if (!token) {
    writeCorsHeaders(res, origin);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "github_token_required", host: coords.host }),
    );
    return;
  }

  try {
    const result = await loadPr(coords, token);
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    if (err instanceof GithubApiError) {
      const e = err.error;
      if (e.kind === "github_token_required") {
        writeCorsHeaders(res, origin);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.kind, host: e.host }));
        return;
      }
      if (e.kind === "github_auth_failed") {
        writeCorsHeaders(res, origin);
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.kind, host: e.host, hint: e.hint }));
        return;
      }
      if (e.kind === "github_pr_not_found") {
        writeCorsHeaders(res, origin);
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.kind }));
        return;
      }
      if (e.kind === "github_upstream") {
        writeCorsHeaders(res, origin);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: e.kind,
            status: e.status,
            message: e.message,
          }),
        );
        return;
      }
      if (e.kind === "github_network") {
        console.warn(
          `[server] github_network: host=${e.host} detail=${e.detail}`,
        );
        writeCorsHeaders(res, origin);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: e.kind, host: e.host, detail: e.detail }),
        );
        return;
      }
    }
    throw err;
  }
}

async function handleGithubPrBranchLookup(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: { worktreePath?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (typeof parsed.worktreePath !== "string" || !parsed.worktreePath) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected { worktreePath: string }" }));
    return;
  }

  try {
    const result = await lookupPrForBranch(
      parsed.worktreePath,
      (host) => getCredential({ kind: "github", host }),
    );
    if (result.kind === "token_required") {
      writeCorsHeaders(res, origin);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "github_token_required",
          host: result.host,
        }),
      );
      return;
    }
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ matched: result.matched }));
  } catch (err) {
    if (err instanceof GithubApiError && err.error.kind === "github_network") {
      const e = err.error;
      console.warn(
        `[server] github_network (branch-lookup): host=${e.host} detail=${e.detail}`,
      );
      writeCorsHeaders(res, origin);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: e.kind, host: e.host, detail: e.detail }),
      );
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

function isAgentResponseIntent(value: unknown): value is AgentResponseIntent {
  return (
    typeof value === "string" &&
    RESPONSE_INTENTS_FOR_AGENT.includes(value as AgentResponseIntent)
  );
}

type AgentInteractionStatus = "unread" | "delivered" | "all";

function isAgentInteractionStatus(v: unknown): v is AgentInteractionStatus {
  return v === "unread" || v === "delivered" || v === "all";
}

// Earliest interaction's sha; entries in one batch usually share a sha anyway.
function earliestCommitSha(interactions: Interaction[]): string {
  const earliest = interactions.reduce<Interaction | undefined>(
    (acc, c) => (!acc || c.enqueuedAt < acc.enqueuedAt ? c : acc),
    undefined,
  );
  return earliest?.commitSha ?? "";
}

// POST /api/agent/interactions — body { worktreePath, status }. `unread` drains
// the pending queue (acks → delivered); `delivered`/`all` are read-only.
async function handleAgentInteractions(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: { worktreePath?: unknown; status?: unknown; watch?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const wtPath =
    typeof parsed.worktreePath === "string" ? parsed.worktreePath : "";
  if (!wtPath) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected { worktreePath: string }" }));
    return;
  }
  if (!isAgentInteractionStatus(parsed.status)) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "status must be one of: unread, delivered, all" }),
    );
    return;
  }
  try {
    await assertGitDir(wtPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
    return;
  }
  // A watch-mode poll tags itself so the panel can show "Agent is watching".
  // Watch mode only ever drains (status `unread`), but the marker is
  // status-agnostic — it records that an agent is actively polling.
  if (parsed.watch === true) {
    agentQueue.markWatchPoll(wtPath);
  }
  const resolved =
    parsed.status === "unread"
      ? agentQueue.pullAndAck(wtPath)
      : parsed.status === "delivered"
        ? agentQueue.readInteractions(wtPath, ["delivered"])
        : agentQueue.readAllInteractions(wtPath);
  // `ids` reports only what this call resolved/drained; parents are pulled in
  // read-only for context and must not count as delivered.
  const ids = resolved.map((c) => c.id);
  const forPayload = agentQueue.withReferencedParents(wtPath, resolved);
  const payload = agentQueue.formatPayload(
    forPayload,
    earliestCommitSha(forPayload),
  );
  writeCorsHeaders(res, origin);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ payload, ids }));
}

async function handleAgentDelivered(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  // Read the URL-encoded `path` query param off req.url. Use a dummy base
  // since req.url is path+query only.
  const url = new URL(req.url ?? "", "http://localhost");
  const wtPath = url.searchParams.get("path") ?? "";
  if (!wtPath) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected ?path=<worktreePath>" }));
    return;
  }
  try {
    await assertGitDir(wtPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
    return;
  }
  const delivered = agentQueue.listDelivered(wtPath);
  writeCorsHeaders(res, origin);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ delivered }));
}

async function handleAgentPostReply(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const body = await readBody(req);
  let parsed: {
    worktreePath?: unknown;
    parentId?: unknown;
    file?: unknown;
    lines?: unknown;
    target?: unknown;
    body?: unknown;
    intent?: unknown;
    agentLabel?: unknown;
    rationale?: unknown;
    suggestedFix?: unknown;
    confidence?: unknown;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const wtPath =
    typeof parsed.worktreePath === "string" ? parsed.worktreePath : "";
  const replyBody = typeof parsed.body === "string" ? parsed.body : "";
  if (!wtPath || replyBody.length === 0) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "expected { worktreePath, body, intent, and either parentId (reply) or file+lines+target (top-level) }",
      }),
    );
    return;
  }
  try {
    await assertGitDir(wtPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
    return;
  }
  const agentLabel =
    typeof parsed.agentLabel === "string" && parsed.agentLabel.length > 0
      ? parsed.agentLabel
      : undefined;
  const hasParent =
    typeof parsed.parentId === "string" && parsed.parentId.length > 0;
  const hasAnchor =
    typeof parsed.file === "string" &&
    parsed.file.length > 0 &&
    typeof parsed.lines === "string" &&
    parsed.lines.length > 0;
  if (hasParent === hasAnchor) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "exactly one of { parentId } (reply) or { file, lines, target } (top-level) must be set",
      }),
    );
    return;
  }
  if (hasParent) {
    const parentId = parsed.parentId as string;
    if (!isAgentResponseIntent(parsed.intent)) {
      writeCorsHeaders(res, origin);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "reply intent must be ack | accept | reject" }));
      return;
    }
    // Reject replies whose parentId isn't a real interaction for this
    // worktree — a fabricated id would silently create an orphan the UI
    // merge step drops. A reviewer comment (any queue state) or an
    // agent-authored comment are all valid targets.
    if (!agentQueue.interactionExistsForWorktree(wtPath, parentId)) {
      writeCorsHeaders(res, origin);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `parentId ${JSON.stringify(parentId)} is not an interaction for this worktree`,
        }),
      );
      return;
    }
    const id = agentQueue.postReply(wtPath, {
      parentId,
      body: replyBody,
      intent: parsed.intent,
      agentLabel,
    });
    recordStat("comment-posted-agent");
    writeCorsHeaders(res, origin);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id }));
    return;
  }
  // Top-level — intent must be an ask; target must be line | block.
  if (
    typeof parsed.intent !== "string" ||
    !ASK_INTENTS.includes(parsed.intent as AskIntent)
  ) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "top-level intent must be comment | question | request | blocker",
      }),
    );
    return;
  }
  if (parsed.target !== "line" && parsed.target !== "block") {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "top-level target must be line | block" }));
    return;
  }
  // The MCP boundary enforces the `rationale`-required rule; the server only
  // light-validates `confidence` against the enum.
  if (
    parsed.confidence !== undefined &&
    parsed.confidence !== "low" &&
    parsed.confidence !== "medium" &&
    parsed.confidence !== "high"
  ) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "confidence must be low | medium | high" }));
    return;
  }
  const id = agentQueue.postTopLevel(wtPath, {
    file: parsed.file as string,
    lines: parsed.lines as string,
    target: parsed.target,
    body: replyBody,
    intent: parsed.intent as AskIntent,
    agentLabel,
    rationale:
      typeof parsed.rationale === "string" ? parsed.rationale : undefined,
    suggestedFix:
      typeof parsed.suggestedFix === "string" ? parsed.suggestedFix : undefined,
    confidence: parsed.confidence,
  });
  recordStat("comment-posted-agent");
  writeCorsHeaders(res, origin);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id }));
}

async function handleAgentListReplies(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
) {
  const url = new URL(req.url ?? "", "http://localhost");
  const wtPath = url.searchParams.get("worktreePath") ?? "";
  if (!wtPath) {
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected ?worktreePath=<worktreePath>" }));
    return;
  }
  try {
    await assertGitDir(wtPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeCorsHeaders(res, origin);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
    return;
  }
  const replies = agentQueue.listReplies(wtPath);
  writeCorsHeaders(res, origin);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ replies, watching: agentQueue.isWatching(wtPath) }));
}

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    // WHATWG URL spec returns the literal string "null" for `.origin` of any
    // non-special scheme (tauri://, app://, file://, etc.), which would
    // collapse every tauri:// URL into the same allowlist entry. Reconstruct
    // a stable scheme+host form so each non-special origin stays distinct.
    if (url.origin === "null") {
      return `${url.protocol}//${url.host}`;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function loadAllowedOrigins(): Set<string> {
  const configured = process.env.SHIPPABLE_ALLOWED_ORIGINS;
  const source =
    configured === undefined
      ? DEFAULT_ALLOWED_ORIGINS
      : configured.split(",");
  return new Set(
    source
      .map((origin) => parseOrigin(origin.trim()))
      .filter((origin): origin is string => !!origin),
  );
}

type OriginCheck =
  | { kind: "absent" }
  | { kind: "opaque" }
  | { kind: "value"; origin: string };

function classifyRequestOrigin(value: string | undefined): OriginCheck {
  // "absent": no Origin header — non-browser caller (curl, Vite dev proxy).
  // "opaque": header present but unparseable, including the literal string
  //   "null" that browsers send from sandboxed iframes, data: URLs, and some
  //   cross-origin redirects. Must be denied — collapsing this to "absent"
  //   is a CSRF hole (see git history for the exploit).
  // "value": parseable origin; check against the allowlist.
  if (value === undefined) return { kind: "absent" };
  const parsed = parseOrigin(value);
  return parsed === null
    ? { kind: "opaque" }
    : { kind: "value", origin: parsed };
}

type FetchSite = "same-origin" | "same-site" | "cross-site" | "none";

function classifyFetchSite(
  value: string | string[] | undefined,
): FetchSite | null {
  if (
    value === "same-origin" ||
    value === "same-site" ||
    value === "cross-site" ||
    value === "none"
  ) {
    return value;
  }
  return null;
}

function isRequestAllowed(
  check: OriginCheck,
  fetchSite: FetchSite | null,
): boolean {
  // Browser requests that present an Origin header must match the explicit
  // allowlist — with one safe exception: a browser-labelled `same-origin`
  // request (see below). `Sec-Fetch-Site` otherwise only ever narrows access,
  // never broadens it.
  if (check.kind === "value") {
    if (ALLOWED_ORIGINS.has(check.origin)) return true;
    // A request the browser labels same-origin came from a page this server
    // served itself (single-port `npm start`). Same-origin is never cross-site,
    // so it can't be CSRF — allow it regardless of the host, which varies on
    // remote sandboxes and can't be pinned in the allowlist ahead of time.
    // `Sec-Fetch-Site` is browser-set and unspoofable by page scripts.
    return fetchSite === "same-origin";
  }
  // Opaque origins (`Origin: null`, sandboxed iframes, data: URLs, some
  // redirects) are always denied.
  if (check.kind === "opaque") {
    return false;
  }
  // No Origin header: allow non-browser callers (curl, the Vite dev proxy).
  // If a browser somehow reports this as cross-site, deny it anyway.
  if (fetchSite === "cross-site") {
    return false;
  }
  // Otherwise this is either a non-browser caller or a legacy browser that
  // didn't send enough fetch metadata to classify further.
  switch (check.kind) {
    case "absent":
      return true;
  }
}

async function main() {
  if (process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "[server] ANTHROPIC_API_KEY is set in the environment but is no longer used; configure via the Settings panel.",
    );
  }
  // Open + migrate the SQLite store before binding. initDb never throws — a
  // failure is captured as the DB status and surfaced via /api/health.
  await initDb();
  const dbStatus = getDbStatus();
  if (dbStatus.status === "error") {
    console.error(`[server] database unavailable: ${dbStatus.error}`);
  } else {
    recordInstallStats();
  }
  const server = createApp();
  server.listen(PORT, HOST, () => {
    const allowed = ALLOWED_ORIGINS.size > 0 ? [...ALLOWED_ORIGINS].join(", ") : "(none)";
    console.log(`[server] listening on http://${HOST}:${PORT}`);
    console.log(`[server] allowed browser origins: ${allowed}`);
    // Gated so the dev server (`npm run server`) doesn't fight the Tauri
    // sidecar for the same on-disk file. The Tauri shell sets the env
    // var when spawning us; nobody else should.
    if (process.env.SHIPPABLE_WRITE_PORT_FILE) {
      void writePortFile(PORT);
    }
  });

  // Best-effort removal so MCP clients don't chase a dead port across
  // restarts. We schedule the unlink and exit immediately — kernel flushes
  // the rename before the process goes away. ENOENT is swallowed inside.
  const cleanup = () => {
    if (process.env.SHIPPABLE_WRITE_PORT_FILE) void removePortFile();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// Only run main when executed directly (not when imported by tests).
const isEntry =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (isEntry) {
  void main();
}
