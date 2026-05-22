import "./InlineThreadStack.css";
import type { MouseEvent, RefObject } from "react";
import type {
  Cursor,
  DeliveredInteraction,
  Interaction,
  LineSelection,
} from "../types";
import type { SymbolIndex } from "../symbols";
import type {
  InspectorViewModel,
  AiNoteRowItem,
  UserCommentRowItem,
} from "../view";
import { RichText } from "./RichText";
import { ReplyThread } from "./ReplyThread";
import { DetachedThreadCard } from "./DetachedThreadCard";

/**
 * Wraps a jump action so a card's onClick ignores clicks that originated
 * inside an interactive or readable sub-zone rather than the card's own
 * chrome — the reply thread (`.thread`: replies, links, the composer), the
 * action cluster (`.ainote__actions`) or the expandable detail body
 * (`.ainote__detail`) — or while the user is selecting text. The summary
 * row stays clickable so the card's headline still jumps to the line.
 */
function cardClick(jump: () => void) {
  return (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest(
        "button, textarea, input, .thread, .ainote__actions, .ainote__detail",
      )
    )
      return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
    jump();
  };
}

/**
 * Which subset of the thread body to render.
 * - "all"        — panel mode; renders both line-anchored and hunk-level sections.
 * - "hunk-level" — inline diff host at the hunk boundary; renders only the
 *                  hunk summary and teammate verdict.
 */
export type ThreadSections = "all" | "hunk-level";

export interface InlineThreadStackProps {
  vm: InspectorViewModel;
  symbols: SymbolIndex;
  /** Per-key draft body lookup. */
  draftFor: (key: string) => string;
  /** Delivered comments indexed by id; undefined when no worktree is loaded. */
  deliveredById?: Record<string, DeliveredInteraction>;
  /** Worktree path for the detached-thread "view at" affordance. */
  worktreePath: string | null;
  onJump: (c: Cursor) => void;
  onJumpToBlock?: (cursor: Cursor, selection: LineSelection) => void;
  onToggleAck: (hunkId: string, lineIdx: number) => void;
  onStartDraft: (key: string) => void;
  /** Mint a fresh `user:`/`block:` thread key and open its composer. */
  onStartNewComment: () => void;
  onCloseDraft: () => void;
  onChangeDraft: (key: string, body: string) => void;
  onSubmitReply: (key: string, body: string) => void;
  onDeleteReply: (key: string, replyId: string) => void;
  onRetryReply: (key: string, replyId: string) => void;
  onVerifyAiNote: (recipe: {
    source: string;
    inputs: Record<string, string>;
  }) => void;
  /** Which sections to render. Default "all". */
  sections?: ThreadSections;
  /**
   * Ref attached to the current line's NoteCard so the panel host can
   * scroll it into view. Inline hosts omit it.
   */
  currentNoteRef?: RefObject<HTMLLIElement | null>;
}

export function InlineThreadStack({
  vm,
  symbols,
  draftFor,
  deliveredById,
  worktreePath,
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
  sections = "all",
  currentNoteRef,
}: InlineThreadStackProps) {
  const lineAnchored = sections === "all";
  const hunkLevel = sections === "all" || sections === "hunk-level";

  return (
    <>
      {lineAnchored && (
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
                  onAck={() => onToggleAck(row.jumpTarget.hunkId, row.lineIdx)}
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
      )}

      {hunkLevel &&
        vm.aiSummary !== null &&
        vm.aiSummaryReplyKey !== null && (
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

      {hunkLevel && vm.teammate !== null && (
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

      {lineAnchored && (
        <UserCommentsSection
          vm={vm}
          symbols={symbols}
          draftFor={draftFor}
          deliveredById={deliveredById}
          onJump={onJump}
          onJumpToBlock={onJumpToBlock}
          onStartDraft={onStartDraft}
          onStartNewComment={onStartNewComment}
          onCloseDraft={onCloseDraft}
          onChangeDraft={onChangeDraft}
          onSubmitReply={onSubmitReply}
          onDeleteReply={onDeleteReply}
          onRetryReply={onRetryReply}
        />
      )}

      {lineAnchored && vm.detachedThreads.length > 0 && (
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
    </>
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
  onStartNewComment,
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
  onStartNewComment: () => void;
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
          onClick={onStartNewComment}
        >
          + comment on L{vm.currentLineNo}{" "}
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

export function UserThreadCard({
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

export function NoteCard({
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
