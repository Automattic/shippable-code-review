import { afterEach, describe, expect, it, vi } from "vitest";

import { reportStat } from "./reportStat";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reportStat", () => {
  it("POSTs the stat name to /api/stats/event", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetchMock);

    reportStat("review-completed");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/stats/event");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "review-completed" });
  });

  it("includes dedupKey when given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetchMock);

    reportStat("review-started", "cs-42");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: "review-started",
      dedupKey: "cs-42",
    });
  });

  it("swallows a rejected fetch without throwing", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);

    expect(() => reportStat("file-marked-okay")).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
