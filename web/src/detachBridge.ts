// Parent-side bridge for detached sidebar/inspector child windows.
//
// Three responsibilities:
//   1. Track which kinds are currently detached for this window. The Rust
//      registry is the source of truth (see lib.rs) — JS just mirrors it.
//   2. Push a fresh snapshot to the child whenever the content changes, and
//      once on `shippable:detach-ready:<self>` so a newly mounted child
//      doesn't render empty until the next parent re-render.
//   3. Receive `shippable:detach-action:<self>` messages and route each
//      one to the same handler the docked panel would use today.
//
// See docs/plans/detached-sidebars.md ("Wire format") for the shape of the
// state-push and action messages.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "./keychain";
import {
  listDetachedChildren,
  type DetachedKind,
} from "./multiWindow";
import type { InspectorViewModel, SidebarViewModel } from "./view";
import type { PromptRunView } from "./components/PromptRunsPanel";
import type {
  AgentContextSlice,
  AgentSessionRef,
  Cursor,
  DeliveredInteraction,
  Interaction,
  LineSelection,
} from "./types";

// ── Wire types ────────────────────────────────────────────────────────────

export interface SidebarSnapshot {
  viewModel: SidebarViewModel;
  runs: PromptRunView[];
  wide: boolean;
  /** PR title / changeset title / branch — whatever's most identifying
   *  for the parent review. Rendered in the detached chrome so the user
   *  knows which window this child belongs to when many are open. */
  parentTitle: string;
}

export type SidebarAction =
  | { type: "pick-file"; fileId: string }
  | { type: "jump-to-first-comment"; fileId: string }
  | { type: "close-run"; id: string }
  | { type: "toggle-wide" };

/** The data half of the docked Inspector's AgentContextProps. Callbacks
 *  (onPickSession, onRefresh) are reconstructed in the child to emit
 *  pick-session / refresh actions. */
export interface AgentContextData {
  slice: AgentContextSlice | null;
  candidates: AgentSessionRef[];
  selectedSessionFilePath: string | null;
  loading: boolean;
  error: string | null;
  mcpStatus: { installed: boolean; installCommand: string } | null;
  delivered: DeliveredInteraction[];
  lastSuccessfulPollAt: string | null;
  deliveredError: boolean;
  agentStartedThreads: Array<{ threadKey: string; head: Interaction }>;
}

export interface InspectorSnapshot {
  viewModel: InspectorViewModel;
  commentCount: number;
  lineHasAiNote: boolean;
  /** Null when the active changeset wasn't loaded from a worktree — the
   *  agent-context section hides itself in that case. */
  agentContext: AgentContextData | null;
  /** Same parent-identifier string as in SidebarSnapshot. */
  parentTitle: string;
}

export type InspectorAction =
  | { type: "jump"; cursor: Cursor }
  | { type: "jump-to-block"; cursor: Cursor; selection: LineSelection }
  | { type: "toggle-ack"; hunkId: string; lineIdx: number }
  | { type: "start-draft"; key: string }
  | { type: "close-draft" }
  | { type: "submit-reply"; key: string; body: string }
  | { type: "retry-reply"; key: string; replyId: string }
  | { type: "delete-reply"; key: string; replyId: string }
  | { type: "prev-comment" }
  | { type: "next-comment" }
  | { type: "pick-session"; sessionFilePath: string }
  | { type: "refresh" }
  | {
      type: "verify-ai-note";
      recipe: { source: string; inputs: Record<string, string> };
    };

export type DetachStateMsg =
  | { kind: "sidebar"; snapshot: SidebarSnapshot }
  | { kind: "inspector"; snapshot: InspectorSnapshot };

export type DetachActionMsg =
  | { kind: "sidebar"; action: SidebarAction }
  | { kind: "inspector"; action: InspectorAction };

export interface DetachReadyMsg {
  kind: DetachedKind;
}

// ── Event-name helpers ────────────────────────────────────────────────────
//
// One channel name per `(parent, purpose)` tuple. The kind discriminator
// lives in the payload — see the wire-format section of the plan.

export const detachStateEvent = (parent: string) =>
  `shippable:detach-state:${parent}`;
export const detachActionEvent = (parent: string) =>
  `shippable:detach-action:${parent}`;
export const detachReadyEvent = (parent: string) =>
  `shippable:detach-ready:${parent}`;
export const detachChildrenChangedEvent = (parent: string) =>
  `shippable:detach-children-changed:${parent}`;

// ── Hook ──────────────────────────────────────────────────────────────────

export interface UseDetachBridgeArgs {
  /** This window's Tauri label. `null` in browser dev — the hook becomes a
   *  no-op and reports nothing as detached. */
  selfLabel: string | null;
  sidebarSnapshot: SidebarSnapshot;
  onSidebarAction: (action: SidebarAction) => void;
  inspectorSnapshot: InspectorSnapshot;
  onInspectorAction: (action: InspectorAction) => void;
}

export interface UseDetachBridgeResult {
  isSidebarDetached: boolean;
  isInspectorDetached: boolean;
}

export function useDetachBridge({
  selfLabel,
  sidebarSnapshot,
  onSidebarAction,
  inspectorSnapshot,
  onInspectorAction,
}: UseDetachBridgeArgs): UseDetachBridgeResult {
  const [detachedKinds, setDetachedKinds] = useState<Set<DetachedKind>>(
    () => new Set(),
  );

  // Latest values reachable from listeners without re-binding them every
  // render. The ready-listener uses these to push the *current* snapshot,
  // not the one captured when the listener was registered.
  const sidebarSnapshotRef = useRef(sidebarSnapshot);
  const onSidebarActionRef = useRef(onSidebarAction);
  const inspectorSnapshotRef = useRef(inspectorSnapshot);
  const onInspectorActionRef = useRef(onInspectorAction);
  useEffect(() => {
    sidebarSnapshotRef.current = sidebarSnapshot;
  }, [sidebarSnapshot]);
  useEffect(() => {
    onSidebarActionRef.current = onSidebarAction;
  }, [onSidebarAction]);
  useEffect(() => {
    inspectorSnapshotRef.current = inspectorSnapshot;
  }, [inspectorSnapshot]);
  useEffect(() => {
    onInspectorActionRef.current = onInspectorAction;
  }, [onInspectorAction]);

  // Refresh the detached-kind set from the Rust registry (source of truth).
  // Wrapped so the ready listener and the children-changed listener share
  // one implementation.
  const refresh = useCallback(async (label: string) => {
    const children = await listDetachedChildren(label);
    setDetachedKinds(new Set(children.map((c) => c.kind)));
  }, []);

  // Mount + on selfLabel change: initial snapshot of the registry, plus
  // subscribers for changes (Rust-driven), child-ready announcements, and
  // child-originated actions.
  useEffect(() => {
    if (!isTauri() || !selfLabel) return;
    let stopChanges: (() => void) | null = null;
    let stopReady: (() => void) | null = null;
    let stopAction: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      await refresh(selfLabel);
      if (cancelled) return;

      const { listen, emit } = await import("@tauri-apps/api/event");
      if (cancelled) return;

      stopChanges = await listen(detachChildrenChangedEvent(selfLabel), () => {
        void refresh(selfLabel);
      });
      if (cancelled) {
        stopChanges();
        return;
      }

      stopReady = await listen<DetachReadyMsg>(
        detachReadyEvent(selfLabel),
        (ev) => {
          // The child just announced it's listening. Push the freshest
          // snapshot immediately so it has something to paint before the
          // next render-driven emit fires.
          if (ev.payload.kind === "sidebar") {
            void emit(detachStateEvent(selfLabel), {
              kind: "sidebar",
              snapshot: sidebarSnapshotRef.current,
            } satisfies DetachStateMsg);
          } else if (ev.payload.kind === "inspector") {
            void emit(detachStateEvent(selfLabel), {
              kind: "inspector",
              snapshot: inspectorSnapshotRef.current,
            } satisfies DetachStateMsg);
          }
          // Re-query the registry in case the ready signal raced ahead of
          // children-changed (or the child opened before our initial fetch
          // landed).
          void refresh(selfLabel);
        },
      );
      if (cancelled) {
        stopChanges?.();
        stopReady();
        return;
      }

      stopAction = await listen<DetachActionMsg>(
        detachActionEvent(selfLabel),
        (ev) => {
          if (ev.payload.kind === "sidebar") {
            onSidebarActionRef.current(ev.payload.action);
          } else if (ev.payload.kind === "inspector") {
            onInspectorActionRef.current(ev.payload.action);
          }
        },
      );
    })();

    return () => {
      cancelled = true;
      stopChanges?.();
      stopReady?.();
      stopAction?.();
    };
  }, [selfLabel, refresh]);

  // Push state on snapshot change while the sidebar is detached. The
  // JSON.stringify gate guards against snapshot identity churn that
  // useMemo couldn't catch — defense in depth.
  const lastEmittedSidebarRef = useRef<string | null>(null);
  const isSidebarDetached = detachedKinds.has("sidebar");
  useEffect(() => {
    if (!isTauri() || !selfLabel || !isSidebarDetached) return;
    const serialized = JSON.stringify(sidebarSnapshot);
    if (lastEmittedSidebarRef.current === serialized) return;
    lastEmittedSidebarRef.current = serialized;
    void (async () => {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(detachStateEvent(selfLabel), {
        kind: "sidebar",
        snapshot: sidebarSnapshot,
      } satisfies DetachStateMsg);
    })();
  }, [selfLabel, isSidebarDetached, sidebarSnapshot]);

  // Reset the "last emitted" cache when the sidebar transitions from
  // detached → not detached. Otherwise a stale `lastEmittedSidebarRef`
  // could skip the first emit after re-detaching, leaving the child
  // empty until the next content change.
  useEffect(() => {
    if (!isSidebarDetached) lastEmittedSidebarRef.current = null;
  }, [isSidebarDetached]);

  // Same pattern for the inspector kind.
  const lastEmittedInspectorRef = useRef<string | null>(null);
  const isInspectorDetached = detachedKinds.has("inspector");
  useEffect(() => {
    if (!isTauri() || !selfLabel || !isInspectorDetached) return;
    const serialized = JSON.stringify(inspectorSnapshot);
    if (lastEmittedInspectorRef.current === serialized) return;
    lastEmittedInspectorRef.current = serialized;
    void (async () => {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(detachStateEvent(selfLabel), {
        kind: "inspector",
        snapshot: inspectorSnapshot,
      } satisfies DetachStateMsg);
    })();
  }, [selfLabel, isInspectorDetached, inspectorSnapshot]);

  useEffect(() => {
    if (!isInspectorDetached) lastEmittedInspectorRef.current = null;
  }, [isInspectorDetached]);

  return useMemo(
    () => ({
      isSidebarDetached,
      isInspectorDetached,
    }),
    [isSidebarDetached, isInspectorDetached],
  );
}
