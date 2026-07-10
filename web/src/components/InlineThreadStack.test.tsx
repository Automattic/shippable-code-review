// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InlineThreadStack } from "./InlineThreadStack";
import type { InspectorViewModel } from "../view";
import type { SymbolIndex } from "../symbols";

afterEach(cleanup);

vi.mock("./ReplyThread", () => ({
  ReplyThread: () => null,
}));
vi.mock("./RichText", () => ({
  RichText: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("./DetachedThreadCard", () => ({
  DetachedThreadCard: ({ row }: { row: { threadKey: string } }) => (
    <li data-testid="detached-card">{row.threadKey}</li>
  ),
}));

const EMPTY_SYMBOLS = new Map() as SymbolIndex;
const NOOP = () => undefined;

// A view model that populates every body section: an AI note row, a user
// comment row, a hunk summary, a teammate verdict, and a detached thread.
function richViewModel(): InspectorViewModel {
  return {
    locationLabel: "src/foo.ts:12",
    language: "typescript",
    lineKind: "context",
    lineText: "const x = 1;",
    lineSign: " ",

    hasAiNotes: true,
    aiNoteCountLabel: "0/1 acked",
    aiNoteRows: [
      {
        lineIdx: 3,
        lineNo: 12,
        severity: "warning",
        sevGlyph: "!",
        summary: "Possible null deref",
        detail: "x can be undefined here",
        isAcked: false,
        isCurrent: true,
        replyKey: "note:hunk1:3",
        replies: [],
        isDrafting: false,
        jumpTarget: {
          changesetId: "cs",
          fileId: "f",
          hunkId: "hunk1",
          lineIdx: 3,
        },
      },
    ],
    nextNoteHint: null,

    aiSummary: "This hunk reworks the parser.",
    aiSummaryReplyKey: "hunkSummary:hunk1",
    aiSummaryReplies: [],
    aiSummaryIsDrafting: false,
    aiSummaryJumpTarget: {
      changesetId: "cs",
      fileId: "f",
      hunkId: "hunk1",
      lineIdx: 0,
    },

    teammate: {
      user: "mina",
      verdict: "approve",
      verdictGlyph: "✓",
      note: "Looks good to me.",
      verdictClass: "info",
      replyKey: "teammate:hunk1",
      replies: [],
      isDrafting: false,
      jumpTarget: {
        changesetId: "cs",
        fileId: "f",
        hunkId: "hunk1",
        lineIdx: 0,
      },
    },

    userCommentCountLabel: "1 thread",
    userCommentRows: [
      {
        lineIdx: 5,
        lineNo: 14,
        threadKey: "user:hunk1:5",
        replies: [
          {
            id: "r1",
            threadKey: "user:hunk1:5",
            target: "line",
            intent: "comment",
            author: "you",
            authorRole: "user",
            body: "Why this branch?",
            createdAt: "2026-05-01T00:00:00Z",
          },
        ],
        isDrafting: false,
        isCurrent: false,
        jumpTarget: {
          changesetId: "cs",
          fileId: "f",
          hunkId: "hunk1",
          lineIdx: 5,
        },
      },
    ],
    showNewCommentCta: false,
    currentLineNo: 12,
    cursorHunkId: "hunk1",
    cursorLineIdx: 3,
    showDraftStub: false,
    draftStubRow: null,

    detachedThreads: [
      {
        threadKey: "user:gone:0",
        replies: [
          {
            id: "d1",
            threadKey: "user:gone:0",
            target: "line",
            intent: "comment",
            author: "you",
            authorRole: "user",
            body: "stale",
            createdAt: "2026-05-01T00:00:00Z",
          },
        ],
        anchorPath: "src/foo.ts",
        anchorLineNo: 7,
        snippetLines: [],
        originType: "committed",
        originSha: "",
        originSha7: "",
        isDrafting: false,
      },
    ],
    fileLineThreads: [],
  };
}

function renderStack(
  over: Partial<Parameters<typeof InlineThreadStack>[0]> = {},
) {
  return render(
    <InlineThreadStack
      vm={richViewModel()}
      symbols={EMPTY_SYMBOLS}
      draftFor={() => ""}
      worktreePath={null}
      onJump={NOOP}
      onToggleAck={NOOP}
      onStartDraft={NOOP}
      onStartNewComment={NOOP}
      onCloseDraft={NOOP}
      onChangeDraft={NOOP}
      onSubmitReply={NOOP}
      onDeleteReply={NOOP}
      onRetryReply={NOOP}
      onVerifyAiNote={NOOP}
      {...over}
    />,
  );
}

describe("InlineThreadStack — sections=all", () => {
  it("renders every body section", () => {
    renderStack();
    expect(screen.getByText("AI concerns in this hunk")).toBeTruthy();
    expect(screen.getByText("Possible null deref")).toBeTruthy();
    expect(screen.getByText("AI on this hunk (summary)")).toBeTruthy();
    expect(screen.getByText("This hunk reworks the parser.")).toBeTruthy();
    expect(screen.getByText("Teammate")).toBeTruthy();
    expect(screen.getByText(/@mina/)).toBeTruthy();
    expect(screen.getByText("Your comments")).toBeTruthy();
    expect(screen.getByText("Detached")).toBeTruthy();
    expect(screen.getByTestId("detached-card")).toBeTruthy();
  });
});

describe("InlineThreadStack — + comment CTA", () => {
  it("routes the + comment click through onStartNewComment, not onStartDraft", () => {
    const onStartNewComment = vi.fn();
    const onStartDraft = vi.fn();
    const vm = { ...richViewModel(), showNewCommentCta: true };
    renderStack({ vm, onStartNewComment, onStartDraft });
    fireEvent.click(screen.getByText(/comment on L12/));
    expect(onStartNewComment).toHaveBeenCalledTimes(1);
    expect(onStartDraft).not.toHaveBeenCalled();
  });
});

describe("InlineThreadStack — sections=hunk-level", () => {
  it("renders hunk summary and teammate but omits line-anchored sections", () => {
    renderStack({ sections: "hunk-level" });
    expect(screen.getByText("AI on this hunk (summary)")).toBeTruthy();
    expect(screen.getByText("Teammate")).toBeTruthy();
    expect(screen.queryByText("AI concerns in this hunk")).toBeNull();
    expect(screen.queryByText("Your comments")).toBeNull();
    expect(screen.queryByText("Detached")).toBeNull();
  });
});
