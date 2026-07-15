import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, resetForTests } from "./index.ts";
import { getUser, upsertUser } from "./user-store.ts";

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
});

afterEach(() => {
  resetForTests();
});

describe("upsertUser", () => {
  it("inserts a new user with an empty display_name", () => {
    upsertUser("u1", "human", "2026-01-01T00:00:00.000Z");
    expect(getUser("u1")).toEqual({
      id: "u1",
      role: "human",
      displayName: "",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("a second upsert for the same id bumps only last_seen_at", () => {
    upsertUser("u2", "human", "2026-01-01T00:00:00.000Z");
    upsertUser("u2", "human", "2026-01-02T00:00:00.000Z");
    expect(getUser("u2")).toEqual({
      id: "u2",
      role: "human",
      displayName: "",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("a conflicting role claim does not flip role — first sight wins", () => {
    upsertUser("u3", "human", "2026-01-01T00:00:00.000Z");
    upsertUser("u3", "ai", "2026-01-02T00:00:00.000Z");
    const user = getUser("u3");
    expect(user?.role).toBe("human");
    expect(user?.lastSeenAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("defaults now to the current time when not supplied", () => {
    const before = Date.now();
    upsertUser("u4", "ai");
    const user = getUser("u4");
    expect(user).toBeDefined();
    expect(new Date(user!.lastSeenAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("getUser", () => {
  it("returns undefined for an unknown id", () => {
    expect(getUser("no-such-user")).toBeUndefined();
  });

  it("round-trips id, role, displayName, lastSeenAt", () => {
    upsertUser("u5", "ai", "2026-03-01T00:00:00.000Z");
    expect(getUser("u5")).toEqual({
      id: "u5",
      role: "ai",
      displayName: "",
      lastSeenAt: "2026-03-01T00:00:00.000Z",
    });
  });
});
