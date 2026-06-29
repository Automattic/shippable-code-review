import { useEffect, useRef } from "react";
import { apiUrl } from "./apiUrl";
import type { WorktreeProvenance, WorktreeState } from "./types";

const POLL_INTERVAL_MS = 3_000;
// Three consecutive polling failures means the worktree is gone (path
// removed, server died, network sleep). Below the threshold we silently
// retry — single transient errors aren't worth surfacing.
const ERROR_THRESHOLD = 3;

interface Args {
  provenance: WorktreeProvenance | null;
  enabled: boolean;
  /** Surface a new HEAD. False for a range pinned to a fixed `toRef` — a
   *  fresh commit wouldn't change that diff, so reloading would be a no-op. */
  watchSha: boolean;
  /** Surface uncommitted edits. False for a slice that excludes them (a range
   *  loaded without "include uncommitted") — the reload wouldn't show them,
   *  so nudging to reload only to load nothing is misleading. */
  watchDirty: boolean;
  onDrift: (next: WorktreeState) => void;
  onWorktreeGone: () => void;
}

/**
 * Poll `/api/worktrees/state` while a worktree is loaded. When the returned
 * `(sha, dirtyHash)` drifts from the baseline, fire `onDrift` with the new
 * state — the parent decides what to do (banner now, reload on click). Only
 * the kinds of drift the loaded slice would actually reflect on reload are
 * surfaced (`watchSha` / `watchDirty`); the rest are ignored so we never nudge
 * a reload that loads nothing.
 *
 * Three consecutive failures fire `onWorktreeGone` once and stop polling.
 * Callbacks are captured via refs so changing their identity each render
 * doesn't restart the loop.
 */
export function useWorktreeLiveReload({
  provenance,
  enabled,
  watchSha,
  watchDirty,
  onDrift,
  onWorktreeGone,
}: Args): void {
  const onDriftRef = useRef(onDrift);
  const onGoneRef = useRef(onWorktreeGone);
  useEffect(() => {
    onDriftRef.current = onDrift;
    onGoneRef.current = onWorktreeGone;
  });

  const path = provenance?.path ?? null;
  const baselineSha = provenance?.state.sha ?? null;
  const baselineDirtyHash = provenance?.state.dirtyHash ?? null;

  useEffect(() => {
    if (!path || !enabled) return;

    let cancelled = false;
    let timer: number | null = null;
    let consecutiveErrors = 0;
    let surfacedGone = false;

    async function tick() {
      if (cancelled) return;
      try {
        const res = await fetch(await apiUrl("/api/worktrees/state"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        if (cancelled) return;
        if (!res.ok) {
          consecutiveErrors += 1;
        } else {
          consecutiveErrors = 0;
          const json = (await res.json()) as WorktreeState;
          const shaDrifted = watchSha && json.sha !== baselineSha;
          const dirtyDrifted =
            watchDirty && (json.dirtyHash ?? null) !== baselineDirtyHash;
          if (shaDrifted || dirtyDrifted) {
            onDriftRef.current(json);
          }
        }
      } catch {
        consecutiveErrors += 1;
      }
      if (consecutiveErrors >= ERROR_THRESHOLD) {
        if (!surfacedGone) {
          surfacedGone = true;
          onGoneRef.current();
        }
        return;
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [path, baselineSha, baselineDirtyHash, enabled, watchSha, watchDirty]);
}
