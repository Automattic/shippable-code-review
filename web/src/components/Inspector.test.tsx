// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { Inspector } from "./Inspector";
import type { PrConversationItem } from "../types";
import type { PrMatch } from "../githubPrClient";

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
    currentLineCommentKey: "user:hunk1:0",
    currentLineNo: 1,
    showDraftStub: false,
    draftStubRow: null,
    detachedThreads: [],
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

// ── Legacy in-Inspector pill behaviour ──────────────────────────────────
// The old test block below exercised lookup + fetch + error handling that
// now lives in ReviewWorkspace. Kept commented for the next reader hunting
// for these test names in git blame; the real coverage moves once we add
// a ReviewWorkspace-level test for handlePillClick.
//
// describe("Inspector — PR pill behaviour", ...) — removed in slice (e).

