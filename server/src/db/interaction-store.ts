import { getDb } from "./index.ts";

// Data-access layer for the `interactions` table. Review-state interactions
// are keyed by `changesetId`; agent-channel rows are keyed by `worktreePath`
// (Task 7). An enqueued review interaction carries both.
//
// Hot columns mirror required Interaction fields. Optional/contextual entity
// fields (anchor*, external, runRecipe) ride in `payload_json`.

export type AgentQueueStatus = "pending" | "delivered";

const PENDING: AgentQueueStatus = "pending";
const DELIVERED: AgentQueueStatus = "delivered";

/** Public shape — camelCase, payload parsed. */
export interface StoredInteraction {
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
  agentQueueStatus: AgentQueueStatus | null;
  /** Optional Interaction fields (anchorPath, anchorHash, anchorContext,
   *  anchorLineNo, originSha, originType, external, runRecipe). Serialised to
   *  payload_json in the DB. enqueueError is transient client state — not here. */
  payload: Record<string, unknown>;
}

/** Raw DB row shape (snake_case). */
interface InteractionRow {
  id: string;
  thread_key: string | null;
  target: string;
  intent: string;
  author: string;
  author_role: string;
  body: string;
  created_at: string;
  changeset_id: string | null;
  worktree_path: string | null;
  agent_queue_status: string | null;
  payload_json: string;
}

function rowToStored(row: InteractionRow): StoredInteraction {
  return {
    id: row.id,
    threadKey: row.thread_key,
    target: row.target,
    intent: row.intent,
    author: row.author,
    authorRole: row.author_role,
    body: row.body,
    createdAt: row.created_at,
    changesetId: row.changeset_id,
    worktreePath: row.worktree_path,
    agentQueueStatus: row.agent_queue_status as AgentQueueStatus | null,
    // payload_json is NOT NULL but can be "" from raw SQL — guard returns {}.
    payload: row.payload_json
      ? (JSON.parse(row.payload_json) as Record<string, unknown>)
      : {},
  };
}

// `worktree_path` and `agent_queue_status` are deliberately absent from the
// DO UPDATE SET clause. The enqueue write (Task 7) owns worktree_path; the
// agent's pull owns agent_queue_status. A reviewer re-sync that included them
// would reset a `delivered` row to `pending`, causing infinite re-delivery.
// On a fresh INSERT both default to the caller-supplied values (typically null
// for a normal review interaction that hasn't been enqueued yet).
const UPSERT_SQL = `
  INSERT INTO interactions (
    id, thread_key, target, intent, author, author_role, body, created_at,
    changeset_id, worktree_path, agent_queue_status, payload_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    thread_key   = excluded.thread_key,
    target       = excluded.target,
    intent       = excluded.intent,
    author       = excluded.author,
    author_role  = excluded.author_role,
    body         = excluded.body,
    created_at   = excluded.created_at,
    changeset_id = excluded.changeset_id,
    payload_json = excluded.payload_json
`;

/** Insert or update one interaction row. Queue columns are protected on conflict. */
export function upsertInteraction(ix: StoredInteraction): void {
  getDb()
    .prepare(UPSERT_SQL)
    .run(
      ix.id,
      ix.threadKey,
      ix.target,
      ix.intent,
      ix.author,
      ix.authorRole,
      ix.body,
      ix.createdAt,
      ix.changesetId,
      ix.worktreePath,
      ix.agentQueueStatus,
      JSON.stringify(ix.payload),
    );
}

/** All interactions for a changeset, sorted oldest-first. */
export function getInteractionsByChangeset(changesetId: string): StoredInteraction[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM interactions WHERE changeset_id = ? ORDER BY created_at, id",
    )
    .all(changesetId) as InteractionRow[];
  return rows.map(rowToStored);
}

/**
 * Delete one interaction by id. Returns true if a row was removed, false if
 * the id was not found.
 */
export function deleteInteraction(id: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM interactions WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

// ─── Agent-channel ops ───────────────────────────────────────────────────────
//
// The interactions table doubles as a reviewer↔agent channel. Review
// interactions are enqueued by setting worktree_path + agent_queue_status on
// their existing row (one write, preserves changeset_id). Agent-authored
// interactions are independent rows with author_role = 'agent'.

/**
 * Mark an existing review interaction as pending for a worktree.
 * Updates worktree_path and agent_queue_status in a single write.
 * Returns false if the id was not found.
 */
export function enqueueToWorktree(id: string, worktreePath: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE interactions SET worktree_path = ?, agent_queue_status = '${PENDING}' WHERE id = ?`,
    )
    .run(worktreePath, id);
  return result.changes > 0;
}

/**
 * Remove a *pending* review interaction from the worktree queue without
 * deleting it. Clears worktree_path and agent_queue_status back to NULL.
 * Returns false if the id was not found or the row is not pending (e.g.
 * already delivered) — un-enqueuing a delivered row is a no-op.
 */
export function unenqueueFromWorktree(id: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE interactions SET worktree_path = NULL, agent_queue_status = NULL WHERE id = ? AND agent_queue_status = '${PENDING}'`,
    )
    .run(id);
  return result.changes > 0;
}

/**
 * Atomically pull all pending interactions for a worktree and mark them
 * delivered. Returns the pulled rows. A concurrent caller that pulls
 * immediately after gets [].
 */
export function pullAndAck(worktreePath: string): StoredInteraction[] {
  const db = getDb();
  return db.transaction((): StoredInteraction[] => {
    const rows = db
      .prepare(
        `SELECT * FROM interactions WHERE worktree_path = ? AND agent_queue_status = '${PENDING}' ORDER BY created_at, id`,
      )
      .all(worktreePath) as InteractionRow[];
    if (rows.length === 0) return [];
    db.prepare(
      `UPDATE interactions SET agent_queue_status = '${DELIVERED}' WHERE worktree_path = ? AND agent_queue_status = '${PENDING}'`,
    ).run(worktreePath);
    // Reflect the delivered status in the returned objects without re-querying.
    return rows.map((r) => rowToStored({ ...r, agent_queue_status: DELIVERED }));
  });
}

/**
 * Read-only: all interactions for a worktree whose agent_queue_status is in
 * `statuses`, sorted oldest-first. Unlike pullAndAck, this never acks.
 */
export function listByQueueStatus(
  worktreePath: string,
  statuses: AgentQueueStatus[],
): StoredInteraction[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT * FROM interactions WHERE worktree_path = ? AND agent_queue_status IN (${placeholders}) ORDER BY created_at, id`,
    )
    .all(worktreePath, ...statuses) as InteractionRow[];
  return rows.map(rowToStored);
}

/**
 * Read-only: every interaction for a worktree regardless of queue status —
 * reviewer rows (pending/delivered) and agent-authored rows (status null)
 * alike. Sorted oldest-first. Unlike pullAndAck, this never acks.
 */
export function listAllForWorktree(worktreePath: string): StoredInteraction[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM interactions WHERE worktree_path = ? ORDER BY created_at, id",
    )
    .all(worktreePath) as InteractionRow[];
  return rows.map(rowToStored);
}

/**
 * Look up interactions for a worktree by id. Used to pull in the parent
 * comment a reply references, regardless of queue status. Missing ids are
 * silently skipped.
 *
 * Scoped to `worktree_path` — every interaction authored in a worktree
 * session carries it, so a referenced parent resolves here without widening
 * the lookup to other worktrees' rows.
 */
export function getByIdsForWorktree(
  worktreePath: string,
  ids: string[],
): StoredInteraction[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT * FROM interactions WHERE worktree_path = ? AND id IN (${placeholders})`,
    )
    .all(worktreePath, ...ids) as InteractionRow[];
  return rows.map(rowToStored);
}

/** Input shape for agent-authored interactions. */
export interface AgentInteractionInput {
  id: string;
  worktreePath: string;
  threadKey: string | null;
  target: string;
  intent: string;
  author: string;
  body: string;
  createdAt: string;
  /** Contextual fields: parentId for replies, file/lines for top-level. */
  payload: Record<string, unknown>;
}

/**
 * Persist an agent-authored interaction (reply or top-level thread).
 * Sets author_role = 'agent'; changeset_id is null (agent rows are channel-keyed,
 * not changeset-keyed).
 */
export function postAgentInteraction(input: AgentInteractionInput): void {
  getDb()
    .prepare(UPSERT_SQL)
    .run(
      input.id,
      input.threadKey,
      input.target,
      input.intent,
      input.author,
      "agent",
      input.body,
      input.createdAt,
      null, // changeset_id — agent rows are not changeset-keyed
      input.worktreePath,
      null, // agent_queue_status — not part of the pull lifecycle
      JSON.stringify(input.payload),
    );
}

/** All agent-authored interactions for a worktree, sorted oldest-first. */
export function listAgentReplies(worktreePath: string): StoredInteraction[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM interactions WHERE worktree_path = ? AND author_role = 'agent' ORDER BY created_at, id",
    )
    .all(worktreePath) as InteractionRow[];
  return rows.map(rowToStored);
}

/**
 * Returns true if `id` is a real interaction belonging to this worktree —
 * a reviewer comment in any queue state, or an agent-authored row. The reply
 * endpoint uses it to reject replies anchored to ids that don't exist for the
 * worktree, while still letting an agent reply to its own (or another
 * agent's) comment, which never enters the delivered queue lifecycle.
 */
export function interactionExistsForWorktree(
  worktreePath: string,
  id: string,
): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM interactions WHERE worktree_path = ? AND id = ?")
    .get(worktreePath, id);
  return row !== undefined;
}
