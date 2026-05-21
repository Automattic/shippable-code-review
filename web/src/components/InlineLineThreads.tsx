// Houses two inline-diff interaction renderers: InlineLineThreads (cursor-line
// threads) and InlineDetachedThreads (file-level detached threads at diff bottom).
import "./InlineThreadStack.css";
import { NoteCard, UserThreadCard } from "./InlineThreadStack";
import type { InlineThreadStackProps } from "./InlineThreadStack";
import type { LineThreadsEntry } from "../view";
import { DetachedThreadCard } from "./DetachedThreadCard";

/**
 * Inline-diff host for the box beneath one diff line. Renders that line's own
 * interactions as bare cards — no section headers, counts, jump buttons, or
 * empty-state placeholders. The hunk-wide view lives in the Inspector panel
 * via `InlineThreadStack`.
 *
 * Two modes:
 * - cursor line (no `lineEntry`): rows come from the cursor-scoped `vm`,
 *   filtered to `isCurrent`, plus the draft composer. Starting a new comment
 *   is offered by the comment column in `DiffView`, not here.
 * - any other line (`lineEntry` supplied): rows come straight from the
 *   per-line projection; no draft stub (that is cursor-only).
 */
type InlineLineThreadsProps = Omit<
  InlineThreadStackProps,
  "sections" | "currentNoteRef"
> & {
  /** When set, render this line's projected threads instead of the cursor's. */
  lineEntry?: LineThreadsEntry;
};

export function InlineLineThreads({
  vm,
  lineEntry,
  symbols,
  draftFor,
  deliveredById,
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
}: InlineLineThreadsProps) {
  const noteRows = lineEntry
    ? lineEntry.aiNoteRows
    : vm.aiNoteRows.filter((r) => r.isCurrent);
  // A block row's `isCurrent` is range-contains; for the cursor-line render we
  // need a single anchor line so it can't double up with the projection.
  // Anchor = `hi` for a block, the line for a line comment.
  const commentRows = lineEntry
    ? lineEntry.userCommentRows
    : vm.userCommentRows.filter(
        (r) => (r.rangeHiLineIdx ?? r.lineIdx) === vm.cursorLineIdx,
      );
  // The draft composer is a cursor-line affordance; a non-cursor line's
  // block never shows it.
  const showDraftStub = !lineEntry && vm.showDraftStub;

  if (noteRows.length === 0 && commentRows.length === 0 && !showDraftStub) {
    return null;
  }

  return (
    <>
      {noteRows.length > 0 && (
        <ul className="notes">
          {noteRows.map((row) => (
            <NoteCard
              key={row.replyKey}
              row={row}
              symbols={symbols}
              draftBody={draftFor(row.replyKey)}
              deliveredById={deliveredById}
              onJump={onJump}
              onAck={() => onToggleAck(row.jumpTarget.hunkId, row.lineIdx)}
              onClickLineNo={() => onJump(row.jumpTarget)}
              onStartDraft={() => onStartDraft(row.replyKey)}
              onCloseDraft={onCloseDraft}
              onChangeDraft={(body) => onChangeDraft(row.replyKey, body)}
              onSubmitReply={(body) => onSubmitReply(row.replyKey, body)}
              onDeleteReply={(replyId) => onDeleteReply(row.replyKey, replyId)}
              onRetryReply={(replyId) => onRetryReply(row.replyKey, replyId)}
              onVerify={() => {
                if (row.runRecipe) onVerifyAiNote(row.runRecipe);
              }}
            />
          ))}
        </ul>
      )}

      {(commentRows.length > 0 || showDraftStub) && (
        <ul className="notes">
          {showDraftStub && vm.draftStubRow && (
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
          {commentRows.map((row) => (
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
              onDeleteReply={(replyId) => onDeleteReply(row.threadKey, replyId)}
              onRetryReply={(replyId) => onRetryReply(row.threadKey, replyId)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

type InlineDetachedThreadsProps = Pick<
  InlineThreadStackProps,
  | "vm"
  | "symbols"
  | "worktreePath"
  | "deliveredById"
  | "draftFor"
  | "onJump"
  | "onStartDraft"
  | "onCloseDraft"
  | "onChangeDraft"
  | "onSubmitReply"
  | "onDeleteReply"
  | "onRetryReply"
>;

/**
 * Renders detached threads at the bottom of the diff — comments whose
 * anchored line no longer exists (the file was rewritten or moved).
 * Mirrors the detached section in `InlineThreadStack` but without section
 * headers or hunk-scoped chrome.
 */
export function InlineDetachedThreads({
  vm,
  symbols,
  draftFor,
  deliveredById,
  worktreePath,
  onJump,
  onStartDraft,
  onCloseDraft,
  onChangeDraft,
  onSubmitReply,
  onDeleteReply,
  onRetryReply,
}: InlineDetachedThreadsProps) {
  if (vm.detachedThreads.length === 0) return null;

  return (
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
          onDeleteReply={(replyId) => onDeleteReply(row.threadKey, replyId)}
          onRetryReply={(replyId) => onRetryReply(row.threadKey, replyId)}
        />
      ))}
    </ul>
  );
}
