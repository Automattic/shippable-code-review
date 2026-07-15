import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, getDb, resetForTests } from "./index.ts";
import {
  deleteInteraction,
  enqueueToWorktree,
  getInteractionsByChangeset,
  interactionExistsForWorktree,
  listAgentReplies,
  listByQueueStatus,
  postAgentInteraction,
  pullAndAck,
  unenqueueFromWorktree,
  upsertInteraction,
  type StoredInteraction,
} from "./interaction-store.ts";

function makeIx(over: Partial<StoredInteraction> = {}): StoredInteraction {
  return {
    id: "ix-1",
    threadKey: "user:hunk-1:3",
    target: "line",
    intent: "comment",
    author: "luiz",
    authorRole: "user",
    body: "looks good",
    createdAt: "2026-01-01T00:00:00.000Z",
    changesetId: "cs-1",
    worktreePath: null,
    agentQueueStatus: null,
    authorId: null,
    payload: { anchorPath: "src/a.ts", anchorLineNo: 12 },
    ...over,
  };
}

beforeEach(async () => {
  await initDb({ SHIPPABLE_DB_PATH: ":memory:" });
});

afterEach(() => {
  resetForTests();
});

describe("upsertInteraction", () => {
  it("inserts a row and reads it back by changeset", () => {
    upsertInteraction(makeIx());
    const rows = getInteractionsByChangeset("cs-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(makeIx());
  });

  it("round-trips anchor payload fields", () => {
    const payload = {
      anchorPath: "src/b.ts",
      anchorHash: "abc123",
      anchorLineNo: 42,
      anchorContext: [{ type: "context" as const, content: "foo", lineNo: 41 }],
      originSha: "sha123",
      originType: "committed" as const,
    };
    upsertInteraction(makeIx({ payload }));
    const [row] = getInteractionsByChangeset("cs-1");
    expect(row.payload).toEqual(payload);
  });

  it("round-trips external payload field", () => {
    const payload = { external: { source: "pr" as const, htmlUrl: "https://github.com/example/pull/1#comment-2" } };
    upsertInteraction(makeIx({ payload }));
    const [row] = getInteractionsByChangeset("cs-1");
    expect(row.payload).toEqual(payload);
  });

  it("round-trips runRecipe payload field", () => {
    const payload = { runRecipe: { source: "security-review", inputs: { file: "src/a.ts" } } };
    upsertInteraction(makeIx({ payload }));
    const [row] = getInteractionsByChangeset("cs-1");
    expect(row.payload).toEqual(payload);
  });

  it("updates content columns on conflict but leaves worktree_path and agent_queue_status untouched", () => {
    // Insert fresh row (worktree_path and agent_queue_status default to null).
    upsertInteraction(makeIx({ id: "ix-protect", body: "original" }));

    // Simulate enqueue: manually set worktree_path and agent_queue_status.
    const db = getDb();
    db.prepare(
      "UPDATE interactions SET worktree_path = ?, agent_queue_status = ? WHERE id = ?"
    ).run("/wt/my-worktree", "pending", "ix-protect");

    // Reviewer re-syncs the same id with updated content.
    upsertInteraction(makeIx({ id: "ix-protect", body: "updated after enqueue" }));

    const rows = getInteractionsByChangeset("cs-1");
    const row = rows.find((r) => r.id === "ix-protect");
    expect(row).toBeDefined();
    // Content updated.
    expect(row!.body).toBe("updated after enqueue");
    // Queue columns untouched — the enqueue is not reset.
    expect(row!.worktreePath).toBe("/wt/my-worktree");
    expect(row!.agentQueueStatus).toBe("pending");
  });

  it("round-trips authorId when supplied", () => {
    upsertInteraction(makeIx({ id: "ix-au", authorId: "u1" }));
    const [row] = getInteractionsByChangeset("cs-1");
    expect(row.authorId).toBe("u1");
  });

  it("leaves authorId null when not supplied", () => {
    upsertInteraction(makeIx({ id: "ix-noau" }));
    const [row] = getInteractionsByChangeset("cs-1");
    expect(row.authorId).toBeNull();
  });

  it("preserves an existing authorId when a later upsert omits it", () => {
    upsertInteraction(makeIx({ id: "ix-preserve", authorId: "original-author" }));

    // Reviewer re-syncs the same id without identity (e.g. no auth header on
    // that particular request) — must not clear the stamped author_id.
    upsertInteraction(makeIx({ id: "ix-preserve", authorId: null, body: "edited" }));

    const [row] = getInteractionsByChangeset("cs-1");
    expect(row.body).toBe("edited");
    expect(row.authorId).toBe("original-author");
  });

  it("updates all content columns on conflict", () => {
    upsertInteraction(
      makeIx({
        body: "v1",
        threadKey: "user:t1",
        target: "line",
        intent: "comment",
        authorRole: "user",
        changesetId: "cs-1",
        payload: { anchorPath: "src/a.ts" },
      })
    );
    upsertInteraction(
      makeIx({
        body: "v2",
        threadKey: "user:t2",
        target: "file",
        intent: "suggestion",
        authorRole: "assistant",
        changesetId: "cs-updated",
        payload: { anchorPath: "src/b.ts", anchorLineNo: 99 },
      })
    );
    const rows = getInteractionsByChangeset("cs-updated");
    expect(rows).toHaveLength(1);
    // body and threadKey (original assertions)
    expect(rows[0].body).toBe("v2");
    expect(rows[0].threadKey).toBe("user:t2");
    // authorRole — the two-word camelCase column mapping
    expect(rows[0].authorRole).toBe("assistant");
    // target and intent — other content columns
    expect(rows[0].target).toBe("file");
    expect(rows[0].intent).toBe("suggestion");
    // changesetId and payload also update
    expect(rows[0].changesetId).toBe("cs-updated");
    expect(rows[0].payload).toEqual({ anchorPath: "src/b.ts", anchorLineNo: 99 });
  });
});

describe("getInteractionsByChangeset", () => {
  it("returns empty array for unknown changeset", () => {
    expect(getInteractionsByChangeset("no-such-cs")).toEqual([]);
  });

  it("returns only rows for the given changeset_id", () => {
    upsertInteraction(makeIx({ id: "a", changesetId: "cs-1" }));
    upsertInteraction(makeIx({ id: "b", changesetId: "cs-2" }));
    const rows = getInteractionsByChangeset("cs-1");
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("returns rows sorted oldest-first by created_at", () => {
    upsertInteraction(makeIx({ id: "late", createdAt: "2026-01-01T00:00:02.000Z" }));
    upsertInteraction(makeIx({ id: "early", createdAt: "2026-01-01T00:00:00.000Z" }));
    upsertInteraction(makeIx({ id: "mid", createdAt: "2026-01-01T00:00:01.000Z" }));
    const rows = getInteractionsByChangeset("cs-1");
    expect(rows.map((r) => r.id)).toEqual(["early", "mid", "late"]);
  });

  it("does not return rows with null changesetId when querying a real changesetId", () => {
    // Agent-channel-style row: changesetId is null (SQL NULL ≠ ? — must not appear).
    upsertInteraction(makeIx({ id: "agent-row", changesetId: null }));
    upsertInteraction(makeIx({ id: "cs-row", changesetId: "cs-1" }));
    const rows = getInteractionsByChangeset("cs-1");
    expect(rows.map((r) => r.id)).toEqual(["cs-row"]);
  });
});

describe("deleteInteraction", () => {
  it("removes the row by id and returns true", () => {
    upsertInteraction(makeIx({ id: "del-me" }));
    const deleted = deleteInteraction("del-me");
    expect(deleted).toBe(true);
    expect(getInteractionsByChangeset("cs-1")).toHaveLength(0);
  });

  it("returns false when the id does not exist", () => {
    expect(deleteInteraction("ghost")).toBe(false);
  });

  it("only deletes the targeted row", () => {
    upsertInteraction(makeIx({ id: "keep" }));
    upsertInteraction(makeIx({ id: "gone" }));
    deleteInteraction("gone");
    const rows = getInteractionsByChangeset("cs-1");
    expect(rows.map((r) => r.id)).toEqual(["keep"]);
  });
});

describe("enqueueToWorktree", () => {
  it("sets worktree_path and agent_queue_status=pending on an existing row", () => {
    upsertInteraction(makeIx({ id: "eq-1", changesetId: "cs-eq" }));
    const ok = enqueueToWorktree("eq-1", "/wt/alpha");
    expect(ok).toBe(true);
    const [row] = getInteractionsByChangeset("cs-eq");
    // Both keying columns present after one write.
    expect(row.worktreePath).toBe("/wt/alpha");
    expect(row.changesetId).toBe("cs-eq");
    expect(row.agentQueueStatus).toBe("pending");
  });

  it("returns false when the id does not exist", () => {
    expect(enqueueToWorktree("no-such-id", "/wt/alpha")).toBe(false);
  });
});

describe("unenqueueFromWorktree", () => {
  it("clears worktree_path and agent_queue_status back to null", () => {
    upsertInteraction(makeIx({ id: "uneq-1", changesetId: "cs-uneq" }));
    enqueueToWorktree("uneq-1", "/wt/beta");
    const ok = unenqueueFromWorktree("uneq-1");
    expect(ok).toBe(true);
    const [row] = getInteractionsByChangeset("cs-uneq");
    // Row still exists — it's a valid review interaction.
    expect(row.id).toBe("uneq-1");
    expect(row.worktreePath).toBeNull();
    expect(row.agentQueueStatus).toBeNull();
  });

  it("returns false when the id does not exist", () => {
    expect(unenqueueFromWorktree("ghost")).toBe(false);
  });

  it("returns false and leaves row delivered when called on a delivered row", () => {
    upsertInteraction(makeIx({ id: "uneq-delivered", changesetId: "cs-uneq-d" }));
    enqueueToWorktree("uneq-delivered", "/wt/delivered-test");
    pullAndAck("/wt/delivered-test"); // now delivered

    const ok = unenqueueFromWorktree("uneq-delivered");
    expect(ok).toBe(false);

    // Row must still be delivered — un-enqueuing a delivered row is a no-op.
    const [row] = getInteractionsByChangeset("cs-uneq-d");
    expect(row.agentQueueStatus).toBe("delivered");
    expect(row.worktreePath).toBe("/wt/delivered-test");
  });
});

describe("pullAndAck", () => {
  it("flips pending→delivered and returns the rows", () => {
    upsertInteraction(makeIx({ id: "p1", changesetId: "cs-p", createdAt: "2026-01-01T00:00:00.000Z" }));
    upsertInteraction(makeIx({ id: "p2", changesetId: "cs-p", createdAt: "2026-01-01T00:00:01.000Z" }));
    enqueueToWorktree("p1", "/wt/gamma");
    enqueueToWorktree("p2", "/wt/gamma");

    const pulled = pullAndAck("/wt/gamma");
    expect(pulled.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(pulled.every((r) => r.agentQueueStatus === "delivered")).toBe(true);
  });

  it("returns empty array when no pending rows", () => {
    expect(pullAndAck("/wt/nobody")).toEqual([]);
  });

  it("is transactional: a second pullAndAck immediately after returns []", () => {
    upsertInteraction(makeIx({ id: "tx-1", changesetId: "cs-tx" }));
    enqueueToWorktree("tx-1", "/wt/delta");

    const first = pullAndAck("/wt/delta");
    expect(first).toHaveLength(1);

    // Already delivered — second pull finds nothing pending.
    const second = pullAndAck("/wt/delta");
    expect(second).toEqual([]);
  });

  it("does not pull rows belonging to a different worktree", () => {
    upsertInteraction(makeIx({ id: "wt-a", changesetId: "cs-wt" }));
    upsertInteraction(makeIx({ id: "wt-b", changesetId: "cs-wt" }));
    enqueueToWorktree("wt-a", "/wt/one");
    enqueueToWorktree("wt-b", "/wt/two");

    const pulled = pullAndAck("/wt/one");
    expect(pulled.map((r) => r.id)).toEqual(["wt-a"]);
  });
});

describe("listByQueueStatus", () => {
  it("returns only delivered rows for [\"delivered\"]", () => {
    upsertInteraction(makeIx({ id: "ld-1", changesetId: "cs-ld", createdAt: "2026-01-01T00:00:00.000Z" }));
    upsertInteraction(makeIx({ id: "ld-2", changesetId: "cs-ld", createdAt: "2026-01-01T00:00:01.000Z" }));
    upsertInteraction(makeIx({ id: "ld-pending", changesetId: "cs-ld", createdAt: "2026-01-01T00:00:02.000Z" }));
    enqueueToWorktree("ld-1", "/wt/epsilon");
    enqueueToWorktree("ld-2", "/wt/epsilon");
    enqueueToWorktree("ld-pending", "/wt/epsilon");
    pullAndAck("/wt/epsilon");
    enqueueToWorktree("ld-pending", "/wt/epsilon"); // re-enqueue → pending again

    const delivered = listByQueueStatus("/wt/epsilon", ["delivered"]);
    expect(delivered.map((r) => r.id)).toEqual(["ld-1", "ld-2"]);
    expect(delivered.every((r) => r.agentQueueStatus === "delivered")).toBe(true);
  });

  it("returns pending + delivered for [\"pending\", \"delivered\"], sorted created_at, id", () => {
    upsertInteraction(makeIx({ id: "b", changesetId: "cs-all", createdAt: "2026-01-01T00:00:01.000Z" }));
    upsertInteraction(makeIx({ id: "a", changesetId: "cs-all", createdAt: "2026-01-01T00:00:00.000Z" }));
    upsertInteraction(makeIx({ id: "c", changesetId: "cs-all", createdAt: "2026-01-01T00:00:02.000Z" }));
    enqueueToWorktree("a", "/wt/all");
    enqueueToWorktree("b", "/wt/all");
    enqueueToWorktree("c", "/wt/all");
    pullAndAck("/wt/all"); // a, b, c → delivered
    upsertInteraction(makeIx({ id: "d", changesetId: "cs-all", createdAt: "2026-01-01T00:00:03.000Z" }));
    enqueueToWorktree("d", "/wt/all"); // d stays pending

    const rows = listByQueueStatus("/wt/all", ["pending", "delivered"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("is read-only — does not ack pending rows", () => {
    upsertInteraction(makeIx({ id: "ro-1", changesetId: "cs-ro" }));
    enqueueToWorktree("ro-1", "/wt/ro");

    listByQueueStatus("/wt/ro", ["pending", "delivered"]);

    const [row] = getInteractionsByChangeset("cs-ro");
    expect(row.agentQueueStatus).toBe("pending");
  });

  it("returns empty array when nothing matches", () => {
    expect(listByQueueStatus("/wt/empty", ["delivered"])).toEqual([]);
  });

  it("returns [] for an empty statuses array without querying", () => {
    upsertInteraction(makeIx({ id: "es-1", changesetId: "cs-es" }));
    enqueueToWorktree("es-1", "/wt/es");

    expect(listByQueueStatus("/wt/es", [])).toEqual([]);
  });

  it("does not return rows belonging to a different worktree", () => {
    upsertInteraction(makeIx({ id: "iso-a", changesetId: "cs-iso" }));
    upsertInteraction(makeIx({ id: "iso-b", changesetId: "cs-iso" }));
    enqueueToWorktree("iso-a", "/wt/iso-a");
    enqueueToWorktree("iso-b", "/wt/iso-b");

    const rows = listByQueueStatus("/wt/iso-a", ["pending", "delivered"]);
    expect(rows.map((r) => r.id)).toEqual(["iso-a"]);
  });
});

describe("postAgentInteraction", () => {
  it("writes an author_role=agent row", () => {
    postAgentInteraction({
      id: "ag-1",
      worktreePath: "/wt/eta",
      threadKey: null,
      target: "reply",
      intent: "ack",
      author: "agent-x",
      body: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { parentId: "p1" },
    });

    const replies = listAgentReplies("/wt/eta");
    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBe("ag-1");
    expect(replies[0].authorRole).toBe("agent");
    expect(replies[0].worktreePath).toBe("/wt/eta");
    expect(replies[0].payload).toEqual({ parentId: "p1" });
    // Agent rows have null changeset.
    expect(replies[0].changesetId).toBeNull();
    // postAgentInteraction hardcodes null — not part of the pull lifecycle.
    expect(replies[0].agentQueueStatus).toBeNull();
    // No authorId supplied — defaults to null.
    expect(replies[0].authorId).toBeNull();
  });

  it("round-trips authorId when supplied", () => {
    postAgentInteraction({
      id: "ag-au",
      worktreePath: "/wt/eta",
      threadKey: null,
      target: "reply",
      intent: "ack",
      author: "agent-x",
      body: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { parentId: "p1" },
      authorId: "u-agent-caller",
    });

    const [reply] = listAgentReplies("/wt/eta");
    expect(reply.authorId).toBe("u-agent-caller");
  });
});

describe("listAgentReplies", () => {
  it("returns only agent rows for the given worktree", () => {
    postAgentInteraction({
      id: "ag-wt1",
      worktreePath: "/wt/iota",
      threadKey: null,
      target: "reply",
      intent: "accept",
      author: "bot",
      body: "accepted",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {},
    });
    postAgentInteraction({
      id: "ag-wt2",
      worktreePath: "/wt/kappa",
      threadKey: null,
      target: "line",
      intent: "comment",
      author: "bot",
      body: "found something",
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: { file: "a.ts", lines: "10" },
    });

    const iotaReplies = listAgentReplies("/wt/iota");
    expect(iotaReplies.map((r) => r.id)).toEqual(["ag-wt1"]);

    const kappaReplies = listAgentReplies("/wt/kappa");
    expect(kappaReplies.map((r) => r.id)).toEqual(["ag-wt2"]);
  });

  it("returns rows sorted oldest-first by created_at, id", () => {
    postAgentInteraction({
      id: "late",
      worktreePath: "/wt/lambda",
      threadKey: null, target: "reply", intent: "ack", author: "bot",
      body: "b", createdAt: "2026-01-01T00:00:02.000Z", payload: {},
    });
    postAgentInteraction({
      id: "early",
      worktreePath: "/wt/lambda",
      threadKey: null, target: "reply", intent: "ack", author: "bot",
      body: "a", createdAt: "2026-01-01T00:00:00.000Z", payload: {},
    });

    const rows = listAgentReplies("/wt/lambda");
    expect(rows.map((r) => r.id)).toEqual(["early", "late"]);
  });
});

describe("interactionExistsForWorktree", () => {
  it("returns true for a delivered interaction", () => {
    upsertInteraction(makeIx({ id: "chk-1", changesetId: "cs-chk" }));
    enqueueToWorktree("chk-1", "/wt/mu");
    pullAndAck("/wt/mu");

    expect(interactionExistsForWorktree("/wt/mu", "chk-1")).toBe(true);
  });

  it("returns true for a pending (not yet delivered) interaction", () => {
    upsertInteraction(makeIx({ id: "chk-2", changesetId: "cs-chk2" }));
    enqueueToWorktree("chk-2", "/wt/nu");

    expect(interactionExistsForWorktree("/wt/nu", "chk-2")).toBe(true);
  });

  it("returns true for an agent-authored interaction", () => {
    postAgentInteraction({
      id: "chk-agent",
      worktreePath: "/wt/rho",
      threadKey: null,
      target: "line",
      intent: "comment",
      author: "agent",
      body: "agent finding",
      createdAt: new Date().toISOString(),
      payload: { file: "f.ts", lines: "1" },
    });

    expect(interactionExistsForWorktree("/wt/rho", "chk-agent")).toBe(true);
  });

  it("returns false for an unknown id", () => {
    expect(interactionExistsForWorktree("/wt/xi", "no-such")).toBe(false);
  });

  it("returns false for an interaction belonging to a different worktree", () => {
    upsertInteraction(makeIx({ id: "chk-3", changesetId: "cs-chk3" }));
    enqueueToWorktree("chk-3", "/wt/sigma");

    expect(interactionExistsForWorktree("/wt/other", "chk-3")).toBe(false);
  });
});
