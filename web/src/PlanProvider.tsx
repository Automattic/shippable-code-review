/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiUrl } from "./apiUrl";
import { planReview } from "./plan";
import type { ChangeSet, Question, ReviewPlan } from "./types";

export type PlanStatus = "idle" | "loading" | "ready" | "fallback";

export interface PlanState {
  plan: ReviewPlan;
  questions: Question[];
  status: PlanStatus;
  error?: string;
}

interface CacheEntry {
  status: Exclude<PlanStatus, "idle">;
  plan?: ReviewPlan;
  questions: Question[];
  error?: string;
}

interface PlanContextValue {
  get(cs: ChangeSet): PlanState;
  trigger(cs: ChangeSet): void;
  regenerate(cs: ChangeSet): void;
  setActive(cs: ChangeSet | null): void;
}

const PlanContext = createContext<PlanContextValue | null>(null);

/** Stable per-CS cache key. Captures file shape + commit shas so a re-ingest
 *  that keeps cs.id but changes the diff invalidates the cached plan. */
function cacheKey(cs: ChangeSet): string {
  const files = cs.files
    .map((f) => `${f.id}:${f.hunks.length}`)
    .join(",");
  const commits = (cs.commits ?? []).map((c) => c.sha).join(",");
  return `${cs.id}|${files}|${commits}`;
}

/** Cache + auto-fire coordinator for the AI review plan. One provider wraps
 *  the workspace; the overlay and the file sidebar both consume from here so
 *  that plans survive overlay open/close and reach the sidebar without prop
 *  drilling.
 *
 *  Cache is in-session (a plain Map in state, dropped on reload). Two kinds
 *  of requests can be in flight:
 *    - auto: fires on first sight of a ChangeSet when a key is configured.
 *            Never aborted on CS switch — the result lands in the cache so a
 *            revisit is instant.
 *    - regenerate: user-initiated. Aborted if the user switches away while it
 *                  is still in flight; the previous cache entry is restored. */
export function PlanProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Map<string, CacheEntry>>(
    () => new Map(),
  );

  // Regenerate is "tied to the active CS." Track the in-flight regenerate
  // controller separately so a CS switch can abort it.
  const regenerateRef = useRef<
    { key: string; controller: AbortController } | null
  >(null);
  const activeKeyRef = useRef<string | null>(null);

  const writeEntry = useCallback((key: string, entry: CacheEntry) => {
    setEntries((prev) => {
      const next = new Map(prev);
      next.set(key, entry);
      return next;
    });
  }, []);

  const restoreOrClear = useCallback(
    (key: string, previous: CacheEntry | undefined) => {
      setEntries((prev) => {
        const next = new Map(prev);
        if (previous) next.set(key, previous);
        else next.delete(key);
        return next;
      });
    },
    [],
  );

  const fireRequest = useCallback(
    (cs: ChangeSet, kind: "auto" | "regenerate") => {
      const key = cacheKey(cs);
      const previous = entries.get(key);
      writeEntry(key, {
        status: "loading",
        plan: previous?.plan,
        questions: previous?.questions ?? [],
      });

      let signal: AbortSignal | undefined;
      if (kind === "regenerate") {
        const ctrl = new AbortController();
        regenerateRef.current = { key, controller: ctrl };
        signal = ctrl.signal;
      }

      apiUrl("/api/plan")
        .then((url) =>
          fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ changeset: cs }),
            signal,
          }),
        )
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.text();
            throw new Error(`HTTP ${res.status}: ${body}`);
          }
          return res.json() as Promise<{
            plan: ReviewPlan;
            questions: Question[];
          }>;
        })
        .then((body) => {
          writeEntry(key, {
            status: "ready",
            plan: body.plan,
            questions: body.questions ?? [],
          });
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") {
            restoreOrClear(key, previous);
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          writeEntry(key, {
            status: "fallback",
            plan: previous?.plan,
            questions: previous?.questions ?? [],
            error: message,
          });
        })
        .finally(() => {
          if (
            kind === "regenerate" &&
            regenerateRef.current?.key === key
          ) {
            regenerateRef.current = null;
          }
        });
    },
    [entries, writeEntry, restoreOrClear],
  );

  const trigger = useCallback(
    (cs: ChangeSet) => {
      const key = cacheKey(cs);
      // Idempotent: any prior entry (loading/ready/fallback) wins. Re-firing
      // happens through regenerate() or a fallback-aware re-arm in the host.
      if (entries.has(key)) return;
      fireRequest(cs, "auto");
    },
    [entries, fireRequest],
  );

  const regenerate = useCallback(
    (cs: ChangeSet) => {
      const key = cacheKey(cs);
      // If a regenerate for this cs is in flight, abort it before starting
      // a new one. Auto-fire requests are not aborted here — they will land
      // harmlessly into the cache slot that this new fetch is about to
      // overwrite (the latest writer wins). In practice they have already
      // resolved by the time the user clicks Regenerate.
      if (regenerateRef.current?.key === key) {
        regenerateRef.current.controller.abort();
        regenerateRef.current = null;
      }
      // Evict and refire. The fireRequest function will see no previous entry
      // and treat this as a fresh load.
      setEntries((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      fireRequest(cs, "regenerate");
    },
    [fireRequest],
  );

  const setActive = useCallback((cs: ChangeSet | null) => {
    const key = cs ? cacheKey(cs) : null;
    activeKeyRef.current = key;
    if (
      regenerateRef.current &&
      regenerateRef.current.key !== key
    ) {
      regenerateRef.current.controller.abort();
      regenerateRef.current = null;
    }
  }, []);

  const get = useCallback(
    (cs: ChangeSet): PlanState => {
      const rulePlan = planReview(cs);
      const entry = entries.get(cacheKey(cs));
      if (!entry) {
        return { plan: rulePlan, questions: [], status: "idle" };
      }
      return {
        plan: entry.plan ?? rulePlan,
        questions: entry.questions,
        status: entry.status,
        error: entry.error,
      };
    },
    [entries],
  );

  // Context value rebuilds on every entries change. That's the point — every
  // consumer of get(cs) needs to re-render when the cache flips.
  const value: PlanContextValue = useMemo(
    () => ({ get, trigger, regenerate, setActive }),
    [get, trigger, regenerate, setActive],
  );

  return (
    <PlanContext.Provider value={value}>{children}</PlanContext.Provider>
  );
}

/** Read the plan state for a ChangeSet. Returns the rule-based plan as the
 *  base, replaced by the AI plan once it lands. Components that need to fire
 *  a request use {@link useTriggerPlan} or {@link useRegeneratePlan}. */
export function usePlanState(cs: ChangeSet): PlanState {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error("usePlanState: missing PlanProvider");
  return ctx.get(cs);
}

export function useTriggerPlan(): (cs: ChangeSet) => void {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error("useTriggerPlan: missing PlanProvider");
  return ctx.trigger;
}

export function useRegeneratePlan(): (cs: ChangeSet) => void {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error("useRegeneratePlan: missing PlanProvider");
  return ctx.regenerate;
}

export function useSetActivePlanCs(): (cs: ChangeSet | null) => void {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error("useSetActivePlanCs: missing PlanProvider");
  return ctx.setActive;
}
