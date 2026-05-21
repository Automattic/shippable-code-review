import { afterEach, describe, expect, it, vi } from "vitest";

import { LogSink, McSink } from "./sink.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LogSink", () => {
  it("writes [stat] <name> +<count> to the console", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    new LogSink().record("review-started", 1);
    expect(log).toHaveBeenCalledWith("[stat] review-started +1");
  });
});

describe("McSink", () => {
  it("GETs the g.gif pixel with the x_<group>/<name>=<count> multiplier", () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    new McSink({}).record("review-started", 3);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://pixel.wp.com/g.gif?v=wpcom-no-pv&x_shippable/review-started=3",
    );
  });

  it("uses SHIPPABLE_STATS_GROUP for the group", () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    new McSink({ SHIPPABLE_STATS_GROUP: "myproduct" }).record("install-new", 1);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://pixel.wp.com/g.gif?v=wpcom-no-pv&x_myproduct/install-new=1",
    );
  });

  it("swallows a rejected fetch without throwing", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(() => new McSink({}).record("review-started", 1)).not.toThrow();
  });
});
