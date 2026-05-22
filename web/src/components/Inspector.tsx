import "./Inspector.css";
import type {
  AgentContextSlice,
  AgentSessionRef,
  Cursor,
  DeliveredInteraction,
  Interaction,
  LineSelection,
  PrConversationItem,
} from "../types";
import type { SymbolIndex } from "../symbols";
import { CodeText } from "./CodeText";
import type { InspectorViewModel } from "../view";
import { InlineThreadStack } from "./InlineThreadStack";
import { AgentContextSection } from "./AgentContextSection";
import { useEffect, useRef } from "react";
import { openExternal } from "../openExternal";
import type { PrMatch } from "../githubPrClient";

/**
 * Props for the agent-context section. The whole bundle is optional — when a
 * changeset wasn't loaded from a worktree (URL ingest, paste, file upload)
 * the parent passes `undefined` and the section doesn't render.
 */
export interface AgentContextProps {
  slice: AgentContextSlice | null;
  candidates: AgentSessionRef[];
  selectedSessionFilePath: string | null;
  loading: boolean;
  error: string | null;
  /**
   * Whether a `shippable` MCP entry is detected in the user's Claude
   * Code config, plus the `claude mcp add …` command the install chip
   * should display + copy. `null` while the fetch is in flight or has
   * failed. The `installCommand` field is authoritative — slice-3 follow-up
   * routes the panel through the server-side resolver so the chip uses
   * the working local-build line until the npm publish in §7 lands.
   */
  mcpStatus: { installed: boolean; installCommand: string } | null;
  /**
   * Tauri-only callback that opens the "Set up MCP…" modal. When provided,
   * the panel renders a button instead of the single-line install chip
   * (web builds leave it undefined; the inline chip stays).
   */
  onMcpSetUp?: () => void;
  /**
   * Newest-first list of delivered comments for this worktree. Drives the
   * Delivered (N) details block at the bottom of the panel and (via the
   * pip seam threaded through to ReplyThread) the per-reply ✓ glyph.
   */
  delivered: DeliveredInteraction[];
  /**
   * ISO timestamp of the most recent successful `fetchDelivered` call. `null`
   * before any successful poll — banner shows "—" in that case. Used by the
   * panel-level failure banner to render "last checked X min ago."
   */
  lastSuccessfulPollAt: string | null;
  /**
   * True when the most recent `fetchDelivered` call errored. Drives the
   * panel-level "Agent status unavailable" banner; pips freeze in place.
   */
  deliveredError: boolean;
  /**
   * True while an agent is in watch mode for this worktree. Drives the
   * panel's "Agent is watching" indicator.
   */
  watching: boolean;
  /**
   * Agent-started threads (top-level Interactions whose first entry is
   * authored by the agent). Drives the "Comments" rollup at the bottom
   * of the panel — a sidebar overview separate from the inline render
   * in the DiffView.
   */
  agentStartedThreads: Array<{ threadKey: string; head: Interaction }>;
  onPickSession: (sessionFilePath: string) => void;
  onRefresh: () => void;
}

interface Props {
  viewModel: InspectorViewModel;
  symbols: SymbolIndex;
  /**
   * Per-key draft bodies. The composer is fully controlled by this map —
   * closing the composer (Esc / close button) does not clear the entry,
   * so reopening restores what the user typed.
   */
  draftBodies: Record<string, string>;
  onJump: (c: Cursor) => void;
  /**
   * Clicking a block-scoped comment should re-select its range so the user
   * sees what they're replying to. Plain line threads use onJump and leave
   * selection collapsed.
   */
  onJumpToBlock?: (cursor: Cursor, selection: LineSelection) => void;
  onToggleAck: (hunkId: string, lineIdx: number) => void;
  onStartDraft: (key: string) => void;
  /** Mint a fresh `user:`/`block:` thread key and open its composer. */
  onStartNewComment: () => void;
  /** Close the composer without discarding the draft. */
  onCloseDraft: () => void;
  onChangeDraft: (key: string, body: string) => void;
  onSubmitReply: (key: string, body: string) => void;
  /** Delete a reply by id within the given thread. UI gates this to
   *  user-authored entries; the reducer enforces no other contracts. */
  onDeleteReply: (key: string, replyId: string) => void;
  /**
   * Retry the enqueue for an Interaction whose previous attempt errored. Wired
   * from the errored pip in ReplyThread. The handler in the parent looks
   * up the Interaction by id, re-derives the payload, and POSTs without
   * `supersedes` — the original POST never landed an id, so there's no
   * predecessor to replace.
   */
  onRetryReply: (key: string, replyId: string) => void;
  /**
   * Open the runner for a given AI note's `runRecipe`. Wired to the
   * `▷ verify` button rendered on notes that have a recipe attached;
   * notes without one don't render the button.
   */
  onVerifyAiNote: (recipe: { source: string; inputs: Record<string, string> }) => void;
  /**
   * Agent-context props bundle. Undefined means "no worktree source for this
   * changeset" — the section is hidden entirely. See AgentContextProps.
   */
  agentContext?: AgentContextProps;
  /**
   * PR-pill state surfaced by the parent. `pillMatch` is the matching open
   * PR found for the active worktree's branch; the parent's effect handles
   * the branch lookup and ownership of busy/error so the detached Inspector
   * window can drive the same pill from a snapshot push.
   */
  pillMatch?: PrMatch | null;
  pillBusy?: boolean;
  pillError?: string | null;
  /** Click handler for the PR pill. Hidden when undefined. */
  onPillClick?: () => void;
  /**
   * Issue-level PR conversation items. Populated when the changeset was loaded
   * from a GitHub PR; absent/empty otherwise.
   */
  prConversation?: PrConversationItem[];
  /** Worktree path threaded through DetachedThreadCard's "view at" panel.
   *  Null when the changeset wasn't loaded from a worktree. */
  worktreePath?: string | null;
  /** Number of comment stops in the changeset; 0 disables the nav buttons. */
  commentCount: number;
  onPrevComment: () => void;
  onNextComment: () => void;
  /** Cursor sits on a line with an AI note — gates the a / r hint chips. */
  lineHasAiNote: boolean;
  /**
   * When true, interaction threads are already rendered inline in the diff.
   * The thread body (InlineThreadStack) is replaced with a brief placeholder
   * so the same content doesn't appear twice.
   */
  interactionsShownInline: boolean;
  /** When set, renders a ↗ button that pops the inspector into its own OS
   *  window. Undefined hides the affordance — browser mode and the gallery
   *  preview both rely on that to keep the chrome out of contexts where it
   *  has nowhere to land. */
  onDetach?: () => void;
}

export function Inspector({
  viewModel,
  symbols,
  draftBodies,
  onJump,
  onJumpToBlock,
  onToggleAck,
  onStartDraft,
  onStartNewComment,
  onCloseDraft,
  onChangeDraft,
  onSubmitReply,
  onDeleteReply,
  onRetryReply,
  onVerifyAiNote,
  agentContext,
  prConversation,
  pillMatch = null,
  pillBusy = false,
  pillError = null,
  onPillClick,
  worktreePath = null,
  commentCount,
  onPrevComment,
  onNextComment,
  lineHasAiNote,
  interactionsShownInline,
  onDetach,
}: Props) {
  const vm = viewModel;
  const draftFor = (key: string) => draftBodies[key] ?? "";

  // Keep the AI note for the current line on screen as the cursor moves.
  // Mirrors what DiffView already does for the cursor itself — without
  // this, the "current" highlight in the inspector can drift off the top
  // when the hunk has many notes.
  const currentNoteRef = useRef<HTMLLIElement | null>(null);
  const currentNoteLineIdx =
    vm.aiNoteRows.find((r) => r.isCurrent)?.lineIdx ?? null;
  useEffect(() => {
    if (currentNoteLineIdx === null) return;
    currentNoteRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentNoteLineIdx]);

  // The location card duplicates the line text that the matching AI
  // note already shows when the cursor is on a noted line — collapse to
  // the path-only label in that case so the inspector doesn't repeat
  // itself. When there's no matching note, the code preview earns its
  // space back as the only "what am I looking at" cue.
  const cursorOnNote = currentNoteLineIdx !== null;

  // Index delivered comments by id once so each ReplyThread's pip lookup
  // is O(1). `undefined` when the agent-context bundle is absent (no
  // worktree loaded) — ReplyThread treats it as "no delivered ids known"
  // which is the right default for the fixture/URL-ingest case.
  const deliveredById: Record<string, DeliveredInteraction> | undefined =
    agentContext
      ? Object.fromEntries(agentContext.delivered.map((d) => [d.id, d]))
      : undefined;

  // PR pill state is owned by the parent so the detached Inspector window
  // can render against the same data the docked one does — see slice (e)
  // of docs/plans/detached-sidebars.md. The pill renders only when the
  // parent surfaces a non-null `pillMatch` (worktreeSource and !prSource
  // gates live with the lookup in the parent).
  const showPill = pillMatch != null;

  return (
    <aside className="inspector" aria-label="inspector">
      <header className="inspector__h">
        <span className="inspector__h-label">inspector</span>
        <span className="inspector__h-viewer">viewing as @you</span>
        <span className="inspector__h-nav" aria-label="comment navigation">
          <button
            type="button"
            className="inspector__h-nav-btn"
            onClick={onPrevComment}
            disabled={commentCount === 0}
            title={
              commentCount === 0
                ? "no comments in this changeset"
                : "previous comment (N)"
            }
            aria-label="previous comment"
          >
            ‹
          </button>
          <span className="inspector__h-nav-label">
            {commentCount === 0 ? "no comments" : `${commentCount} comment${commentCount === 1 ? "" : "s"}`}
          </span>
          <button
            type="button"
            className="inspector__h-nav-btn"
            onClick={onNextComment}
            disabled={commentCount === 0}
            title={
              commentCount === 0
                ? "no comments in this changeset"
                : "next comment (n)"
            }
            aria-label="next comment"
          >
            ›
          </button>
        </span>
        <span className="inspector__h-hint">
          <kbd>i</kbd>
          {lineHasAiNote && (
            <>
              {" · "}<kbd>a</kbd> ack · <kbd>r</kbd> reply
            </>
          )}
        </span>
        {onDetach && (
          <button
            type="button"
            className="inspector__h-detach"
            onClick={onDetach}
            title="Pop the inspector into its own window"
            aria-label="Detach inspector"
          >
            ↗
          </button>
        )}
      </header>

      {agentContext && (
        <AgentContextSection
          slice={agentContext.slice}
          candidates={agentContext.candidates}
          selectedSessionFilePath={agentContext.selectedSessionFilePath}
          loading={agentContext.loading}
          error={agentContext.error}
          symbols={symbols}
          mcpStatus={agentContext.mcpStatus}
          onMcpSetUp={agentContext.onMcpSetUp}
          delivered={agentContext.delivered}
          lastSuccessfulPollAt={agentContext.lastSuccessfulPollAt}
          deliveredError={agentContext.deliveredError}
          watching={agentContext.watching}
          agentStartedThreads={agentContext.agentStartedThreads}
          onJump={onJump}
          onPickSession={agentContext.onPickSession}
          onRefresh={agentContext.onRefresh}
        />
      )}

      {showPill && (
        <div className="inspector__pr-pill">
          <button
            className="inspector__pr-pill-btn"
            disabled={pillBusy}
            onClick={onPillClick}
          >
            {pillBusy
              ? "Loading PR overlay…"
              : `Matching PR: #${pillMatch.number} — ${pillMatch.title}`}
          </button>
          {pillError && (
            <span className="inspector__pr-pill-err">{pillError}</span>
          )}
        </div>
      )}

      {prConversation && prConversation.length > 0 && (
        <PrConversationSection items={prConversation} />
      )}

      <section className="inspector__sec">
        <div className="inspector__loc">{vm.locationLabel}</div>
        {!cursorOnNote && (
          <div className={`inspector__code inspector__code--${vm.lineKind}`}>
            <span className="inspector__code-sign">{vm.lineSign}</span>
            {vm.lineText ? <CodeText text={vm.lineText} language={vm.language} /> : " "}
          </div>
        )}
      </section>

      {interactionsShownInline ? (
        <section className="inspector__sec">
          <p className="inspector__empty">Comments are shown inline in the diff.</p>
        </section>
      ) : (
        <InlineThreadStack
          vm={vm}
          sections="all"
          symbols={symbols}
          draftFor={draftFor}
          deliveredById={deliveredById}
          worktreePath={worktreePath}
          currentNoteRef={currentNoteRef}
          onJump={onJump}
          onJumpToBlock={onJumpToBlock}
          onToggleAck={onToggleAck}
          onStartDraft={onStartDraft}
          onStartNewComment={onStartNewComment}
          onCloseDraft={onCloseDraft}
          onChangeDraft={onChangeDraft}
          onSubmitReply={onSubmitReply}
          onDeleteReply={onDeleteReply}
          onRetryReply={onRetryReply}
          onVerifyAiNote={onVerifyAiNote}
        />
      )}
    </aside>
  );
}

// ── PR conversation (issue-level discussion, read-only) ───────────────────────

function PrConversationSection({ items }: { items: PrConversationItem[] }) {
  return (
    <details className="inspector__sec inspector__pr-conv">
      <summary className="inspector__sec-h inspector__pr-conv-summary">
        PR conversation ({items.length})
      </summary>
      <ul className="notes">
        {items.map((item) => (
          <li key={item.id} className="ainote ainote--info">
            <div className="ainote__head">
              <span className="inspector__pr-conv-author">@{item.author}</span>
              <span className="ainote__summary ainote__summary--muted">
                <time dateTime={item.createdAt} title={item.createdAt}>
                  {humanAgo(item.createdAt)}
                </time>
              </span>
              <span className="ainote__actions">
                <a
                  href={item.htmlUrl}
                  onClick={(e) => {
                    e.preventDefault();
                    void openExternal(item.htmlUrl);
                  }}
                  className="ainote__ack"
                  title="Open on GitHub"
                >
                  ↗
                </a>
              </span>
            </div>
            <div className="ainote__detail">{item.body}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function humanAgo(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return "—";
  }
}
