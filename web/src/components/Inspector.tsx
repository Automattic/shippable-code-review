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
import type {
  InspectorViewModel,
  AiNoteRowItem,
  UserCommentRowItem,
} from "../view";
import { RichText } from "./RichText";
import { ReplyThread } from "./ReplyThread";
import { DetachedThreadCard } from "./DetachedThreadCard";
import { AgentContextSection } from "./AgentContextSection";
import { useEffect, useRef } from "react";
import type { MouseEvent, RefObject } from "react";
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
   * Agent-started threads (top-level Interactions whose first entry is
   * authored by the agent). Drives the "Comments" rollup at the bottom
   * of the panel — a sidebar overview separate from the inline render
   * in the DiffView.
   */
  agentStartedThreads: Array<{ threadKey: string; head: Interaction }>;
  onPickSession: (sessionFilePath: string) => void;
  onRefresh: () => void;
}

/**
 * Wraps a jump action so a card's onClick ignores clicks that originated
 * inside an interactive child (buttons, textareas, the composer) or while
 * the user is actively selecting text.
 */
function cardClick(jump: () => void) {
  return (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, textarea, input, kbd, .composer")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
    jump();
  };
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
          delivered={agentContext.delivered}
          lastSuccessfulPollAt={agentContext.lastSuccessfulPollAt}
          deliveredError={agentContext.deliveredError}
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

      <section className="inspector__sec">
        <div className="inspector__sec-h">
          AI concerns in this hunk
          <span className="inspector__sec-count">{vm.aiNoteCountLabel}</span>
          {vm.nextNoteHint && (
            <button
              className="inspector__sec-jump"
              onClick={() => onJump(vm.nextNoteHint!.jumpTarget)}
              title="jump to the nearest AI note"
            >
              {vm.nextNoteHint.label}
            </button>
          )}
        </div>
        {!vm.hasAiNotes ? (
          <div className="inspector__empty">No AI notes on this hunk.</div>
        ) : (
          <ul className="notes">
            {vm.aiNoteRows.map((row) => (
              <NoteCard
                key={row.lineIdx}
                row={row}
                symbols={symbols}
                draftBody={draftFor(row.replyKey)}
                cardRef={row.isCurrent ? currentNoteRef : undefined}
                deliveredById={deliveredById}
                onJump={onJump}
                onAck={() => {
                  // Extract hunkId from the replyKey ("note:hunkId:lineIdx")
                  // by using the jumpTarget which carries hunkId directly.
                  onToggleAck(row.jumpTarget.hunkId, row.lineIdx);
                }}
                onClickLineNo={() => onJump(row.jumpTarget)}
                onStartDraft={() => onStartDraft(row.replyKey)}
                onCloseDraft={onCloseDraft}
                onChangeDraft={(body) => onChangeDraft(row.replyKey, body)}
                onSubmitReply={(body) => onSubmitReply(row.replyKey, body)}
                onDeleteReply={(replyId) =>
                  onDeleteReply(row.replyKey, replyId)
                }
                onRetryReply={(replyId) =>
                  onRetryReply(row.replyKey, replyId)
                }
                onVerify={() => {
                  if (row.runRecipe) onVerifyAiNote(row.runRecipe);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {vm.aiSummary !== null && vm.aiSummaryReplyKey !== null && (
        <HunkSummarySection
          summary={vm.aiSummary}
          replies={vm.aiSummaryReplies}
          replyKey={vm.aiSummaryReplyKey}
          isDrafting={vm.aiSummaryIsDrafting}
          draftBody={draftFor(vm.aiSummaryReplyKey)}
          jumpTarget={vm.aiSummaryJumpTarget!}
          symbols={symbols}
          deliveredById={deliveredById}
          onJump={onJump}
          onStartDraft={() => onStartDraft(vm.aiSummaryReplyKey!)}
          onCloseDraft={onCloseDraft}
          onChangeDraft={(body) => onChangeDraft(vm.aiSummaryReplyKey!, body)}
          onSubmitReply={(body) => onSubmitReply(vm.aiSummaryReplyKey!, body)}
          onDeleteReply={(replyId) =>
            onDeleteReply(vm.aiSummaryReplyKey!, replyId)
          }
          onRetryReply={(replyId) =>
            onRetryReply(vm.aiSummaryReplyKey!, replyId)
          }
        />
      )}

      {vm.teammate !== null && (
        <TeammateSection
          teammate={vm.teammate}
          symbols={symbols}
          draftBody={draftFor(vm.teammate.replyKey)}
          deliveredById={deliveredById}
          onJump={onJump}
          onStartDraft={() => onStartDraft(vm.teammate!.replyKey)}
          onCloseDraft={onCloseDraft}
          onChangeDraft={(body) => onChangeDraft(vm.teammate!.replyKey, body)}
          onSubmitReply={(body) => onSubmitReply(vm.teammate!.replyKey, body)}
          onDeleteReply={(replyId) =>
            onDeleteReply(vm.teammate!.replyKey, replyId)
          }
          onRetryReply={(replyId) =>
            onRetryReply(vm.teammate!.replyKey, replyId)
          }
        />
      )}

      <UserCommentsSection
        vm={vm}
        symbols={symbols}
        draftFor={draftFor}
        deliveredById={deliveredById}
        onJump={onJump}
        onJumpToBlock={onJumpToBlock}
        onStartDraft={onStartDraft}
        onCloseDraft={onCloseDraft}
        onChangeDraft={onChangeDraft}
        onSubmitReply={onSubmitReply}
        onDeleteReply={onDeleteReply}
        onRetryReply={onRetryReply}
      />

      {vm.detachedThreads.length > 0 && (
        <section className="inspector__sec">
          <div
            className="inspector__sec-h"
            title="comments on lines that are no longer in this diff (the file was rewritten or moved)"
          >
            Detached
            <span className="inspector__sec-count">
              {vm.detachedThreads.length} on this file
            </span>
          </div>
          <ul className="notes">
            {vm.detachedThreads.map((row) => (
              <DetachedThreadCard
                key={row.threadKey}
                row={row}
                symbols={symbols}
                worktreePath={worktreePath}
                deliveredById={deliveredById}
                isDrafting={row.isDrafting}
                draftBody={draftFor(row.threadKey)}
                onJump={onJump}
                onStartDraft={() => onStartDraft(row.threadKey)}
                onCloseDraft={onCloseDraft}
                onChangeDraft={(body) => onChangeDraft(row.threadKey, body)}
                onSubmitReply={(body) => onSubmitReply(row.threadKey, body)}
                onDeleteReply={(replyId) =>
                  onDeleteReply(row.threadKey, replyId)
                }
                onRetryReply={(replyId) =>
                  onRetryReply(row.threadKey, replyId)
                }
              />
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function UserCommentsSection({
  vm,
  symbols,
  draftFor,
  deliveredById,
  onJump,
  onJumpToBlock,
  onStartDraft,
  onCloseDraft,
  onChangeDraft,
  onSubmitReply,
  onDeleteReply,
  onRetryReply,
}: {
  vm: InspectorViewModel;
  symbols: SymbolIndex;
  draftFor: (key: string) => string;
  deliveredById?: Record<string, DeliveredInteraction>;
  onJump: (c: Cursor) => void;
  onJumpToBlock?: (cursor: Cursor, selection: LineSelection) => void;
  onStartDraft: (key: string) => void;
  onCloseDraft: () => void;
  onChangeDraft: (key: string, body: string) => void;
  onSubmitReply: (key: string, body: string) => void;
  onDeleteReply: (key: string, replyId: string) => void;
  onRetryReply: (key: string, replyId: string) => void;
}) {
  return (
    <section className="inspector__sec">
      <div className="inspector__sec-h">
        Your comments
        <span className="inspector__sec-count">{vm.userCommentCountLabel}</span>
      </div>

      {vm.showNewCommentCta && (
        <button
          className="thread__start thread__start--cta"
          onClick={() => onStartDraft(vm.currentLineCommentKey)}
        >
          {draftFor(vm.currentLineCommentKey).trim()
            ? "↻ resume draft"
            : `+ comment on L${vm.currentLineNo}`}{" "}
          <span className="thread__start-hint">
            press <kbd>c</kbd>
          </span>
        </button>
      )}

      {vm.userCommentRows.length === 0 && !vm.showDraftStub ? (
        <div className="inspector__empty">No user comments on this hunk yet.</div>
      ) : (
        <ul className="notes">
          {vm.draftStubRow && (
            <UserThreadCard
              row={vm.draftStubRow}
              symbols={symbols}
              draftBody={draftFor(vm.draftStubRow.threadKey)}
              deliveredById={deliveredById}
              onJump={onJump}
              onClickLineNo={() => onJump(vm.draftStubRow!.jumpTarget)}
              onStartDraft={() => onStartDraft(vm.draftStubRow!.threadKey)}
              onCloseDraft={onCloseDraft}
              onChangeDraft={(body) =>
                onChangeDraft(vm.draftStubRow!.threadKey, body)
              }
              onSubmitReply={(body) =>
                onSubmitReply(vm.draftStubRow!.threadKey, body)
              }
              onDeleteReply={(replyId) =>
                onDeleteReply(vm.draftStubRow!.threadKey, replyId)
              }
              onRetryReply={(replyId) =>
                onRetryReply(vm.draftStubRow!.threadKey, replyId)
              }
            />
          )}
          {vm.userCommentRows.map((row) => (
            <UserThreadCard
              key={row.threadKey}
              row={row}
              symbols={symbols}
              draftBody={draftFor(row.threadKey)}
              deliveredById={deliveredById}
              onJump={onJump}
              onClickLineNo={() => {
                if (row.rangeHiLineIdx !== undefined && onJumpToBlock) {
                  onJumpToBlock(row.jumpTarget, {
                    hunkId: row.jumpTarget.hunkId,
                    anchor: row.lineIdx,
                    head: row.rangeHiLineIdx,
                  });
                } else {
                  onJump(row.jumpTarget);
                }
              }}
              onStartDraft={() => onStartDraft(row.threadKey)}
              onCloseDraft={onCloseDraft}
              onChangeDraft={(body) => onChangeDraft(row.threadKey, body)}
              onSubmitReply={(body) => onSubmitReply(row.threadKey, body)}
              onRetryReply={(replyId) =>
                onRetryReply(row.threadKey, replyId)
              }
              onDeleteReply={(replyId) =>
                onDeleteReply(row.threadKey, replyId)
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function UserThreadCard({
  row,
  symbols,
  draftBody,
  deliveredById,
  onJump,
  onClickLineNo,
  onStartDraft,
  onCloseDraft,
  onChangeDraft,
  onSubmitReply,
  onDeleteReply,
  onRetryReply,
}: {
  row: UserCommentRowItem;
  symbols: SymbolIndex;
  draftBody: string;
  deliveredById?: Record<string, DeliveredInteraction>;
  onJump: (c: Cursor) => void;
  onClickLineNo: () => void;
  onStartDraft: () => void;
  onCloseDraft: () => void;
  onChangeDraft: (body: string) => void;
  onSubmitReply: (body: string) => void;
  onDeleteReply: (replyId: string) => void;
  onRetryReply: (replyId: string) => void;
}) {
  return (
    <li
      className={`ainote ainote--user ainote--clickable ${
        row.isCurrent ? "ainote--current" : ""
      }`}
      onClick={cardClick(onClickLineNo)}
      title="click to jump to this line"
    >
      <div className="ainote__head">
        <button
          className="ainote__lineno"
          onClick={onClickLineNo}
          title={
            row.rangeHiLineNo
              ? `jump to lines L${row.lineNo}–L${row.rangeHiLineNo}`
              : "jump to this line"
          }
        >
          {row.rangeHiLineNo
            ? `L${row.lineNo}–L${row.rangeHiLineNo}`
            : `L${row.lineNo}`}
        </button>
        <span className="ainote__summary ainote__summary--muted">
          {row.replies.length === 0
            ? "new thread"
            : `${row.replies.length} message${row.replies.length > 1 ? "s" : ""}`}
        </span>
      </div>
      <ReplyThread
        interactions={row.replies}
        isDrafting={row.isDrafting}
        draftBody={draftBody}
        onStartDraft={onStartDraft}
        onCloseDraft={onCloseDraft}
        onChangeDraft={onChangeDraft}
        onSubmitReply={onSubmitReply}
        onDeleteReply={onDeleteReply}
        onRetryReply={onRetryReply}
        symbols={symbols}
        onJump={onJump}
        deliveredById={deliveredById}
      />
    </li>
  );
}

function NoteCard({
  row,
  symbols,
  draftBody,
  cardRef,
  deliveredById,
  onJump,
  onAck,
  onClickLineNo,
  onStartDraft,
  onCloseDraft,
  onChangeDraft,
  onSubmitReply,
  onDeleteReply,
  onRetryReply,
  onVerify,
}: {
  row: AiNoteRowItem;
  symbols: SymbolIndex;
  draftBody: string;
  /** Attached only when this is the cursor's note — drives auto-scroll. */
  cardRef?: RefObject<HTMLLIElement | null>;
  deliveredById?: Record<string, DeliveredInteraction>;
  onJump: (c: Cursor) => void;
  onAck: () => void;
  onClickLineNo: () => void;
  onStartDraft: () => void;
  onCloseDraft: () => void;
  onChangeDraft: (body: string) => void;
  onSubmitReply: (body: string) => void;
  onDeleteReply: (replyId: string) => void;
  onRetryReply: (replyId: string) => void;
  /**
   * Open the runner pre-loaded with this note's recipe. Only invoked
   * when row.runRecipe is defined; the button is hidden otherwise.
   */
  onVerify: () => void;
}) {
  return (
    <li
      ref={cardRef}
      className={`ainote ainote--${row.severity} ainote--clickable ${
        row.isCurrent ? "ainote--current" : ""
      } ${row.isAcked ? "ainote--acked" : ""}`}
      onClick={cardClick(onClickLineNo)}
      title="click to jump to this line"
    >
      <div className="ainote__head">
        <button
          className="ainote__lineno"
          onClick={onClickLineNo}
          title="jump to this line"
        >
          L{row.lineNo}
        </button>
        <span className="ainote__sev">{row.sevGlyph}</span>
        <span className="ainote__summary">
          <RichText text={row.summary} symbols={symbols} onJump={onJump} />
        </span>
        <span className="ainote__actions">
          {row.runRecipe && (
            <button
              className="ainote__verify"
              onClick={onVerify}
              title="open the runner with this snippet and the AI's suggested inputs pre-filled"
            >
              ▷ verify
            </button>
          )}
          <button className="ainote__ack" onClick={onStartDraft} title="reply">
            reply
          </button>
          <button
            className={`ainote__ack ${row.isAcked ? "ainote__ack--on" : ""}`}
            onClick={onAck}
            title={row.isAcked ? "un-ack" : "acknowledge"}
          >
            {row.isAcked ? "✓ acked" : "ack"}
          </button>
        </span>
      </div>
      {row.detail && (
        <div className="ainote__detail">
          <RichText text={row.detail} symbols={symbols} onJump={onJump} />
        </div>
      )}
      <ReplyThread
        interactions={row.replies}
        isDrafting={row.isDrafting}
        draftBody={draftBody}
        onStartDraft={onStartDraft}
        onCloseDraft={onCloseDraft}
        onChangeDraft={onChangeDraft}
        onSubmitReply={onSubmitReply}
        onDeleteReply={onDeleteReply}
        onRetryReply={onRetryReply}
        symbols={symbols}
        onJump={onJump}
        deliveredById={deliveredById}
      />
    </li>
  );
}

function HunkSummarySection({
  summary,
  replies,
  isDrafting,
  draftBody,
  jumpTarget,
  symbols,
  deliveredById,
  onJump,
  onStartDraft,
  onCloseDraft,
  onChangeDraft,
  onSubmitReply,
  onDeleteReply,
  onRetryReply,
}: {
  summary: string;
  replies: Interaction[];
  replyKey: string;
  isDrafting: boolean;
  draftBody: string;
  jumpTarget: Cursor;
  symbols: SymbolIndex;
  deliveredById?: Record<string, DeliveredInteraction>;
  onJump: (c: Cursor) => void;
  onStartDraft: () => void;
  onCloseDraft: () => void;
  onChangeDraft: (body: string) => void;
  onSubmitReply: (body: string) => void;
  onDeleteReply: (replyId: string) => void;
  onRetryReply: (replyId: string) => void;
}) {
  return (
    <section className="inspector__sec">
      <div className="inspector__sec-h">AI on this hunk (summary)</div>
      <div
        className="ainote ainote--info ainote--clickable"
        onClick={cardClick(() => onJump(jumpTarget))}
        title="click to jump to the top of this hunk"
      >
        <div className="inspector__summary">
          <RichText text={summary} symbols={symbols} onJump={onJump} />
        </div>
        <ReplyThread
          interactions={replies}
          isDrafting={isDrafting}
          draftBody={draftBody}
          onStartDraft={onStartDraft}
          onCloseDraft={onCloseDraft}
          onChangeDraft={onChangeDraft}
          onSubmitReply={onSubmitReply}
          onDeleteReply={onDeleteReply}
          onRetryReply={onRetryReply}
          symbols={symbols}
          onJump={onJump}
          deliveredById={deliveredById}
        />
      </div>
    </section>
  );
}

function TeammateSection({
  teammate,
  symbols,
  draftBody,
  deliveredById,
  onJump,
  onStartDraft,
  onCloseDraft,
  onChangeDraft,
  onSubmitReply,
  onDeleteReply,
  onRetryReply,
}: {
  teammate: NonNullable<InspectorViewModel["teammate"]>;
  symbols: SymbolIndex;
  draftBody: string;
  deliveredById?: Record<string, DeliveredInteraction>;
  onJump: (c: Cursor) => void;
  onStartDraft: () => void;
  onCloseDraft: () => void;
  onChangeDraft: (body: string) => void;
  onSubmitReply: (body: string) => void;
  onDeleteReply: (replyId: string) => void;
  onRetryReply: (replyId: string) => void;
}) {
  return (
    <section className="inspector__sec">
      <div className="inspector__sec-h">Teammate</div>
      <div
        className={`ainote ainote--clickable ainote--${teammate.verdictClass}`}
        onClick={cardClick(() => onJump(teammate.jumpTarget))}
        title="click to jump to the top of this hunk"
      >
        <div className="ainote__head">
          <span className="ainote__sev">
            @{teammate.user} {teammate.verdictGlyph}
          </span>
        </div>
        {teammate.note && (
          <div className="ainote__detail">
            <RichText text={teammate.note} symbols={symbols} onJump={onJump} />
          </div>
        )}
        <ReplyThread
          interactions={teammate.replies}
          isDrafting={teammate.isDrafting}
          draftBody={draftBody}
          onStartDraft={onStartDraft}
          onCloseDraft={onCloseDraft}
          onChangeDraft={onChangeDraft}
          onSubmitReply={onSubmitReply}
          onDeleteReply={onDeleteReply}
          onRetryReply={onRetryReply}
          symbols={symbols}
          onJump={onJump}
          deliveredById={deliveredById}
        />
      </div>
    </section>
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
