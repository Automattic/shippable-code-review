import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { Inspector } from "./components/Inspector";
import "./components/Sidebar.css";
import "./components/PromptRunsPanel.css";
import "./components/Inspector.css";
import "./components/ReplyThread.css";
import "./components/AgentContextSection.css";
import "./components/DetachedThreadCard.css";
import "./components/CodeText.css";
import {
  detachActionEvent,
  detachReadyEvent,
  detachStateEvent,
  type DetachActionMsg,
  type DetachStateMsg,
  type InspectorAction,
  type InspectorSnapshot,
  type SidebarAction,
  type SidebarSnapshot,
} from "./detachBridge";
import type { SymbolIndex } from "./symbols";

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

async function emitSidebarAction(
  parent: string,
  action: SidebarAction,
): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(detachActionEvent(parent), {
    kind: "sidebar",
    action,
  } satisfies DetachActionMsg);
}

async function emitInspectorAction(
  parent: string,
  action: InspectorAction,
): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(detachActionEvent(parent), {
    kind: "inspector",
    action,
  } satisfies DetachActionMsg);
}

/** Shared empty SymbolIndex used by the detached Inspector. Symbol clicks
 *  in the child render as inert text; per-window symbol navigation is a
 *  follow-up — `onJump` callbacks already route through the parent. */
const EMPTY_SYMBOLS: SymbolIndex = new Map();

async function reattachClose(): Promise<void> {
  const { getCurrentWebviewWindow } = await import(
    "@tauri-apps/api/webviewWindow"
  );
  await getCurrentWebviewWindow().close();
}

export function DetachedHost() {
  const [params] = useState<DetachParams | null>(() => readParams());
  // The parent's title arrives via the snapshot, so we lift it out of the
  // subcomponent and into this shell so both kinds can render it once.
  const [parentTitle, setParentTitle] = useState<string | null>(null);

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
          <span className="detached-shell__parent">
            {" — "}
            {parentTitle ?? params.parent}
          </span>
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
          <SidebarBody parent={params.parent} onParentTitle={setParentTitle} />
        ) : (
          <InspectorBody
            parent={params.parent}
            onParentTitle={setParentTitle}
          />
        )}
      </div>
    </div>
  );
}

interface SidebarBodyProps {
  parent: string;
  onParentTitle: (title: string) => void;
}

/**
 * Renders the docked <Sidebar> against snapshots pushed by the parent.
 * Mounts → subscribes to detach-state → announces ready → waits for the
 * first snapshot. Callbacks emit detach-action messages back; ReviewState
 * lives in the parent and reflects back through the next snapshot push.
 */
function SidebarBody({ parent, onParentTitle }: SidebarBodyProps) {
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

  useEffect(() => {
    if (snapshot?.parentTitle) onParentTitle(snapshot.parentTitle);
  }, [snapshot?.parentTitle, onParentTitle]);

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
        void emitSidebarAction(parent, { type: "pick-file", fileId })
      }
      onJumpToFirstComment={(fileId) =>
        void emitSidebarAction(parent, {
          type: "jump-to-first-comment",
          fileId,
        })
      }
      onCloseRun={(id) =>
        void emitSidebarAction(parent, { type: "close-run", id })
      }
      onToggleWide={() =>
        void emitSidebarAction(parent, { type: "toggle-wide" })
      }
    />
  );
}

interface InspectorBodyProps {
  parent: string;
  onParentTitle: (title: string) => void;
}

/**
 * Renders the docked <Inspector> against snapshots pushed by the parent.
 * Draft bodies (textarea contents) live in this child component — submit/
 * close/start round-trip through actions, but keystrokes don't, so the
 * composer stays responsive without thrashing the event bus.
 */
function InspectorBody({ parent, onParentTitle }: InspectorBodyProps) {
  const [snapshot, setSnapshot] = useState<InspectorSnapshot | null>(null);
  // Child-owned draft bodies. The parent doesn't see textarea keystrokes
  // — only submit-reply / close-draft round-trips. This is the trade-off
  // recorded in the plan under "child owns drafts until submit."
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let stopState: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      const { listen, emit } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      stopState = await listen<DetachStateMsg>(
        detachStateEvent(parent),
        (ev) => {
          if (ev.payload.kind === "inspector") setSnapshot(ev.payload.snapshot);
        },
      );
      if (cancelled) {
        stopState();
        return;
      }
      await emit(detachReadyEvent(parent), { kind: "inspector" });
    })();

    return () => {
      cancelled = true;
      stopState?.();
    };
  }, [parent]);

  useEffect(() => {
    if (snapshot?.parentTitle) onParentTitle(snapshot.parentTitle);
  }, [snapshot?.parentTitle, onParentTitle]);

  if (!snapshot) {
    return <p className="detached-shell__placeholder">Loading inspector…</p>;
  }

  const agentContext = snapshot.agentContext
    ? {
        ...snapshot.agentContext,
        onPickSession: (fp: string) =>
          void emitInspectorAction(parent, {
            type: "pick-session",
            sessionFilePath: fp,
          }),
        onRefresh: () =>
          void emitInspectorAction(parent, { type: "refresh" }),
      }
    : undefined;

  return (
    <Inspector
      viewModel={snapshot.viewModel}
      commentCount={snapshot.commentCount}
      lineHasAiNote={snapshot.lineHasAiNote}
      symbols={EMPTY_SYMBOLS}
      draftBodies={drafts}
      onJump={(cursor) =>
        void emitInspectorAction(parent, { type: "jump", cursor })
      }
      onJumpToBlock={(cursor, selection) =>
        void emitInspectorAction(parent, {
          type: "jump-to-block",
          cursor,
          selection,
        })
      }
      onToggleAck={(hunkId, lineIdx) =>
        void emitInspectorAction(parent, {
          type: "toggle-ack",
          hunkId,
          lineIdx,
        })
      }
      onStartDraft={(key) =>
        void emitInspectorAction(parent, { type: "start-draft", key })
      }
      onCloseDraft={() =>
        void emitInspectorAction(parent, { type: "close-draft" })
      }
      onChangeDraft={(key, body) =>
        setDrafts((prev) => ({ ...prev, [key]: body }))
      }
      onSubmitReply={(key, body) => {
        void emitInspectorAction(parent, {
          type: "submit-reply",
          key,
          body,
        });
        // Clear the local draft optimistically — matches the parent's
        // post-submit cleanup so reopening the composer doesn't show the
        // previously-submitted text.
        setDrafts((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }}
      onRetryReply={(key, replyId) =>
        void emitInspectorAction(parent, {
          type: "retry-reply",
          key,
          replyId,
        })
      }
      onDeleteReply={(key, replyId) =>
        void emitInspectorAction(parent, {
          type: "delete-reply",
          key,
          replyId,
        })
      }
      onVerifyAiNote={(recipe) =>
        void emitInspectorAction(parent, {
          type: "verify-ai-note",
          recipe,
        })
      }
      onPrevComment={() =>
        void emitInspectorAction(parent, { type: "prev-comment" })
      }
      onNextComment={() =>
        void emitInspectorAction(parent, { type: "next-comment" })
      }
      agentContext={agentContext}
      worktreePath={snapshot.worktreePath}
      pillMatch={snapshot.pillMatch}
      pillBusy={snapshot.pillBusy}
      pillError={snapshot.pillError}
      onPillClick={() =>
        void emitInspectorAction(parent, { type: "pill-click" })
      }
    />
  );
}
