// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InlineLineThreads, InlineDetachedThreads } from "./InlineLineThreads";
import type { InspectorViewModel, AiNoteRowItem, UserCommentRowItem, DetachedThreadRowItem } from "../view";
import type { SymbolIndex } from "../symbols";

afterEach(cleanup);

vi.mock("./ReplyThread", () => ({
  ReplyThread: () => null,
}));
vi.mock("./RichText", () => ({
  RichText: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("./DetachedThreadCard", () => ({
  DetachedThreadCard: ({ row }: { row: DetachedThreadRowItem }) => (
    <li className="detached-card-stub">{row.threadKey}</li>
  ),
}));

const EMPTY_SYMBOLS = new Map() as SymbolIndex;
const NOOP = () => undefined;

function jumpTarget(lineIdx: number): AiNoteRowItem["jumpTarget"] {
  return { changesetId: "cs", fileId: "f", hunkId: "hunk1", lineIdx };
}

function aiNote(lineIdx: number, isCurrent: boolean): AiNoteRowItem {
  return {
    lineIdx,
    lineNo: lineIdx + 1,
    severity: "warning",
    sevGlyph: "!",
    summary: `note on line ${lineIdx}`,
    detail: undefined,
    isAcked: false,
    isCurrent,
    replyKey: `note:hunk1:${lineIdx}`,
    replies: [],
    isDrafting: false,
    jumpTarget: jumpTarget(lineIdx),
  };
}

function userComment(
  lineIdx: number,
  isCurrent: boolean,
  rangeHiLineIdx?: number,
): UserCommentRowItem {
  return {
    lineIdx,
    lineNo: lineIdx + 1,
    rangeHiLineIdx,
    rangeHiLineNo: rangeHiLineIdx !== undefined ? rangeHiLineIdx + 1 : undefined,
    threadKey: `user:hunk1:${lineIdx}`,
    replies: [],
    isDrafting: false,
    isCurrent,
    jumpTarget: jumpTarget(lineIdx),
  };
}

function vmWith(over: Partial<InspectorViewModel>): InspectorViewModel {
  return {
    locationLabel: "src/foo.ts:12",
    language: "typescript",
    lineKind: "context",
    lineText: "const x = 1;",
    lineSign: " ",

    hasAiNotes: false,
    aiNoteCountLabel: "none",
    aiNoteRows: [],
    nextNoteHint: null,

    aiSummary: null,
    aiSummaryReplyKey: null,
    aiSummaryReplies: [],
    aiSummaryIsDrafting: false,
    aiSummaryJumpTarget: null,

    teammate: null,

    userCommentCountLabel: "none",
    userCommentRows: [],
    showNewCommentCta: false,
    currentLineNo: 12,
    cursorHunkId: "hunk1",
    cursorLineIdx: 3,
    showDraftStub: false,
    draftStubRow: null,

    detachedThreads: [],
    ...over,
  };
}

function renderThreads(
  vm: InspectorViewModel,
  over: Partial<Parameters<typeof InlineLineThreads>[0]> = {},
) {
  return render(
    <InlineLineThreads
      vm={vm}
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

function detachedThread(key: string): DetachedThreadRowItem {
  return {
    threadKey: key,
    replies: [],
    anchorPath: "src/foo.ts",
    anchorLineNo: 5,
    snippetLines: [],
    originType: "committed",
    originSha: "abc123",
    originSha7: "abc123",
    isDrafting: false,
  };
}

describe("InlineLineThreads", () => {
  it("renders only the cursor line's AI note, with no section headers", () => {
    const vm = vmWith({
      hasAiNotes: true,
      aiNoteRows: [aiNote(3, true), aiNote(7, false)],
    });
    renderThreads(vm);
    expect(screen.getByText("note on line 3")).toBeTruthy();
    expect(screen.queryByText("note on line 7")).toBeNull();
    expect(screen.queryByText("AI concerns in this hunk")).toBeNull();
    expect(screen.queryByText("Your comments")).toBeNull();
  });

  it("does not render the + comment CTA — the comment rail replaces it", () => {
    const { container } = renderThreads(vmWith({ showNewCommentCta: true }));
    expect(container.querySelector(".thread__start--cta")).toBeNull();
  });

  it("renders a current block-comment user thread", () => {
    const vm = vmWith({
      cursorLineIdx: 5,
      userCommentRows: [userComment(2, true, 5)],
    });
    const { container } = renderThreads(vm);
    expect(container.querySelector(".ainote--user")).toBeTruthy();
  });

  it("returns null when there is nothing to show", () => {
    const { container } = renderThreads(vmWith({}));
    expect(container.firstChild).toBeNull();
  });

  it("renders a block-comment row when the cursor is at its last line (hi)", () => {
    const vm = vmWith({
      cursorLineIdx: 5,
      userCommentRows: [userComment(2, false, 5)],
    });
    const { container } = renderThreads(vm);
    expect(container.querySelector(".ainote--user")).toBeTruthy();
  });

  it("does NOT render a block-comment row when the cursor is mid-range (not hi)", () => {
    const vm = vmWith({
      cursorLineIdx: 3,
      userCommentRows: [userComment(2, true, 5)],
    });
    const { container } = renderThreads(vm);
    expect(container.querySelector(".ainote--user")).toBeNull();
  });

  it("renders a UserThreadCard when showDraftStub is true", () => {
    const stub: UserCommentRowItem = userComment(3, true);
    const vm = vmWith({
      showDraftStub: true,
      draftStubRow: { ...stub, threadKey: "user:hunk1:3" },
    });
    const { container } = renderThreads(vm);
    expect(container.querySelector(".ainote--user")).toBeTruthy();
  });
});

describe("InlineDetachedThreads", () => {
  function renderDetached(
    vm: InspectorViewModel,
    over: Partial<Parameters<typeof InlineDetachedThreads>[0]> = {},
  ) {
    return render(
      <InlineDetachedThreads
        vm={vm}
        symbols={EMPTY_SYMBOLS}
        draftFor={() => ""}
        worktreePath={null}
        onJump={NOOP}
        onStartDraft={NOOP}
        onCloseDraft={NOOP}
        onChangeDraft={NOOP}
        onSubmitReply={NOOP}
        onDeleteReply={NOOP}
        onRetryReply={NOOP}
        {...over}
      />,
    );
  }

  it("renders a DetachedThreadCard for each entry in vm.detachedThreads", () => {
    const vm = vmWith({
      detachedThreads: [detachedThread("dt:1"), detachedThread("dt:2")],
    });
    const { container } = renderDetached(vm);
    const cards = container.querySelectorAll(".detached-card-stub");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("dt:1")).toBeTruthy();
    expect(screen.getByText("dt:2")).toBeTruthy();
  });

  it("returns null when vm.detachedThreads is empty", () => {
    const { container } = renderDetached(vmWith({ detachedThreads: [] }));
    expect(container.firstChild).toBeNull();
  });
});
