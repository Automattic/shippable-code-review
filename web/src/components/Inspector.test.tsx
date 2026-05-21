// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Inspector } from "./Inspector";
import type { PrConversationItem, WorktreeSource, PrSource } from "../types";
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

const WORKTREE_SOURCE: WorktreeSource = {
  worktreePath: "/workspace/test-repo",
  commitSha: "abc123",
  branch: "feat/my-feature",
};

const PR_SOURCE: PrSource = {
  host: "github.com",
  owner: "owner",
  repo: "repo",
  number: 42,
  htmlUrl: "https://github.com/owner/repo/pull/42",
  headSha: "headsha",
  baseSha: "basesha",
  state: "open",
  title: "My feature",
  body: "",
  baseRef: "main",
  headRef: "feat/my-feature",
  lastFetchedAt: new Date().toISOString(),
};

describe("Inspector — PR pill", () => {
  afterEach(() => vi.resetAllMocks());

  it("renders the pill when worktreeSource is set and lookup returns a match", async () => {
    const { lookupPrForBranch: mockLookup } = await import("../githubPrClient");
    (mockLookup as ReturnType<typeof vi.fn>).mockResolvedValue({
      matched: {
        host: "github.com",
        owner: "owner",
        repo: "repo",
        number: 42,
        title: "My feature",
        state: "open",
        htmlUrl: "https://github.com/owner/repo/pull/42",
      },
    });

    renderInspector({ worktreeSource: WORKTREE_SOURCE, changesetId: "wt:test" });

    await waitFor(() => {
      expect(screen.getByText(/Matching PR: #42/)).toBeTruthy();
    });
  });

  it("does not render the pill when worktreeSource is absent", async () => {
    renderInspector({});
    // Give any async effects time to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/Matching PR/)).toBeNull();
  });

  it("does not render the pill when prSource is already set", async () => {
    const { lookupPrForBranch: mockLookup } = await import("../githubPrClient");
    (mockLookup as ReturnType<typeof vi.fn>).mockResolvedValue({
      matched: {
        host: "github.com",
        owner: "owner",
        repo: "repo",
        number: 42,
        title: "My feature",
        state: "open",
        htmlUrl: "https://github.com/owner/repo/pull/42",
      },
    });

    renderInspector({
      worktreeSource: WORKTREE_SOURCE,
      prSource: PR_SOURCE,
      changesetId: "wt:test",
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/Matching PR/)).toBeNull();
  });

  it("does not render the pill when lookup returns { matched: null }", async () => {
    const { lookupPrForBranch: mockLookup } = await import("../githubPrClient");
    (mockLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ matched: null });

    renderInspector({ worktreeSource: WORKTREE_SOURCE, changesetId: "wt:test" });

    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/Matching PR/)).toBeNull();
  });

  it("pill click with github_token_required calls onAuthError and does NOT set pillError", async () => {
    const { lookupPrForBranch: mockLookup, loadGithubPr: mockLoad, GithubFetchError: MockGithubFetchError } =
      await import("../githubPrClient");
    (mockLookup as ReturnType<typeof vi.fn>).mockResolvedValue({
      matched: {
        host: "github.com",
        owner: "owner",
        repo: "repo",
        number: 7,
        title: "Token required PR",
        state: "open",
        htmlUrl: "https://github.com/owner/repo/pull/7",
      },
    });
    (mockLoad as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (MockGithubFetchError as new (d: string, m: string, h?: string) => unknown)(
        "github_token_required",
        "github_token_required",
        "github.com",
      ),
    );

    const onAuthError = vi.fn();
    renderInspector({
      worktreeSource: WORKTREE_SOURCE,
      changesetId: "wt:test",
      onAuthError,
      onMergePrOverlay: vi.fn(),
    });

    await waitFor(() => screen.getByText(/Matching PR: #7/));
    fireEvent.click(screen.getByText(/Matching PR: #7/));

    await waitFor(() => {
      expect(onAuthError).toHaveBeenCalledOnce();
      const [host, reason, retry] = onAuthError.mock.calls[0];
      expect(host).toBe("github.com");
      expect(reason).toBe("first-time");
      expect(typeof retry).toBe("function");
    });
    // pillError must NOT be set
    expect(document.querySelector(".inspector__pr-pill-err")).toBeNull();
  });

  it("pill click with github_auth_failed calls onAuthError with reason=rejected and does NOT set pillError", async () => {
    const { lookupPrForBranch: mockLookup, loadGithubPr: mockLoad, GithubFetchError: MockGithubFetchError } =
      await import("../githubPrClient");
    (mockLookup as ReturnType<typeof vi.fn>).mockResolvedValue({
      matched: {
        host: "github.com",
        owner: "owner",
        repo: "repo",
        number: 8,
        title: "Auth failed PR",
        state: "open",
        htmlUrl: "https://github.com/owner/repo/pull/8",
      },
    });
    (mockLoad as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (MockGithubFetchError as new (d: string, m: string, h?: string) => unknown)(
        "github_auth_failed",
        "github_auth_failed",
        "github.com",
      ),
    );

    const onAuthError = vi.fn();
    renderInspector({
      worktreeSource: WORKTREE_SOURCE,
      changesetId: "wt:test",
      onAuthError,
      onMergePrOverlay: vi.fn(),
    });

    await waitFor(() => screen.getByText(/Matching PR: #8/));
    fireEvent.click(screen.getByText(/Matching PR: #8/));

    await waitFor(() => {
      expect(onAuthError).toHaveBeenCalledOnce();
      const [host, reason] = onAuthError.mock.calls[0];
      expect(host).toBe("github.com");
      expect(reason).toBe("rejected");
    });
    expect(document.querySelector(".inspector__pr-pill-err")).toBeNull();
  });

  it("pill click calls loadGithubPr and dispatches MERGE_PR_OVERLAY via onMergePrOverlay", async () => {
    const { lookupPrForBranch: mockLookup, loadGithubPr: mockLoad } =
      await import("../githubPrClient");
    (mockLookup as ReturnType<typeof vi.fn>).mockResolvedValue({
      matched: {
        host: "github.com",
        owner: "owner",
        repo: "repo",
        number: 42,
        title: "My feature",
        state: "open",
        htmlUrl: "https://github.com/owner/repo/pull/42",
      },
    });

    const fakePrSource = {
      host: "github.com",
      owner: "owner",
      repo: "repo",
      number: 42,
      htmlUrl: "https://github.com/owner/repo/pull/42",
      headSha: "h",
      baseSha: "b",
      state: "open" as const,
      title: "My feature",
      body: "",
      baseRef: "main",
      headRef: "feat/branch",
      lastFetchedAt: "2026-05-07T00:00:00Z",
    };
    const fakePrCs = {
      id: "pr:github.com:owner:repo:42",
      title: "My feature",
      files: [],
      prSource: fakePrSource,
      prConversation: [],
    };
    (mockLoad as ReturnType<typeof vi.fn>).mockResolvedValue({
      changeSet: fakePrCs,
      prInteractions: {},
      prDetached: [],
    });

    const onMergePrOverlay = vi.fn();
    renderInspector({
      worktreeSource: WORKTREE_SOURCE,
      changesetId: "wt:test",
      onMergePrOverlay,
    });

    await waitFor(() => screen.getByText(/Matching PR: #42/));

    fireEvent.click(screen.getByText(/Matching PR: #42/));

    await waitFor(() => {
      expect(mockLoad).toHaveBeenCalledWith(
        "https://github.com/owner/repo/pull/42",
      );
      expect(onMergePrOverlay).toHaveBeenCalledWith(
        "wt:test",
        fakePrSource,
        [],
        {},
        [],
      );
    });
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

describe("Inspector — pill cleared on worktreePath change", () => {
  afterEach(() => vi.resetAllMocks());

  it("clears #42 pill when worktreePath changes to a path returning null", async () => {
    const { lookupPrForBranch: mockLookup } = await import("../githubPrClient");
    (mockLookup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      matched: {
        host: "github.com",
        owner: "owner",
        repo: "repo",
        number: 42,
        title: "My feature",
        state: "open",
        htmlUrl: "https://github.com/owner/repo/pull/42",
      },
    }).mockResolvedValueOnce({ matched: null });

    const sourceA: WorktreeSource = {
      worktreePath: "/a",
      commitSha: "aaa",
      branch: "feat/a",
    };
    const sourceB: WorktreeSource = {
      worktreePath: "/b",
      commitSha: "bbb",
      branch: "feat/b",
    };

    const { rerender } = renderInspector({
      worktreeSource: sourceA,
      changesetId: "wt:a",
    });

    // Wait for #42 pill to appear
    await waitFor(() => screen.getByText(/Matching PR: #42/));

    // Change worktreePath — stale pill should disappear immediately
    rerender(
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
        worktreeSource={sourceB}
        changesetId="wt:b"
      />,
    );

    // The #42 pill must be gone immediately (synchronous state reset)
    expect(screen.queryByText(/Matching PR: #42/)).toBeNull();

    // And the new lookup for /b returns null, so no pill ever appears
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Matching PR/)).toBeNull();
  });
});
