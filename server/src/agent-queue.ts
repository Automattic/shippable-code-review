import {
  pullAndAck as storePullAndAck,
  listByQueueStatus as storeListByQueueStatus,
  postAgentInteraction,
  listAgentReplies,
  isDeliveredInteractionId as storeIsDelivered,
  type AgentQueueStatus,
  type StoredInteraction,
} from "./db/interaction-store.ts";
import { resetForTests as resetDb } from "./db/index.ts";

/**
 * Mint a fresh agent-authored interaction id. `a-` prefix mirrors the
 * reviewer-side `r-` (see web/src/interactions.ts newReviewerInteractionId)
 * so DB inspection distinguishes origin at a glance. The random suffix
 * guards against two agent posts arriving in the same millisecond — the
 * `interactions` table's UPSERT silently overwrites on conflict, which
 * would have been a long-tail bug if the prior `randomUUID()` were ever
 * swapped for a less-entropic scheme.
 */
function newAgentInteractionId(): string {
  return `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// The reviewer↔agent channel. Backed by the SQLite `interactions` table via
// db/interaction-store.ts — this module owns only the wire envelope: the
// `<reviewer-feedback>` XML the agent reads, CDATA sanitisation, attribute
// escaping, and payload sort order.

export type InteractionTarget = "line" | "block" | "reply";

export type AskIntent = "comment" | "question" | "request" | "blocker";
export type ResponseIntent = "ack" | "unack" | "accept" | "reject";
export type InteractionIntent = AskIntent | ResponseIntent;

export type InteractionAuthorRole = "user" | "ai" | "agent";

export function isAskIntent(i: InteractionIntent): i is AskIntent {
  return i === "comment" || i === "question" || i === "request" || i === "blocker";
}

export function isInteractionTarget(v: unknown): v is InteractionTarget {
  return v === "line" || v === "block" || v === "reply";
}

export function isInteractionIntent(v: unknown): v is InteractionIntent {
  return (
    v === "comment" ||
    v === "question" ||
    v === "request" ||
    v === "blocker" ||
    v === "ack" ||
    v === "unack" ||
    v === "accept" ||
    v === "reject"
  );
}

export function isAuthorRole(v: unknown): v is InteractionAuthorRole {
  return v === "user" || v === "ai" || v === "agent";
}

/**
 * Validity rule (mirrors `web/src/types.ts#isValidInteractionPair`): response
 * intents only ever attach to other interactions — every `reply-to-*` target.
 * Asks attach to code (`line`/`block`) or to other interactions. The web
 * reducer and composer enforce this too; this is the third belt-and-braces
 * seam called out in docs/plans/typed-review-interactions.md (§158-162).
 */
export function isValidInteractionPair(
  target: InteractionTarget,
  intent: InteractionIntent,
): boolean {
  if (target === "line" || target === "block") return isAskIntent(intent);
  return true;
}

/**
 * Wire shape of one entry in the `<reviewer-feedback>` envelope. Projected from
 * a `StoredInteraction`: the hot columns map straight across, `file` / `lines` /
 * `commitSha` / `htmlUrl` are pulled out of `payload`.
 */
export interface Interaction {
  id: string;
  target: InteractionTarget;
  intent: InteractionIntent;
  author: string;
  authorRole: InteractionAuthorRole;
  /** Repo-relative path. */
  file: string;
  /** String, not number — `"118"` and `"72-79"` both fit. */
  lines?: string;
  body: string;
  commitSha: string;
  /** ISO timestamp — `created_at` of the stored row. */
  enqueuedAt: string;
  /** Optional provenance link back to GitHub for PR-imported interactions. */
  htmlUrl?: string;
}

export interface DeliveredInteraction extends Interaction {
  /** Mirrors `created_at`; the channel no longer stamps a distinct delivery time. */
  deliveredAt: string;
}

/** Server-side outcome alias for the typed response intents accepted on
 *  the reply endpoint. Kept as a Response-intent subset for now — `unack`
 *  is a local toggle, not something an agent posts back. */
export type AgentResponseIntent = Exclude<ResponseIntent, "unack">;

// ─── StoredInteraction → wire projection ─────────────────────────────────────

/** Pull a string off a payload bag, or "" when absent / wrong-typed. */
function payloadString(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === "string" ? v : "";
}

/**
 * `file` lives in `payload.anchorPath` for enqueued review interactions and in
 * `payload.file` for agent-started rows. `lines` is `payload.anchorLineNo`
 * (a number) or `payload.lines` (already a string).
 */
function wireFile(payload: Record<string, unknown>): string {
  return payloadString(payload, "anchorPath") || payloadString(payload, "file");
}

function wireLines(payload: Record<string, unknown>): string | undefined {
  const lines = payload.lines;
  if (typeof lines === "string" && lines.length > 0) return lines;
  const anchorLineNo = payload.anchorLineNo;
  if (typeof anchorLineNo === "number") return String(anchorLineNo);
  return undefined;
}

function wireHtmlUrl(payload: Record<string, unknown>): string | undefined {
  const external = payload.external;
  if (
    external &&
    typeof external === "object" &&
    typeof (external as { htmlUrl?: unknown }).htmlUrl === "string"
  ) {
    return (external as { htmlUrl: string }).htmlUrl;
  }
  const direct = payload.htmlUrl;
  return typeof direct === "string" && direct.length > 0 ? direct : undefined;
}

function toWire(row: StoredInteraction): Interaction {
  const wire: Interaction = {
    id: row.id,
    target: row.target as InteractionTarget,
    intent: row.intent as InteractionIntent,
    author: row.author,
    authorRole: row.authorRole as InteractionAuthorRole,
    file: wireFile(row.payload),
    body: row.body,
    commitSha: payloadString(row.payload, "originSha"),
    enqueuedAt: row.createdAt,
  };
  const lines = wireLines(row.payload);
  if (lines !== undefined) wire.lines = lines;
  const htmlUrl = wireHtmlUrl(row.payload);
  if (htmlUrl !== undefined) wire.htmlUrl = htmlUrl;
  return wire;
}

// Agent-authored rows are sorted by `created_at` in the store. Two posts in
// the same millisecond would otherwise tie and fall back to a random-UUID id —
// non-deterministic order. A monotonic clock keeps insertion order stable.
let lastPostedMs = 0;
function nextCreatedAt(): string {
  const now = Math.max(Date.now(), lastPostedMs + 1);
  lastPostedMs = now;
  return new Date(now).toISOString();
}

// ─── Channel operations (DB-backed) ──────────────────────────────────────────

/**
 * Atomic pull: drains the worktree's pending rows to `delivered` and returns
 * them as wire interactions. The transaction lives in interaction-store.ts.
 */
export function pullAndAck(worktreePath: string): Interaction[] {
  return storePullAndAck(worktreePath).map(toWire);
}

export function listDelivered(worktreePath: string): DeliveredInteraction[] {
  return storeListByQueueStatus(worktreePath, ["delivered"]).map((row) => ({
    ...toWire(row),
    deliveredAt: row.createdAt,
  }));
}

/** Read-only: interactions for a worktree in any of `statuses`, as wire shapes. */
export function readInteractions(
  worktreePath: string,
  statuses: AgentQueueStatus[],
): Interaction[] {
  return storeListByQueueStatus(worktreePath, statuses).map(toWire);
}

/**
 * Post a reply-shaped agent entry (responds to a delivered reviewer
 * interaction). Caller already validated the parentId exists in the
 * delivered set.
 */
export function postReply(
  worktreePath: string,
  payload: {
    parentId: string;
    body: string;
    intent: AgentResponseIntent;
    agentLabel?: string;
  },
): string {
  const id = newAgentInteractionId();
  postAgentInteraction({
    id,
    worktreePath,
    threadKey: null,
    target: "reply",
    intent: payload.intent,
    author: payload.agentLabel ?? "agent",
    body: payload.body,
    createdAt: nextCreatedAt(),
    payload: { parentId: payload.parentId },
  });
  return id;
}

/**
 * Post a top-level agent-started entry — a fresh thread anchored to
 * (file, lines). Intent must be an ask; target distinguishes single-line
 * from block.
 */
export function postTopLevel(
  worktreePath: string,
  payload: {
    file: string;
    lines: string;
    target: "line" | "block";
    body: string;
    intent: AskIntent;
    agentLabel?: string;
  },
): string {
  const id = newAgentInteractionId();
  postAgentInteraction({
    id,
    worktreePath,
    threadKey: null,
    target: payload.target,
    intent: payload.intent,
    author: payload.agentLabel ?? "agent",
    body: payload.body,
    createdAt: nextCreatedAt(),
    payload: { file: payload.file, lines: payload.lines },
  });
  return id;
}

/**
 * Wire shape returned by GET /api/agent/replies — one envelope covers
 * both reply-shaped (parentId set) and top-level-shaped (file + lines
 * set) entries. The web client merges either into state.interactions.
 */
export type AgentReplyWireItem =
  | {
      id: string;
      parentId: string;
      body: string;
      intent: AgentResponseIntent;
      author: string;
      authorRole: "agent";
      target: "reply";
      postedAt: string;
    }
  | {
      id: string;
      file: string;
      lines: string;
      body: string;
      intent: AskIntent;
      author: string;
      authorRole: "agent";
      target: "line" | "block";
      postedAt: string;
    };

export function listReplies(worktreePath: string): AgentReplyWireItem[] {
  return listAgentReplies(worktreePath).map((row): AgentReplyWireItem => {
    const parentId = row.payload.parentId;
    if (typeof parentId === "string") {
      return {
        id: row.id,
        parentId,
        body: row.body,
        intent: row.intent as AgentResponseIntent,
        author: row.author,
        authorRole: "agent",
        target: "reply",
        postedAt: row.createdAt,
      };
    }
    return {
      id: row.id,
      file: payloadString(row.payload, "file"),
      lines: payloadString(row.payload, "lines"),
      body: row.body,
      intent: row.intent as AskIntent,
      author: row.author,
      authorRole: "agent",
      target: row.target as "line" | "block",
      postedAt: row.createdAt,
    };
  });
}

/**
 * Returns true when `id` was previously delivered for this worktree.
 * Used by the reply endpoint to defensively reject replies anchored to ids
 * the agent never actually saw.
 */
export function isDeliveredInteractionId(
  worktreePath: string,
  id: string,
): boolean {
  return storeIsDelivered(worktreePath, id);
}

/** Test-only: reset the backing database and the monotonic clock. */
export function resetForTests(): void {
  resetDb();
  lastPostedMs = 0;
  watchPolls.clear();
}

// ─── Watch marker ────────────────────────────────────────────────────────────

/**
 * How long after its last watch poll an agent is still considered "watching".
 * Must outlast the agent's between-comments work phase (when it is acting, not
 * polling) yet clear soon after a real stop. The watch loop polls every ~2s, so
 * a live agent refreshes well inside the window; a stopped loop clears ≤ 90s
 * later. Approximate by nature of polling — the SSE follow-up makes it exact.
 */
export const WATCH_TTL_MS = 90_000;

// Last watch-poll timestamp per worktree. In-memory and ephemeral on purpose:
// this only drives the UI's "Agent is watching" indicator, and a server
// restart legitimately means nothing is watching anymore.
const watchPolls = new Map<string, number>();

/** Stamp a watch poll for `worktreePath` — called when a pull carries `watch: true`. */
export function markWatchPoll(worktreePath: string): void {
  watchPolls.set(worktreePath, Date.now());
}

/** True when `worktreePath` was watch-polled within the last `WATCH_TTL_MS`. */
export function isWatching(worktreePath: string, now: number = Date.now()): boolean {
  const at = watchPolls.get(worktreePath);
  return at !== undefined && now - at < WATCH_TTL_MS;
}

// ─── Wire envelope ───────────────────────────────────────────────────────────

function lowerLineBound(lines: string | undefined): number {
  if (!lines) return Number.POSITIVE_INFINITY;
  const m = lines.match(/^(\d+)/);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

function sortForPayload(items: Interaction[]): Interaction[] {
  // File path ascending, then line lower-bound ascending.
  return items.slice().sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    return lowerLineBound(a.lines) - lowerLineBound(b.lines);
  });
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sanitizeBody(body: string): string {
  // Strip `]]>` so the CDATA wrapper can't be terminated early by user content.
  return body.replace(/\]\]>/g, "]]");
}

export function formatPayload(
  items: Interaction[],
  commitSha: string,
): string {
  if (items.length === 0) return "";
  const sorted = sortForPayload(items);
  const body = sorted.map(renderInteraction).join("\n");
  return `<reviewer-feedback from="shippable" commit="${escapeXmlAttr(commitSha)}">\n${body}\n</reviewer-feedback>`;
}

function renderInteraction(c: Interaction): string {
  // `id` is first so the agent sees it before the body — needed to call
  // `shippable_post_review_comment`. Pull-and-ack drains the queue, so this
  // is the only chance the agent has to read the id.
  const attrs: string[] = [
    `id="${escapeXmlAttr(c.id)}"`,
    `target="${escapeXmlAttr(c.target)}"`,
    `intent="${escapeXmlAttr(c.intent)}"`,
    `author="${escapeXmlAttr(c.author)}"`,
    `authorRole="${escapeXmlAttr(c.authorRole)}"`,
    `file="${escapeXmlAttr(c.file)}"`,
  ];
  if (c.lines) {
    attrs.push(`lines="${escapeXmlAttr(c.lines)}"`);
  }
  if (c.htmlUrl) {
    attrs.push(`htmlUrl="${escapeXmlAttr(c.htmlUrl)}"`);
  }
  // Wrap body in CDATA so a reviewer can't break out of the <interaction>
  // element by pasting `</interaction>` into their comment.
  return `  <interaction ${attrs.join(" ")}><![CDATA[${sanitizeBody(c.body)}]]></interaction>`;
}
