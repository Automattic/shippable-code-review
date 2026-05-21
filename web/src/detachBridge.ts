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
import type { SidebarViewModel } from "./view";
import type { PromptRunView } from "./components/PromptRunsPanel";

// ── Wire types ────────────────────────────────────────────────────────────

export interface SidebarSnapshot {
  viewModel: SidebarViewModel;
  runs: PromptRunView[];
  wide: boolean;
}

export type SidebarAction =
  | { type: "pick-file"; fileId: string }
  | { type: "jump-to-first-comment"; fileId: string }
  | { type: "close-run"; id: string }
  | { type: "toggle-wide" };

export type DetachStateMsg =
  | { kind: "sidebar"; snapshot: SidebarSnapshot };
// inspector branch arrives in slice (c).

export type DetachActionMsg =
  | { kind: "sidebar"; action: SidebarAction };
// inspector branch arrives in slice (c).

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
}

export interface UseDetachBridgeResult {
  isSidebarDetached: boolean;
  /** Always false in slice (b); slice (c) wires the inspector half. */
  isInspectorDetached: boolean;
}

export function useDetachBridge({
  selfLabel,
  sidebarSnapshot,
  onSidebarAction,
}: UseDetachBridgeArgs): UseDetachBridgeResult {
  const [detachedKinds, setDetachedKinds] = useState<Set<DetachedKind>>(
    () => new Set(),
  );

  // Latest values reachable from listeners without re-binding them every
  // render. The ready-listener uses these to push the *current* snapshot,
  // not the one captured when the listener was registered.
  const sidebarSnapshotRef = useRef(sidebarSnapshot);
  const onSidebarActionRef = useRef(onSidebarAction);
  useEffect(() => {
    sidebarSnapshotRef.current = sidebarSnapshot;
  }, [sidebarSnapshot]);
  useEffect(() => {
    onSidebarActionRef.current = onSidebarAction;
  }, [onSidebarAction]);

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

  return useMemo(
    () => ({
      isSidebarDetached,
      isInspectorDetached: detachedKinds.has("inspector"),
    }),
    [detachedKinds, isSidebarDetached],
  );
}
