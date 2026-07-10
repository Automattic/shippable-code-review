// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DiffView } from "./DiffView";
import type {
  DiffViewModel,
  InspectorViewModel,
  LineThreadsProjection,
} from "../view";
import type { SymbolIndex } from "../symbols";

vi.mock("../highlight", () => ({
  highlightLines: vi.fn(async (lines: string[], language?: string) => ({
    language: language ?? "text",
    lines: lines.map((_line, i) => (
      <span
        key={i}
        className="shiki-token shiki-token--symbol"
        data-symbol="loadPrefs"
        data-token-col={7}
        role="button"
        tabIndex={0}
      >
        loadPrefs
      </span>
    )),
  })),
}));

// jsdom does not implement these methods on Element; the DiffView's
// scroll-on-cursor effect and the gutter pointer-capture path both poke
// them, so we install no-op stubs to keep the test environment quiet.
beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = vi.fn();
  }
  if (typeof Element.prototype.setPointerCapture !== "function") {
    Element.prototype.setPointerCapture = vi.fn();
  }
  if (typeof Element.prototype.releasePointerCapture !== "function") {
    Element.prototype.releasePointerCapture = vi.fn();
  }
});

afterEach(cleanup);

describe("DiffView symbol navigation", () => {
  it("calls onSymbolClick when a highlighted symbol is clicked", async () => {
    const onSymbolClick = vi.fn();

    render(
      <DiffView
        viewModel={fixtureViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        clickableSymbols={new Set(["loadPrefs"])}
        onSymbolClick={onSymbolClick}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "loadPrefs" }));

    expect(onSymbolClick).toHaveBeenCalledWith({
      symbol: "loadPrefs",
      file: "src/preferences.ts",
      language: "typescript",
      line: 0,
      col: 7,
    });
  });

  it("symbol click does not fire onLineFocus or open the context menu", async () => {
    const onLineFocus = vi.fn();
    const onLineContextMenu = vi.fn();
    const onSymbolClick = vi.fn();

    render(
      <DiffView
        viewModel={fixtureViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        clickableSymbols={new Set(["loadPrefs"])}
        onSymbolClick={onSymbolClick}
        onLineFocus={onLineFocus}
        onLineContextMenu={onLineContextMenu}
      />,
    );

    const token = await screen.findByRole("button", { name: "loadPrefs" });
    fireEvent.pointerDown(token, { button: 0 });
    fireEvent.click(token);

    expect(onSymbolClick).toHaveBeenCalled();
    expect(onLineFocus).not.toHaveBeenCalled();
    expect(onLineContextMenu).not.toHaveBeenCalled();
  });
});

describe("DiffView line interactions", () => {
  function multiLineViewModel(): DiffViewModel {
    return {
      path: "src/multi.ts",
      language: "typescript",
      status: "modified",
      fileId: "file-multi",
      isFileReviewed: false,
      canExpandFile: false,
      fileFullyExpanded: false,
      fullFileLines: [],
      filePreviewing: false,
      canPreview: false,
      previewSource: "",
      hunks: [
        {
          id: "hunk-A",
          header: "@@ -1,3 +1,3 @@",
          coverage: 0,
          isCurrent: true,
          aiReviewed: false,
          definesSymbols: [],
          referencesSymbols: [],
          contextAbove: [],
          contextBelow: [],
          lines: [
            {
              kind: "add",
              text: "alpha;",
              newNo: 1,
              isCursor: true,
              isRead: false,
              isSelected: false,
              isAcked: false,
              hasUserComment: false,
              aiGlyph: " ",
            },
            {
              kind: "add",
              text: "beta;",
              newNo: 2,
              isCursor: false,
              isRead: false,
              isSelected: false,
              isAcked: false,
              hasUserComment: false,
              aiGlyph: " ",
            },
            {
              kind: "add",
              text: "gamma;",
              newNo: 3,
              isCursor: false,
              isRead: false,
              isSelected: false,
              isAcked: false,
              hasUserComment: false,
              aiGlyph: " ",
            },
          ],
        },
        {
          id: "hunk-B",
          header: "@@ -10,1 +10,1 @@",
          coverage: 0,
          isCurrent: false,
          aiReviewed: false,
          definesSymbols: [],
          referencesSymbols: [],
          contextAbove: [],
          contextBelow: [],
          lines: [
            {
              kind: "context",
              text: "later;",
              newNo: 10,
              oldNo: 10,
              isCursor: false,
              isRead: false,
              isSelected: false,
              isAcked: false,
              hasUserComment: false,
              aiGlyph: " ",
            },
          ],
        },
      ],
    };
  }

  type DiffViewHandlers = Pick<
    React.ComponentProps<typeof DiffView>,
    | "onLineFocus"
    | "onLineSelectRange"
    | "onLineCharSelect"
    | "onLineContextMenu"
    | "onHunkFocus"
  >;

  function renderMulti(handlers: DiffViewHandlers) {
    return render(
      <DiffView
        viewModel={multiLineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        {...handlers}
      />,
    );
  }

  function lineGutter(container: HTMLElement, hunkId: string, lineIdx: number): HTMLElement {
    const hunk = container.querySelector(`[data-hunk-id="${hunkId}"]`);
    if (!hunk) throw new Error(`hunk ${hunkId} missing`);
    const line = hunk.querySelector(`[data-line-idx="${lineIdx}"]`);
    if (!line) throw new Error(`line ${lineIdx} missing in ${hunkId}`);
    const gutter = line.querySelector(".line__sign");
    if (!gutter) throw new Error(`sign column missing on line ${lineIdx}`);
    return gutter as HTMLElement;
  }

  function lineText(container: HTMLElement, hunkId: string, lineIdx: number): HTMLElement {
    const hunk = container.querySelector(`[data-hunk-id="${hunkId}"]`);
    const line = hunk?.querySelector(`[data-line-idx="${lineIdx}"]`);
    const text = line?.querySelector(".line__text");
    if (!text) throw new Error("line__text missing");
    return text as HTMLElement;
  }

  it("pointerdown on the AI glyph column calls onLineFocus for that line", () => {
    const onLineFocus = vi.fn();
    const { container } = renderMulti({ onLineFocus });
    const glyph = container
      .querySelector(`[data-hunk-id="hunk-A"] [data-line-idx="2"] .line__ai`);
    if (!glyph) throw new Error("line__ai glyph missing");
    fireEvent.pointerDown(glyph, { button: 0 });
    expect(onLineFocus).toHaveBeenCalledWith("hunk-A", 2, { extend: false });
  });

  it("clicking a non-current hunk's interaction badge calls onHunkFocus", () => {
    const onHunkFocus = vi.fn();
    const vm = multiLineViewModel();
    vm.hunks[1].aiReviewed = true;
    const { container } = render(
      <DiffView
        viewModel={vm}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        onHunkFocus={onHunkFocus}
      />,
    );
    const badge = container
      .querySelector(`[data-hunk-id="hunk-B"]`)
      ?.closest(".hunk")
      ?.querySelector(".hunk__badges .badge--ai");
    if (!badge) throw new Error("AI badge missing on hunk-B");
    fireEvent.click(badge);
    expect(onHunkFocus).toHaveBeenCalledWith("hunk-B");
  });

  it("clicking the current hunk's badge does not call onHunkFocus", () => {
    const onHunkFocus = vi.fn();
    const vm = multiLineViewModel();
    vm.hunks[0].aiReviewed = true;
    const { container } = render(
      <DiffView
        viewModel={vm}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        onHunkFocus={onHunkFocus}
      />,
    );
    const badge = container
      .querySelector(".hunk--current .hunk__badges .badge--ai");
    if (!badge) throw new Error("AI badge missing on current hunk");
    fireEvent.click(badge);
    expect(onHunkFocus).not.toHaveBeenCalled();
  });

  it("clicking a non-current hunk's header text does not call onHunkFocus", () => {
    const onHunkFocus = vi.fn();
    const vm = multiLineViewModel();
    vm.hunks[1].aiReviewed = true;
    const { container } = render(
      <DiffView
        viewModel={vm}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        onHunkFocus={onHunkFocus}
      />,
    );
    const headerText = container
      .querySelector(`[data-hunk-id="hunk-B"]`)
      ?.closest(".hunk")
      ?.querySelector(".hunk__header-text");
    if (!headerText) throw new Error("header text missing on hunk-B");
    fireEvent.click(headerText);
    expect(onHunkFocus).not.toHaveBeenCalled();
  });

  it("pointerdown on the gutter calls onLineFocus with extend reflecting shiftKey", () => {
    const onLineFocus = vi.fn();
    const { container } = renderMulti({ onLineFocus });
    fireEvent.pointerDown(lineGutter(container, "hunk-A", 1), { button: 0 });
    expect(onLineFocus).toHaveBeenCalledWith("hunk-A", 1, { extend: false });
  });

  it("shift-click on the gutter passes extend=true", () => {
    const onLineFocus = vi.fn();
    const { container } = renderMulti({ onLineFocus });
    fireEvent.pointerDown(lineGutter(container, "hunk-A", 2), {
      button: 0,
      shiftKey: true,
    });
    expect(onLineFocus).toHaveBeenLastCalledWith("hunk-A", 2, { extend: true });
  });

  it("right-click on a line calls onLineContextMenu", () => {
    const onLineContextMenu = vi.fn();
    const { container } = renderMulti({ onLineContextMenu });
    const target = lineGutter(container, "hunk-A", 1);
    fireEvent.contextMenu(target, { clientX: 100, clientY: 200 });
    expect(onLineContextMenu).toHaveBeenCalledWith("hunk-A", 1, 100, 200);
  });

  it("text-content pointerdown does not call onLineFocus immediately", () => {
    const onLineFocus = vi.fn();
    const { container } = renderMulti({ onLineFocus });
    fireEvent.pointerDown(lineText(container, "hunk-A", 1), { button: 0 });
    expect(onLineFocus).not.toHaveBeenCalled();
  });

  it("text-content collapsed pointerup falls through to onLineFocus", () => {
    const onLineFocus = vi.fn();
    const { container } = renderMulti({ onLineFocus });
    const target = lineText(container, "hunk-A", 1);
    fireEvent.pointerDown(target, { button: 0 });
    fireEvent.pointerUp(target);
    expect(onLineFocus).toHaveBeenCalledWith("hunk-A", 1, { extend: false });
  });

  it("interactionsEnabled=false suppresses pointer + contextmenu callbacks", () => {
    const onLineFocus = vi.fn();
    const onLineContextMenu = vi.fn();
    const { container } = render(
      <DiffView
        viewModel={multiLineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        onLineFocus={onLineFocus}
        onLineContextMenu={onLineContextMenu}
        interactionsEnabled={false}
      />,
    );
    fireEvent.pointerDown(lineGutter(container, "hunk-A", 0), { button: 0 });
    fireEvent.contextMenu(lineGutter(container, "hunk-A", 0));
    expect(onLineFocus).not.toHaveBeenCalled();
    expect(onLineContextMenu).not.toHaveBeenCalled();
  });
});

describe("DiffView inline threads", () => {
  function inlineViewModel(): DiffViewModel {
    return {
      path: "src/inline.ts",
      language: "typescript",
      status: "modified",
      fileId: "file-inline",
      isFileReviewed: false,
      canExpandFile: false,
      fileFullyExpanded: false,
      fullFileLines: [],
      filePreviewing: false,
      canPreview: false,
      previewSource: "",
      hunks: [
        {
          id: "hunk-1",
          header: "@@ -1,2 +1,2 @@",
          coverage: 0,
          isCurrent: true,
          aiReviewed: false,
          definesSymbols: [],
          referencesSymbols: [],
          contextAbove: [],
          contextBelow: [],
          lines: [
            {
              kind: "add",
              text: "first;",
              newNo: 1,
              isCursor: true,
              isRead: false,
              isSelected: false,
              isAcked: false,
              hasUserComment: false,
              aiGlyph: " ",
            },
            {
              kind: "add",
              text: "second;",
              newNo: 2,
              isCursor: false,
              isRead: false,
              isSelected: false,
              isAcked: false,
              hasUserComment: false,
              aiGlyph: " ",
            },
          ],
        },
      ],
    };
  }

  function inlineInspectorVm(): InspectorViewModel {
    return {
      locationLabel: "src/inline.ts:1",
      language: "typescript",
      lineKind: "add",
      lineText: "first;",
      lineSign: "+",
      hasAiNotes: true,
      aiNoteCountLabel: "0/1 acked",
      aiNoteRows: [
        {
          lineIdx: 0,
          lineNo: 1,
          severity: "warning",
          sevGlyph: "!",
          summary: "Inline AI concern",
          isAcked: false,
          isCurrent: true,
          replyKey: "note:hunk-1:0",
          replies: [],
          isDrafting: false,
          jumpTarget: { changesetId: "cs", fileId: "file-inline", hunkId: "hunk-1", lineIdx: 0 },
        },
      ],
      nextNoteHint: null,
      aiSummary: null,
      aiSummaryReplyKey: null,
      aiSummaryReplies: [],
      aiSummaryIsDrafting: false,
      aiSummaryJumpTarget: null,
      teammate: null,
      userCommentCountLabel: "1 thread",
      userCommentRows: [
        {
          lineIdx: 0,
          lineNo: 1,
          threadKey: "user:hunk-1:0",
          replies: [
            {
              id: "r1",
              threadKey: "user:hunk-1:0",
              target: "line",
              intent: "comment",
              author: "you",
              authorRole: "user",
              body: "Inline user comment",
              createdAt: "2026-05-01T00:00:00Z",
            },
          ],
          isDrafting: false,
          isCurrent: true,
          jumpTarget: { changesetId: "cs", fileId: "file-inline", hunkId: "hunk-1", lineIdx: 0 },
        },
      ],
      showNewCommentCta: false,
      currentLineNo: 1,
      cursorHunkId: "hunk-1",
      cursorLineIdx: 0,
      showDraftStub: false,
      draftStubRow: null,
      detachedThreads: [],
    };
  }

  const inlineThreads = () => ({
    vm: inlineInspectorVm(),
    symbols: new Map() as SymbolIndex,
    draftFor: () => "",
    worktreePath: null,
    onJump: () => undefined,
    onToggleAck: () => undefined,
    onStartDraft: () => undefined,
    onStartNewComment: () => undefined,
    onCloseDraft: () => undefined,
    onChangeDraft: () => undefined,
    onSubmitReply: () => undefined,
    onDeleteReply: () => undefined,
    onRetryReply: () => undefined,
    onVerifyAiNote: () => undefined,
  });

  it("renders the cursor line's own interactions inline, with no hunk chrome", () => {
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={inlineThreads()}
      />,
    );

    const region = container.querySelector(".line-inline-threads");
    expect(region).toBeTruthy();
    // It must live inside hunk__body, right after the cursor line.
    const body = container.querySelector(".hunk__body");
    expect(region!.parentElement).toBe(body);
    const cursorLine = body!.querySelector(".line--cursor");
    expect(cursorLine!.nextElementSibling).toBe(region);

    // Bare cards for the cursor line — the AI note renders as a `.notes li`,
    // with none of the hunk-scoped section headers.
    expect(region!.querySelector(".notes li")).toBeTruthy();
    expect(screen.getByText("Inline AI concern")).toBeTruthy();
    expect(region!.textContent).not.toContain("AI concerns in this hunk");
  });

  it("a no-op re-render does not re-observe inline regions or re-scroll the cursor", () => {
    // Regression: inlineRegionRef was recreated on every render, so React 19
    // re-ran the callback ref (unobserve + observe) every render. A fresh
    // ResizeObserver.observe() fires an initial callback, which scrollIntoView'd
    // the cursor — yanking the viewport back the moment the user scrolled away.
    const observed: Element[] = [];
    let roCallback: ResizeObserverCallback = () => undefined;
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe(el: Element) {
        observed.push(el);
        roCallback([], this as unknown as ResizeObserver); // real RO fires on observe
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

    const props = {
      viewModel: inlineViewModel(),
      onSetExpandLevel: () => undefined,
      onToggleExpandFile: () => undefined,
      onTogglePreviewFile: () => undefined,
      inlineThreads: inlineThreads(),
    };
    const { rerender } = render(<DiffView {...props} />);

    observed.length = 0;
    scrollIntoView.mockClear();

    // Identical props — the cursor has not moved; nothing should scroll.
    rerender(<DiffView {...props} />);

    expect(observed).toEqual([]); // stable ref ⇒ React does not re-attach
    expect(scrollIntoView).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    scrollIntoView.mockRestore();
  });

  it("on a non-noted cursor line, renders no inline region — the comment button offers the comment", () => {
    // A cursor line with no AI note / no comment of its own: InlineLineThreads
    // filters every row out, so no inline block mounts. The comment button is
    // the sole new-comment affordance. The note/comment rows are on another line.
    const vm = inlineInspectorVm();
    vm.aiNoteRows[0].isCurrent = false;
    vm.userCommentRows[0].isCurrent = false;
    vm.userCommentRows[0].lineIdx = 1;
    vm.showNewCommentCta = true;

    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={{ ...inlineThreads(), vm }}
      />,
    );

    expect(container.querySelector(".thread__start--cta")).toBeNull();
    expect(
      container.querySelector(".line--cursor .line__comment-btn"),
    ).toBeTruthy();
  });

  it("renders no inline threads when the prop is absent", () => {
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
      />,
    );
    expect(container.querySelector(".line-inline-threads")).toBeNull();
  });

  it("renders hunk-level threads below the hunk body, not in the header", () => {
    const vm = inlineInspectorVm();
    vm.aiSummary = "Hunk-level AI summary";
    vm.aiSummaryReplyKey = "summary:hunk-1";
    vm.aiSummaryJumpTarget = {
      changesetId: "cs",
      fileId: "file-inline",
      hunkId: "hunk-1",
      lineIdx: 0,
    };
    vm.teammate = {
      user: "robin",
      verdict: "approve",
      verdictClass: "approve",
      verdictGlyph: "✓",
      note: "Looks good",
      replies: [],
      isDrafting: false,
      replyKey: "teammate:hunk-1",
      jumpTarget: {
        changesetId: "cs",
        fileId: "file-inline",
        hunkId: "hunk-1",
        lineIdx: 0,
      },
    };
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={{ ...inlineThreads(), vm }}
      />,
    );

    // Exactly one hunk-level block, attached to the current hunk only.
    const blocks = container.querySelectorAll(".hunk__inline-threads");
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    // Not a descendant of hunk__body, and lives in the current hunk section.
    expect(block.closest(".hunk__body")).toBeNull();
    expect(block.closest(".hunk")).toBe(container.querySelector(".hunk--current"));
    // It appears AFTER .hunk__body in document order (below the body, not in the header).
    const hunkSection = container.querySelector(".hunk--current")!;
    const body = hunkSection.querySelector(".hunk__body")!;
    const children = Array.from(hunkSection.children);
    expect(children.indexOf(body)).toBeLessThan(children.indexOf(block));
    expect(screen.getByText("Hunk-level AI summary")).toBeTruthy();
    expect(screen.getByText("Teammate")).toBeTruthy();
  });

  it("renders no hunk-level threads when the prop is absent", () => {
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
      />,
    );
    expect(container.querySelector(".hunk__inline-threads")).toBeNull();
  });

  it("renders .diff__detached after the last .hunk when detachedThreads is non-empty", () => {
    const vm = inlineInspectorVm();
    vm.detachedThreads = [
      {
        threadKey: "dt:file:0",
        replies: [],
        anchorPath: "src/inline.ts",
        anchorLineNo: 99,
        snippetLines: [],
        originType: "committed",
        originSha: "deadbeef",
        originSha7: "deadbee",
        isDrafting: false,
      },
    ];
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={{ ...inlineThreads(), vm }}
      />,
    );
    const detached = container.querySelector(".diff__detached");
    expect(detached).toBeTruthy();
    // Must appear after the last .hunk in document order.
    const hunks = Array.from(container.querySelectorAll(".hunk"));
    const lastHunk = hunks[hunks.length - 1];
    const main = container.querySelector("main.diff")!;
    const children = Array.from(main.children);
    expect(children.indexOf(lastHunk)).toBeLessThan(children.indexOf(detached!));
  });

  it("renders no .diff__detached when detachedThreads is empty", () => {
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={inlineThreads()}
      />,
    );
    // inlineThreads() uses inlineInspectorVm() which has detachedThreads: []
    expect(container.querySelector(".diff__detached")).toBeNull();
  });

  it("renders no .diff__detached when inlineThreads prop is absent", () => {
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
      />,
    );
    expect(container.querySelector(".diff__detached")).toBeNull();
  });

  it("renders a trailing comment cell on every diff line when inline comments is on", () => {
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={inlineThreads()}
      />,
    );
    const body = container.querySelector(".hunk__body")!;
    expect(body.classList.contains("hunk__body--comment-col")).toBe(true);
    const lines = body.querySelectorAll(".line");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.lastElementChild?.classList.contains("line__comment")).toBe(
        true,
      );
    }
  });

  it("renders no comment cell when inline comments is off", () => {
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
      />,
    );
    expect(container.querySelector(".line__comment")).toBeNull();
    expect(container.querySelector(".hunk__body--comment-col")).toBeNull();
  });

  it("shows the + comment button in the comment cell of the cursor line only", () => {
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={inlineThreads()}
      />,
    );
    const buttons = container.querySelectorAll(".line__comment-btn");
    expect(buttons).toHaveLength(1);
    const cursorLine = container.querySelector(".line--cursor")!;
    expect(cursorLine.querySelector(".line__comment-btn")).toBe(buttons[0]);
    // The button is accessible by its name; non-cursor cells are empty.
    expect(
      screen.getByRole("button", { name: "Comment on this line" }),
    ).toBe(buttons[0]);
    const body = container.querySelector(".hunk__body")!;
    for (const line of body.querySelectorAll(".line")) {
      if (line.classList.contains("line--cursor")) continue;
      expect(line.querySelector(".line__comment")!.childElementCount).toBe(0);
    }
  });

  it("invokes onStartNewComment when the + comment button is clicked", () => {
    const onStartNewComment = vi.fn();
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={{ ...inlineThreads(), onStartNewComment }}
      />,
    );
    fireEvent.click(container.querySelector(".line__comment-btn")!);
    expect(onStartNewComment).toHaveBeenCalledTimes(1);
  });

  it("orders diff line children so code is not displaced by the comment column", () => {
    // The grid template is `… 1fr 96px`: a desynchronised grid (a renderer
    // emitting the wrong child count) wraps the code text into the wrong
    // column. Pin the child order for add/del/context diff lines in the
    // hunk body (ContextLine is covered by the companion test below).
    const expected = [
      "line__old",
      "line__new",
      "line__ai",
      "line__sign",
      "line__text",
      "line__comment",
    ];
    const { container } = render(
      <DiffView
        viewModel={twoLineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={inlineThreads()}
      />,
    );
    const checkLine = (line: Element) => {
      const classes = Array.from(line.children).map(
        (c) => c.className.split(" ")[0],
      );
      expect(classes).toEqual(expected);
    };
    const body = container.querySelector(".hunk__body")!;
    for (const line of body.querySelectorAll(".line")) checkLine(line);
  });

  it("orders context-line children so code is not displaced by the comment column", () => {
    // ContextLine (rendered by ContextLinesBlock from contextAbove/contextBelow)
    // appends its own line__comment cell. Pin the child order so a miscount
    // can't silently push the code text into the wrong grid column.
    const vm = twoLineViewModel();
    vm.hunks[0].contextAbove = [
      { kind: "context", text: "ctx above;", oldNo: 0, newNo: 0 },
    ];
    vm.hunks[0].contextBelow = [
      { kind: "context", text: "ctx below;", oldNo: 3, newNo: 3 },
    ];
    const { container } = render(
      <DiffView
        viewModel={vm}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={inlineThreads()}
      />,
    );

    // Confirm ContextLinesBlock rendered: the context container must exist
    // and contain at least one .line--context child.
    const ctxBodies = container.querySelectorAll(".hunk__body--context");
    expect(ctxBodies.length).toBeGreaterThan(0);
    const ctxLines = container.querySelectorAll(".hunk__body--context .line--context");
    expect(ctxLines.length).toBeGreaterThan(0);

    const expected = [
      "line__old",
      "line__new",
      "line__ai",
      "line__sign",
      "line__text",
      "line__comment",
    ];
    for (const line of ctxLines) {
      const classes = Array.from(line.children).map(
        (c) => c.className.split(" ")[0],
      );
      expect(classes).toEqual(expected);
      // Context lines never carry the + comment button — the cell is always empty.
      expect(line.querySelector(".line__comment")!.childElementCount).toBe(0);
    }
  });

  it("orders full-file line children so code is not displaced by the comment column", () => {
    const vm = inlineViewModel();
    vm.canExpandFile = true;
    vm.fileFullyExpanded = true;
    vm.fullFileLines = [
      { kind: "context", text: "const x = 1;", newNo: 1, oldNo: 1, sign: " ", threads: [] },
      { kind: "add", text: "const y = 2;", newNo: 2, sign: "+", threads: [] },
    ];
    const { container } = render(
      <DiffView
        viewModel={vm}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={inlineThreads()}
      />,
    );
    const expected = [
      "line__old",
      "line__new",
      "line__ai",
      "line__sign",
      "line__text",
      "line__comment",
    ];
    const body = container.querySelector(".hunk__body--comment-col")!;
    const lines = body.querySelectorAll(".line");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const classes = Array.from(line.children).map(
        (c) => c.className.split(" ")[0],
      );
      expect(classes).toEqual(expected);
    }
  });

  it("does not turn a pointer gesture inside the inline region into a line drag", () => {
    const onLineFocus = vi.fn();
    const onLineSelectRange = vi.fn();
    const { container } = render(
      <DiffView
        viewModel={inlineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        onLineFocus={onLineFocus}
        onLineSelectRange={onLineSelectRange}
        inlineThreads={inlineThreads()}
      />,
    );
    const region = container.querySelector(".line-inline-threads") as HTMLElement;
    fireEvent.pointerDown(region, { button: 0 });
    fireEvent.pointerMove(region);
    fireEvent.pointerUp(region);
    expect(onLineFocus).not.toHaveBeenCalled();
    expect(onLineSelectRange).not.toHaveBeenCalled();
  });

  // A two-line inline diff: cursor on line 0, a comment thread on line 1.
  function twoLineViewModel(): DiffViewModel {
    const vm = inlineViewModel();
    vm.hunks[0].header = "@@ -1,2 +1,2 @@";
    return vm;
  }

  function lineThreadsProjection(): LineThreadsProjection {
    return [
      {
        hunkId: "hunk-1",
        lineIdx: 0,
        isCursor: true,
        aiNoteRows: [],
        userCommentRows: [],
      },
      {
        hunkId: "hunk-1",
        lineIdx: 1,
        isCursor: false,
        aiNoteRows: [],
        userCommentRows: [
          {
            lineIdx: 1,
            lineNo: 2,
            threadKey: "user:hunk-1:1:zzz",
            replies: [
              {
                id: "rL1",
                threadKey: "user:hunk-1:1:zzz",
                target: "line",
                intent: "comment",
                author: "you",
                authorRole: "user",
                body: "Comment on the second line",
                createdAt: "2026-05-02T00:00:00Z",
              },
            ],
            isDrafting: false,
            isCurrent: false,
            jumpTarget: {
              changesetId: "cs",
              fileId: "file-inline",
              hunkId: "hunk-1",
              lineIdx: 1,
            },
          },
        ],
      },
    ];
  }

  it("mounts an inline block under every line with threads when lineThreads is supplied", () => {
    const { container } = render(
      <DiffView
        viewModel={twoLineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={inlineThreads()}
        lineThreads={lineThreadsProjection()}
      />,
    );
    // One block under the cursor line (line 0), one under line 1.
    const regions = container.querySelectorAll(".line-inline-threads");
    expect(regions).toHaveLength(2);
    const body = container.querySelector(".hunk__body")!;
    const line1 = body.querySelector('[data-line-idx="1"]')!;
    expect(line1.nextElementSibling).toBe(regions[1]);
    // Line 1's projected comment renders in its block.
    expect(screen.getByText("Comment on the second line")).toBeTruthy();
    // The cursor line's block keeps the cursor-VM content.
    expect(screen.getByText("Inline AI concern")).toBeTruthy();
  });

  it("renders only the cursor line's block when lineThreads is the cursor entry only", () => {
    // "hide non-active comments" on → ReviewWorkspace passes only the cursor
    // entry; non-cursor lines get no block.
    const cursorOnly = lineThreadsProjection().filter((e) => e.isCursor);
    const { container } = render(
      <DiffView
        viewModel={twoLineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={inlineThreads()}
        lineThreads={cursorOnly}
      />,
    );
    const regions = container.querySelectorAll(".line-inline-threads");
    expect(regions).toHaveLength(1);
    const body = container.querySelector(".hunk__body")!;
    expect(body.querySelector(".line--cursor")!.nextElementSibling).toBe(
      regions[0],
    );
    expect(screen.queryByText("Comment on the second line")).toBeNull();
  });

  it("non-cursor line blocks carry no + comment CTA", () => {
    const { container } = render(
      <DiffView
        viewModel={twoLineViewModel()}
        onSetExpandLevel={() => undefined}
        onToggleExpandFile={() => undefined}
        onTogglePreviewFile={() => undefined}
        inlineThreads={inlineThreads()}
        lineThreads={lineThreadsProjection()}
      />,
    );
    const regions = container.querySelectorAll(".line-inline-threads");
    // regions[1] is line 1's block — no CTA there.
    expect(regions[1].querySelector(".thread__start--cta")).toBeNull();
  });

  it("observes inline regions via one live ResizeObserver and re-scrolls a visible cursor on resize", () => {
    // jsdom has no ResizeObserver; install a stub that faithfully models
    // observe/unobserve/disconnect per instance, so the test can fire a resize
    // for a chosen node and assert which observer is watching which nodes.
    const observers: StubResizeObserver[] = [];
    class StubResizeObserver {
      live = new Set<Element>();
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        observers.push(this);
      }
      observe(el: Element) {
        this.live.add(el);
      }
      unobserve(el: Element) {
        this.live.delete(el);
      }
      disconnect() {
        this.live.clear();
      }
      resize(el: Element) {
        if (this.live.has(el)) this.cb([], this as unknown as ResizeObserver);
      }
    }
    const fireResize = (el: Element) => observers.forEach((o) => o.resize(el));
    const props = {
      viewModel: inlineViewModel(),
      onSetExpandLevel: () => undefined,
      onToggleExpandFile: () => undefined,
      onTogglePreviewFile: () => undefined,
    };
    vi.stubGlobal("ResizeObserver", StubResizeObserver);

    try {
      // First render carries inline threads.
      const { container, rerender, unmount } = render(
        <DiffView {...props} inlineThreads={inlineThreads()} />,
      );

      const cursorLine = container.querySelector(".line--cursor") as HTMLElement;
      const region = container.querySelector(".line-inline-threads") as HTMLElement;
      const hunkRegion = container.querySelector(
        ".hunk__inline-threads",
      ) as HTMLElement;
      const scrollSpy = vi.spyOn(cursorLine, "scrollIntoView");

      // The observer re-scrolls only a cursor still inside the viewport. jsdom
      // has no layout, so place the cursor explicitly; with no scrollable
      // ancestor findScrollContainer falls back to window (innerHeight 768).
      const rect = (top: number, bottom: number) =>
        ({
          top,
          bottom,
          left: 0,
          right: 0,
          width: 0,
          height: bottom - top,
          x: 0,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
      const cursorRect = vi
        .spyOn(cursorLine, "getBoundingClientRect")
        .mockReturnValue(rect(200, 220));

      // A reply landing rebuilds the view model — DiffView re-renders with a
      // fresh `inlineThreads` object but no cursor/hunk/file move. `991630b`
      // created the observer inside an effect keyed on `inlineThreads`, so each
      // such render disconnected the old observer and built a new one; nodes
      // that joined between runs were left unobserved. The fix keeps exactly
      // one observer for the component's lifetime.
      rerender(<DiffView {...props} inlineThreads={inlineThreads()} />);
      expect(observers).toHaveLength(1);

      // That single observer watches both region kinds; resizing either one —
      // with no cursor move — pulls the cursor line back into view.
      const live = observers[0].live;
      expect(live.has(region)).toBe(true);
      expect(live.has(hunkRegion)).toBe(true);

      fireResize(region);
      expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });

      scrollSpy.mockClear();
      fireResize(hunkRegion);
      expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });

      // A cursor the user has scrolled fully off-screen stays put: resizing a
      // distant thread (deleting, expanding, replying) must not yank it back.
      scrollSpy.mockClear();
      cursorRect.mockReturnValue(rect(900, 920));
      fireResize(region);
      expect(scrollSpy).not.toHaveBeenCalled();

      // Unmount disconnects the observer; later resizes are inert.
      unmount();
      scrollSpy.mockClear();
      fireResize(region);
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function fixtureViewModel(): DiffViewModel {
  return {
    path: "src/preferences.ts",
    language: "typescript",
    status: "modified",
    fileId: "file-1",
    isFileReviewed: false,
    canExpandFile: false,
    fileFullyExpanded: false,
    fullFileLines: [],
    filePreviewing: false,
    canPreview: false,
    previewSource: "",
    hunks: [
      {
        id: "hunk-1",
        header: "@@ -1,1 +1,1 @@",
        coverage: 0,
        isCurrent: false,
        aiReviewed: false,
        definesSymbols: ["loadPrefs"],
        referencesSymbols: [],
        contextAbove: [],
        contextBelow: [],
        lines: [
          {
            kind: "add",
            text: "loadPrefs();",
            newNo: 1,
            isCursor: false,
            isRead: false,
            isSelected: false,
            isAcked: false,
            hasUserComment: false,
            aiGlyph: " ",
          },
        ],
      },
    ],
  };
}
