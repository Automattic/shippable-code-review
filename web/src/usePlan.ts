import { useCallback } from "react";
import {
  useRegeneratePlan,
  useTriggerPlan,
  usePlanState,
  type PlanStatus,
} from "./PlanProvider";
import type { ChangeSet, Question, ReviewPlan } from "./types";

export type { PlanStatus };

export interface UsePlanResult {
  plan: ReviewPlan;
  questions: Question[];
  status: PlanStatus;
  error?: string;
  /** Fires the AI request for `cs` if it has not been fetched in this
   *  session yet. Idempotent: a cached or in-flight entry is a no-op. */
  generate: () => void;
  /** Discards any cached entry for `cs` and fires a fresh AI request. */
  regenerate: () => void;
}

/**
 * Bound view of the plan cache for a single ChangeSet. Reads through to
 * {@link PlanProvider}; the rule-based plan is the default and the AI plan
 * replaces it when ready.
 */
export function usePlan(cs: ChangeSet): UsePlanResult {
  const state = usePlanState(cs);
  const triggerPlan = useTriggerPlan();
  const regeneratePlan = useRegeneratePlan();
  const generate = useCallback(() => triggerPlan(cs), [triggerPlan, cs]);
  const regenerate = useCallback(
    () => regeneratePlan(cs),
    [regeneratePlan, cs],
  );
  return { ...state, generate, regenerate };
}
