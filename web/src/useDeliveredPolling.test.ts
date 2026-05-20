// @vitest-environment jsdom
// Hook-level tests for `useDeliveredPolling`. Uses @testing-library/react's
// `renderHook` to drive React's lifecycle; jsdom provides the DOM the React
// renderer expects. The polling predicate is `mounted && tab visible` —
// see docs/sdd/agent-reply-support/spec.md for why per-comment outstanding
// gates are unsound under multi-reply.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  POLL_INTERVAL_MS,
  useDeliveredPolling,
} from "./useDeliveredPolling";
import type { AgentRepliesResult } from "./agentContextClient";
import type { PolledAgentReply } from "./state";
import type { DeliveredInteraction } from "./types";

function delivered(id: string, deliveredAt = "2026-05-06T12:00:00.000Z"): DeliveredInteraction {
  return {
    id,
    target: "line",
    intent: "comment",
    author: "you",
    authorRole: "user",
    file: "f.ts",
    lines: "1",
    body: "b",
    commitSha: "sha",
    supersedes: null,
    enqueuedAt: "2026-05-06T11:00:00.000Z",
    deliveredAt,
  };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state === "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useDeliveredPolling — polling lifecycle", () => {
  it("does not poll when worktreePath is null", async () => {
    const fetcher = vi.fn(async () => [] as DeliveredInteraction[]);
    renderHook(() =>
      useDeliveredPolling({ worktreePath: null, fetcher }),
    );
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("polls at every POLL_INTERVAL_MS while mounted and tab is visible", async () => {
    const fetcher = vi.fn(async () => [delivered("cmt_1")]);
    renderHook(() => useDeliveredPolling({ worktreePath: "/wt", fetcher }));

    // Immediate first tick on mount.
    await act(() => Promise.resolve());
    expect(fetcher).toHaveBeenCalledTimes(1);

    const before = fetcher.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(fetcher.mock.calls.length).toBe(before + 1);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(fetcher.mock.calls.length).toBe(before + 2);
  });

  it("pauses while tab is hidden and resumes with an immediate catch-up poll on visible", async () => {
    const fetcher = vi.fn(async () => [delivered("cmt_1")]);
    renderHook(() => useDeliveredPolling({ worktreePath: "/wt", fetcher }));
    await act(() => Promise.resolve());
    const onMount = fetcher.mock.calls.length;
    expect(onMount).toBeGreaterThanOrEqual(1);

    // Hide tab — interval should clear, no further polls.
    await act(async () => {
      setVisibility("hidden");
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
      await Promise.resolve();
    });
    expect(fetcher.mock.calls.length).toBe(onMount);

    // Reveal — immediate catch-up poll fires synchronously, then the
    // interval re-arms.
    await act(async () => {
      setVisibility("visible");
      await Promise.resolve();
    });
    expect(fetcher.mock.calls.length).toBe(onMount + 1);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(fetcher.mock.calls.length).toBe(onMount + 2);
  });

  it("freezes the delivered list and flags `error` on a failed fetch", async () => {
    const fetcher = vi
      .fn<(p: string) => Promise<DeliveredInteraction[]>>()
      .mockResolvedValueOnce([delivered("cmt_1")])
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const repliesFetcher = vi.fn<(p: string) => Promise<AgentRepliesResult>>(
      async () => ({ replies: [], watching: false }),
    );

    const r = renderHook(() =>
      useDeliveredPolling({
        worktreePath: "/wt",
        fetcher,
        repliesFetcher,
      }),
    );
    await act(() => Promise.resolve());
    expect(r.result.current.delivered.map((d) => d.id)).toEqual(["cmt_1"]);
    expect(r.result.current.error).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(r.result.current.error).toBe(true);
    // Frozen — last good list survives the failed poll.
    expect(r.result.current.delivered.map((d) => d.id)).toEqual(["cmt_1"]);
  });

  it("Promise.allSettled keeps endpoints independent: delivered fails, replies succeeds → delivered frozen, agentReplies updated, error: true", async () => {
    // The headline behaviour change in the polling rewrite: a failure in
    // one endpoint must not poison the other. Pre-commit, delivered
    // would freeze in last-known state when its fetcher errored, but
    // there was a single try/catch; under Promise.allSettled the two
    // sides freeze independently.
    const ar = (id: string, postedAt: string): PolledAgentReply => ({
      id,
      parentId: "cmt_1",
      body: id,
      intent: "accept",
      author: "agent",
      authorRole: "agent",
      target: "reply",
      postedAt,
    });

    const fetcher = vi
      .fn<(p: string) => Promise<DeliveredInteraction[]>>()
      .mockResolvedValueOnce([delivered("cmt_1")])
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const repliesFetcher = vi
      .fn<(p: string) => Promise<AgentRepliesResult>>()
      .mockResolvedValueOnce({
        replies: [ar("ar1", "2026-05-06T12:01:00.000Z")],
        watching: false,
      })
      .mockResolvedValueOnce({
        replies: [
          ar("ar1", "2026-05-06T12:01:00.000Z"),
          ar("ar2", "2026-05-06T12:02:00.000Z"),
        ],
        watching: false,
      });

    const r = renderHook(() =>
      useDeliveredPolling({ worktreePath: "/wt", fetcher, repliesFetcher }),
    );

    // First tick: both succeed; both populated; no error.
    await act(() => Promise.resolve());
    expect(r.result.current.delivered.map((d) => d.id)).toEqual(["cmt_1"]);
    expect(r.result.current.agentReplies.map((a) => a.id)).toEqual(["ar1"]);
    expect(r.result.current.error).toBe(false);

    // Second tick: delivered errors; replies succeeds with a new entry.
    // delivered must stay frozen at ["cmt_1"]; agentReplies must update;
    // error flips true.
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(r.result.current.delivered.map((d) => d.id)).toEqual(["cmt_1"]);
    expect(r.result.current.agentReplies.map((a) => a.id)).toEqual([
      "ar1",
      "ar2",
    ]);
    expect(r.result.current.error).toBe(true);
  });

  it("Promise.allSettled keeps endpoints independent: replies fails, delivered succeeds → agentReplies frozen, delivered updated, error: true", async () => {
    // Mirror of the above with the failure on the other side.
    const fetcher = vi
      .fn<(p: string) => Promise<DeliveredInteraction[]>>()
      .mockResolvedValueOnce([delivered("cmt_1")])
      .mockResolvedValueOnce([delivered("cmt_1"), delivered("cmt_2")]);
    const repliesFetcher = vi
      .fn<(p: string) => Promise<AgentRepliesResult>>()
      .mockResolvedValueOnce({
        replies: [
          {
            id: "ar1",
            parentId: "cmt_1",
            body: "fixed",
            intent: "accept",
            author: "agent",
            authorRole: "agent",
            target: "reply",
            postedAt: "2026-05-06T12:01:00.000Z",
          },
        ],
        watching: false,
      })
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const r = renderHook(() =>
      useDeliveredPolling({ worktreePath: "/wt", fetcher, repliesFetcher }),
    );
    await act(() => Promise.resolve());
    expect(r.result.current.agentReplies.map((a) => a.id)).toEqual(["ar1"]);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    // delivered updated; agentReplies frozen at last good value.
    expect(r.result.current.delivered.map((d) => d.id)).toEqual([
      "cmt_1",
      "cmt_2",
    ]);
    expect(r.result.current.agentReplies.map((a) => a.id)).toEqual(["ar1"]);
    expect(r.result.current.error).toBe(true);
  });

  it("polls agent replies in parallel and exposes them on the result", async () => {
    const fetcher = vi.fn(async () => [delivered("cmt_1")]);
    const repliesFetcher = vi.fn<(p: string) => Promise<AgentRepliesResult>>(
      async () => ({
        replies: [
          {
            id: "ar1",
            parentId: "cmt_1",
            body: "fixed",
            intent: "accept",
            author: "agent",
            authorRole: "agent",
            target: "reply",
            postedAt: "2026-05-06T12:01:00.000Z",
          },
        ],
        watching: true,
      }),
    );
    const r = renderHook(() =>
      useDeliveredPolling({
        worktreePath: "/wt",
        fetcher,
        repliesFetcher,
      }),
    );
    await act(() => Promise.resolve());
    expect(repliesFetcher).toHaveBeenCalledWith("/wt");
    expect(r.result.current.agentReplies).toHaveLength(1);
    const first = r.result.current.agentReplies[0];
    expect("parentId" in first ? first.parentId : null).toBe("cmt_1");
    // The replies poll also carries watch state through to the panel.
    expect(r.result.current.watching).toBe(true);
  });

  it("resets state when worktreePath changes", async () => {
    const wt1Delivered = [delivered("cmt_a")];
    const wt2Delivered = [delivered("cmt_b")];
    const fetcher = vi.fn<(p: string) => Promise<DeliveredInteraction[]>>(
      async (p) => (p === "/wt1" ? wt1Delivered : wt2Delivered),
    );
    const repliesFetcher = vi.fn<(p: string) => Promise<AgentRepliesResult>>(
      async () => ({ replies: [], watching: false }),
    );

    const r = renderHook(
      ({ worktreePath }: { worktreePath: string }) =>
        useDeliveredPolling({ worktreePath, fetcher, repliesFetcher }),
      { initialProps: { worktreePath: "/wt1" } },
    );
    await act(() => Promise.resolve());
    expect(r.result.current.delivered.map((d) => d.id)).toEqual(["cmt_a"]);

    r.rerender({ worktreePath: "/wt2" });
    await act(() => Promise.resolve());
    expect(r.result.current.delivered.map((d) => d.id)).toEqual(["cmt_b"]);
  });
});
