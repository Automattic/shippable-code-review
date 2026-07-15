import { getDb } from "./index.ts";

// Data-access layer for the `users` table. One row per author (human or AI)
// the server has seen. role and display_name are set on first sight and never
// change on conflict — a later upsert only bumps last_seen_at.

export type UserRole = "human" | "ai";

/** Public shape — camelCase. */
export interface StoredUser {
  id: string;
  role: UserRole;
  displayName: string;
  lastSeenAt: string;
}

/** Raw DB row shape (snake_case), columns this store reads. */
interface UserRow {
  id: string;
  role: string;
  display_name: string;
  last_seen_at: string;
}

function rowToUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    role: row.role as UserRole,
    displayName: row.display_name,
    lastSeenAt: row.last_seen_at,
  };
}

// display_name starts empty (no naming affordance yet). role and display_name
// are absent from the DO UPDATE SET clause deliberately — first sight wins;
// only last_seen_at tracks renewed activity.
const UPSERT_SQL = `
  INSERT INTO users (id, role, display_name, last_seen_at)
  VALUES (?, ?, '', ?)
  ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
`;

/** Insert a user on first sight, or refresh last_seen_at if already known. */
export function upsertUser(
  id: string,
  role: UserRole,
  now: string = new Date().toISOString(),
): void {
  getDb().prepare(UPSERT_SQL).run(id, role, now);
}

/** Look up a user by id. Returns undefined if not found. */
export function getUser(id: string): StoredUser | undefined {
  const row = getDb()
    .prepare("SELECT id, role, display_name, last_seen_at FROM users WHERE id = ?")
    .get(id) as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}
