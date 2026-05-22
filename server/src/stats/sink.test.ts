import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveStat } from "./known.ts";
import { LogSink, McSink } from "./sink.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LogSink", () => {
  it("writes [stat] <id> → <group>/<name> +<count> to the console", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    new LogSink().record(resolveStat("review-started"), 1);
    expect(log).toHaveBeenCalledWith(
      "[stat] review-started → shippable-reviews/started +1",
    );
  });
});

describe("McSink", () => {
  it("GETs the g.gif pixel with the x_<group>/<name>=<count> multiplier", () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    new McSink().record(resolveStat("review-started"), 3);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://pixel.wp.com/g.gif?v=wpcom-no-pv&x_shippable-reviews/started=3",
    );
  });

  it("routes each stat to its own group and name", () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    new McSink().record(resolveStat("comment-posted-ai"), 1);
    new McSink().record(resolveStat("install-new"), 1);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://pixel.wp.com/g.gif?v=wpcom-no-pv&x_shippable-comments/ai=1",
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://pixel.wp.com/g.gif?v=wpcom-no-pv&x_shippable-installs/new=1",
    );
  });

  it("swallows a rejected fetch without throwing", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(() =>
      new McSink().record(resolveStat("review-started"), 1),
    ).not.toThrow();
  });
});
