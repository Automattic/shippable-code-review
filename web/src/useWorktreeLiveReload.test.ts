// @vitest-environment jsdom
// Gating tests for `useWorktreeLiveReload`: the poll only surfaces drift the
// loaded slice would actually reflect on reload. A range without "include
// uncommitted" must ignore dirty drift; a range pinned to a fixed `toRef` must
// ignore new commits. Otherwise we'd nudge a reload that loads nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWorktreeLiveReload } from "./useWorktreeLiveReload";
import type { WorktreeProvenance, WorktreeState } from "./types";

vi.mock("./apiUrl", () => ({ apiUrl: async (p: string) => p }));

const POLL_MS = 3_000;

function provenanceWith(state: WorktreeState): WorktreeProvenance {
  return { path: "/wt", branch: "feat/x", state };
}

/** Stub global fetch so every poll returns `next`. */
function stubPoll(next: WorktreeState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => next }) as Response),
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useWorktreeLiveReload — drift gating", () => {
  const clean: WorktreeState = { sha: "aaa", dirty: false, dirtyHash: null };
  const nowDirty: WorktreeState = { sha: "aaa", dirty: true, dirtyHash: "h1" };
  const newCommit: WorktreeState = { sha: "bbb", dirty: false, dirtyHash: null };

  it("watchDirty=false ignores uncommitted edits appearing", async () => {
    stubPoll(nowDirty);
    const onDrift = vi.fn();
    renderHook(() =>
      useWorktreeLiveReload({
        provenance: provenanceWith(clean),
        enabled: true,
        watchSha: true,
        watchDirty: false,
        onDrift,
        onWorktreeGone: vi.fn(),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(onDrift).not.toHaveBeenCalled();
  });

  it("watchDirty=true surfaces uncommitted edits appearing", async () => {
    stubPoll(nowDirty);
    const onDrift = vi.fn();
    renderHook(() =>
      useWorktreeLiveReload({
        provenance: provenanceWith(clean),
        enabled: true,
        watchSha: true,
        watchDirty: true,
        onDrift,
        onWorktreeGone: vi.fn(),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(onDrift).toHaveBeenCalledWith(nowDirty);
  });

  it("watchSha=false ignores a fresh commit (fixed-range toRef)", async () => {
    stubPoll(newCommit);
    const onDrift = vi.fn();
    renderHook(() =>
      useWorktreeLiveReload({
        provenance: provenanceWith(clean),
        enabled: true,
        watchSha: false,
        watchDirty: true,
        onDrift,
        onWorktreeGone: vi.fn(),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(onDrift).not.toHaveBeenCalled();
  });

  it("watchSha=true surfaces a fresh commit", async () => {
    stubPoll(newCommit);
    const onDrift = vi.fn();
    renderHook(() =>
      useWorktreeLiveReload({
        provenance: provenanceWith(clean),
        enabled: true,
        watchSha: true,
        watchDirty: true,
        onDrift,
        onWorktreeGone: vi.fn(),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(onDrift).toHaveBeenCalledWith(newCommit);
  });
});
