import type { SqliteDb } from "./adapter.ts";

// The `interactions` table and a `schema_meta` version row. `runMigrations`
// applies ordered forward steps from the stored version up to `SCHEMA_HEAD`.

export const SCHEMA_HEAD = 4;

type Migration = (db: SqliteDb) => void;

// MIGRATIONS[n] takes the schema from version n to n+1.
const MIGRATIONS: Migration[] = [
  // v0 → v1: the interactions table.
  // Hot columns mirror required Interaction fields; optional/contextual fields
  // live in payload_json. changeset_id / worktree_path are storage-keying
  // columns; agent_queue_status drives the pending/delivered pull lifecycle.
  (db) => {
    db.exec(`
      CREATE TABLE interactions (
        id                 TEXT PRIMARY KEY,
        thread_key         TEXT,
        target             TEXT NOT NULL,
        intent             TEXT NOT NULL,
        author             TEXT NOT NULL,
        author_role        TEXT NOT NULL,
        body               TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        changeset_id       TEXT,
        worktree_path      TEXT,
        agent_queue_status TEXT,
        payload_json       TEXT NOT NULL
      )
    `);
    db.exec(
      "CREATE INDEX idx_interactions_changeset ON interactions (changeset_id)"
    );
    db.exec(
      "CREATE INDEX idx_interactions_worktree ON interactions (worktree_path, agent_queue_status)"
    );
  },
  // v1 → v2: stats tracking. stat_dedup backs recordStatOnce — one row per
  // distinct (stat, dedup key). settings is a generic key/value store holding
  // the install id and the MC consent flag.
  (db) => {
    db.exec(`
      CREATE TABLE stat_dedup (
        name        TEXT NOT NULL,
        dedup_key   TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (name, dedup_key)
      )
    `);
    db.exec(`
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  },
  // v2 → v3: identity. One row per author (human or AI) seen by the server.
  // declared_json/observed_json are reserved for future identity signals —
  // no store reads or writes them yet.
  (db) => {
    db.exec(`
      CREATE TABLE users (
        id             TEXT PRIMARY KEY,
        role           TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        declared_json  TEXT,
        observed_json  TEXT,
        last_seen_at   TEXT NOT NULL
      )
    `);
  },
  // v3 → v4: links interactions to their author's user row. Nullable —
  // existing rows have no author_id, and nothing queries by it yet, so no
  // index.
  (db) => {
    db.exec("ALTER TABLE interactions ADD COLUMN author_id TEXT");
  },
];

// Invariant: one migration function per schema version step.
if (MIGRATIONS.length !== SCHEMA_HEAD) {
  throw new Error(
    `MIGRATIONS.length (${MIGRATIONS.length}) must equal SCHEMA_HEAD (${SCHEMA_HEAD})`,
  );
}

/**
 * Returns the stored schema version. Returns 0 when `schema_meta` is absent
 * or holds no version row — i.e. a fresh, unmigrated database.
 */
export function getSchemaVersion(db: SqliteDb): number {
  // Only suppress "table missing"; all other errors (closed handle, corrupt DB,
  // etc.) must propagate so the caller sees the real cause.
  const tableExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'"
    )
    .get();
  if (!tableExists) return 0;
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

/**
 * Brings the database schema up to SCHEMA_HEAD. Each migration step runs in
 * its own transaction so a failure can't leave a half-applied schema.
 * Idempotent: a database already at head is left untouched.
 */
export function runMigrations(db: SqliteDb): void {
  // Ensure the version-tracking table exists before we read from it.
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)"
  );

  const current = getSchemaVersion(db);
  for (let v = current; v < SCHEMA_HEAD; v++) {
    // Each step gets its own top-level transaction — never nested.
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.prepare(
        `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(String(v + 1));
    });
  }
}
