// Mirrors local user-authored interaction mutations to the server DB.
//
// Mechanism: a `dispatch` wrapper. The wrapper sees the *action*, which
// is what lets it tell a user-authored mutation apart from interactions
// that merely *appeared* in state — DB fetches (LOAD_CHANGESET), agent
// polls (MERGE_AGENT_REPLIES), PR imports (MERGE_PR_INTERACTIONS) must
// NOT be echoed back to the server. A plain state-diff effect can't make
// that distinction; the action can.
//
//   ADD_INTERACTION / TOGGLE_ACK → upsert the new/changed interaction
//   DELETE_INTERACTION           → delete by id
//   everything else              → pass through untouched
//
// TOGGLE_ACK constructs its Interaction inside the reducer, so the
// wrapper runs the (pure) reducer itself to recover the new entry by
// diffing the affected thread. Only `authorRole: "user"` non-PR entries
// are mirrored. A failed upsert dispatches SET_INTERACTION_ENQUEUE_ERROR
// (the ⚠ retry pip); a genuinely-down DB is the health gate's job.

import { useCallback, useEffect, useRef } from "react";
import { deleteInteraction, upsertInteraction } from "./interactionClient";
import { reducer } from "./state";
import { lineNoteReplyKey } from "./types";
import type { Action } from "./state";
import type { Interaction, ReviewState } from "./types";

function shouldMirror(ix: Interaction): boolean {
  return ix.authorRole === "user" && ix.external?.source !== "pr";
}

/** The interaction a TOGGLE_ACK appended — the entry present on the
 *  thread in `next` but not in `prev`. */
function ackedInteraction(
  prev: ReviewState,
  next: ReviewState,
  threadKey: string,
): Interaction | null {
  const before = prev.interactions[threadKey] ?? [];
  const after = next.interactions[threadKey] ?? [];
  if (after.length <= before.length) return null;
  const beforeIds = new Set(before.map((ix) => ix.id));
  return after.find((ix) => !beforeIds.has(ix.id)) ?? null;
}

export function useInteractionSync(
  state: ReviewState,
  dispatch: React.Dispatch<Action>,
  changesetId: string | null,
  worktreePath: string | null,
): React.Dispatch<Action> {
  // Latest state + changesetId + worktreePath in refs so the wrapper identity
  // is stable (it's threaded deep through the tree as `dispatch`).
  const stateRef = useRef(state);
  const changesetIdRef = useRef(changesetId);
  const worktreePathRef = useRef(worktreePath);
  useEffect(() => {
    stateRef.current = state;
    changesetIdRef.current = changesetId;
    worktreePathRef.current = worktreePath;
  });

  return useCallback(
    (action: Action) => {
      const csId = changesetIdRef.current;
      const wtPath = worktreePathRef.current ?? undefined;
      const fail = (threadKey: string, id: string) => (err: unknown) => {
        console.error("[shippable] interaction sync failed:", err);
        dispatch({
          type: "SET_INTERACTION_ENQUEUE_ERROR",
          targetKey: threadKey,
          interactionId: id,
          error: true,
        });
      };

      if (csId) {
        if (action.type === "ADD_INTERACTION") {
          const ix = action.interaction;
          if (shouldMirror(ix)) {
            upsertInteraction(ix, csId, wtPath).catch(fail(action.targetKey, ix.id));
          }
        } else if (action.type === "TOGGLE_ACK") {
          const next = reducer(stateRef.current, action);
          const threadKey = lineNoteReplyKey(action.hunkId, action.lineIdx);
          const ix = ackedInteraction(stateRef.current, next, threadKey);
          if (ix && shouldMirror(ix)) {
            upsertInteraction(ix, csId, wtPath).catch(fail(threadKey, ix.id));
          }
        } else if (action.type === "DELETE_INTERACTION") {
          // The interaction may be agent/PR-sourced — only DB-row deletes
          // for entries we'd have mirrored. Look it up before it's gone.
          const list = stateRef.current.interactions[action.targetKey] ?? [];
          const ix = list.find((e) => e.id === action.interactionId);
          if (ix && shouldMirror(ix)) {
            deleteInteraction(ix.id).catch((err: unknown) => {
              // The interaction is already gone from local state — no row
              // to hang an error pip on. Log; the next load reconciles.
              console.error("[shippable] interaction delete failed:", err);
            });
          }
        }
      }

      dispatch(action);
    },
    [dispatch],
  );
}
