// Typed client for /api/interactions. Wraps getJson/postJson/deleteJson from
// apiClient — no fetch plumbing here. ApiError is thrown on non-2xx; callers
// can check err.status === 404 to distinguish "not found" from other failures.

import { getJson, postJson, deleteJson } from "./apiClient";
import type { Interaction } from "./types";

// Server shape returned by GET /api/interactions. Mirrors StoredInteraction
// from server/src/db/interaction-store.ts — kept local to avoid a shared
// package dep; keep in sync if the server shape changes.
interface StoredInteraction {
  id: string;
  threadKey: string | null;
  target: string;
  intent: string;
  author: string;
  authorRole: string;
  body: string;
  createdAt: string;
  changesetId: string | null;
  worktreePath: string | null;
  agentQueueStatus: "pending" | "delivered" | null;
  payload: Record<string, unknown>;
}

// Map a server row → web Interaction. The server stores optional fields
// (anchorPath, anchorHash, etc.) in a nested `payload` object; flatten them
// back out. `agentQueueStatus` is preserved — the pip reads it. The other
// storage-only columns (changesetId, worktreePath) carry no web meaning.
function storedToInteraction(row: StoredInteraction): Interaction {
  return {
    id: row.id,
    agentQueueStatus: row.agentQueueStatus,
    // null = stored without a thread anchor; "" groups it separately —
    // consumers must not treat "" as "no thread". Revisit if thread grouping
    // changes (the next task rewires this).
    threadKey: row.threadKey ?? "",
    target: row.target as Interaction["target"],
    intent: row.intent as Interaction["intent"],
    author: row.author,
    authorRole: row.authorRole as Interaction["authorRole"],
    body: row.body,
    createdAt: row.createdAt,
    // Safe to spread payload directly and cast the whole object: the server's
    // PAYLOAD_FIELDS allowlist (interaction-endpoints.ts) constrains exactly
    // which keys can land in payload, so none of them collide with the hot
    // columns above. Revisit if payload scope expands beyond that allowlist.
    ...row.payload,
  } as Interaction;
}

/** Fetch all interactions for a changeset, oldest-first. */
export async function fetchInteractions(changesetId: string): Promise<Interaction[]> {
  const { interactions } = await getJson<{ interactions: StoredInteraction[] }>(
    `/api/interactions?changesetId=${encodeURIComponent(changesetId)}`,
  );
  return interactions.map(storedToInteraction);
}

/** Persist (insert or update) one interaction. The server collects optional
 *  fields into payload itself, so we send everything flat plus changesetId.
 *  `worktreePath` is passed when the changeset is worktree-backed, so the
 *  comment is stamped to that worktree at creation — not only on enqueue. */
export async function upsertInteraction(
  interaction: Interaction,
  changesetId: string,
  worktreePath?: string,
): Promise<void> {
  // Spread sends transient fields like enqueueError over the wire; the server's
  // PAYLOAD_FIELDS allowlist silently drops anything it doesn't recognise, so
  // this is safe and no explicit omission is needed here.
  await postJson<{ ok: true }>("/api/interactions", {
    ...interaction,
    changesetId,
    ...(worktreePath ? { worktreePath } : {}),
  });
}

/** Delete one interaction by id. Returns true if a row was removed. */
export async function deleteInteraction(id: string): Promise<boolean> {
  const { deleted } = await deleteJson<{ deleted: boolean }>(
    `/api/interactions?id=${encodeURIComponent(id)}`,
  );
  return deleted;
}

/** Delete every interaction stored for a changeset. Returns the row count.
 *  Backs the review-reset flow — reset must clear the DB rows or the next
 *  per-changeset fetch brings every comment back. */
export async function deleteInteractionsForChangeset(
  changesetId: string,
): Promise<number> {
  const { deleted } = await deleteJson<{ deleted: number }>(
    `/api/interactions?changesetId=${encodeURIComponent(changesetId)}`,
  );
  return deleted;
}

/** Mark an existing interaction as pending for a worktree agent.
 *  Throws ApiError (status 404) if the id is not found. */
export async function enqueueInteraction(
  id: string,
  worktreePath: string,
): Promise<void> {
  await postJson<{ ok: true }>("/api/interactions/enqueue", { id, worktreePath });
}

/** Remove a pending interaction from the worktree queue without deleting it.
 *  Throws ApiError (status 404) if no pending row is found for that id. */
export async function unenqueueInteraction(id: string): Promise<void> {
  await postJson<{ ok: true }>("/api/interactions/unenqueue", { id });
}
