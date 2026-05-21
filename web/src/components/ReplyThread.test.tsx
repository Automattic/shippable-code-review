// @vitest-environment jsdom
// Component tests for ReplyThread's pip rendering. The pip state machine
// + tooltip copy is a load-bearing UI contract from the
// share-review-comments plan; these tests pin the strings.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { ReplyThread } from "./ReplyThread";
import type { DeliveredInteraction, Interaction } from "../types";

function userIx(over: Partial<Interaction> = {}): Interaction {
  return {
    id: "r1",
    threadKey: "user:cs/f#h:0",
    target: "line",
    intent: "comment",
    author: "you",
    authorRole: "user",
    body: "hello",
    createdAt: "2026-05-06T12:34:56.000Z",
    ...over,
  };
}

function agentIx(over: Partial<Interaction> = {}): Interaction {
  return {
    id: "ar1",
    threadKey: "user:cs/f#h:0",
    target: "reply",
    intent: "accept",
    author: "agent",
    authorRole: "agent",
    body: "fixed it",
    createdAt: "2026-05-06T12:35:01.000Z",
    ...over,
  };
}

function delivered(id: string, deliveredAt: string): DeliveredInteraction {
  return {
    id,
    target: "line",
    intent: "comment",
    author: "you",
    authorRole: "user",
    file: "f.ts",
    lines: "1",
    body: "b",
    commitSha: "sha",
    supersedes: null,
    enqueuedAt: "2026-05-06T12:00:00.000Z",
    deliveredAt,
  };
}

const empty = new Map<string, never>();
const noop = () => {};

function emptySymbols() {
  // The SymbolIndex interface is just `Map<string, Cursor>`; an empty map
  // satisfies it for these tests because no body content references known
  // symbols.
  return empty as unknown as Parameters<typeof ReplyThread>[0]["symbols"];
}

describe("ReplyThread — pip state machine", () => {
  it("renders no pip when the interaction is not enqueued", () => {
    const { container } = render(
      <ReplyThread
        interactions={[userIx()]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
      />,
    );
    expect(container.querySelector(".reply__pip")).toBeNull();
  });

  it("renders the queued pip when agentQueueStatus is pending and not delivered", () => {
    const { container } = render(
      <ReplyThread
        interactions={[userIx({ agentQueueStatus: "pending" })]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{}}
      />,
    );
    const pip = container.querySelector(".reply__pip");
    expect(pip).not.toBeNull();
    expect(pip!.className).toContain("reply__pip--queued");
    expect(pip!.textContent).toContain("queued");
  });

  it("renders the delivered pip when the interaction id is in the delivered map", () => {
    const d = delivered("r1", "2026-05-06T12:35:01.000Z");
    const { container } = render(
      <ReplyThread
        interactions={[userIx({ agentQueueStatus: "pending" })]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{ r1: d }}
      />,
    );
    const pip = container.querySelector(".reply__pip");
    expect(pip).not.toBeNull();
    expect(pip!.className).toContain("reply__pip--delivered");
    expect(pip!.textContent).toContain("delivered");
  });

  it("renders the delivered pip when agentQueueStatus is delivered, even without a delivered map entry", () => {
    const { container } = render(
      <ReplyThread
        interactions={[userIx({ agentQueueStatus: "delivered" })]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{}}
      />,
    );
    const pip = container.querySelector(".reply__pip");
    expect(pip).not.toBeNull();
    expect(pip!.className).toContain("reply__pip--delivered");
  });
});

describe("ReplyThread — delete-button tooltip", () => {
  const SPEC_TITLE_DELIVERED =
    "the agent already saw this; deleting only removes it from your view.";

  it("uses the spec string when the reply is in the delivered set", () => {
    const d = delivered("r1", "2026-05-06T12:35:01.000Z");
    const { container } = render(
      <ReplyThread
        interactions={[userIx({ agentQueueStatus: "pending" })]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{ r1: d }}
      />,
    );
    const del = container.querySelector(".reply__delete") as HTMLElement;
    expect(del.getAttribute("title")).toBe(SPEC_TITLE_DELIVERED);
  });

  it("uses the generic 'delete reply' title when the reply is queued but not yet delivered", () => {
    const { container } = render(
      <ReplyThread
        interactions={[userIx({ agentQueueStatus: "pending" })]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{}}
      />,
    );
    const del = container.querySelector(".reply__delete") as HTMLElement;
    expect(del.getAttribute("title")).toBe("delete reply");
  });

  it("uses the generic 'delete reply' title when the reply is not enqueued", () => {
    const { container } = render(
      <ReplyThread
        interactions={[userIx()]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
      />,
    );
    const del = container.querySelector(".reply__delete") as HTMLElement;
    expect(del.getAttribute("title")).toBe("delete reply");
  });
});

describe("ReplyThread — errored pip + retry", () => {
  const ERR_TITLE = "Couldn't reach your agent — click to retry.";

  it("renders the errored pip with the spec glyph + title when enqueueError is true and not enqueued", () => {
    const onRetry = vi.fn();
    const { container } = render(
      <ReplyThread
        interactions={[userIx({ enqueueError: true })]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        onRetryReply={onRetry}
        symbols={emptySymbols()}
        onJump={noop}
      />,
    );
    const pip = container.querySelector(".reply__pip--errored") as HTMLElement;
    expect(pip).not.toBeNull();
    expect(pip.textContent).toContain("⚠");
    expect(pip.textContent).toContain("retry");
    expect(pip.getAttribute("title")).toBe(ERR_TITLE);
  });

  it("clicking the errored pip calls onRetryReply with the reply id", () => {
    const onRetry = vi.fn();
    const r = userIx({
      id: "r-bad",
      enqueueError: true,
    });
    const { container } = render(
      <ReplyThread
        interactions={[r]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        onRetryReply={onRetry}
        symbols={emptySymbols()}
        onJump={noop}
      />,
    );
    const pip = container.querySelector(".reply__pip--errored") as HTMLElement;
    fireEvent.click(pip);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith("r-bad");
  });

  it("delivered wins over errored when both are technically true (delivered is the source of truth)", () => {
    const d = delivered("r1", "2026-05-06T12:35:01.000Z");
    const { container } = render(
      <ReplyThread
        interactions={[
          userIx({ agentQueueStatus: "pending", enqueueError: true }),
        ]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{ r1: d }}
      />,
    );
    expect(container.querySelector(".reply__pip--errored")).toBeNull();
    expect(container.querySelector(".reply__pip--delivered")).not.toBeNull();
  });

  it("renders queued pip optimistically when agentQueueStatus is pending and no enqueue error", () => {
    // Covers the submit→delivered window: the interaction is optimistically
    // set to pending on submit before the server round-trip completes.
    const { container } = render(
      <ReplyThread
        interactions={[userIx({ agentQueueStatus: "pending", enqueueError: false })]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{}}
      />,
    );
    const pip = container.querySelector(".reply__pip");
    expect(pip).not.toBeNull();
    expect(pip!.className).toContain("reply__pip--queued");
    expect(pip!.textContent).toContain("queued");
  });

  it("errored wins over queued — covers the optimistic-pending-then-enqueue-failed case", () => {
    const { container } = render(
      <ReplyThread
        interactions={[
          userIx({ agentQueueStatus: "pending", enqueueError: true }),
        ]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        onRetryReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{}}
      />,
    );
    expect(container.querySelector(".reply__pip--queued")).toBeNull();
    expect(container.querySelector(".reply__pip--errored")).not.toBeNull();
  });

  it("renders no pip when neither enqueued nor errored", () => {
    const { container } = render(
      <ReplyThread
        interactions={[userIx()]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
      />,
    );
    expect(container.querySelector(".reply__pip")).toBeNull();
  });

  it("after a successful retry the pip flips back to ◌ queued", () => {
    const { container, rerender } = render(
      <ReplyThread
        interactions={[userIx({ enqueueError: true })]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        onRetryReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
      />,
    );
    expect(container.querySelector(".reply__pip--errored")).not.toBeNull();
    rerender(
      <ReplyThread
        interactions={[
          userIx({ agentQueueStatus: "pending", enqueueError: false }),
        ]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        onRetryReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{}}
      />,
    );
    expect(container.querySelector(".reply__pip--errored")).toBeNull();
    expect(container.querySelector(".reply__pip--queued")).not.toBeNull();
  });
});

describe("ReplyThread — agent replies as sibling Interactions", () => {
  it("renders nothing extra when no agent Interactions sit alongside the user one", () => {
    const { container } = render(
      <ReplyThread
        interactions={[userIx({ agentQueueStatus: "pending" })]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
      />,
    );
    expect(container.querySelector(".agent-reply")).toBeNull();
  });

  it("renders one row per agent Interaction with intent glyph, label, body and timestamp", () => {
    const user = userIx({ agentQueueStatus: "pending" });
    const agents = [
      agentIx({
        id: "ar1",
        body: "fixed it",
        intent: "accept",
        createdAt: "2026-05-06T12:35:01.000Z",
      }),
      agentIx({
        id: "ar2",
        body: "won't fix",
        intent: "reject",
        createdAt: "2026-05-06T12:36:01.000Z",
      }),
      agentIx({
        id: "ar3",
        body: "noted",
        intent: "ack",
        createdAt: "2026-05-06T12:37:01.000Z",
      }),
    ];
    const { container } = render(
      <ReplyThread
        interactions={[user, ...agents]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
      />,
    );
    const blocks = container.querySelectorAll(".agent-reply");
    expect(blocks.length).toBe(3);
    blocks.forEach((b) =>
      expect(b.querySelector(".agent-reply__label")?.textContent).toBe("agent"),
    );
    expect(container.querySelector(".agent-reply--accept")).not.toBeNull();
    expect(container.querySelector(".agent-reply--reject")).not.toBeNull();
    expect(container.querySelector(".agent-reply--ack")).not.toBeNull();
    const bodies = Array.from(
      container.querySelectorAll(".agent-reply__body"),
    ).map((el) => el.textContent);
    expect(bodies).toEqual(["fixed it", "won't fix", "noted"]);
  });

  it("renders agent rows in input order — callers (selectInteractions) sort by createdAt", () => {
    const user = userIx({ agentQueueStatus: "pending" });
    const a = agentIx({
      id: "a",
      body: "A",
      intent: "ack",
      createdAt: "2026-05-06T12:35:01.000Z",
    });
    const z = agentIx({
      id: "z",
      body: "Z",
      intent: "accept",
      createdAt: "2026-05-06T12:38:01.000Z",
    });
    const { container } = render(
      <ReplyThread
        interactions={[user, a, z]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
      />,
    );
    const bodies = Array.from(
      container.querySelectorAll(".agent-reply__body"),
    ).map((el) => el.textContent);
    expect(bodies).toEqual(["A", "Z"]);
  });
});

describe("ReplyThread — pip tooltips", () => {
  it("queued tooltip uses the exact 'Sent to your agent's queue at HH:MM:SS.' prefix", () => {
    const { container } = render(
      <ReplyThread
        interactions={[
          userIx({
            agentQueueStatus: "pending",
            createdAt: "2026-05-06T12:34:56.000Z",
          }),
        ]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{}}
      />,
    );
    const pip = container.querySelector(".reply__pip--queued") as HTMLElement;
    const title = pip.getAttribute("title") ?? "";
    expect(title).toMatch(/^Sent to your agent's queue at \d{2}:\d{2}:\d{2}\.$/);
  });

  it("delivered tooltip uses the exact 'Fetched by your agent at HH:MM:SS.' prefix", () => {
    const d = delivered("r1", "2026-05-06T12:35:01.000Z");
    const { container } = render(
      <ReplyThread
        interactions={[userIx({ agentQueueStatus: "pending" })]}
        isDrafting={false}
        draftBody=""
        onStartDraft={noop}
        onCloseDraft={noop}
        onChangeDraft={noop}
        onSubmitReply={noop}
        onDeleteReply={noop}
        symbols={emptySymbols()}
        onJump={noop}
        deliveredById={{ r1: d }}
      />,
    );
    const pip = container.querySelector(".reply__pip--delivered") as HTMLElement;
    const title = pip.getAttribute("title") ?? "";
    expect(title).toMatch(/^Fetched by your agent at \d{2}:\d{2}:\d{2}\.$/);
  });
});

// Helper: a reply-target interaction (target === "reply").
function replyIx(over: Partial<Interaction> = {}): Interaction {
  return {
    id: "rep1",
    threadKey: "user:cs/f#h:0:r1",
    target: "reply",
    intent: "comment",
    author: "you",
    authorRole: "user",
    body: "a reply",
    createdAt: "2026-05-06T12:40:00.000Z",
    ...over,
  };
}

function renderThread(interactions: Interaction[]) {
  return render(
    <ReplyThread
      interactions={interactions}
      isDrafting={false}
      draftBody=""
      onStartDraft={noop}
      onCloseDraft={noop}
      onChangeDraft={noop}
      onSubmitReply={noop}
      onDeleteReply={noop}
      symbols={emptySymbols()}
      onJump={noop}
    />,
  );
}

describe("ReplyThread — two-level thread layout (user comment head + nested replies)", () => {
  // The head interaction (target: "line") is the user's comment. It must render
  // as a distinct comment block, NOT as one of the reply rows under a label.
  it("renders the thread head (target line) as .thread__head, not inside .thread__list", () => {
    const head = userIx({ id: "r1", target: "line", body: "top-level comment" });
    const { container } = renderThread([head]);

    expect(container.querySelector(".thread__head")).not.toBeNull();
    // The head must NOT be a .reply li inside .thread__list
    const listItems = container.querySelectorAll(".thread__list .reply");
    expect(listItems.length).toBe(0);
  });

  it("renders reply-target interactions nested inside .thread__list beneath the head", () => {
    const head = userIx({ id: "r1", target: "line", body: "top-level comment" });
    const reply1 = replyIx({ id: "rep1", body: "reply one" });
    const reply2 = replyIx({ id: "rep2", body: "reply two" });

    const { container } = renderThread([head, reply1, reply2]);

    // Head renders distinctly
    expect(container.querySelector(".thread__head")).not.toBeNull();
    // Both replies are in the list
    const listItems = container.querySelectorAll(".thread__list .reply");
    expect(listItems.length).toBe(2);
  });

  it("'replies (N)' label counts only reply-target entries, not the head", () => {
    const head = userIx({ id: "r1", target: "line", body: "top-level comment" });
    const reply1 = replyIx({ id: "rep1", body: "reply one" });
    const reply2 = replyIx({ id: "rep2", body: "reply two" });

    const { container } = renderThread([head, reply1, reply2]);

    const label = container.querySelector(".thread__label");
    expect(label).not.toBeNull();
    // Must say "replies (2)", not "replies (3)"
    expect(label!.textContent).toMatch(/replies \(2\)/);
  });

  it("omits the 'replies' label when the head has no replies", () => {
    const head = userIx({ id: "r1", target: "line", body: "just a comment, no replies" });

    const { container } = renderThread([head]);

    expect(container.querySelector(".thread__label")).toBeNull();
  });

  it("note/teammate threads (no head in rows) still render flat reply list unchanged", () => {
    // A teammate: thread head is filtered out by rows; only reply entries remain.
    const teammateReply = replyIx({
      id: "rep1",
      threadKey: "teammate:cs/f#h:0",
      authorRole: "user",
      target: "reply",
      body: "a follow-up",
    });

    const { container } = renderThread([teammateReply]);

    // No thread__head — we're on the no-head path
    expect(container.querySelector(".thread__head")).toBeNull();
    // The reply still renders in the list
    const listItems = container.querySelectorAll(".thread__list .reply");
    expect(listItems.length).toBe(1);
  });
});

describe("ReplyThread — structured agent fields", () => {
  // A top-level agent comment is the head of its own thread. Render it solo so
  // these exercise the thread-head path — the structured fields live in
  // AgentRow, and the head must route through AgentRow, not renderUserRow.
  function renderAgentHead(over: Partial<Interaction> = {}) {
    return renderThread([
      agentIx({ target: "line", intent: "request", ...over }),
    ]);
  }

  it("renders a top-level agent comment as the thread head via AgentRow", () => {
    const { container } = renderAgentHead({ confidence: "high" });
    expect(
      container.querySelector(".thread__head .agent-reply"),
    ).not.toBeNull();
    // It must NOT fall through to the user-row renderer.
    expect(container.querySelector(".thread__head .reply")).toBeNull();
  });

  it("renders a confidence chip when confidence is set", () => {
    const { container } = renderAgentHead({ confidence: "high" });
    const chip = container.querySelector(".agent-reply__confidence");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toMatch(/high/i);
    expect(
      container.querySelector(".agent-reply__confidence--high"),
    ).not.toBeNull();
  });

  it("renders rationale and suggestedFix as collapsed <details> sections", () => {
    const { container } = renderAgentHead({
      rationale: "this leaks a handle",
      suggestedFix: "close(fd)",
    });
    const rationale = container.querySelector(
      "details.agent-reply__detail--rationale",
    ) as HTMLDetailsElement | null;
    const fix = container.querySelector(
      "details.agent-reply__detail--fix",
    ) as HTMLDetailsElement | null;
    expect(rationale).not.toBeNull();
    expect(fix).not.toBeNull();
    // Collapsed by default — a glance shows body + intent + chip only.
    expect(rationale!.open).toBe(false);
    expect(fix!.open).toBe(false);
    expect(rationale!.textContent).toContain("this leaks a handle");
    expect(fix!.textContent).toContain("close(fd)");
    // suggestedFix renders as regular text, not a code container.
    expect(fix!.querySelector(".agent-reply__detail-body")).not.toBeNull();
    expect(fix!.querySelector("pre")).toBeNull();
  });

  it("renders none of the structured fields when the interaction lacks them", () => {
    const { container } = renderAgentHead();
    expect(container.querySelector(".agent-reply__confidence")).toBeNull();
    expect(container.querySelector(".agent-reply__detail--rationale")).toBeNull();
    expect(container.querySelector(".agent-reply__detail--fix")).toBeNull();
  });
});
