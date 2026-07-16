// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserId, resetForTests } from "./userId";

const STORAGE_KEY = "shippable:userId:v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  resetForTests();
});

describe("getUserId", () => {
  it("mints a uuid-shaped id on first call", () => {
    expect(getUserId()).toMatch(UUID_RE);
  });

  it("persists the minted id under shippable:userId:v1", () => {
    const id = getUserId();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(id);
  });

  it("returns the same id across repeated calls", () => {
    const first = getUserId();
    const second = getUserId();
    expect(second).toBe(first);
  });

  it("reads a pre-existing stored id instead of minting a new one", () => {
    localStorage.setItem(STORAGE_KEY, "fixed-id-from-storage");
    expect(getUserId()).toBe("fixed-id-from-storage");
  });

  it("falls back to an in-memory id when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: private mode");
    });
    expect(getUserId()).toMatch(UUID_RE);
  });

  it("keeps the same in-memory fallback id across calls when storage keeps throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: private mode");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError: private mode");
    });
    const first = getUserId();
    const second = getUserId();
    expect(second).toBe(first);
  });

  it("keeps one id for the session even when storage fails and then recovers", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    const first = getUserId();

    getItem.mockRestore();
    setItem.mockRestore();
    const second = getUserId();
    expect(second).toBe(first);
  });

  it("does not throw when localStorage.setItem throws (quota/private mode)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => getUserId()).not.toThrow();
  });
});
