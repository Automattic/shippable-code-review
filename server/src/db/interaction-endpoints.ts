// Handlers for /api/interactions — GET by changeset, POST upsert,
// POST enqueue/unenqueue, DELETE. This is the HTTP edge over interaction-store.ts.
// Validation lives here (trust the boundary); the store is not re-validated.

import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson, readJson } from "../http.ts";
import type {
  InteractionTarget,
  InteractionIntent,
  InteractionAuthorRole,
} from "../agent-queue.ts";
import {
  isValidInteractionPair,
  isInteractionTarget,
  isInteractionIntent,
  isAuthorRole,
  isAskIntent,
} from "../agent-queue.ts";
import { recordStatOnce } from "../stats/record.ts";
import {
  upsertInteraction,
  getInteractionsByChangeset,
  deleteInteraction,
  deleteInteractionsByChangeset,
  deleteInteractionsByWorktree,
  enqueueToWorktree,
  unenqueueFromWorktree,
  type StoredInteraction,
} from "./interaction-store.ts";

// Known optional payload fields. Unknown keys are dropped — no pass-through of
// arbitrary caller data into storage.
const PAYLOAD_FIELDS = [
  "anchorPath",
  "anchorHash",
  "anchorContext",
  "anchorLineNo",
  "originSha",
  "originType",
  "external",
  "runRecipe",
  // Set on replies to an agent comment — the parent's interaction id, so the
  // agent channel can link a reply back to the comment it answers.
  "parentId",
] as const;

// ─── Handlers ────────────────────────────────────────────────────────────────

/** GET /api/interactions?changesetId=<id> → { interactions: StoredInteraction[] } */
export async function handleInteractionsGet(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const changesetId = url.searchParams.get("changesetId");
  if (!changesetId) {
    writeJson(res, origin, 400, { error: "missing required query param: changesetId" });
    return;
  }
  const interactions = getInteractionsByChangeset(changesetId);
  writeJson(res, origin, 200, { interactions });
}

/** POST /api/interactions — upsert one interaction. Body is the full interaction shape. */
export async function handleInteractionsUpsert(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
): Promise<void> {
  const raw = await readJson(req);
  if (!raw || typeof raw !== "object") {
    writeJson(res, origin, 400, { error: "invalid JSON body" });
    return;
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.id !== "string" || b.id === "") {
    writeJson(res, origin, 400, { error: "id must be a non-empty string" });
    return;
  }
  if (typeof b.changesetId !== "string" || b.changesetId === "") {
    writeJson(res, origin, 400, { error: "changesetId must be a non-empty string" });
    return;
  }
  if (!isInteractionTarget(b.target)) {
    writeJson(res, origin, 400, { error: "invalid target" });
    return;
  }
  if (!isInteractionIntent(b.intent)) {
    writeJson(res, origin, 400, { error: "invalid intent" });
    return;
  }
  if (!isValidInteractionPair(b.target, b.intent)) {
    writeJson(res, origin, 400, {
      error: "invalid (target, intent) pair: response intents only attach to reply targets",
    });
    return;
  }
  if (!isAuthorRole(b.authorRole)) {
    writeJson(res, origin, 400, { error: "invalid authorRole" });
    return;
  }
  if (typeof b.author !== "string" || b.author === "") {
    writeJson(res, origin, 400, { error: "author must be a non-empty string" });
    return;
  }
  // ack/unack are state toggles with no authored text — allow empty body.
  const bodyless = b.intent === "ack" || b.intent === "unack";
  if (typeof b.body !== "string" || (b.body === "" && !bodyless)) {
    writeJson(res, origin, 400, { error: "body must be a non-empty string" });
    return;
  }

  // Collect known optional payload fields; ignore the rest.
  const payload: Record<string, unknown> = {};
  for (const key of PAYLOAD_FIELDS) {
    if (b[key] !== undefined) payload[key] = b[key];
  }

  const ix: StoredInteraction = {
    id: b.id,
    changesetId: b.changesetId,
    target: b.target,
    intent: b.intent,
    author: b.author,
    authorRole: b.authorRole,
    body: b.body,
    threadKey: typeof b.threadKey === "string" ? b.threadKey : null,
    createdAt:
      typeof b.createdAt === "string"
        ? b.createdAt
        : new Date().toISOString(),
    // A comment authored in a worktree session belongs to that worktree from
    // birth — the client sends `worktreePath` so it's stamped at creation,
    // not only on enqueue. The UPSERT's ON CONFLICT clause leaves the column
    // untouched, so this never resets an already-enqueued row.
    worktreePath:
      typeof b.worktreePath === "string" && b.worktreePath.length > 0
        ? b.worktreePath
        : null,
    agentQueueStatus: null,
    payload,
  };

  upsertInteraction(ix);
  // Dedup on the interaction id so an upsert counts a distinct comment once,
  // not on every re-save or edit.
  if (isAskIntent(b.intent) && b.authorRole === "user") {
    recordStatOnce("comment-posted-user", ix.id);
  }
  writeJson(res, origin, 200, { ok: true });
}

/** POST /api/interactions/enqueue — body: { id, worktreePath } */
export async function handleInteractionsEnqueue(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
): Promise<void> {
  const raw = await readJson(req);
  if (!raw || typeof raw !== "object") {
    writeJson(res, origin, 400, { error: "invalid JSON body" });
    return;
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.id !== "string" || b.id === "") {
    writeJson(res, origin, 400, { error: "id must be a non-empty string" });
    return;
  }
  if (typeof b.worktreePath !== "string" || b.worktreePath === "") {
    writeJson(res, origin, 400, { error: "worktreePath must be a non-empty string" });
    return;
  }

  const found = enqueueToWorktree(b.id, b.worktreePath);
  if (!found) {
    writeJson(res, origin, 404, { error: "interaction not found" });
    return;
  }
  writeJson(res, origin, 200, { ok: true });
}

/** POST /api/interactions/unenqueue — body: { id }. Returns 404 if no pending row matched. */
export async function handleInteractionsUnenqueue(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
): Promise<void> {
  const raw = await readJson(req);
  if (!raw || typeof raw !== "object") {
    writeJson(res, origin, 400, { error: "invalid JSON body" });
    return;
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.id !== "string" || b.id === "") {
    writeJson(res, origin, 400, { error: "id must be a non-empty string" });
    return;
  }

  // Returns false if the id wasn't found OR the row isn't pending — both are 404.
  const removed = unenqueueFromWorktree(b.id);
  if (!removed) {
    writeJson(res, origin, 404, {
      error: "no pending interaction found for that id",
    });
    return;
  }
  writeJson(res, origin, 200, { ok: true });
}

/** DELETE /api/interactions?id=<id> → { deleted: boolean } */
export async function handleInteractionsDelete(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const id = url.searchParams.get("id");
  const changesetId = url.searchParams.get("changesetId");
  const worktreePath = url.searchParams.get("worktreePath");
  if (id) {
    writeJson(res, origin, 200, { deleted: deleteInteraction(id) });
    return;
  }
  // Bulk forms back the review-reset flow: `deleted` is a row count. Reset
  // needs both scopes — user comments are changeset-keyed, agent comments
  // (MCP posts) are worktree-keyed with changeset_id null.
  if (changesetId) {
    writeJson(res, origin, 200, {
      deleted: deleteInteractionsByChangeset(changesetId),
    });
    return;
  }
  if (worktreePath) {
    writeJson(res, origin, 200, {
      deleted: deleteInteractionsByWorktree(worktreePath),
    });
    return;
  }
  writeJson(res, origin, 400, {
    error: "missing required query param: id, changesetId, or worktreePath",
  });
}
