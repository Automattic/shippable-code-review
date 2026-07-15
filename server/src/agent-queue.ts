import {
  pullAndAck as storePullAndAck,
  listByQueueStatus as storeListByQueueStatus,
  listAllForWorktree as storeListAllForWorktree,
  getByIdsForWorktree as storeGetByIds,
  postAgentInteraction,
  listAgentReplies,
  interactionExistsForWorktree as storeInteractionExists,
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

/**
 * Where an interaction's body came from, and (by direct implication) whether
 * the agent should treat the body as trusted feedback or as quoted data. The
 * reviewer is the trust source: `"local"` means typed by the reviewer in
 * this Shippable session; `"external"` is third-party content the reviewer
 * imported (today only GitHub PR comments; future Slack / Linear sit under
 * the same trust bucket). `renderInteraction` wraps `"external"` bodies in
 * `<untrusted-quoted-content>`; specific provenance is carried by `htmlUrl`.
 */
export type CommentSource = "local" | "external";

/** Agent's self-reported confidence in a top-level comment. */
export type Confidence = "low" | "medium" | "high";

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
  /** Parent interaction id — set on replies so the agent can locate the
   *  comment a reply responds to. Absent on top-level interactions. */
  parentId?: string;
  /**
   * Where the body came from. Always present; the agent reads it to decide
   * whether to treat the body as trusted reviewer feedback (`"local"`) or
   * as quoted data from a third-party origin (`"github"`). Anything other
   * than `"local"` also gets the `<untrusted-quoted-content>` body wrapper.
   */
  source: CommentSource;
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

/**
 * Maps the stored `payload.external` shape to the wire `source` enum.
 * Presence of `payload.external` is the storage convention for "imported
 * from a third-party origin," so it always resolves to `"external"` —
 * legacy rows with `external.source === "pr"` need no migration. If we
 * ever want to distinguish origins (github vs slack), add a separate
 * descriptive field; the trust enum stays binary.
 */
function wireSource(payload: Record<string, unknown>): CommentSource {
  if (payload.external && typeof payload.external === "object") {
    return "external";
  }
  return "local";
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
    source: wireSource(row.payload),
  };
  const lines = wireLines(row.payload);
  if (lines !== undefined) wire.lines = lines;
  const htmlUrl = wireHtmlUrl(row.payload);
  if (htmlUrl !== undefined) wire.htmlUrl = htmlUrl;
  const parentId = payloadString(row.payload, "parentId");
  if (parentId.length > 0) wire.parentId = parentId;
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
 * Read-only: every interaction for a worktree — reviewer rows in any queue
 * state plus agent-authored rows — as wire shapes. Backs the `all` pull.
 */
export function readAllInteractions(worktreePath: string): Interaction[] {
  return storeListAllForWorktree(worktreePath).map(toWire);
}

/**
 * Append every parent a reply in `items` points at but that isn't already
 * present — read-only, so an agent pulling a reply also sees the comment it
 * responds to. Walks the parent chain (reply-to-a-reply) until it bottoms out.
 */
export function withReferencedParents(
  worktreePath: string,
  items: Interaction[],
): Interaction[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const added: Interaction[] = [];
  let frontier = items;
  while (true) {
    const missing = new Set<string>();
    for (const it of frontier) {
      if (it.parentId && !byId.has(it.parentId)) missing.add(it.parentId);
    }
    if (missing.size === 0) break;
    const parents = storeGetByIds(worktreePath, [...missing]).map(toWire);
    if (parents.length === 0) break;
    for (const p of parents) byId.set(p.id, p);
    added.push(...parents);
    frontier = parents;
  }
  return added.length === 0 ? items : [...added, ...items];
}

/**
 * Post a reply-shaped agent entry — a response to another interaction
 * (reviewer comment or agent comment). Caller already validated that the
 * parentId is a real interaction for the worktree.
 */
export function postReply(
  worktreePath: string,
  payload: {
    parentId: string;
    body: string;
    intent: AgentResponseIntent;
    agentLabel?: string;
    authorId?: string | null;
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
    authorId: payload.authorId,
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
    rationale?: string;
    suggestedFix?: string;
    confidence?: Confidence;
    authorId?: string | null;
  },
): string {
  const id = newAgentInteractionId();
  const bag: Record<string, unknown> = {
    file: payload.file,
    lines: payload.lines,
  };
  if (payload.rationale !== undefined) bag.rationale = payload.rationale;
  if (payload.suggestedFix !== undefined) bag.suggestedFix = payload.suggestedFix;
  if (payload.confidence !== undefined) bag.confidence = payload.confidence;
  postAgentInteraction({
    id,
    worktreePath,
    threadKey: null,
    target: payload.target,
    intent: payload.intent,
    author: payload.agentLabel ?? "agent",
    body: payload.body,
    createdAt: nextCreatedAt(),
    payload: bag,
    authorId: payload.authorId,
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
      /** Structured fields, present only when the agent supplied them. */
      rationale?: string;
      suggestedFix?: string;
      confidence?: Confidence;
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
    const item: Extract<AgentReplyWireItem, { target: "line" | "block" }> = {
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
    const rationale = payloadString(row.payload, "rationale");
    if (rationale.length > 0) item.rationale = rationale;
    const suggestedFix = payloadString(row.payload, "suggestedFix");
    if (suggestedFix.length > 0) item.suggestedFix = suggestedFix;
    const confidence = row.payload.confidence;
    if (confidence === "low" || confidence === "medium" || confidence === "high") {
      item.confidence = confidence;
    }
    return item;
  });
}

/**
 * Returns true when `id` is a real interaction for this worktree. Used by the
 * reply endpoint to reject replies anchored to ids that don't exist for the
 * worktree, while allowing replies to agent-authored comments.
 */
export function interactionExistsForWorktree(
  worktreePath: string,
  id: string,
): boolean {
  return storeInteractionExists(worktreePath, id);
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
  // `source` is always present on the wire — the agent reads it on every
  // interaction to decide trust without falling back on attribute absence.
  attrs.push(`source="${escapeXmlAttr(c.source)}"`);
  if (c.htmlUrl) {
    attrs.push(`htmlUrl="${escapeXmlAttr(c.htmlUrl)}"`);
  }
  if (c.parentId) {
    attrs.push(`parentId="${escapeXmlAttr(c.parentId)}"`);
  }
  // Wrap body in CDATA so a reviewer can't break out of the <interaction>
  // element by pasting `</interaction>` into their comment. When the body
  // didn't come from the local reviewer, add an inner <untrusted-quoted-content>
  // element so the agent has a structural cue to treat it as quoted data,
  // not instructions to execute. The element name is the cue; specific
  // provenance (which external origin) is conveyed by `htmlUrl`.
  const safeBody = sanitizeBody(c.body);
  const bodyContent =
    c.source === "local"
      ? `<![CDATA[${safeBody}]]>`
      : `<untrusted-quoted-content><![CDATA[${safeBody}]]></untrusted-quoted-content>`;
  return `  <interaction ${attrs.join(" ")}>${bodyContent}</interaction>`;
}
