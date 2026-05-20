// Polls /api/agent/delivered while the panel is mounted AND the tab is
// visible. Both gates required; either one false stops polling. See
// docs/sdd/agent-reply-support/spec.md for why per-comment outstanding
// gates are unsound under multi-reply.
//
// The hook is the visual heartbeat for the queue substrate: it flips
// `◌ queued` pips to `✓ delivered` once the agent fetches a comment and
// drives the panel-level "Delivered (N)" block + failure banner.
//
// Behavior contract:
//   - One immediate fetch on mount; then every POLL_INTERVAL_MS while the
//     tab is visible.
//   - Tab visibility transitions: hide → pause; show → one immediate
//     catch-up poll, then resume the interval.
//   - Errors do NOT throw. They flip `error` to true and freeze the
//     `delivered` array in its last-known state until a successful poll
//     overwrites both.
//   - Tests can inject `fetcher` and a fake `setInterval`/clock.

import { useEffect, useRef, useState } from "react";
import {
  fetchAgentReplies,
  fetchDelivered,
  type AgentRepliesResult,
} from "./agentContextClient";
import type { PolledAgentReply } from "./state";
import type { DeliveredInteraction } from "./types";

/** Match the existing AgentContextSection cadence. */
export const POLL_INTERVAL_MS = 2000;

export interface DeliveredPollingResult {
  delivered: DeliveredInteraction[];
  /**
   * Polled agent replies (flat list). The caller dispatches
   * `MERGE_AGENT_REPLIES` with this on change so the reducer reconciles
   * them into the matching thread by `parentId` → interaction `id`, or by
   * (file, lines) → hunkId for top-level entries.
   */
  agentReplies: PolledAgentReply[];
  /**
   * True while an agent is in watch mode for this worktree — drives the
   * panel's "Agent is watching" indicator. Frozen at last-known on a failed
   * replies poll, same as `agentReplies`.
   */
  watching: boolean;
  /** ISO of the last successful fetch; null until the first one lands. */
  lastSuccessfulPollAt: string | null;
  /** True iff the most recent fetch errored. */
  error: boolean;
}

export interface UseDeliveredPollingArgs {
  /**
   * The active worktree path. `null` disables the hook entirely (no
   * worktree loaded → no panel → no polling).
   */
  worktreePath: string | null;
  /**
   * Override the delivered-comments fetcher. Defaults to the real
   * `fetchDelivered` from `agentContextClient`.
   */
  fetcher?: (worktreePath: string) => Promise<DeliveredInteraction[]>;
  /**
   * Override the agent-replies fetcher. Defaults to the real
   * `fetchAgentReplies` from `agentContextClient`.
   */
  repliesFetcher?: (worktreePath: string) => Promise<AgentRepliesResult>;
}

export function useDeliveredPolling({
  worktreePath,
  fetcher = fetchDelivered,
  repliesFetcher = fetchAgentReplies,
}: UseDeliveredPollingArgs): DeliveredPollingResult {
  const [delivered, setDelivered] = useState<DeliveredInteraction[]>([]);
  const [agentReplies, setAgentReplies] = useState<PolledAgentReply[]>([]);
  const [watching, setWatching] = useState(false);
  const [lastSuccessfulPollAt, setLastSuccessfulPollAt] = useState<
    string | null
  >(null);
  const [error, setError] = useState(false);

  // "Adjusting state during render" — same pattern App.tsx uses for the
  // agent-context fetch. When `worktreePath` transitions we synchronously
  // wipe the previous worktree's snapshot so the effect body stays free
  // of cascading setState() calls (the lint rule is strict about that).
  const [lastResetWorktree, setLastResetWorktree] = useState<string | null>(
    worktreePath,
  );
  if (lastResetWorktree !== worktreePath) {
    setLastResetWorktree(worktreePath);
    setDelivered([]);
    setAgentReplies([]);
    setWatching(false);
    setLastSuccessfulPollAt(null);
    setError(false);
  }

  // Latest fetchers in refs so the polling effect doesn't restart whenever
  // a new fetcher reference is passed (parents commonly do this from a
  // closure).
  const fetcherRef = useRef(fetcher);
  const repliesFetcherRef = useRef(repliesFetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
    repliesFetcherRef.current = repliesFetcher;
  }, [fetcher, repliesFetcher]);

  useEffect(() => {
    if (!worktreePath) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (cancelled) return;
      // Run both endpoints in parallel but handle outcomes independently:
      // a failed agent-replies fetch shouldn't wipe a successful delivered
      // poll, and vice versa.
      const [deliveredResult, repliesResult] = await Promise.allSettled([
        fetcherRef.current(worktreePath),
        repliesFetcherRef.current(worktreePath),
      ]);
      if (cancelled) return;
      let anyOk = false;
      if (deliveredResult.status === "fulfilled") {
        setDelivered(deliveredResult.value);
        anyOk = true;
      }
      if (repliesResult.status === "fulfilled") {
        setAgentReplies(repliesResult.value.replies);
        setWatching(repliesResult.value.watching);
        anyOk = true;
      }
      if (anyOk) setLastSuccessfulPollAt(new Date().toISOString());
      setError(
        deliveredResult.status === "rejected" ||
          repliesResult.status === "rejected",
      );
    };

    const start = () => {
      if (timer) return;
      void tick();
      timer = setInterval(tick, POLL_INTERVAL_MS);
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Catch-up poll fires immediately, then the interval re-arms.
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [worktreePath]);

  return { delivered, agentReplies, watching, lastSuccessfulPollAt, error };
}
