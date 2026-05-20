import { discoverSidecarPort } from "./port-discovery.js";

export const DEFAULT_PORT = 3001;

/** How often the watch loop re-polls `/api/agent/interactions` for new comments. */
export const POLL_INTERVAL_MS = 2000;

/** Watch-loop timeout bounds. The agent re-calls, so a short window is costless. */
export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 300;

/**
 * Appended to a watch result that delivered comments. Keeps the loop
 * self-sustaining even after the tool description fades from the model's
 * focus (mirrors the auto-reply-hint pattern).
 */
export const WATCH_DELIVERED_HINT =
  "Address the reviewer comments above. After you handle each one, post the " +
  "outcome back with `shippable_post_review_comment`. Then call " +
  "`shippable_watch_review_comments` again to keep watching for the next batch.";

/** Appended to a watch result that timed out with nothing pending. */
export const WATCH_IDLE_HINT =
  "No comments arrived yet — call `shippable_watch_review_comments` again to " +
  "keep watching. The reviewer ends watch mode by interrupting you.";

export interface HandlerDeps {
  fetchFn?: typeof fetch;
  port?: number;
  cwd?: () => string;
  /**
   * Discovery override for tests. When omitted, production uses the
   * real `discoverSidecarPort` which reads the sidecar's port file and
   * health-checks before returning a port.
   */
  discoverPortFn?: () => Promise<number | null>;
  /** Watch-loop seams for deterministic tests. Production: real setTimeout / Date.now. */
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [x: string]: unknown;
}

interface PullResponse {
  payload: string;
  ids: string[];
}

export type AgentInteractionStatus = "unread" | "delivered" | "all";

async function resolvePort(deps?: HandlerDeps): Promise<number> {
  if (deps?.port !== undefined) return deps.port;
  const envPort = process.env.SHIPPABLE_PORT;
  if (envPort !== undefined && envPort !== "") {
    const parsed = Number(envPort);
    if (Number.isFinite(parsed)) return parsed;
  }
  // The Tauri sidecar picks an ephemeral port and writes it to an
  // OS-conventional port file (see server/src/port-file.ts). Discovery
  // health-checks before returning, so a stale file from a crashed
  // sidecar falls through to the default.
  const discoverFn = deps?.discoverPortFn ?? discoverSidecarPort;
  const discovered = await discoverFn();
  if (discovered !== null) return discovered;
  return DEFAULT_PORT;
}

function resolveWorktreePath(
  input: { worktreePath?: string },
  deps?: HandlerDeps,
): string {
  if (input.worktreePath !== undefined && input.worktreePath !== "") {
    return input.worktreePath;
  }
  if (deps?.cwd) return deps.cwd();
  return process.cwd();
}

function errorResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

export async function handleCheckReviewComments(
  input: { worktreePath?: string; status: AgentInteractionStatus },
  deps?: HandlerDeps,
): Promise<ToolResult> {
  const port = await resolvePort(deps);
  const worktreePath = resolveWorktreePath(input, deps);
  const baseUrl = `http://127.0.0.1:${port}`;
  const url = `${baseUrl}/api/agent/interactions`;
  const fetchFn = deps?.fetchFn ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreePath, status: input.status }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(
      `Error contacting Shippable server at ${baseUrl}: ${message}`,
    );
  }

  if (!response.ok) {
    return errorResult(
      `Error contacting Shippable server at ${baseUrl}: HTTP ${response.status}`,
    );
  }

  let body: PullResponse;
  try {
    body = (await response.json()) as PullResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(
      `Error contacting Shippable server at ${baseUrl}: invalid JSON response (${message})`,
    );
  }

  const text = typeof body.payload === "string" && body.payload.length > 0
    ? body.payload
    : "No pending comments.";
  return {
    content: [{ type: "text", text }],
  };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampTimeoutSeconds(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, seconds));
}

/**
 * Watch mode: poll `/api/agent/interactions` until reviewer comments arrive or
 * the timeout elapses, then return — always. The agent loops the tool either
 * way, so live review needs only one kickoff prompt. Each poll uses
 * `status: "unread"` — watch mode drains the queue, same as a one-shot check.
 */
export async function handleWatchReviewComments(
  input: { worktreePath?: string; timeoutSeconds?: number },
  deps?: HandlerDeps,
): Promise<ToolResult> {
  const port = await resolvePort(deps);
  const worktreePath = resolveWorktreePath(input, deps);
  const baseUrl = `http://127.0.0.1:${port}`;
  const url = `${baseUrl}/api/agent/interactions`;
  const fetchFn = deps?.fetchFn ?? fetch;
  const sleepFn = deps?.sleepFn ?? realSleep;
  const nowFn = deps?.nowFn ?? Date.now;

  const timeoutSeconds = clampTimeoutSeconds(input.timeoutSeconds);
  const deadline = nowFn() + timeoutSeconds * 1000;

  for (;;) {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktreePath, status: "unread", watch: true }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(
        `Error contacting Shippable server at ${baseUrl}: ${message}`,
      );
    }

    if (!response.ok) {
      return errorResult(
        `Error contacting Shippable server at ${baseUrl}: HTTP ${response.status}`,
      );
    }

    let body: PullResponse;
    try {
      body = (await response.json()) as PullResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(
        `Error contacting Shippable server at ${baseUrl}: invalid JSON response (${message})`,
      );
    }

    if (typeof body.payload === "string" && body.payload.length > 0) {
      return {
        content: [
          { type: "text", text: `${body.payload}\n\n${WATCH_DELIVERED_HINT}` },
        ],
      };
    }
    if (nowFn() >= deadline) {
      return {
        content: [
          {
            type: "text",
            text: `No reviewer comments arrived within the watch window.\n\n${WATCH_IDLE_HINT}`,
          },
        ],
      };
    }
    await sleepFn(POLL_INTERVAL_MS);
  }
}

export type AgentResponseIntent = "ack" | "accept" | "reject";
export type AskIntent = "comment" | "question" | "request" | "blocker";
export type AgentIntent = AgentResponseIntent | AskIntent;

interface PostCommentInput {
  worktreePath?: string;
  /** Reply mode: the id of the interaction this entry answers. */
  parentInteractionId?: string;
  /** Top-level mode: 'line' for a single line, 'block' for a range. */
  target?: "line" | "block";
  /** Top-level mode: repo-relative file path. */
  file?: string;
  /** Top-level mode: the line number or inclusive range, e.g. "118" or "72-79". */
  lines?: string;
  /**
   * Free-form prose for the interaction. Named `replyText` rather than
   * `body` because some model serializers conflate `body` with HTML's
   * `<body>` element and emit `</body>` close tags into the value — see
   * docs/sdd/agent-reply-support/spec.md. The HTTP wire field on the
   * local Shippable server stays `body`; the rename is contained to the
   * MCP boundary because that's where the serializer problem bites.
   */
  replyText: string;
  intent: AgentIntent;
}

interface PostCommentResponse {
  id: string;
}

const ASK_INTENTS: readonly AskIntent[] = [
  "comment",
  "question",
  "request",
  "blocker",
];
const RESPONSE_INTENTS: readonly AgentResponseIntent[] = [
  "ack",
  "accept",
  "reject",
];

function isAskIntent(value: unknown): value is AskIntent {
  return (
    typeof value === "string" && ASK_INTENTS.includes(value as AskIntent)
  );
}

function isResponseIntent(value: unknown): value is AgentResponseIntent {
  return (
    typeof value === "string" &&
    RESPONSE_INTENTS.includes(value as AgentResponseIntent)
  );
}

export async function handlePostReviewComment(
  input: PostCommentInput,
  deps?: HandlerDeps,
): Promise<ToolResult> {
  const port = await resolvePort(deps);
  const worktreePath = resolveWorktreePath(input, deps);
  const baseUrl = `http://127.0.0.1:${port}`;
  const url = `${baseUrl}/api/agent/replies`;
  const fetchFn = deps?.fetchFn ?? fetch;

  const hasParent =
    typeof input.parentInteractionId === "string" &&
    input.parentInteractionId.length > 0;
  const hasAnchor =
    typeof input.target === "string" &&
    typeof input.file === "string" &&
    input.file.length > 0 &&
    typeof input.lines === "string" &&
    input.lines.length > 0;
  if (hasParent === hasAnchor) {
    return errorResult(
      "Either parentInteractionId (reply mode) or target+file+lines (top-level mode) must be set — never both.",
    );
  }
  if (hasParent && !isResponseIntent(input.intent)) {
    return errorResult(
      "Reply intent must be one of: ack, accept, reject.",
    );
  }
  if (!hasParent && !isAskIntent(input.intent)) {
    return errorResult(
      "Top-level intent must be one of: comment, question, request, blocker.",
    );
  }

  // Translate MCP-boundary names to the HTTP wire shape — server-side
  // stays `parentId` + `body` (see PostCommentInput JSDoc for why the
  // MCP names diverge).
  const payload: Record<string, unknown> = {
    worktreePath,
    body: input.replyText,
    intent: input.intent,
  };
  if (hasParent) {
    payload.parentId = input.parentInteractionId;
  } else {
    payload.target = input.target;
    payload.file = input.file;
    payload.lines = input.lines;
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(
      `Error contacting Shippable server at ${baseUrl}: ${message}`,
    );
  }

  if (!response.ok) {
    return errorResult(
      `Error contacting Shippable server at ${baseUrl}: HTTP ${response.status}`,
    );
  }

  let parsed: PostCommentResponse;
  try {
    parsed = (await response.json()) as PostCommentResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(
      `Error contacting Shippable server at ${baseUrl}: invalid JSON response (${message})`,
    );
  }

  const summary = hasParent
    ? `Posted reply ${parsed.id} for interaction ${input.parentInteractionId}.`
    : `Posted ${input.intent} ${parsed.id} on ${input.file}:${input.lines}.`;
  return {
    content: [{ type: "text", text: summary }],
  };
}
