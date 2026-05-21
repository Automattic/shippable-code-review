import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import "./components/Sidebar.css";
import "./components/PromptRunsPanel.css";
import {
  detachActionEvent,
  detachReadyEvent,
  detachStateEvent,
  type DetachActionMsg,
  type DetachStateMsg,
  type SidebarAction,
  type SidebarSnapshot,
} from "./detachBridge";

type Kind = "sidebar" | "inspector";

interface DetachParams {
  kind: Kind;
  parent: string;
}

function readParams(): DetachParams | null {
  const search = new URLSearchParams(window.location.search);
  const kind = search.get("kind");
  const parent = search.get("parent");
  if ((kind !== "sidebar" && kind !== "inspector") || !parent) return null;
  return { kind, parent };
}

async function emitAction(parent: string, action: SidebarAction): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(detachActionEvent(parent), {
    kind: "sidebar",
    action,
  } satisfies DetachActionMsg);
}

async function reattachClose(): Promise<void> {
  const { getCurrentWebviewWindow } = await import(
    "@tauri-apps/api/webviewWindow"
  );
  await getCurrentWebviewWindow().close();
}

export function DetachedHost() {
  const [params] = useState<DetachParams | null>(() => readParams());

  if (!params) {
    return (
      <div className="detached-shell">
        <div className="detached-shell__error">
          Detached window opened without a kind/parent. Close this window and
          re-detach from the parent review.
        </div>
      </div>
    );
  }

  return (
    <div className="detached-shell" data-kind={params.kind}>
      <header className="detached-shell__chrome">
        <span className="detached-shell__title">
          {params.kind === "sidebar" ? "Files" : "Inspector"}
          <span className="detached-shell__parent">— {params.parent}</span>
        </span>
        <button
          type="button"
          className="detached-shell__reattach"
          onClick={() => void reattachClose()}
          title="Re-attach to the parent window"
        >
          ↙ re-attach
        </button>
      </header>
      <div className="detached-shell__body">
        {params.kind === "sidebar" ? (
          <SidebarBody parent={params.parent} />
        ) : (
          <p className="detached-shell__placeholder">
            Inspector wiring lands in the next slice. Closing this window or
            the parent re-docks the panel automatically.
          </p>
        )}
      </div>
    </div>
  );
}

interface SidebarBodyProps {
  parent: string;
}

/**
 * Renders the docked <Sidebar> against snapshots pushed by the parent.
 * Mounts → subscribes to detach-state → announces ready → waits for the
 * first snapshot. Callbacks emit detach-action messages back; ReviewState
 * lives in the parent and reflects back through the next snapshot push.
 */
function SidebarBody({ parent }: SidebarBodyProps) {
  const [snapshot, setSnapshot] = useState<SidebarSnapshot | null>(null);

  useEffect(() => {
    let stopState: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      const { listen, emit } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      stopState = await listen<DetachStateMsg>(
        detachStateEvent(parent),
        (ev) => {
          if (ev.payload.kind === "sidebar") setSnapshot(ev.payload.snapshot);
        },
      );
      if (cancelled) {
        stopState();
        return;
      }
      // Announce we're listening so the parent pushes the current snapshot.
      // Subsequent emits ride the normal "snapshot changed" path.
      await emit(detachReadyEvent(parent), { kind: "sidebar" });
    })();

    return () => {
      cancelled = true;
      stopState?.();
    };
  }, [parent]);

  if (!snapshot) {
    return (
      <p className="detached-shell__placeholder">Loading file list…</p>
    );
  }
  return (
    <Sidebar
      viewModel={snapshot.viewModel}
      runs={snapshot.runs}
      wide={snapshot.wide}
      onPickFile={(fileId) =>
        void emitAction(parent, { type: "pick-file", fileId })
      }
      onJumpToFirstComment={(fileId) =>
        void emitAction(parent, { type: "jump-to-first-comment", fileId })
      }
      onCloseRun={(id) =>
        void emitAction(parent, { type: "close-run", id })
      }
      onToggleWide={() =>
        void emitAction(parent, { type: "toggle-wide" })
      }
    />
  );
}
