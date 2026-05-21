import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "./apiUrl";
import { planReview } from "./plan";
import type { ChangeSet, Question, ReviewPlan } from "./types";

export type PlanStatus = "idle" | "loading" | "ready" | "fallback";

export interface UsePlanResult {
  plan: ReviewPlan;
  questions: Question[];
  status: PlanStatus;
  error?: string;
  /** Caller invokes this to send the diff to the AI provider. No-op once
   *  the request is already in flight or has resolved. */
  generate: () => void;
}

/**
 * Holds the rule-based plan as the default and fetches the AI plan only when
 * the caller explicitly invokes `generate()`. Sending the diff to a third
 * party is a privacy + cost decision, so we make it an opt-in per ChangeSet
 * rather than firing on mount.
 *
 * State machine:
 *   idle --(generate)--> loading --> ready
 *                                 \-> fallback   (error or refusal)
 *
 * Switching ChangeSet resets to "idle" and aborts any in-flight request.
 */
export function usePlan(cs: ChangeSet): UsePlanResult {
  const rulePlan = useMemo(() => planReview(cs), [cs]);
  const [prevCs, setPrevCs] = useState(cs);
  const [aiPlan, setAiPlan] = useState<ReviewPlan | null>(null);
  const [aiQuestions, setAiQuestions] = useState<Question[]>([]);
  const [status, setStatus] = useState<PlanStatus>("idle");
  const [error, setError] = useState<string | undefined>(undefined);

  // Reset on changeset switch (the prevState-during-render pattern, so we
  // don't need a setState-in-effect).
  if (cs !== prevCs) {
    setPrevCs(cs);
    setAiPlan(null);
    setAiQuestions([]);
    setStatus("idle");
    setError(undefined);
  }

  // Track which cs the caller is currently looking at, so generate() can
  // drop a stale fetch result if state has moved on by the time it resolves.
  const csRef = useRef(cs);
  useEffect(() => {
    csRef.current = cs;
  });

  const generate = useCallback(() => {
    const targetCs = csRef.current;
    setStatus("loading");
    setError(undefined);
    apiUrl("/api/plan")
      .then((url) =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changeset: targetCs }),
        }),
      )
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`HTTP ${res.status}: ${body}`);
        }
        return res.json() as Promise<{ plan: ReviewPlan; questions: Question[] }>;
      })
      .then((body) => {
        if (csRef.current !== targetCs) return; // user moved on, drop the result
        setAiPlan(body.plan);
        setAiQuestions(body.questions ?? []);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (csRef.current !== targetCs) return;
        console.warn("[usePlan] AI plan failed, staying on rule-based:", err);
        setError(err instanceof Error ? err.message : String(err));
        setStatus("fallback");
      });
  }, []);

  return { plan: aiPlan ?? rulePlan, questions: aiQuestions, status, error, generate };
}
