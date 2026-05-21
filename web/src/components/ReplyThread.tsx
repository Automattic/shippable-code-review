import "./ReplyThread.css";
import { useEffect, useRef, useState } from "react";
import type {
  Cursor,
  DeliveredInteraction,
  Interaction,
  InteractionIntent,
} from "../types";
import type { SymbolIndex } from "../symbols";
import { openExternal } from "../openExternal";
import { RichText } from "./RichText";

interface Props {
  /**
   * Interactions on this thread. May include user-authored entries, agent
   * responses, and (for AI/teammate-headed threads) the head Interaction
   * itself — the renderer skips ingest-sourced heads since the surrounding
   * Inspector card already shows them above the thread.
   */
  interactions: Interaction[];
  isDrafting: boolean;
  /**
   * Current draft body for this thread. Persists across composer
   * close/reopen — the parent owns it. The composer is fully controlled.
   */
  draftBody: string;
  onStartDraft: () => void;
  /** Close the composer without discarding `draftBody`. */
  onCloseDraft: () => void;
  onChangeDraft: (body: string) => void;
  onSubmitReply: (body: string) => void;
  /** Delete a reply by id. Only invoked for user-authored entries. */
  onDeleteReply: (replyId: string) => void;
  /**
   * Retry the enqueue for an Interaction whose previous attempt errored.
   * Wired to the click on the ⚠ errored pip. Optional — surfaces only on
   * agent-context-aware threads. Threads without it fall back to the
   * three-state pip (no pip · ◌ queued · ✓ delivered).
   */
  onRetryReply?: (replyId: string) => void;
  symbols: SymbolIndex;
  onJump: (c: Cursor) => void;
  /**
   * Map keyed by delivered Interaction id of items the agent has fetched.
   * Drives the `✓ delivered` pip on each user Interaction whose own `id`
   * is in the map. Empty/missing → the pip falls back to the
   * interaction's persisted `agentQueueStatus`.
   */
  deliveredById?: Record<string, DeliveredInteraction>;
}

export function ReplyThread({
  interactions,
  isDrafting,
  draftBody,
  onStartDraft,
  onCloseDraft,
  onChangeDraft,
  onSubmitReply,
  onDeleteReply,
  onRetryReply,
  symbols,
  onJump,
  deliveredById,
}: Props) {
  // The Inspector card above the thread already shows ingest-sourced
  // heads (AI note, AI hunk summary, teammate review); skip them here so
  // they don't render twice. Teammate verdicts are identified structurally
  // as the head of a `teammate:` thread (target !== "reply").
  const rows = interactions.filter((ix) => {
    if (ix.authorRole === "ai") return false;
    if (ix.threadKey.startsWith("teammate:") && ix.target !== "reply") return false;
    return true;
  });

  // Split rows into the thread head (user comment, target line/block) and its
  // nested replies (target "reply"). When there is no head in rows — note/
  // teammate threads whose head was filtered out above, or drafting states —
  // fall back to the flat reply list so those paths are unchanged.
  const headIx = rows.find(
    (ix) => ix.target === "line" || ix.target === "block",
  ) ?? null;
  const replyRows = headIx ? rows.filter((ix) => ix !== headIx) : rows;

  // Inline two-step delete: clicking "× delete" arms the row instead of
  // popping a native browser confirm() that breaks focus and looks foreign.
  // The armed row swaps in a "delete?  [yes] [cancel]" cluster in place.
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);

  // A non-empty draft on a closed composer means the user closed without
  // sending. Surface a hint so they know it's still waiting.
  const hasUnsentDraft = !isDrafting && draftBody.trim().length > 0;

  if (rows.length === 0 && !isDrafting) {
    return (
      <div className="thread thread--empty">
        <button className="thread__start" onClick={onStartDraft}>
          {hasUnsentDraft ? "↻ resume draft" : "+ reply"}
        </button>
      </div>
    );
  }

  function renderUserRow(ix: Interaction, asItem = true) {
    const isDelivered =
      ix.agentQueueStatus === "delivered" || !!deliveredById?.[ix.id];
    const deleteTitle = isDelivered
      ? "the agent already saw this; deleting only removes it from your view."
      : "delete reply";
    const isExternal = ix.external?.source === "pr";
    const children = (
      <>
        <div className="reply__head">
          <span className="reply__author">@{ix.author}</span>
          <span className="reply__sep">·</span>
          <span className="reply__time">{timeAgo(ix.createdAt)}</span>
          {isExternal ? (
            <a
              className="reply__external"
              href={ix.external!.htmlUrl}
              onClick={(e) => {
                e.preventDefault();
                void openExternal(ix.external!.htmlUrl);
              }}
              title="Open on GitHub"
            >
              ↗ GitHub
            </a>
          ) : (
            <>
              <ReplyPip
                ix={ix}
                deliveredById={deliveredById}
                onRetry={onRetryReply ? () => onRetryReply(ix.id) : undefined}
              />
              {ix.author === "you" &&
                (armedDeleteId === ix.id ? (
                  <span
                    className="reply__confirm"
                    role="group"
                    aria-label="confirm delete"
                  >
                    <span className="reply__confirm-q">delete?</span>
                    <button
                      type="button"
                      className="reply__confirm-yes"
                      onClick={() => {
                        setArmedDeleteId(null);
                        onDeleteReply(ix.id);
                      }}
                      autoFocus
                    >
                      yes
                    </button>
                    <button
                      type="button"
                      className="reply__confirm-no"
                      onClick={() => setArmedDeleteId(null)}
                    >
                      cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="reply__delete"
                    onClick={() => setArmedDeleteId(ix.id)}
                    title={deleteTitle}
                  >
                    × delete
                  </button>
                ))}
            </>
          )}
        </div>
        <div className="reply__body">
          <RichText text={ix.body} symbols={symbols} onJump={onJump} />
        </div>
      </>
    );
    // The head is a <div> (not a list item), so it has a valid parent in context;
    // replies inside <ul> stay as <li> for correct list semantics.
    return asItem ? (
      <li key={ix.id} className="reply">
        {children}
      </li>
    ) : (
      <div key={ix.id} className="reply">
        {children}
      </div>
    );
  }

  function renderRow(ix: Interaction) {
    if (ix.authorRole === "agent") {
      return <AgentRow key={ix.id} ix={ix} symbols={symbols} onJump={onJump} />;
    }
    return renderUserRow(ix);
  }

  return (
    <div className="thread">
      {headIx ? (
        // Two-level layout: head comment rendered distinctly, replies nested.
        <>
          <div className="thread__head">{renderUserRow(headIx, false)}</div>
          {replyRows.length > 0 && (
            <>
              <div className="thread__label">replies ({replyRows.length})</div>
              <ul className="thread__list thread__list--replies">
                {replyRows.map(renderRow)}
              </ul>
            </>
          )}
        </>
      ) : (
        // No-head path: note/teammate threads (head filtered out) — render flat.
        <>
          {replyRows.length > 0 && (
            <div className="thread__label">replies ({replyRows.length})</div>
          )}
          <ul className="thread__list">{replyRows.map(renderRow)}</ul>
        </>
      )}
      {isDrafting ? (
        <Composer
          body={draftBody}
          onChange={onChangeDraft}
          onClose={onCloseDraft}
          onSubmit={onSubmitReply}
        />
      ) : (
        <button className="thread__start" onClick={onStartDraft}>
          {hasUnsentDraft ? "↻ resume draft" : "+ reply"}
        </button>
      )}
    </div>
  );
}

/** Render an agent-authored Interaction with intent-glyph + label. */
function AgentRow({
  ix,
  symbols,
  onJump,
}: {
  ix: Interaction;
  symbols: SymbolIndex;
  onJump: (c: Cursor) => void;
}) {
  return (
    <li className={`agent-reply agent-reply--${ix.intent}`}>
      <div className="agent-reply__head">
        <span
          className="agent-reply__icon"
          aria-label={ix.intent}
          title={intentLabel(ix.intent)}
        >
          {intentGlyph(ix.intent)}
        </span>
        <span className="agent-reply__label">{ix.author || "agent"}</span>
        <span className="agent-reply__sep">·</span>
        <span className="agent-reply__time" title={ix.createdAt}>
          {timeAgo(ix.createdAt)}
        </span>
      </div>
      <div className="agent-reply__body">
        <RichText text={ix.body} symbols={symbols} onJump={onJump} />
      </div>
    </li>
  );
}

function intentGlyph(intent: InteractionIntent): string {
  switch (intent) {
    case "accept":
      return "✓";
    case "reject":
      return "⊘";
    case "ack":
      return "ℹ";
    case "unack":
      return "↺";
    case "blocker":
      return "🚧";
    case "request":
      return "🔧";
    case "question":
      return "❓";
    case "comment":
      return "•";
  }
}

function intentLabel(intent: InteractionIntent): string {
  return intent;
}

function Composer({
  body,
  onChange,
  onClose,
  onSubmit,
}: {
  body: string;
  onChange: (body: string) => void;
  onClose: () => void;
  onSubmit: (body: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    // Place caret at the end when reopening a saved draft so the user
    // can keep typing without re-clicking.
    const len = ref.current?.value.length ?? 0;
    ref.current?.setSelectionRange(len, len);
  }, []);
  return (
    <div className="composer">
      <textarea
        ref={ref}
        className="composer__input"
        value={body}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (body.trim()) onSubmit(body.trim());
          }
        }}
        placeholder="Write a reply…"
        rows={2}
      />
      <div className="composer__foot">
        <span className="composer__hint">
          <kbd>⌘Enter</kbd> send · <kbd>Esc</kbd> close (saves draft)
        </span>
        <button className="composer__cancel" onClick={onClose}>
          close
        </button>
        <button
          className="composer__send"
          disabled={!body.trim()}
          onClick={() => onSubmit(body.trim())}
        >
          send
        </button>
      </div>
    </div>
  );
}

/**
 * Per-interaction pip. Four possible states; the precedence order is fixed:
 *
 *   1. `✓ delivered` — `agentQueueStatus === "delivered"`, or the polling
 *      `deliveredById` map carries the interaction's own `id`. Wins over
 *      everything else; a delivered entry's stale local error shouldn't show.
 *   2. `⚠ retry` — `enqueueError === true`. Wins over queued. Covers the
 *      optimistic-pending-then-enqueue-failed case: the interaction is
 *      optimistically set to pending on submit, but if the enqueue POST
 *      fails the user must see the error, not a false "queued" pip.
 *   3. `◌ queued` — `agentQueueStatus === "pending"` and not delivered. Set
 *      optimistically on submit (and confirmed server-side once enqueue
 *      lands), so the pip appears immediately in the submit→delivered window.
 *   4. (no pip) — not enqueued and no error (entries authored on a
 *      non-worktree changeset, fresh fixture entries, etc.).
 */
function ReplyPip({
  ix,
  deliveredById,
  onRetry,
}: {
  ix: Interaction;
  deliveredById?: Record<string, DeliveredInteraction>;
  /** When the parent threads a retry handler in, the errored pip becomes
   *  a click-to-retry button. Without it the errored state still renders
   *  (so the user knows something went wrong), but as inert text. */
  onRetry?: () => void;
}) {
  const errored = !!ix.enqueueError;
  const delivered =
    ix.agentQueueStatus === "delivered" ? null : deliveredById?.[ix.id] ?? null;
  // Delivered wins over everything: the agent has already seen this entry,
  // so any local error flag is stale.
  if (ix.agentQueueStatus === "delivered" || delivered) {
    const title = delivered
      ? `Fetched by your agent at ${formatClock(delivered.deliveredAt)}.`
      : "Fetched by your agent.";
    return (
      <span className="reply__pip reply__pip--delivered" title={title}>
        ✓ delivered
      </span>
    );
  }
  // Error wins over queued: if the enqueue POST failed after an optimistic
  // pending was set, the user must see the error instead of a false "queued".
  if (errored) {
    const title = "Couldn't reach your agent — click to retry.";
    if (onRetry) {
      return (
        <button
          type="button"
          className="reply__pip reply__pip--errored"
          title={title}
          onClick={onRetry}
        >
          ⚠ retry
        </button>
      );
    }
    return (
      <span className="reply__pip reply__pip--errored" title={title}>
        ⚠ retry
      </span>
    );
  }
  if (ix.agentQueueStatus === "pending") {
    return (
      <span
        className="reply__pip reply__pip--queued"
        title={`Sent to your agent's queue at ${formatClock(ix.createdAt)}.`}
      >
        ◌ queued
      </span>
    );
  }
  return null;
}

function formatClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "??:??:??";
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function timeAgo(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
