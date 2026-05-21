// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { Inspector } from "./Inspector";
import type { PrConversationItem } from "../types";
import type { PrMatch } from "../githubPrClient";
import type { InspectorViewModel } from "../view";

// jsdom does not implement scrollIntoView; mock it globally so effects that
// call it (e.g. auto-scroll to the current AI note) don't throw.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

// Minimal mocks to silence deps that are not under test
vi.mock("./AgentContextSection", () => ({
  AgentContextSection: () => null,
}));
vi.mock("./ReplyThread", () => ({
  ReplyThread: () => null,
}));
vi.mock("./CodeText", () => ({
  CodeText: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("./RichText", () => ({
  RichText: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../githubPrClient", () => ({
  GithubFetchError: class GithubFetchError extends Error {
    discriminator: string;
    host?: string;
    constructor(discriminator: string, message: string, host?: string) {
      super(message);
      this.discriminator = discriminator;
      this.host = host;
    }
  },
  lookupPrForBranch: vi.fn(),
  loadGithubPr: vi.fn(),
}));

const EMPTY_SYMBOLS = new Map() as Parameters<typeof Inspector>[0]["symbols"];
const NOOP = () => undefined;

function minimalViewModel() {
  return {
    locationLabel: "src/foo.ts:1",
    language: "typescript",
    lineKind: "context" as const,
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
    currentLineNo: 1,
    cursorHunkId: "hunk1",
    cursorLineIdx: 0,
    showDraftStub: false,
    draftStubRow: null,
    detachedThreads: [],
  };
}

// A view model with real AI-note and user-comment content so tests can verify
// that InlineThreadStack body is genuinely hidden (not just an empty body).
function richViewModel(): InspectorViewModel {
  return {
    ...minimalViewModel(),
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
  };
}

function renderInspector(
  over: Partial<Parameters<typeof Inspector>[0]> = {},
) {
  return render(
    <Inspector
      viewModel={minimalViewModel()}
      commentCount={0}
      onPrevComment={NOOP}
      onNextComment={NOOP}
      lineHasAiNote={false}
      symbols={EMPTY_SYMBOLS}
      draftBodies={{}}
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
      interactionsShownInline={false}
      {...over}
    />,
  );
}

describe("Inspector — prConversation", () => {
  it("renders the PR conversation disclosure with item count", () => {
    const items: PrConversationItem[] = [
      {
        id: 10,
        author: "carol",
        createdAt: new Date(Date.now() - 60 * 60000).toISOString(),
        body: "Why was this approach chosen?",
        htmlUrl: "https://github.com/owner/repo/pull/1#issuecomment-10",
      },
    ];

    renderInspector({ prConversation: items });

    expect(screen.getByText(/PR conversation \(1\)/i)).toBeTruthy();
    expect(screen.getByText("@carol")).toBeTruthy();
    expect(screen.getByText("Why was this approach chosen?")).toBeTruthy();
  });

  it("does not render the section when prConversation is empty", () => {
    renderInspector({ prConversation: [] });
    expect(screen.queryByText(/PR conversation/i)).toBeNull();
  });
});

const PILL_MATCH: PrMatch = {
  host: "github.com",
  owner: "owner",
  repo: "repo",
  number: 42,
  title: "My feature",
  state: "open",
  htmlUrl: "https://github.com/owner/repo/pull/42",
};

describe("Inspector — PR pill (presentation)", () => {
  // The pill's behavior (branch lookup, click → fetch, auth-error flow)
  // moved to ReviewWorkspace as part of detached-sidebars slice (e), so
  // these tests now cover only how Inspector renders the pill given the
  // parent-supplied props.
  afterEach(() => vi.resetAllMocks());

  it("renders the pill when a pillMatch prop is provided", () => {
    renderInspector({ pillMatch: PILL_MATCH });
    expect(screen.getByText(/Matching PR: #42/)).toBeTruthy();
  });

  it("does not render the pill when pillMatch is null", () => {
    renderInspector({ pillMatch: null });
    expect(screen.queryByText(/Matching PR/)).toBeNull();
  });

  it("disables the button while pillBusy", () => {
    renderInspector({ pillMatch: PILL_MATCH, pillBusy: true });
    const button = screen.getByRole("button", { name: /Loading PR overlay/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows pillError text alongside the pill", () => {
    renderInspector({ pillMatch: PILL_MATCH, pillError: "Network down" });
    expect(screen.getByText("Network down")).toBeTruthy();
  });

  it("calls onPillClick when the pill is clicked", () => {
    const onPillClick = vi.fn();
    renderInspector({ pillMatch: PILL_MATCH, onPillClick });
    fireEvent.click(screen.getByRole("button", { name: /Matching PR: #42/ }));
    expect(onPillClick).toHaveBeenCalledOnce();
  });
});

describe("Inspector — interactionsShownInline", () => {
  it("renders real thread content when interactionsShownInline is false", () => {
    render(
      <Inspector
        viewModel={richViewModel()}
        commentCount={0}
        onPrevComment={NOOP}
        onNextComment={NOOP}
        lineHasAiNote={false}
        symbols={EMPTY_SYMBOLS}
        draftBodies={{}}
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
        interactionsShownInline={false}
      />,
    );
    // Thread body sections from richViewModel must be visible
    expect(screen.getByText("AI concerns in this hunk")).toBeTruthy();
    expect(screen.getByText("Possible null deref")).toBeTruthy();
    expect(screen.getByText("Your comments")).toBeTruthy();
    // Placeholder must be absent
    expect(screen.queryByText("Comments are shown inline in the diff.")).toBeNull();
  });

  it("hides real thread content and shows placeholder when interactionsShownInline is true", () => {
    render(
      <Inspector
        viewModel={richViewModel()}
        commentCount={0}
        onPrevComment={NOOP}
        onNextComment={NOOP}
        lineHasAiNote={false}
        symbols={EMPTY_SYMBOLS}
        draftBodies={{}}
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
        interactionsShownInline={true}
      />,
    );
    // Placeholder must appear
    expect(screen.getByText("Comments are shown inline in the diff.")).toBeTruthy();
    // Thread body content from richViewModel must be absent
    expect(screen.queryByText("AI concerns in this hunk")).toBeNull();
    expect(screen.queryByText("Possible null deref")).toBeNull();
    expect(screen.queryByText("Your comments")).toBeNull();
    // Chrome (header + location card) must still be present
    expect(screen.getByText("inspector")).toBeTruthy();
    expect(screen.getByText("src/foo.ts:1")).toBeTruthy();
  });
});

// ── Legacy in-Inspector pill behaviour ──────────────────────────────────
// Lookup + fetch + error handling moved to ReviewWorkspace as part of
// detached-sidebars slice (e). The pill-cleared-on-worktree-change test
// that used to live here belongs there now.
