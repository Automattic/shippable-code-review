import { describe, it, expect, afterEach } from "vitest";

import { initDb, getDb, getDbStatus, resetForTests } from "./index.ts";
import { SCHEMA_HEAD } from "./schema.ts";

afterEach(() => {
  resetForTests();
});

describe("initDb — happy path", () => {
  it("returns without throwing when using :memory:", async () => {
    await expect(
      initDb({ SHIPPABLE_DB_PATH: ":memory:" }),
    ).resolves.toBeUndefined();
  });

  it("sets status to { status: 'ok' } after successful open+migrate", async () => {
    await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
    expect(getDbStatus()).toEqual({ status: "ok" });
  });

  it("exposes getDb() after a successful init", async () => {
    await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
    const db = getDb();
    // Basic smoke: the handle is usable.
    expect(() => db.exec("SELECT 1")).not.toThrow();
  });

  it("schema_meta table exists after init (migrations ran)", async () => {
    await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_HEAD));
  });
});

describe("initDb — failure path", () => {
  it("does NOT throw when resolveDbPath fails (no HOME, no SHIPPABLE_DB_PATH)", async () => {
    // An empty env has neither SHIPPABLE_DB_PATH nor any HOME-like var,
    // so resolveDbPath throws — initDb must absorb it.
    await expect(initDb({})).resolves.toBeUndefined();
  });

  it("sets status to { status: 'error', error: <message> } when open/migrate fails", async () => {
    await initDb({});
    const status = getDbStatus();
    expect(status.status).toBe("error");
    // A non-empty error string is sufficient — avoid coupling to location.ts wording.
    expect((status as { status: "error"; error: string }).error).toBeTruthy();
  });

  it("getDb() throws after a failed init", async () => {
    await initDb({});
    expect(() => getDb()).toThrow(/not.*init|uninitialised|no.*database/i);
  });
});

describe("getDb() before init", () => {
  it("throws a clear error when called before any successful init", () => {
    // resetForTests() was called in afterEach so singleton is clear.
    expect(() => getDb()).toThrow(/not.*init|uninitialised|no.*database/i);
  });
});
