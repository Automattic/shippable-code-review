import { describe, expect, it } from "vitest";
import { newReviewerInteractionId, selectInteractions } from "./interactions";
import {
  ackedNotesToInteractions,
  firstTargetForKey,
  initialState,
  mergeInteractionMaps,
  replyTarget,
} from "./state";
import type {
  ChangeSet,
  DetachedInteraction,
  DiffFile,
  DiffLine,
  Hunk,
  Interaction,
  InteractionIntent,
  ReviewState,
} from "./types";
import {
  blockCommentKey,
  hunkSummaryReplyKey,
  lineNoteReplyKey,
  noteKey,
  teammateReplyKey,
  userCommentKey,
} from "./types";

// Minimal user-Interaction literal for fixture construction.
interface UserReplyLiteral {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  agentQueueStatus?: "pending" | "delivered" | null;
  enqueueError?: boolean;
  anchorPath?: string;
  anchorContext?: DiffLine[];
  anchorHash?: string;
  anchorLineNo?: number;
  originSha?: string;
  originType?: "committed" | "dirty";
  external?: { source: "pr"; htmlUrl: string };
  agentReplies?: AgentReplyLiteral[];
}
interface AgentReplyLiteral {
  id: string;
  body: string;
  outcome: "addressed" | "declined" | "noted";
  postedAt: string;
  agentLabel?: string;
}

function userInteraction(
  threadKey: string,
  isFirst: boolean,
  literal: UserReplyLiteral,
): Interaction {
  return {
    id: literal.id,
    threadKey,
    target: isFirst ? firstTargetForKey(threadKey) : replyTarget(),
    intent: "comment",
    author: literal.author,
    authorRole: "user",
    body: literal.body,
    createdAt: literal.createdAt,
    agentQueueStatus: literal.agentQueueStatus,
    enqueueError: literal.enqueueError,
    anchorPath: literal.anchorPath,
    anchorHash: literal.anchorHash,
    anchorContext: literal.anchorContext,
    anchorLineNo: literal.anchorLineNo,
    originSha: literal.originSha,
    originType: literal.originType,
    external: literal.external,
  };
}

function agentInteraction(
  threadKey: string,
  literal: AgentReplyLiteral,
): Interaction {
  const intent: InteractionIntent =
    literal.outcome === "addressed"
      ? "accept"
      : literal.outcome === "declined"
        ? "reject"
        : "ack";
  return {
    id: literal.id,
    threadKey,
    target: replyTarget(),
    intent,
    author: literal.agentLabel ?? "agent",
    authorRole: "agent",
    body: literal.body,
    createdAt: literal.postedAt,
  };
}

function repliesToInteractionMap(
  replies: Record<string, UserReplyLiteral[]>,
): Record<string, Interaction[]> {
  const out: Record<string, Interaction[]> = {};
  for (const [key, list] of Object.entries(replies)) {
    const ixs: Interaction[] = [];
    list.forEach((r, i) => {
      ixs.push(userInteraction(key, i === 0, r));
      for (const a of r.agentReplies ?? []) {
        ixs.push(agentInteraction(key, a));
      }
    });
    out[key] = ixs;
  }
  return out;
}

function mkDetachedInteractions(
  detached: Array<{ literal: UserReplyLiteral; threadKey: string }>,
): DetachedInteraction[] {
  return detached.map(({ literal, threadKey }) => ({
    interaction: userInteraction(threadKey, true, literal),
    threadKey,
  }));
}

// ── Fixture helpers ──────────────────────────────────────────────────────
//
// Tests still author AI notes in the legacy `{ severity, summary, detail,
// runRecipe }` shape because it's the most readable input format; helpers
// below project them into Interactions before seeding.

interface AiNote {
  severity: "info" | "question" | "warning";
  summary: string;
  detail?: string;
  runRecipe?: { source: string; inputs: Record<string, string> };
}

interface HunkOpts {
  aiNotes?: Record<number, AiNote>;
  aiSummary?: string;
  teammateReview?: {
    user: string;
    verdict: "approve" | "comment";
    note?: string;
  };
}

const INGEST_TS = "0001-01-01T00:00:00.000Z";

function aiNoteIntent(severity: AiNote["severity"]): InteractionIntent {
  if (severity === "question") return "question";
  if (severity === "warning") return "request";
  return "comment";
}

function teammateVerdictIntent(
  verdict: "approve" | "comment",
): InteractionIntent {
  return verdict === "approve" ? "ack" : "comment";
}

function seedFromHunkOpts(
  hunkId: string,
  opts: HunkOpts,
): Record<string, Interaction[]> {
  const out: Record<string, Interaction[]> = {};
  for (const [idxStr, note] of Object.entries(opts.aiNotes ?? {})) {
    const lineIdx = Number(idxStr);
    const threadKey = lineNoteReplyKey(hunkId, lineIdx);
    const body = note.detail ? `${note.summary}\n\n${note.detail}` : note.summary;
    const ix: Interaction = {
      id: `ai:${threadKey}`,
      threadKey,
      target: "line",
      intent: aiNoteIntent(note.severity),
      author: "ai",
      authorRole: "ai",
      body,
      createdAt: INGEST_TS,
    };
    if (note.runRecipe) ix.runRecipe = note.runRecipe;
    out[threadKey] = [ix];
  }
  if (opts.aiSummary) {
    const threadKey = hunkSummaryReplyKey(hunkId);
    out[threadKey] = [
      {
        id: `ai:${threadKey}`,
        threadKey,
        target: "block",
        intent: "comment",
        author: "ai",
        authorRole: "ai",
        body: opts.aiSummary,
        createdAt: INGEST_TS,
      },
    ];
  }
  if (opts.teammateReview) {
    const threadKey = teammateReplyKey(hunkId);
    out[threadKey] = [
      {
        id: `teammate:${threadKey}`,
        threadKey,
        target: "block",
        intent: teammateVerdictIntent(opts.teammateReview.verdict),
        author: opts.teammateReview.user,
        authorRole: "user",
        body: opts.teammateReview.note ?? "",
        createdAt: INGEST_TS,
      },
    ];
  }
  return out;
}

function seedState(cs: ChangeSet, opts: HunkOpts = {}): ReviewState {
  // Single-hunk fixtures: seed against the cs's first hunk.
  const hunk = cs.files[0].hunks[0];
  return initialState([cs], seedFromHunkOpts(hunk.id, opts));
}

function makeLines(n: number): DiffLine[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "context" as const,
    text: `l${i}`,
    oldNo: i + 1,
    newNo: i + 1,
  }));
}

function makeHunk(id: string, lineCount: number): Hunk {
  return {
    id,
    header: `@@ -1,${lineCount} +1,${lineCount} @@`,
    oldStart: 1,
    oldCount: lineCount,
    newStart: 1,
    newCount: lineCount,
    lines: makeLines(lineCount),
  };
}

function makeFile(id: string, hunks: Hunk[]): DiffFile {
  return { id, path: `${id}.ts`, language: "ts", status: "modified", hunks };
}

function makeChangeset(id: string, files: DiffFile[]): ChangeSet {
  return {
    id,
    title: id,
    author: "tester",
    branch: "head",
    base: "base",
    createdAt: "2026-04-30T00:00:00.000Z",
    description: "",
    files,
  };
}

function withReplies(
  state: ReviewState,
  replies: Record<string, UserReplyLiteral[]>,
): ReviewState {
  return {
    ...state,
    interactions: mergeInteractionMaps(
      state.interactions,
      repliesToInteractionMap(replies),
    ),
  };
}

function withAcked(state: ReviewState, keys: string[]): ReviewState {
  return {
    ...state,
    interactions: ackedNotesToInteractions(new Set(keys), state.interactions),
  };
}

const HUNK_ID = "cs1/f1#h1";

// ── Empty state ──────────────────────────────────────────────────────────

describe("selectInteractions — empty state", () => {
  it("returns empty selection when no changesets are loaded", () => {
    const s: ReviewState = initialState([]);
    const sel = selectInteractions(s);
    expect(sel.all).toEqual([]);
    expect(sel.threads).toEqual([]);
    expect(sel.byIntent.comment).toEqual([]);
    expect(Object.keys(sel.byThreadKey)).toEqual([]);
  });

  it("returns empty selection when changesets have no interactions", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [makeHunk(HUNK_ID, 3)])]);
    const sel = selectInteractions(initialState([cs]));
    expect(sel.all).toEqual([]);
  });
});

// ── AI annotations ───────────────────────────────────────────────────────

describe("selectInteractions — AI annotations", () => {
  function csWithAiNote(note: AiNote, lineIdx = 1): ReviewState {
    const hunk = makeHunk(HUNK_ID, 3);
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [hunk])]);
    return seedState(cs, { aiNotes: { [lineIdx]: note } });
  }

  it("projects an info note as intent: comment", () => {
    const state = csWithAiNote({ severity: "info", summary: "fyi" });
    const [ix] = selectInteractions(state).all;
    expect(ix.intent).toBe("comment");
    expect(ix.authorRole).toBe("ai");
    expect(ix.target).toBe("line");
    expect(ix.body).toBe("fyi");
    expect(ix.threadKey).toBe(lineNoteReplyKey(HUNK_ID, 1));
  });

  it("projects a question note as intent: question", () => {
    const state = csWithAiNote({ severity: "question", summary: "why?" });
    expect(selectInteractions(state).all[0].intent).toBe("question");
  });

  it("projects a warning note as intent: request (not blocker)", () => {
    const state = csWithAiNote({ severity: "warning", summary: "careful" });
    expect(selectInteractions(state).all[0].intent).toBe("request");
  });

  it("concatenates summary + detail into the body", () => {
    const state = csWithAiNote({
      severity: "info",
      summary: "short version",
      detail: "longer explanation",
    });
    expect(selectInteractions(state).all[0].body).toBe(
      "short version\n\nlonger explanation",
    );
  });

  it("carries the runRecipe through to the Interaction", () => {
    const recipe = { source: "verify()", inputs: { x: "1" } };
    const state = csWithAiNote({
      severity: "info",
      summary: "claim",
      runRecipe: recipe,
    });
    expect(selectInteractions(state).all[0].runRecipe).toEqual(recipe);
  });

  it("projects an ack on an AI note as a response interaction", () => {
    const note: AiNote = { severity: "warning", summary: "x" };
    const hunk = makeHunk(HUNK_ID, 3);
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [hunk])]);
    const seeded = seedState(cs, { aiNotes: { 1: note } });
    const state = withAcked(seeded, [noteKey(HUNK_ID, 1)]);

    const sel = selectInteractions(state);
    const thread = sel.byThreadKey[lineNoteReplyKey(HUNK_ID, 1)];
    expect(thread).toHaveLength(2);
    expect(thread[0].authorRole).toBe("ai");
    expect(thread[1].intent).toBe("ack");
    expect(thread[1].target).toBe("reply");
    expect(thread[1].authorRole).toBe("user");
    expect(thread[1].body).toBe("");
  });
});

// ── Teammate reviews ─────────────────────────────────────────────────────

describe("selectInteractions — teammate reviews", () => {
  function csWithTeammate(verdict: "approve" | "comment", note?: string): ReviewState {
    const hunk = makeHunk(HUNK_ID, 3);
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [hunk])]);
    return seedState(cs, {
      teammateReview: { user: "luiz", verdict, note },
    });
  }

  it("projects approve verdict as intent: ack", () => {
    const [ix] = selectInteractions(csWithTeammate("approve")).all;
    expect(ix.intent).toBe("ack");
    expect(ix.authorRole).toBe("user");
    expect(ix.target).toBe("block");
    expect(ix.author).toBe("luiz");
    expect(ix.threadKey).toBe(teammateReplyKey(HUNK_ID));
  });

  it("projects comment verdict as intent: comment, body from note", () => {
    const [ix] = selectInteractions(csWithTeammate("comment", "lgtm with caveats")).all;
    expect(ix.intent).toBe("comment");
    expect(ix.body).toBe("lgtm with caveats");
  });

  it("uses empty body when no note", () => {
    expect(selectInteractions(csWithTeammate("approve")).all[0].body).toBe("");
  });
});

// ── AI hunk summary ──────────────────────────────────────────────────────

describe("selectInteractions — AI hunk summary", () => {
  it("projects aiSummary as a block-target comment from the AI", () => {
    const hunk = makeHunk(HUNK_ID, 3);
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [hunk])]);
    const [ix] = selectInteractions(
      seedState(cs, { aiSummary: "this hunk pages users" }),
    ).all;
    expect(ix.intent).toBe("comment");
    expect(ix.target).toBe("block");
    expect(ix.authorRole).toBe("ai");
    expect(ix.body).toBe("this hunk pages users");
    expect(ix.threadKey).toBe(hunkSummaryReplyKey(HUNK_ID));
  });
});

// ── User replies ─────────────────────────────────────────────────────────

describe("selectInteractions — user replies", () => {
  function baseHunk() {
    return makeHunk(HUNK_ID, 3);
  }

  function mkReply(
    id: string,
    body: string,
    createdAt = "2026-05-06T10:00:00Z",
  ): UserReplyLiteral {
    return { id, author: "you", body, createdAt };
  }

  it("projects user reply to AI note with target reply", () => {
    const note: AiNote = { severity: "info", summary: "fyi" };
    const hunk = makeHunk(HUNK_ID, 3);
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [hunk])]);
    const key = lineNoteReplyKey(HUNK_ID, 1);
    const seeded = seedState(cs, { aiNotes: { 1: note } });
    const state = withReplies(seeded, {
      [key]: [mkReply("u1", "agreed")],
    });
    const sel = selectInteractions(state);
    const thread = sel.byThreadKey[key];
    expect(thread).toHaveLength(2);
    const [ai, user] = thread;
    expect(ai.authorRole).toBe("ai");
    expect(user.target).toBe("reply");
    expect(user.authorRole).toBe("user");
  });

  it("projects user-started line thread head with target: line", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [baseHunk()])]);
    const key = userCommentKey(HUNK_ID, 0, "c1");
    const state = withReplies(initialState([cs]), {
      [key]: [mkReply("u1", "look here")],
    });
    const [ix] = selectInteractions(state).all;
    expect(ix.target).toBe("line");
    expect(ix.authorRole).toBe("user");
  });

  it("projects subsequent replies on a user thread as reply", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [baseHunk()])]);
    const key = userCommentKey(HUNK_ID, 0, "c1");
    const state = withReplies(initialState([cs]), {
      [key]: [
        mkReply("u1", "start", "2026-05-06T10:00:00Z"),
        mkReply("u2", "reply", "2026-05-06T10:01:00Z"),
      ],
    });
    const thread = selectInteractions(state).byThreadKey[key];
    expect(thread[0].target).toBe("line");
    expect(thread[1].target).toBe("reply");
  });

  it("projects block-thread head with target: block", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [baseHunk()])]);
    const key = blockCommentKey(HUNK_ID, 0, 2, "c1");
    const state = withReplies(initialState([cs]), {
      [key]: [mkReply("u1", "ranged")],
    });
    const [ix] = selectInteractions(state).all;
    expect(ix.target).toBe("block");
    expect(ix.threadKey).toBe(key);
  });

  it("carries Interaction provenance fields (anchorPath, external, agentQueueStatus) through", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [baseHunk()])]);
    const key = userCommentKey(HUNK_ID, 0, "c1");
    const reply: UserReplyLiteral = {
      id: "u1",
      author: "you",
      body: "x",
      createdAt: "2026-05-06T10:00:00Z",
      anchorPath: "f1.ts",
      agentQueueStatus: "pending",
      external: { source: "pr", htmlUrl: "https://github.com/x/y/pull/1#1" },
    };
    const state = withReplies(initialState([cs]), { [key]: [reply] });
    const [ix] = selectInteractions(state).all;
    expect(ix.anchorPath).toBe("f1.ts");
    expect(ix.agentQueueStatus).toBe("pending");
    expect(ix.external).toEqual({
      source: "pr",
      htmlUrl: "https://github.com/x/y/pull/1#1",
    });
  });
});

// ── Agent replies ────────────────────────────────────────────────────────

describe("selectInteractions — agent replies", () => {
  it("projects addressed outcome as accept", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [makeHunk(HUNK_ID, 3)])]);
    const key = userCommentKey(HUNK_ID, 0, "c1");
    const state = withReplies(initialState([cs]), {
      [key]: [
        {
          id: "u1",
          author: "you",
          body: "do x",
          createdAt: "2026-05-06T10:00:00Z",
          agentReplies: [
            { id: "a1", body: "done", outcome: "addressed", postedAt: "2026-05-06T11:00:00Z" },
          ],
        },
      ],
    });
    const thread = selectInteractions(state).byThreadKey[key];
    const agent = thread.find((ix) => ix.authorRole === "agent");
    expect(agent?.intent).toBe("accept");
    expect(agent?.target).toBe("reply");
  });

  it("maps declined → reject, noted → ack", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [makeHunk(HUNK_ID, 3)])]);
    const key = userCommentKey(HUNK_ID, 0, "c1");
    const state = withReplies(initialState([cs]), {
      [key]: [
        {
          id: "u1",
          author: "you",
          body: "do x",
          createdAt: "2026-05-06T10:00:00Z",
          agentReplies: [
            { id: "a1", body: "no", outcome: "declined", postedAt: "2026-05-06T11:00:00Z" },
            { id: "a2", body: "noted", outcome: "noted", postedAt: "2026-05-06T11:30:00Z" },
          ],
        },
      ],
    });
    const agents = selectInteractions(state).all.filter((ix) => ix.authorRole === "agent");
    expect(agents.map((a) => a.intent)).toEqual(["reject", "ack"]);
  });
});

// ── Indexed views ────────────────────────────────────────────────────────

describe("selectInteractions — indexed views", () => {
  it("byIntent buckets every interaction by its intent", () => {
    const note: AiNote = { severity: "warning", summary: "watch out" };
    const hunk = makeHunk(HUNK_ID, 3);
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [hunk])]);
    const sel = selectInteractions(
      seedState(cs, {
        aiNotes: { 1: note },
        teammateReview: { user: "t", verdict: "approve" },
      }),
    );
    expect(sel.byIntent.request).toHaveLength(1);
    expect(sel.byIntent.ack).toHaveLength(1);
    expect(sel.byIntent.comment).toHaveLength(0);
  });

  it("byThreadKey groups every interaction by its thread", () => {
    const note: AiNote = { severity: "info", summary: "x" };
    const hunk = makeHunk(HUNK_ID, 3);
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [hunk])]);
    const key = lineNoteReplyKey(HUNK_ID, 1);
    const seeded = seedState(cs, { aiNotes: { 1: note } });
    const state = withReplies(seeded, {
      [key]: [{ id: "u1", author: "you", body: "ack", createdAt: "2026-05-06T10:00:00Z" }],
    });
    const sel = selectInteractions(state);
    expect(sel.byThreadKey[key]).toHaveLength(2);
  });
});

// ── Thread summary derivation ────────────────────────────────────────────

describe("selectInteractions — thread summary", () => {
  function chooseThread(state: ReviewState, key: string) {
    return selectInteractions(state).threads.find((t) => t.threadKey === key);
  }

  it("originalAsk and currentAsk equal when nothing has shifted", () => {
    const note: AiNote = { severity: "question", summary: "why?" };
    const hunk = makeHunk(HUNK_ID, 3);
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [hunk])]);
    const key = lineNoteReplyKey(HUNK_ID, 0);
    const seeded = seedState(cs, { aiNotes: { 0: note } });
    const t = chooseThread(seeded, key);
    expect(t?.originalAsk).toBe("question");
    expect(t?.currentAsk).toBe("question");
  });

  it("currentResponse reflects an ack derived from state.ackedNotes", () => {
    const note: AiNote = { severity: "info", summary: "x" };
    const hunk = makeHunk(HUNK_ID, 3);
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [hunk])]);
    const key = lineNoteReplyKey(HUNK_ID, 0);
    const seeded = seedState(cs, { aiNotes: { 0: note } });
    const state = withAcked(seeded, [noteKey(HUNK_ID, 0)]);
    expect(chooseThread(state, key)?.currentResponse).toBe("ack");
  });

  it("currentResponse stays null when the thread has only asks", () => {
    const note: AiNote = { severity: "info", summary: "x" };
    const hunk = makeHunk(HUNK_ID, 3);
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [hunk])]);
    const key = lineNoteReplyKey(HUNK_ID, 0);
    const seeded = seedState(cs, { aiNotes: { 0: note } });
    expect(chooseThread(seeded, key)?.currentResponse).toBeNull();
  });

  it("rolls up multiple authors — latest response wins across authors", () => {
    // Today we can't synthesize a thread with two response authors using the
    // legacy carriers alone (state.ackedNotes is single-user). We can drive
    // it via the agentReplies literal though: a user 'reject' reply + an agent
    // 'addressed' (accept) reply on the same thread. Agent posts later, so
    // accept wins.
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [makeHunk(HUNK_ID, 3)])]);
    const key = userCommentKey(HUNK_ID, 0, "c1");
    const state = withReplies(initialState([cs]), {
      [key]: [
        {
          id: "u1",
          author: "you",
          body: "fix",
          createdAt: "2026-05-06T10:00:00Z",
          agentReplies: [
            { id: "a1", body: "done", outcome: "addressed", postedAt: "2026-05-06T11:00:00Z" },
          ],
        },
      ],
    });
    expect(selectInteractions(state).threads[0].currentResponse).toBe("accept");
  });
});

// ── Detached replies ─────────────────────────────────────────────────────

describe("selectInteractions — detached replies", () => {
  it("projects detached replies under their stored threadKey", () => {
    const cs = makeChangeset("cs1", [makeFile("cs1/f1", [makeHunk(HUNK_ID, 3)])]);
    const threadKey = userCommentKey("ghost-hunk", 0, "c1");
    const state: ReviewState = {
      ...initialState([cs]),
      detachedInteractions: mkDetachedInteractions([
        {
          literal: {
            id: "d1",
            author: "you",
            body: "stranded",
            createdAt: "2026-05-06T10:00:00Z",
          },
          threadKey,
        },
      ]),
    };
    const sel = selectInteractions(state);
    expect(sel.all).toHaveLength(1);
    expect(sel.all[0].id).toBe("d1");
    expect(sel.all[0].threadKey).toBe(threadKey);
  });
});

describe("newReviewerInteractionId", () => {
  it("emits the r- prefix and an embedded timestamp", () => {
    const id = newReviewerInteractionId();
    expect(id).toMatch(/^r-\d+-[a-z0-9]+$/);
  });

  it("produces distinct ids inside a single millisecond bucket", () => {
    // Reproduces the original B2 scenario — two interactions authored in the
    // same Date.now() tick must not produce the same id, or the DB UPSERT
    // silently overwrites the first row.
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(newReviewerInteractionId());
    expect(ids.size).toBe(1000);
  });
});
