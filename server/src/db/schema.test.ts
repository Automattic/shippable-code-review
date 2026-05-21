import { afterEach, describe, expect, it } from "vitest";

import { openDb, type SqliteDb } from "./adapter.ts";
import { SCHEMA_HEAD, getSchemaVersion, runMigrations } from "./schema.ts";

describe("schema migrations", () => {
  let db: SqliteDb;

  afterEach(() => {
    db?.close();
    db = undefined as unknown as SqliteDb;
  });

  describe("getSchemaVersion", () => {
    it("returns 0 on a fresh database with no schema_meta table", () => {
      db = openDb(":memory:");
      expect(getSchemaVersion(db)).toBe(0);
    });

    it("returns 0 when schema_meta exists but has no version row", () => {
      db = openDb(":memory:");
      db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)");
      expect(getSchemaVersion(db)).toBe(0);
    });

    it("returns the stored version when a version row exists", () => {
      db = openDb(":memory:");
      db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)");
      db.exec("INSERT INTO schema_meta VALUES ('schema_version', '1')");
      expect(getSchemaVersion(db)).toBe(1);
    });
  });

  describe("runMigrations", () => {
    it("creates interactions table on a fresh database", () => {
      db = openDb(":memory:");
      runMigrations(db);

      // Table must exist — querying it should not throw
      const rows = db.prepare("SELECT * FROM interactions LIMIT 0").all();
      expect(rows).toEqual([]);
    });

    it("creates interactions table with all required columns", () => {
      db = openDb(":memory:");
      runMigrations(db);

      // Round-trip a full row to verify column names and nullability rules
      db.prepare(`
        INSERT INTO interactions
          (id, thread_key, target, intent, author, author_role, body, created_at,
           changeset_id, worktree_path, agent_queue_status, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "uuid-1",
        null,
        "line",
        "ask",
        "Alice",
        "user",
        "looks good",
        "2026-01-01T00:00:00.000Z",
        "cs-abc",
        null,
        null,
        "{}",
      );

      const row = db
        .prepare("SELECT * FROM interactions WHERE id = ?")
        .get("uuid-1") as Record<string, unknown>;

      expect(row).toMatchObject({
        id: "uuid-1",
        thread_key: null,
        target: "line",
        intent: "ask",
        author: "Alice",
        author_role: "user",
        body: "looks good",
        created_at: "2026-01-01T00:00:00.000Z",
        changeset_id: "cs-abc",
        worktree_path: null,
        agent_queue_status: null,
        payload_json: "{}",
      });
    });

    it("creates schema_meta table and sets version to SCHEMA_HEAD", () => {
      db = openDb(":memory:");
      runMigrations(db);
      expect(getSchemaVersion(db)).toBe(SCHEMA_HEAD);
    });

    it("is idempotent — repeated calls leave the schema unchanged", () => {
      db = openDb(":memory:");
      runMigrations(db);

      // Insert a row so we can confirm repeated runs don't wipe the table
      db.prepare(
        "INSERT INTO interactions (id, target, intent, author, author_role, body, created_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run("uuid-2", "block", "ask", "Bob", "user", "hello", "2026-01-01T00:00:00.000Z", "{}");

      expect(() => runMigrations(db)).not.toThrow();
      expect(getSchemaVersion(db)).toBe(SCHEMA_HEAD);

      expect(() => runMigrations(db)).not.toThrow();
      expect(getSchemaVersion(db)).toBe(SCHEMA_HEAD);

      // Row survives after all three runs
      const row = db.prepare("SELECT id FROM interactions WHERE id = ?").get("uuid-2");
      expect(row).toBeDefined();
    });

    it("creates the index on changeset_id", () => {
      db = openDb(":memory:");
      runMigrations(db);

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'interactions'"
        )
        .all() as { name: string }[];

      const names = indexes.map((r) => r.name);
      expect(names).toContain("idx_interactions_changeset");
    });

    it("creates the composite index on (worktree_path, agent_queue_status)", () => {
      db = openDb(":memory:");
      runMigrations(db);

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'interactions'"
        )
        .all() as { name: string }[];

      const names = indexes.map((r) => r.name);
      expect(names).toContain("idx_interactions_worktree");
    });
  });

  describe("schema v2", () => {
    it("creates the stat_dedup table", () => {
      db = openDb(":memory:");
      runMigrations(db);

      db.prepare(
        "INSERT INTO stat_dedup (name, dedup_key, recorded_at) VALUES (?, ?, ?)"
      ).run("review-started", "cs-abc", "2026-01-01T00:00:00.000Z");

      const row = db
        .prepare("SELECT * FROM stat_dedup WHERE name = ? AND dedup_key = ?")
        .get("review-started", "cs-abc") as Record<string, unknown>;
      expect(row).toMatchObject({
        name: "review-started",
        dedup_key: "cs-abc",
        recorded_at: "2026-01-01T00:00:00.000Z",
      });
    });

    it("makes (name, dedup_key) the stat_dedup primary key", () => {
      db = openDb(":memory:");
      runMigrations(db);

      const insert = db.prepare(
        "INSERT OR IGNORE INTO stat_dedup (name, dedup_key, recorded_at) VALUES (?, ?, ?)"
      );
      insert.run("install-active", "id:2026-01-01", "2026-01-01T00:00:00.000Z");
      const second = insert.run(
        "install-active",
        "id:2026-01-01",
        "2026-01-01T01:00:00.000Z",
      );
      expect(second.changes).toBe(0);
    });

    it("creates the settings table", () => {
      db = openDb(":memory:");
      runMigrations(db);

      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "install_id",
        "uuid-xyz",
      );
      const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("install_id") as { value: string };
      expect(row.value).toBe("uuid-xyz");
    });
  });

  describe("SCHEMA_HEAD", () => {
    it("is 2", () => {
      expect(SCHEMA_HEAD).toBe(2);
    });
  });
});
