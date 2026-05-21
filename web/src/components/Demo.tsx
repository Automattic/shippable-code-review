import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CS_42, INTERACTIONS_42 } from "../fixtures/cs-42-preferences";
import { CS_72, INTERACTIONS_72 } from "../fixtures/cs-72-docs-preview";
import { CS_91 } from "../fixtures/cs-91-agent-flow";
import {
  ackedNotesToInteractions,
  buildCommentStops,
  changesetCoverage,
  firstTargetForKey,
  initialState,
  mergeInteractionMaps,
  reducer,
  replyTarget,
  reviewedFilesCount,
  selectAckedNotes,
} from "../state";
import { planReview } from "../plan";
import { applyThemeToRoot, type ThemeId } from "../tokens";
import { buildReplyAnchor } from "../anchor";
import { Sidebar } from "./Sidebar";
import { DiffView } from "./DiffView";
import { Inspector } from "./Inspector";
import { StatusBar } from "./StatusBar";
import { ReviewPlanView } from "./ReviewPlanView";
import { GuidePrompt } from "./GuidePrompt";
import { HelpOverlay } from "./HelpOverlay";
import { LoadModal } from "./LoadModal";
import { CodeRunner } from "./CodeRunner";
import { CredentialsPanel } from "./CredentialsPanel";
import { CredentialsProvider } from "../auth/useCredentials";
import { PromptPicker } from "./PromptPicker";
import { PromptEditor } from "./PromptEditor";
import { type PromptRunView } from "./PromptRunsPanel";
import { ThemePicker } from "./ThemePicker";
import "./Welcome.css";
import {
  buildDiffViewModel,
  buildGuidePromptViewModel,
  buildInspectorViewModel,
  buildSidebarViewModel,
  buildStatusBarViewModel,
} from "../view";
import { selectIngestSignals } from "../interactions";
import { buildSymbolIndex, type SymbolIndex } from "../symbols";
import { maybeSuggest } from "../guide";
import { buildAutoFillContext, type Prompt } from "../promptStore";
import { runPrompt } from "../promptRun";
import { KEYMAP } from "../keymap";
import { buildRepoCodeGraph } from "../codeGraph";
import type { RecentEntry } from "../recents";
import {
  blockCommentKey,
  lineNoteReplyKey,
  mintCommentId,
  noteKey,
  userCommentKey,
  type AgentContextSlice,
  type Cursor,
  type DeliveredInteraction,
  type EvidenceRef,
  type Interaction,
  type ReviewState,
  type ChangeSet,
} from "../types";
import type { AgentContextProps } from "./Inspector";
import "./Demo.css";

const CS = CS_42;
const PREVIEW_CS = CS_72;
const AGENT_CS = CS_91;
const USER_FILE = CS.files[0];
const PREF_FILE = CS.files.find(
  (f) => f.path === "src/components/PreferencesPanel.tsx",
)!;
const STORAGE_FILE = CS.files.find((f) => f.path === "src/utils/storage.ts")!;
const PREVIEW_FILE = PREVIEW_CS.files[0];
const AGENT_QUEUE_FILE = AGENT_CS.files[0];

const DEMO_INLINE_SOURCE =
  "function clamp(value, min, max) {\n" +
  "  return Math.min(max, Math.max(min, value));\n" +
  "}\n" +
  "clamp(42, 0, 10);\n";

const DEMO_LIBRARY_PROMPTS = [
  {
    id: "review-this-hunk",
    name: "Review this hunk",
    description: "Look for risk, edge cases, and missing tests in the current selection.",
    args: [{ name: "selection", required: true, auto: "selection" }],
    body: "Review this diff hunk like a skeptical senior engineer:\n\n{{selection}}",
  },
  {
    id: "security-review",
    name: "Security review",
    description: "Focus on auth, input validation, and unsafe data flow.",
    args: [
      { name: "selection", required: true, auto: "selection" },
      { name: "file", required: false, auto: "file" },
    ],
    body:
      "Review this code for security issues.\n\n{{selection}}\n{{#file}}File: {{file}}{{/file}}",
  },
];

const DEMO_USER_PROMPT = {
  id: "business-risk-pass",
  name: "Business risk pass",
  description: "Call out rollout, support, and migration risk.",
  args: [
    { name: "selection", required: true, auto: "selection" },
    { name: "title", required: false, auto: "changeset.title" },
  ],
  body:
    "Change: {{title}}\n\nAssess business risk in this selection:\n{{selection}}",
};

const DEMO_PROMPT_RUNS: PromptRunView[] = [
  {
    id: "demo-run-1",
    promptName: "Business risk pass",
    status: "done",
    text:
      "Rollout risk is low because this is local-only UI state, but malformed saved prefs still need sanitizing before apply.",
  },
  {
    id: "demo-run-2",
    promptName: "Security review",
    status: "streaming",
    text:
      "Two reviewer-relevant concerns so far:\n\n1. localStorage JSON is trusted as-is.\n2. invalid theme values can flow straight into controlled UI state.",
  },
];

const DEMO_WORKTREE_DIR = "/Users/you/code/shippable";
const DEMO_WORKTREES = [
  {
    path: `${DEMO_WORKTREE_DIR}`,
    branch: "main",
    head: "7251d27c8630d6a2fd8b14b8d3bb4a46f5117a20",
    isMain: true,
  },
  {
    path: `${DEMO_WORKTREE_DIR}-preview-mode`,
    branch: "docs/preview-mode",
    head: "682b0b7ac12a52dd44ef1203b89cbf0cb9bc2d61",
    isMain: false,
  },
  {
    path: `${DEMO_WORKTREE_DIR}-prompt-lab`,
    branch: "feat/prompt-library",
    head: "9bda200f4d77f9832c9fd0d8be0bb4c03d0bc7ab",
    isMain: false,
  },
  {
    // Path matches CS_91.worktreeSource.worktreePath so the agent-context
    // panel renders for the trailing agent-integration frames.
    path: `${DEMO_WORKTREE_DIR}-agent-flow`,
    branch: AGENT_CS.branch,
    head: AGENT_CS.worktreeSource!.commitSha,
    isMain: false,
  },
];

const DEMO_RECENTS: RecentEntry[] = [
  {
    id: PREVIEW_CS.id,
    title: PREVIEW_CS.title,
    addedAt: Date.parse("2026-05-04T15:20:00Z"),
    source: {
      kind: "worktree",
      path: DEMO_WORKTREES[1].path,
      branch: DEMO_WORKTREES[1].branch,
    },
    changeset: PREVIEW_CS,
  },
  {
    id: CS.id,
    title: CS.title,
    addedAt: Date.parse("2026-05-04T11:05:00Z"),
    source: { kind: "paste" },
    changeset: CS,
  },
];

type Overlay =
  | { kind: "none" }
  | { kind: "plan" }
  | { kind: "help" }
  | { kind: "load" }
  | { kind: "promptPicker" }
  | { kind: "runnerInline"; source: string }
  | { kind: "runnerFree" };

interface BaseFrame {
  caption: string;
  themeId?: ThemeId;
  durationMs?: number;
}

interface WorkspaceFrame extends BaseFrame {
  kind: "workspace";
  state: ReviewState;
  overlay: Overlay;
  showGuide?: boolean;
  showInspector?: boolean;
  showSidebar?: boolean;
  sidebarWide?: boolean;
  seedRuns?: PromptRunView[];
  /**
   * Synthetic agent-context bundle for frames that exercise the
   * agent-integration surface. Present only on the agent-flow frames; absent
   * frames render Inspector without the agent panel (current behavior).
   * Drives the Delivered (N) block — pip glyphs come from each Interaction's
   * own `id` matched against `delivered`, plus its `agentQueueStatus`.
   */
  agentSnapshot?: AgentSnapshot;
  /**
   * Optional fake-CLI overlay for the agent-integration frames. Static —
   * each frame supplies the fully-populated content it wants visible.
   */
  agentCli?: AgentCliContent;
}

interface AgentSnapshot {
  slice: AgentContextSlice | null;
  delivered: DeliveredInteraction[];
}

/**
 * A fake agent terminal overlay rendered on the agent-integration frames so
 * the round-trip is visible as concrete tool calls instead of just a
 * caption. Static — frames swap in fully populated content; no typewriter
 * animation. See `AgentCli` below.
 */
type AgentCliLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; tool: string; args?: string; result?: string };

interface AgentCliContent {
  title?: string;
  lines: AgentCliLine[];
}

interface WelcomeFrame extends BaseFrame {
  kind: "welcome";
}

interface KeySetupFrame extends BaseFrame {
  kind: "keySetup";
  saved?: boolean;
}

interface PromptEditorFrame extends BaseFrame {
  kind: "promptEditor";
}

type Frame = WorkspaceFrame | WelcomeFrame | KeySetupFrame | PromptEditorFrame;

// ── frame state helpers ───────────────────────────────────────────────────

function ingestFor(cs: ChangeSet): Record<string, Interaction[]> {
  if (cs.id === CS.id) return INTERACTIONS_42;
  if (cs.id === PREVIEW_CS.id) return INTERACTIONS_72;
  return {};
}

function fresh(cs: ChangeSet = CS): ReviewState {
  return {
    ...initialState([cs]),
    interactions: ingestFor(cs),
  };
}

function withCursor(
  state: ReviewState,
  fileId: string,
  hunkId: string,
  lineIdx: number,
): ReviewState {
  const currentCs = state.changesets[0];
  return {
    ...state,
    cursor: { changesetId: currentCs.id, fileId, hunkId, lineIdx },
  };
}

function makeContextExpandedState(): ReviewState {
  const hunk = USER_FILE.hunks[0];
  return {
    ...fresh(),
    cursor: {
      changesetId: CS.id,
      fileId: USER_FILE.id,
      hunkId: hunk.id,
      lineIdx: 7,
    },
    expandLevelAbove: { [hunk.id]: 2 },
    expandLevelBelow: { [hunk.id]: 2 },
  };
}

function makeFullFileState(): ReviewState {
  const hunk = USER_FILE.hunks[0];
  return {
    ...fresh(),
    cursor: {
      changesetId: CS.id,
      fileId: USER_FILE.id,
      hunkId: hunk.id,
      lineIdx: 0,
    },
    fullExpandedFiles: new Set([USER_FILE.id]),
  };
}

function makePreviewState(): ReviewState {
  return {
    ...fresh(PREVIEW_CS),
    cursor: {
      changesetId: PREVIEW_CS.id,
      fileId: PREVIEW_FILE.id,
      hunkId: PREVIEW_FILE.hunks[0].id,
      lineIdx: 0,
    },
    previewedFiles: new Set([PREVIEW_FILE.id]),
  };
}

function readRequestJson(init?: RequestInit): Record<string, unknown> {
  if (!init?.body || typeof init.body !== "string") return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function linePrefix(kind: "context" | "add" | "del"): string {
  return kind === "add" ? "+" : kind === "del" ? "-" : " ";
}

function changesetToDiff(cs: ChangeSet): string {
  const parts: string[] = [];
  for (const file of cs.files) {
    parts.push(`diff --git a/${file.path} b/${file.path}`);
    if (file.status === "added") parts.push("new file mode 100644");
    if (file.status === "deleted") parts.push("deleted file mode 100644");
    parts.push(file.status === "added" ? "--- /dev/null" : `--- a/${file.path}`);
    parts.push(file.status === "deleted" ? "+++ /dev/null" : `+++ b/${file.path}`);
    for (const h of file.hunks) {
      parts.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
      for (const l of h.lines) {
        parts.push(`${linePrefix(l.kind)}${l.text}`);
      }
    }
  }
  return parts.join("\n");
}

function buildFileContents(cs: ChangeSet): Record<string, string> | undefined {
  const entries = cs.files
    .filter((file) => file.fullContent && file.fullContent.length > 0)
    .map((file) => [
      file.path,
      file.fullContent!.map((line) => line.text).join("\n"),
    ] as const);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function buildGraphSources(cs: ChangeSet): Array<{ path: string; text: string }> {
  return cs.files.map((file) => ({
    path: file.path,
    text: file.fullContent?.map((line) => line.text).join("\n")
      ?? file.hunks
        .flatMap((hunk) => hunk.lines.filter((line) => line.kind !== "del"))
        .map((line) => line.text)
        .join("\n"),
  }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installDemoMocks() {
  const win = window as Window & {
    __shippableDemoFetchInstalled?: boolean;
    __shippableDemoOriginalFetch?: typeof window.fetch;
  };
  if (win.__shippableDemoFetchInstalled) return;
  win.__shippableDemoFetchInstalled = true;
  win.__shippableDemoOriginalFetch = window.fetch.bind(window);

  localStorage.setItem(
    "shippable.prompts.user",
    JSON.stringify([DEMO_USER_PROMPT]),
  );

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/health")) {
      return jsonResponse({ ok: true });
    }
    if (url.endsWith("/api/library/prompts")) {
      return jsonResponse({ prompts: DEMO_LIBRARY_PROMPTS });
    }
    if (url.endsWith("/api/worktrees/pick-directory")) {
      return jsonResponse({ path: DEMO_WORKTREE_DIR });
    }
    if (url.endsWith("/api/worktrees/list")) {
      return jsonResponse({ worktrees: DEMO_WORKTREES });
    }
    if (url.endsWith("/api/worktrees/changeset")) {
      const req = readRequestJson(init);
      const path = typeof req.path === "string" ? req.path : DEMO_WORKTREES[0].path;
      const wt = DEMO_WORKTREES.find((item) => item.path === path) ?? DEMO_WORKTREES[0];
      const cs =
        wt.path === DEMO_WORKTREES[1].path
          ? PREVIEW_CS
          : wt.path === DEMO_WORKTREES[3].path
            ? AGENT_CS
            : CS;
      return jsonResponse({
        diff: changesetToDiff(cs),
        sha: wt.head,
        subject: cs.title,
        author: cs.author,
        date: cs.createdAt,
        branch: wt.branch,
        fileContents: buildFileContents(cs),
      });
    }
    if (url.endsWith("/api/worktrees/graph")) {
      const req = readRequestJson(init);
      const path = typeof req.path === "string" ? req.path : DEMO_WORKTREES[0].path;
      const wt = DEMO_WORKTREES.find((item) => item.path === path) ?? DEMO_WORKTREES[0];
      const cs =
        wt.path === DEMO_WORKTREES[1].path
          ? PREVIEW_CS
          : wt.path === DEMO_WORKTREES[3].path
            ? AGENT_CS
            : CS;
      return jsonResponse({ graph: buildRepoCodeGraph(buildGraphSources(cs)) });
    }
    if (url.endsWith("/api/code-graph")) {
      // Demo runs without a real LSP; serve the regex-built graph so
      // fetchDiffCodeGraph resolves without hitting the network. The demo
      // path stays regex-only by design.
      const req = readRequestJson(init);
      const path = typeof req.workspaceRoot === "string" ? req.workspaceRoot : DEMO_WORKTREES[0].path;
      const wt = DEMO_WORKTREES.find((item) => item.path === path) ?? DEMO_WORKTREES[0];
      const cs = wt.path === DEMO_WORKTREES[1].path ? PREVIEW_CS : CS;
      return jsonResponse({
        graph: buildRepoCodeGraph(buildGraphSources(cs)),
        sources: [],
      });
    }
    if (url.endsWith("/api/plan")) {
      const req = readRequestJson(init);
      const requested = req.changeset as ChangeSet | undefined;
      return jsonResponse({ plan: planReview(requested ?? CS) });
    }
    return win.__shippableDemoOriginalFetch!(input, init);
  };
}

// ── frames ────────────────────────────────────────────────────────────────

function buildFrames(): Frame[] {
  const PREF_H1 = PREF_FILE.hunks[0];
  const STORAGE_H1 = STORAGE_FILE.hunks[0];
  const STORAGE_H2 = STORAGE_FILE.hunks[1];
  const AGENT_H1 = AGENT_QUEUE_FILE.hunks[0];

  // ── agent-integration segment (four trailing frames) ────────────────────
  // Walks the round-trip: comments queue → ◌ pip → agent fetches → ✓ pip +
  // Delivered (N) → agent posts structured replies (addressed / declined)
  // that thread under each comment. WorkspaceStage does not run the polling
  // hook, so the lifecycle is expressed as plain seeded state per frame;
  // the synthetic agent-context bundle is built from each frame's
  // `agentSnapshot`. The fixture has no AI notes so both reviewer comments
  // surface in the inspector's "Your comments" section, side-by-side with
  // their agent replies.

  const AGENT_LINE1_LINE_IDX = 1;  // the new `import { assertGitDir }`
  const AGENT_LINE2_LINE_IDX = 7;  // the silent-no-op guard

  const lineKey1 = userCommentKey(AGENT_H1.id, AGENT_LINE1_LINE_IDX, "c1");
  const lineKey2 = userCommentKey(AGENT_H1.id, AGENT_LINE2_LINE_IDX, "c2");

  const replyLine1: Interaction = {
    id: "demo-r-a1",
    threadKey: lineKey1,
    target: "line",
    intent: "comment",
    author: "you",
    authorRole: "user",
    body: "`assertGitDir` reads like it returns void — rename to `assertWorktreeIsGitDir`?",
    createdAt: "2026-05-06T10:01:30Z",
    agentQueueStatus: "pending",
  };
  const replyLine2: Interaction = {
    id: "demo-r-a2",
    threadKey: lineKey2,
    target: "line",
    intent: "comment",
    author: "you",
    authorRole: "user",
    body: "this should throw — `{ id: \"\" }` reads as success on the wire.",
    createdAt: "2026-05-06T10:02:10Z",
    agentQueueStatus: "pending",
  };
  const agentReplyLine1: Interaction = {
    id: "ar-1",
    threadKey: lineKey1,
    target: "reply",
    intent: "accept",
    author: "agent",
    authorRole: "agent",
    body: "Renamed to `assertWorktreeIsGitDir`; updated both call sites in `c8e21f9`.",
    createdAt: "2026-05-06T10:05:00Z",
  };
  const agentReplyLine2: Interaction = {
    id: "ar-2",
    threadKey: lineKey2,
    target: "reply",
    intent: "reject",
    author: "agent",
    authorRole: "agent",
    body: "Keeping the no-op — the route handler already shapes the 400 and the in-process caller relies on it. Noted in JSDoc.",
    createdAt: "2026-05-06T10:06:30Z",
  };

  const deliveredA1: DeliveredInteraction = {
    id: replyLine1.id,
    target: "line",
    intent: "comment",
    author: replyLine1.author,
    authorRole: "user",
    file: AGENT_QUEUE_FILE.path,
    lines: "4",
    body: replyLine1.body,
    commitSha: AGENT_CS.worktreeSource!.commitSha,
    supersedes: null,
    enqueuedAt: replyLine1.createdAt,
    deliveredAt: "2026-05-06T10:04:00Z",
  };
  const deliveredA2: DeliveredInteraction = {
    id: replyLine2.id,
    target: "line",
    intent: "comment",
    author: replyLine2.author,
    authorRole: "user",
    file: AGENT_QUEUE_FILE.path,
    lines: "10",
    body: replyLine2.body,
    commitSha: AGENT_CS.worktreeSource!.commitSha,
    supersedes: null,
    enqueuedAt: replyLine2.createdAt,
    deliveredAt: "2026-05-06T10:04:00Z",
  };

  // Matches the slice shape users actually see in the live tool: a session
  // ref + the bare footer ("N turns"), with the per-block sections collapsed
  // because the slice has no in-window messages, todos, or files-touched.
  // Faking a fully-populated slice was misleading.
  const agentSlice: AgentContextSlice = {
    session: {
      sessionId: "01HZ8M3K4P9X2YQ7B6N5T1V0WC",
      filePath: "~/.claude/projects/shippable-agent-flow/01HZ8M3K4P9X2YQ7B6N5T1V0WC.jsonl",
      startedAt: "2026-05-06T22:14:00Z",
      lastEventAt: "2026-05-06T22:31:00Z",
      taskTitle: "validate worktree path on agent enqueue",
      turnCount: 0,
      cwds: [AGENT_CS.worktreeSource!.worktreePath],
    },
    commitSha: AGENT_CS.worktreeSource!.commitSha,
    fromTime: null,
    toTime: "2026-05-06T22:31:00Z",
    task: null,
    followUps: [],
    todos: [],
    filesTouched: [],
    messages: [],
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
    model: null,
  };

  const agentBase = {
    ...initialState([AGENT_CS]),
    cursor: {
      changesetId: AGENT_CS.id,
      fileId: AGENT_QUEUE_FILE.id,
      hunkId: AGENT_H1.id,
      lineIdx: AGENT_LINE1_LINE_IDX,
    },
  };

  // Frame agent-1 — fresh worktree-loaded view, no comments yet.
  const fAgent1State: ReviewState = { ...agentBase };

  // Frame agent-2 — both line comments seeded with `agentQueueStatus:
  // "pending"` → both render the ◌ queued pip. No delivered ids yet.
  const fAgent2State: ReviewState = {
    ...agentBase,
    interactions: {
      [lineKey1]: [replyLine1],
      [lineKey2]: [replyLine2],
    },
  };

  // Frame agent-3 — agent fetches: same replies, but `delivered` carries
  // both so pips flip to ✓ and the panel shows Delivered (2).
  const fAgent3State: ReviewState = { ...fAgent2State };

  // Frame agent-4 — agent posts replies: accept on the rename, reject on
  // the throw-vs-silent-no-op call. Both visible in the same view because
  // the comments share a hunk.
  const fAgent4State: ReviewState = {
    ...agentBase,
    interactions: {
      [lineKey1]: [replyLine1, agentReplyLine1],
      [lineKey2]: [replyLine2, agentReplyLine2],
    },
  };

  const agentSnapshotEmpty: AgentSnapshot = { slice: agentSlice, delivered: [] };
  const agentSnapshotDelivered: AgentSnapshot = {
    slice: agentSlice,
    delivered: [deliveredA2, deliveredA1], // newest-first
  };

  // Fake terminal content for the delivered + replies frames. Static; the
  // replies frame appends to the delivered frame's transcript so the user
  // can see what was already there before scrolling shows the new lines.
  const reviewerFeedbackEnvelope =
    `<reviewer-feedback from="shippable" commit="a3c91d7e">\n` +
    `  <interaction id="cmt_a1" target="line" intent="request" author="@luiz" authorRole="user" file="server/src/agent-queue.ts" lines="4">\n` +
    `    \`assertGitDir\` reads like it returns void — rename to\n` +
    `    \`assertWorktreeIsGitDir\`?\n` +
    `  </interaction>\n` +
    `  <interaction id="cmt_a2" target="line" intent="blocker" author="@luiz" authorRole="user" file="server/src/agent-queue.ts" lines="10">\n` +
    `    this should throw — \`{ id: "" }\` reads as success on the wire.\n` +
    `  </interaction>\n` +
    `</reviewer-feedback>`;

  const cliFetchLines: AgentCliLine[] = [
    { kind: "user", text: "check shippable" },
    {
      kind: "tool",
      tool: "shippable_check_review_comments",
      result: reviewerFeedbackEnvelope,
    },
  ];

  const cliDelivered: AgentCliContent = {
    title: "agent · shippable-agent-flow",
    lines: cliFetchLines,
  };

  const cliReplies: AgentCliContent = {
    title: "agent · shippable-agent-flow",
    lines: [
      ...cliFetchLines,
      {
        kind: "assistant",
        text: "Two reviewer comments. I'll handle each.",
      },
      {
        kind: "tool",
        tool: "shippable_post_review_comment",
        args: "cmt_a1 · accept",
        result:
          "Renamed to `assertWorktreeIsGitDir`; updated both call sites in `c8e21f9`.",
      },
      {
        kind: "tool",
        tool: "shippable_post_review_comment",
        args: "cmt_a2 · reject",
        result:
          "Keeping the no-op — the route handler already shapes the 400 and the in-process caller relies on it. Noted in JSDoc.",
      },
      {
        kind: "assistant",
        text:
          "Renamed and pushed `c8e21f9`. Kept the no-op for now and explained the contract in JSDoc.",
      },
    ],
  };

  // 5 — ack the note at line 14, plus a user reply on the note at line 21.
  const lineNote21 = lineNoteReplyKey(PREF_H1.id, 21);
  const f5State = withCursor(
    {
      ...fresh(),
      interactions: ackedNotesToInteractions(
        new Set([noteKey(PREF_H1.id, 14)]),
        mergeInteractionMaps(INTERACTIONS_42, {
          [lineNote21]: [
            {
              id: "demo-r1",
              threadKey: lineNote21,
              target: "reply",
              intent: "comment",
              author: "you",
              authorRole: "user",
              body: "Good catch — I'll add a useCallback before merging.",
              createdAt: "2026-04-30T10:00:00Z",
            },
          ],
        }),
      ),
    },
    PREF_FILE.id,
    PREF_H1.id,
    21,
  );

  // 6 — block selection across the try/catch in storage.ts#h2.
  const BLOCK_LO = 6;
  const BLOCK_HI = 11;
  const blockKey = blockCommentKey(STORAGE_H2.id, BLOCK_LO, BLOCK_HI, "c1");
  const f6State: ReviewState = {
    ...fresh(),
    cursor: {
      changesetId: CS.id,
      fileId: STORAGE_FILE.id,
      hunkId: STORAGE_H2.id,
      lineIdx: BLOCK_HI,
    },
    selection: { hunkId: STORAGE_H2.id, anchor: BLOCK_LO, head: BLOCK_HI },
    interactions: mergeInteractionMaps(INTERACTIONS_42, {
      [blockKey]: [
        {
          id: "demo-block",
          threadKey: blockKey,
          target: "block",
          intent: "comment",
          author: "dan",
          authorRole: "user",
          body: "The whole try/catch reads cleaner as a parse-and-validate helper.",
          createdAt: "2026-04-30T11:00:00Z",
        },
      ],
    }),
  };

  // 7 — storage.ts read end-to-end + signed off.
  const f7Read: Record<string, Set<number>> = {};
  for (const h of STORAGE_FILE.hunks) {
    f7Read[h.id] = new Set(
      Array.from({ length: h.lines.length }, (_, i) => i),
    );
  }
  const f7State: ReviewState = {
    ...fresh(),
    cursor: {
      changesetId: CS.id,
      fileId: STORAGE_FILE.id,
      hunkId: STORAGE_H1.id,
      lineIdx: 0,
    },
    readLines: f7Read,
    reviewedFiles: new Set([STORAGE_FILE.id]),
  };

  return [
    {
      kind: "welcome",
      caption: "start from a recent review or scan local worktrees",
      themeId: "light",
      durationMs: 8500,
    },
    {
      kind: "workspace",
      caption: "plan mode answers where do I begin?",
      themeId: "light",
      durationMs: 9000,
      state: fresh(),
      overlay: { kind: "plan" },
    },
    {
      kind: "workspace",
      caption: "go to the recommended starting point",
      state: withCursor(fresh(), PREF_FILE.id, PREF_H1.id, 0),
      overlay: { kind: "none" },
    },
    {
      kind: "workspace",
      caption: "AI notes are top of mind",
      state: withCursor(fresh(), PREF_FILE.id, PREF_H1.id, 14),
      overlay: { kind: "none" },
    },
    {
      kind: "workspace",
      caption: "ack to dismiss, reply to start a thread",
      state: f5State,
      overlay: { kind: "none" },
    },
    {
      kind: "workspace",
      caption: "comment a block of code",
      state: f6State,
      overlay: { kind: "none" },
    },
    {
      kind: "workspace",
      caption: "expand just enough surrounding context before you zoom out",
      state: makeContextExpandedState(),
      overlay: { kind: "none" },
      showInspector: false,
    },
    {
      kind: "workspace",
      caption: "flip from review hunks to the full post-change file",
      state: makeFullFileState(),
      overlay: { kind: "none" },
      showInspector: false,
    },
    {
      kind: "workspace",
      caption: "markdown diffs can switch into rendered preview mode",
      state: makePreviewState(),
      overlay: { kind: "none" },
      showInspector: false,
    },
    {
      kind: "workspace",
      caption: "Shift+M signs off; the topbar plan chip tracks progress",
      state: f7State,
      overlay: { kind: "none" },
    },
    {
      kind: "workspace",
      caption: "prompt output stays in the sidebar instead of covering the diff",
      state: withCursor(fresh(), PREF_FILE.id, PREF_H1.id, 14),
      overlay: { kind: "none" },
      seedRuns: DEMO_PROMPT_RUNS,
      sidebarWide: true,
    },
    {
      kind: "workspace",
      caption: "press f to hide the file list and focus on the diff",
      state: withCursor(fresh(), PREF_FILE.id, PREF_H1.id, 14),
      overlay: { kind: "none" },
      showSidebar: false,
    },
    {
      kind: "workspace",
      caption: "run any saved prompt against the current context",
      state: withCursor(fresh(), PREF_FILE.id, PREF_H1.id, 14),
      overlay: { kind: "promptPicker" },
    },
    {
      kind: "promptEditor",
      caption: "fork built-ins or edit your own prompts with live preview",
    },
    {
      kind: "workspace",
      caption: "quick checks without leaving the diff",
      state: withCursor(fresh(), STORAGE_FILE.id, STORAGE_H1.id, 0),
      overlay: { kind: "runnerInline", source: DEMO_INLINE_SOURCE },
    },
    {
      kind: "workspace",
      caption: "scratch space for one-off snippets",
      state: withCursor(fresh(), STORAGE_FILE.id, STORAGE_H1.id, 0),
      overlay: { kind: "runnerFree" },
    },
    {
      kind: "workspace",
      caption: "review any change",
      state: fresh(),
      overlay: { kind: "load" },
    },
    {
      kind: "workspace",
      caption:
        "the guide nudges you toward related changes you haven't read",
      state: withCursor(fresh(), PREF_FILE.id, PREF_H1.id, 1),
      overlay: { kind: "none" },
      showGuide: true,
    },
    {
      kind: "workspace",
      caption: "everything is keyboard-driven; ? is the cheat sheet",
      state: fresh(),
      overlay: { kind: "help" },
    },
    {
      kind: "keySetup",
      caption: "desktop mode asks for an API key only when AI features need it",
      durationMs: 7000,
    },
    {
      kind: "workspace",
      caption: "open from a worktree; the inspector tracks your agent's session",
      durationMs: 6500,
      state: fAgent1State,
      overlay: { kind: "none" },
      showInspector: true,
      agentSnapshot: agentSnapshotEmpty,
    },
    {
      kind: "workspace",
      caption: "every comment queues for your agent — ◌ means it hasn't fetched yet",
      durationMs: 7500,
      state: fAgent2State,
      overlay: { kind: "none" },
      showInspector: true,
      agentSnapshot: agentSnapshotEmpty,
    },
    {
      kind: "workspace",
      caption: "your agent ran check shippable — pips flip to ✓ and Delivered logs the pull",
      durationMs: 7500,
      state: fAgent3State,
      overlay: { kind: "none" },
      showInspector: true,
      agentSnapshot: agentSnapshotDelivered,
      agentCli: cliDelivered,
    },
    {
      kind: "workspace",
      caption: "replies thread under each comment — ✓ addressed, ⊘ declined",
      durationMs: 8500,
      state: fAgent4State,
      overlay: { kind: "none" },
      showInspector: true,
      agentSnapshot: agentSnapshotDelivered,
      agentCli: cliReplies,
    },
    {
      kind: "workspace",
      caption: "we also have themes :)",
      durationMs: 6000,
      state: fresh(),
      overlay: { kind: "none" },
    },
  ];
}

// ── component ─────────────────────────────────────────────────────────────

function DemoFrame({
  frame,
  themeId,
  onPickTheme,
}: {
  frame: Frame;
  themeId: ThemeId;
  onPickTheme: (id: ThemeId) => void;
}) {
  if (frame.kind === "welcome") {
    return <WelcomeStage />;
  }
  if (frame.kind === "keySetup") {
    return <KeySetupStage />;
  }
  if (frame.kind === "promptEditor") {
    return <PromptEditorStage />;
  }
  return (
    <WorkspaceStage
      frame={frame}
      themeId={themeId}
      onPickTheme={onPickTheme}
    />
  );
}

function WelcomeStage() {
  return (
    <div className="demo__app welcome">
      <div className="welcome__top">
        <span className="welcome__brand">shippable</span>
        <span className="welcome__sep">│</span>
        <span className="welcome__sub">
          prototype — review a diff to get started
        </span>
      </div>

      <div className="welcome__body">
        <section className="welcome__recents">
          <h2 className="welcome__sec-h">Recent</h2>
          <ul className="welcome__recents-list">
            {DEMO_RECENTS.map((recent) => (
              <li key={recent.id}>
                <button type="button" className="welcome__recent">
                  <span className="welcome__recent-title">{recent.title}</span>
                  <span className="welcome__recent-meta">
                    {recent.source.kind === "worktree"
                      ? recent.source.branch
                      : recent.source.kind}{" "}
                    · recent
                  </span>
                  <span className="welcome__recent-x" aria-hidden="true">
                    ×
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="welcome__hero welcome__wt">
          <h1 className="welcome__hero-h">Open a local branch</h1>
          <p className="welcome__hero-sub">
            Choose a repo root or worktrees folder. Shippable scans it and
            loads the latest committed diff from the worktree you pick.
          </p>
          <div className="welcome__wt-actions">
            <button className="welcome__btn welcome__btn--primary">
              choose folder…
            </button>
            <button className="welcome__btn">rescan</button>
            <button className="welcome__btn">paste path instead</button>
          </div>
          <div className="welcome__wt-picked">
            Current folder: <code>{DEMO_WORKTREE_DIR}</code>
          </div>
          <ul className="welcome__wt-list modal__wt-list">
            {DEMO_WORKTREES.map((wt) => (
              <li key={wt.path}>
                <button type="button" className="modal__wt-row">
                  <span className="modal__wt-branch">
                    {wt.branch ?? "(detached)"}
                    {wt.isMain && <span className="modal__wt-tag"> main</span>}
                  </span>
                  <span className="modal__wt-path">{wt.path}</span>
                  <span className="modal__wt-head">{wt.head.slice(0, 7)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function KeySetupStage() {
  return (
    <div className="demo__app demo__center-stage">
      <CredentialsProvider>
        <CredentialsPanel mode="boot" />
      </CredentialsProvider>
    </div>
  );
}

function PromptEditorStage() {
  return (
    <div className="demo__app demo__center-stage">
      <div className="demo__editor-shell modal__box">
        <header className="modal__h">
          <span className="modal__h-label">edit prompt</span>
          <button className="modal__close" type="button">
            × close
          </button>
        </header>
        <PromptEditor
          initial={{ ...DEMO_USER_PROMPT, source: "user" }}
          context={buildAutoFillContext(CS, PREF_FILE, PREF_FILE.hunks[0], null)}
          onSaved={() => {}}
          onCancel={() => {}}
          onDeleted={() => {}}
        />
      </div>
    </div>
  );
}

export function Demo() {
  installDemoMocks();
  const frames = useMemo(() => buildFrames(), []);
  const [idx, setIdx] = useState(0);
  // Demo opens paused so a recorder can frame the shot before hitting Play —
  // matches the gallery's play mode.
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState(false);
  // Initial theme matches the opening frame; the theme demo at the end
  // still animates to dollhouse once playback reaches it.
  const [themeId, setThemeId] = useState<ThemeId>("light");
  // Buttons hide entirely when false — for clean recording. The caption +
  // text stay visible. Toggle with Ctrl/⌘+. or the × button.
  const [controlsVisible, setControlsVisible] = useState(true);

  const current = frames[idx];
  const dur = current.durationMs ?? 6500;
  const themeDemoIdx = frames.length - 1;

  // Theme reacts to the active frame *only while playing*. When paused the
  // viewer can change themes manually without us snapping back. Done via
  // the during-render "adjust state when prop changes" pattern so we don't
  // cascade renders through an effect.
  const [trackedFrame, setTrackedFrame] = useState({ playing, idx });
  if (trackedFrame.playing !== playing || trackedFrame.idx !== idx) {
    setTrackedFrame({ playing, idx });
    if (playing) {
      if (idx === themeDemoIdx) setThemeId("light");
      else if (current.themeId) setThemeId(current.themeId);
    }
  }

  // The dollhouse animation on the theme-showcase frame still needs an
  // effect because it schedules a setTimeout — the setState inside the
  // callback is async, not a synchronous cascade.
  useEffect(() => {
    if (!playing || idx !== themeDemoIdx) return;
    const t = setTimeout(() => setThemeId("dollhouse"), 3000);
    return () => clearTimeout(t);
  }, [playing, idx, themeDemoIdx]);

  useEffect(() => {
    applyThemeToRoot(document.documentElement, themeId);
  }, [themeId]);

  // Auto-advance. Hovering the stage pauses, so people can read.
  useEffect(() => {
    if (!playing || hover) return;
    const t = setTimeout(
      () => setIdx((i) => (i + 1) % frames.length),
      dur,
    );
    return () => clearTimeout(t);
  }, [idx, playing, hover, dur, frames.length]);

  // Stepping with prev/next implies "I want this to be playing" — matches
  // the gallery's play mode so the user can scrub without first hitting Play.
  const goPrev = () => {
    setIdx((i) => (i - 1 + frames.length) % frames.length);
    if (!playing) setPlaying(true);
  };
  const goNext = () => {
    setIdx((i) => (i + 1) % frames.length);
    if (!playing) setPlaying(true);
  };

  // Demo-level shortcuts. All gated on Ctrl or ⌘ so they never collide with
  // the live app's single-key bindings (j/k/c/r/etc.) inside WorkspaceStage.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          setPlaying((p) => !p);
          break;
        case "ArrowLeft":
          e.preventDefault();
          goPrev();
          break;
        case "ArrowRight":
          e.preventDefault();
          goNext();
          break;
        case ".":
          e.preventDefault();
          setControlsVisible((v) => !v);
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // goPrev / goNext are referentially fresh each render but we want them
    // to read the latest `playing` — listing those deps captures it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, frames.length]);

  return (
    <div
      className="demo"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <DemoFrame
        key={idx}
        frame={current}
        themeId={themeId}
        onPickTheme={setThemeId}
      />
      <div
        className="demo__caption"
        role="status"
        aria-live="polite"
      >
        {controlsVisible && (
          <span className="demo__caption-num">
            {idx + 1} / {frames.length}
          </span>
        )}
        <span className="demo__caption-text">{current.caption}</span>
      </div>
      {controlsVisible && (
        <div className="demo__controls" role="group" aria-label="Demo playback">
          <button
            type="button"
            className="demo__btn"
            onClick={goPrev}
            title="Previous frame (⌃ ←)"
            aria-label="Previous frame"
          >
            ◀ prev
          </button>
          <button
            type="button"
            className={
              "demo__btn demo__btn--primary" +
              (playing ? " demo__btn--active" : "")
            }
            onClick={() => setPlaying((p) => !p)}
            aria-pressed={playing}
            title={playing ? "Pause demo (⌃ Space)" : "Play demo (⌃ Space)"}
          >
            {playing ? "⏸ Pause" : "▶ Play"}
          </button>
          <button
            type="button"
            className="demo__btn"
            onClick={goNext}
            title="Next frame (⌃ →)"
            aria-label="Next frame"
          >
            next ▶
          </button>
          <span className="demo__counter">
            {idx + 1} / {frames.length}
          </span>
          {(hover || !playing) && (
            <span className="demo__paused-hint">paused</span>
          )}
          <button
            type="button"
            className="demo__btn demo__btn--ghost"
            onClick={() => setControlsVisible(false)}
            title="Hide controls (⌃ . to toggle)"
            aria-label="Hide controls"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// ── stage ─────────────────────────────────────────────────────────────────

function WorkspaceStage({
  frame,
  themeId,
  onPickTheme,
}: {
  frame: WorkspaceFrame;
  themeId: ThemeId;
  onPickTheme: (id: ThemeId) => void;
}) {
  const [state, dispatch] = useReducer(reducer, frame.state);

  // Composer + UI state mirrors App.tsx's local state. Each frame mounts a
  // fresh WorkspaceStage, so drafts are scoped to a frame's lifetime —
  // advancing and coming back resets them, which is what we want for a demo.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftingKey, setDraftingKey] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(
    frame.showInspector ?? true,
  );
  const [showSidebar, setShowSidebar] = useState(frame.showSidebar ?? true);

  // Per-frame modal visibility. Initial values are seeded from the frame's
  // declared overlay. The user can dismiss them and toggle via keyboard
  // like in the live app.
  const [showPlan, setShowPlan] = useState(frame.overlay.kind === "plan");
  const [showHelp, setShowHelp] = useState(frame.overlay.kind === "help");
  const [showLoad, setShowLoad] = useState(frame.overlay.kind === "load");
  const [showPicker, setShowPicker] = useState(
    frame.overlay.kind === "promptPicker",
  );
  const [freeRunnerOpen, setFreeRunnerOpen] = useState(
    frame.overlay.kind === "runnerFree",
  );

  const cs = state.changesets[0];
  const file = cs.files.find((f) => f.id === state.cursor.fileId)!;
  const hunk = file.hunks.find((h) => h.id === state.cursor.hunkId)!;
  const line = hunk.lines[state.cursor.lineIdx];
  const symbolIndex = useMemo(() => buildSymbolIndex(cs), [cs]);
  const demoIngestSignals = selectIngestSignals(state);
  const demoLineHasAiNote =
    !!demoIngestSignals.aiNoteByLine[
      `${state.cursor.hunkId}:${state.cursor.lineIdx}`
    ];
  const jumpTo = (c: Cursor) => dispatch({ type: "SET_CURSOR", cursor: c });

  // Synthetic agent-context bundle for the trailing agent-integration
  // frames. WorkspaceStage doesn't run the polling hook, so the bundle is
  // pure props built from the frame's snapshot. Frames without a snapshot
  // pass `undefined`, which keeps the Inspector's pre-existing behaviour
  // (no panel) intact for the rest of the reel.
  const agentContext = useMemo<AgentContextProps | undefined>(() => {
    const snap = frame.agentSnapshot;
    if (!snap) return undefined;
    return {
      slice: snap.slice,
      candidates: snap.slice ? [snap.slice.session] : [],
      selectedSessionFilePath: snap.slice?.session.filePath ?? null,
      loading: false,
      error: null,
      mcpStatus: { installed: true, installCommand: "claude mcp add shippable …" },
      delivered: snap.delivered,
      lastSuccessfulPollAt: new Date().toISOString(),
      deliveredError: false,
      watching: false,
      agentStartedThreads: [],
      onPickSession: () => {},
      onRefresh: () => {},
    };
  }, [frame.agentSnapshot]);

  // Demo runs without a server, so the plan overlay is seeded from the
  // rule-based fixture utility (the same path gallery-fixtures uses) and
  // presented as if Claude had already responded.
  const plan = useMemo(() => planReview(cs), [cs]);
  const planStatus = "ready" as const;
  const planError: string | undefined = undefined;
  const generatePlan = () => {};

  // Inline-runner request — populated when the frame seeds an inline runner,
  // and re-populated by the `e` keybinding (see RUN_SELECTION below).
  const [runRequest, setRunRequest] = useState<{
    tick: number;
    source: string;
    inputs?: Record<string, string>;
  } | null>(
    frame.overlay.kind === "runnerInline"
      ? { tick: 1, source: frame.overlay.source }
      : null,
  );

  // Prompt runs — real Claude streams from picker submits land here, and
  // the prompt-picker frame also seeds a fake-streaming demo run so the
  // populated even without a backend. Rendered in the sidebar panel.
  const [runs, setRuns] = useState<PromptRunView[]>(
    frame.overlay.kind === "promptPicker"
      ? [
          {
            id: "demo-run",
            promptName: "review-this-hunk",
            text: "",
            status: "streaming",
          },
        ]
      : (frame.seedRuns ?? []),
  );
  const [sidebarWide, setSidebarWide] = useState(frame.sidebarWide ?? false);
  const runControllersRef = useRef<Map<string, AbortController>>(new Map());
  useEffect(() => {
    if (frame.overlay.kind !== "promptPicker") return;
    const id = "demo-run";
    const full =
      "Three reviewer-relevant observations on this hunk:\n\n" +
      "1. DEFAULTS is declared inline — if SSR ever needs these you'll want a shared config module.\n" +
      "2. The useEffect runs after mount, so the first paint flashes the default theme before loadPrefs() resolves.\n" +
      "3. The form has no onSubmit handler — pressing Enter inside the select triggers a full-page submit.";
    let i = 0;
    const t = window.setInterval(() => {
      i = Math.min(full.length, i + 14);
      setRuns((prev) =>
        prev.map((r) =>
          r.id === id
            ? {
                ...r,
                text: full.slice(0, i),
                status: i >= full.length ? "done" : "streaming",
              }
            : r,
        ),
      );
      if (i >= full.length) window.clearInterval(t);
    }, 70);
    return () => window.clearInterval(t);
  }, [frame.overlay.kind]);

  function startPromptRun(prompt: Prompt, rendered: string) {
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    runControllersRef.current.set(id, controller);
    setRuns((prev) => [
      { id, promptName: prompt.name, text: "", status: "streaming" },
      ...prev,
    ]);
    setShowPicker(false);
    const patchRun = (patch: (r: PromptRunView) => PromptRunView) =>
      setRuns((prev) => prev.map((r) => (r.id === id ? patch(r) : r)));
    runPrompt(
      { text: rendered, signal: controller.signal },
      {
        onText: (chunk) =>
          patchRun((r) => ({ ...r, text: r.text + chunk })),
        onDone: () => {
          runControllersRef.current.delete(id);
          patchRun((r) => ({ ...r, status: "done" }));
        },
        onError: (msg) => {
          runControllersRef.current.delete(id);
          patchRun((r) => ({ ...r, status: "error", error: msg }));
        },
      },
    );
  }
  function closePromptRun(id: string) {
    runControllersRef.current.get(id)?.abort();
    runControllersRef.current.delete(id);
    setRuns((prev) => prev.filter((r) => r.id !== id));
  }

  const fileIdx = cs.files.findIndex((f) => f.id === file.id);
  const hunkIdx = file.hunks.findIndex((h) => h.id === hunk.id);
  const readCoverage = changesetCoverage(cs, state.readLines);
  const reviewedFiles = reviewedFilesCount(cs, state.reviewedFiles);
  // The guide always renders when the underlying state has a suggestion,
  // matching the live app. `frame.showGuide` is no longer needed as a force-
  // flag — the cursor-on-import seed for frame 12 triggers it naturally.
  const suggestion = maybeSuggest(cs, state);
  const guideViewModel = suggestion
    ? buildGuidePromptViewModel(suggestion, symbolIndex, cs.id)
    : null;

  // Single source of truth for the new-comment thread key — a block key
  // when a multi-line selection is live on the cursor's hunk, a line key
  // otherwise. Each call mints a fresh id so every "+ comment" / `c`
  // press opens its own thread.
  const newCommentKey = useCallback((): string => {
    const sel = state.selection;
    return sel && sel.hunkId === state.cursor.hunkId && sel.anchor !== sel.head
      ? blockCommentKey(
          sel.hunkId,
          Math.min(sel.anchor, sel.head),
          Math.max(sel.anchor, sel.head),
          mintCommentId(),
        )
      : userCommentKey(
          state.cursor.hunkId,
          state.cursor.lineIdx,
          mintCommentId(),
        );
  }, [state.selection, state.cursor]);

  const planDone = plan.entryPoints.filter((e) =>
    state.reviewedFiles.has(e.fileId),
  ).length;
  const planTotal = plan.entryPoints.length;

  const selectionForBar =
    state.selection && state.selection.hunkId === hunk.id
      ? (() => {
          const lo = Math.min(state.selection.anchor, state.selection.head);
          const hi = Math.max(state.selection.anchor, state.selection.head);
          return {
            lo,
            hi,
            loLineNo:
              hunk.lines[lo]?.newNo ?? hunk.lines[lo]?.oldNo ?? lo + 1,
            hiLineNo:
              hunk.lines[hi]?.newNo ?? hunk.lines[hi]?.oldNo ?? hi + 1,
          };
        })()
      : null;

  // Keyboard handler — ported from App.tsx so the demo accepts the same
  // shortcuts a presenter would naturally reach for. Skipped: changeset
  // cycling ([ / ]) since the demo is single-changeset.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showHelp && e.key !== "?" && e.key !== "Escape") return;
      if (showPlan && !["p", "?", "Escape"].includes(e.key)) return;
      if (showPicker && e.key !== "Escape") return;

      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Tab" && tgt && tgt !== document.body) return;

      const predicates: Record<string, boolean> = {
        hasSuggestion: !!suggestion,
        lineHasAiNote: demoLineHasAiNote,
        hasSelection: !!state.selection,
        hasPlan: showPlan,
        hasPicker: showPicker,
        hasChangesetToken: false,
      };

      const entry = KEYMAP.find(
        (km) =>
          km.key === e.key &&
          (km.shift === undefined ? true : km.shift === e.shiftKey) &&
          (km.when === undefined ? true : predicates[km.when]),
      );
      if (!entry) return;
      e.preventDefault();

      const preserveSelection = draftingKey?.startsWith("block:") ?? false;

      switch (entry.action) {
        case "MOVE_LINE_DOWN":
          dispatch({ type: "MOVE_LINE", delta: 1, preserveSelection });
          break;
        case "MOVE_LINE_UP":
          dispatch({ type: "MOVE_LINE", delta: -1, preserveSelection });
          break;
        case "MOVE_LINE_DOWN_EXTEND":
          dispatch({ type: "MOVE_LINE", delta: 1, extend: true });
          break;
        case "MOVE_LINE_UP_EXTEND":
          dispatch({ type: "MOVE_LINE", delta: -1, extend: true });
          break;
        case "COLLAPSE_SELECTION":
          dispatch({ type: "COLLAPSE_SELECTION" });
          break;
        case "MOVE_HUNK_DOWN":
          dispatch({ type: "MOVE_HUNK", delta: 1 });
          break;
        case "MOVE_HUNK_UP":
          dispatch({ type: "MOVE_HUNK", delta: -1 });
          break;
        case "MOVE_FILE_NEXT":
          dispatch({ type: "MOVE_FILE", delta: 1 });
          break;
        case "MOVE_FILE_PREV":
          dispatch({ type: "MOVE_FILE", delta: -1 });
          break;
        case "TOGGLE_HELP":
          setShowHelp((v) => !v);
          break;
        case "TOGGLE_INSPECTOR":
          setShowInspector((v) => !v);
          break;
        case "TOGGLE_SIDEBAR":
          setShowSidebar((v) => !v);
          break;
        case "TOGGLE_PLAN":
          setShowPlan((v) => !v);
          break;
        case "CLOSE_PLAN":
          setShowPlan(false);
          break;
        case "TOGGLE_ACK":
          dispatch({
            type: "TOGGLE_ACK",
            hunkId: state.cursor.hunkId,
            lineIdx: state.cursor.lineIdx,
          });
          break;
        case "TOGGLE_FILE_REVIEWED":
          dispatch({
            type: "TOGGLE_FILE_REVIEWED",
            fileId: state.cursor.fileId,
          });
          break;
        case "START_REPLY":
          setDraftingKey(
            lineNoteReplyKey(state.cursor.hunkId, state.cursor.lineIdx),
          );
          setShowInspector(true);
          break;
        case "START_COMMENT":
          setDraftingKey(newCommentKey());
          setShowInspector(true);
          break;
        case "ACCEPT_GUIDE": {
          if (!suggestion) break;
          dispatch({
            type: "SET_CURSOR",
            cursor: {
              changesetId: state.cursor.changesetId,
              fileId: suggestion.toFileId,
              hunkId: suggestion.toHunkId,
              lineIdx: suggestion.toLineIdx,
            },
          });
          break;
        }
        case "DISMISS_GUIDE":
          if (suggestion) {
            dispatch({ type: "DISMISS_GUIDE", guideId: suggestion.id });
          }
          break;
        case "CLOSE_HELP":
          if (showHelp) setShowHelp(false);
          break;
        case "OPEN_LOAD":
          setShowLoad(true);
          break;
        case "OPEN_RUNNER":
          setFreeRunnerOpen(true);
          break;
        case "OPEN_PROMPT_PICKER":
          setShowPicker((v) => !v);
          break;
        case "CLOSE_PROMPT_PICKER":
          setShowPicker(false);
          break;
        case "RUN_SELECTION": {
          const sel2 = state.selection;
          const lines =
            sel2 && sel2.hunkId === hunk.id
              ? hunk.lines.slice(
                  Math.min(sel2.anchor, sel2.head),
                  Math.max(sel2.anchor, sel2.head) + 1,
                )
              : hunk.lines;
          const source = lines
            .filter((l) => l.kind !== "del")
            .map((l) => l.text)
            .join("\n");
          setRunRequest((prev) => ({
            tick: (prev?.tick ?? 0) + 1,
            source,
          }));
          break;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    showHelp,
    showPlan,
    showPicker,
    state.cursor,
    state.selection,
    suggestion,
    line,
    draftingKey,
    hunk,
    demoLineHasAiNote,
    newCommentKey,
  ]);

  return (
    <div className="demo__app app">
      <header className="topbar">
        <span className="topbar__brand">shippable</span>
        <span className="topbar__sep">│</span>
        <span className="topbar__id">{cs.id}</span>
        <span className="topbar__title">{cs.title}</span>
        <button
          type="button"
          className={
            "topbar__btn topbar__btn--plan" +
            (showPlan ? " topbar__btn--on" : "") +
            (planTotal > 0 && planDone === planTotal
              ? " topbar__btn--done"
              : "")
          }
          onClick={() => setShowPlan((v) => !v)}
          title="open the review plan (p)"
        >
          ◇ plan{planTotal > 0 ? ` · ${planDone}/${planTotal}` : ""}
        </button>
        <span className="topbar__sep">│</span>
        <span className="topbar__branch">
          {cs.branch} → {cs.base}
        </span>
        <span className="topbar__spacer" />
        <span className="topbar__author">@{cs.author}</span>
        <ThemePicker value={themeId} onChange={onPickTheme} />
        <button
          className="topbar__btn"
          onClick={() => setFreeRunnerOpen(true)}
          title="open a free code runner (shift+R)"
        >
          ▷ run
        </button>
        <button
          className="topbar__btn"
          onClick={() => setShowLoad(true)}
          title="load a changeset (shift+L)"
        >
          + load
        </button>
      </header>

      <div
        className={[
          "main",
          showInspector && "main--with-inspector",
          !showSidebar
            ? "main--no-sidebar"
            : sidebarWide && "main--wide-sidebar",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {showSidebar && (
          <Sidebar
            viewModel={buildSidebarViewModel({
              files: cs.files,
              currentFileId: state.cursor.fileId,
              readLines: state.readLines,
              reviewedFiles: state.reviewedFiles,
              interactions: state.interactions,
            })}
            onPickFile={(fileId) => {
              const f = cs.files.find((ff) => ff.id === fileId);
              if (!f) return;
              dispatch({
                type: "SET_CURSOR",
                cursor: {
                  changesetId: cs.id,
                  fileId,
                  hunkId: f.hunks[0].id,
                  lineIdx: 0,
                },
              });
            }}
            onJumpToFirstComment={(fileId) => {
              const stop = buildCommentStops(cs, state.interactions).find(
                (s) => s.fileId === fileId,
              );
              if (!stop) return;
              dispatch({
                type: "SET_CURSOR",
                cursor: {
                  changesetId: cs.id,
                  fileId: stop.fileId,
                  hunkId: stop.hunkId,
                  lineIdx: stop.lineIdx,
                },
              });
            }}
            runs={runs}
            onCloseRun={closePromptRun}
            wide={sidebarWide}
            onToggleWide={() => setSidebarWide((v) => !v)}
          />
        )}
        <DiffView
          viewModel={buildDiffViewModel({
            file,
            currentHunkId: hunk.id,
            cursorLineIdx: state.cursor.lineIdx,
            read: state.readLines,
            isFileReviewed: state.reviewedFiles.has(file.id),
            acked: selectAckedNotes(state),
            replies: state.interactions,
            expandLevelAbove: state.expandLevelAbove,
            expandLevelBelow: state.expandLevelBelow,
            fileFullyExpanded: state.fullExpandedFiles.has(file.id),
            filePreviewing: state.previewedFiles.has(file.id),
            imageAssets: cs.imageAssets,
            selection: state.selection,
            signals: demoIngestSignals,
          })}
          onSetExpandLevel={(hunkId, dir, level) =>
            dispatch({ type: "SET_EXPAND_LEVEL", hunkId, dir, level })
          }
          onToggleExpandFile={(fileId) =>
            dispatch({ type: "TOGGLE_EXPAND_FILE", fileId })
          }
          onTogglePreviewFile={(fileId) =>
            dispatch({ type: "TOGGLE_PREVIEW_FILE", fileId })
          }
        />
        {showInspector && (
          <Inspector
            viewModel={buildInspectorViewModel({
              file,
              hunk,
              line,
              cursor: state.cursor,
              symbols: symbolIndex,
              acked: selectAckedNotes(state),
              replies: state.interactions,
              draftingKey,
              signals: demoIngestSignals,
              detachedInteractions: state.detachedInteractions,
            })}
            commentCount={buildCommentStops(cs, state.interactions).length}
            onPrevComment={() => dispatch({ type: "MOVE_TO_COMMENT", delta: -1 })}
            onNextComment={() => dispatch({ type: "MOVE_TO_COMMENT", delta: 1 })}
            lineHasAiNote={demoLineHasAiNote}
            symbols={symbolIndex}
            draftBodies={drafts}
            onJump={jumpTo}
            onJumpToBlock={(cursor, selection) =>
              dispatch({ type: "SET_CURSOR", cursor, selection })
            }
            onToggleAck={(hunkId, lineIdx) =>
              dispatch({ type: "TOGGLE_ACK", hunkId, lineIdx })
            }
            onStartDraft={(key) => setDraftingKey(key)}
            onStartNewComment={() => setDraftingKey(newCommentKey())}
            onCloseDraft={() => setDraftingKey(null)}
            onChangeDraft={(key, body) =>
              setDrafts((prev) => ({ ...prev, [key]: body }))
            }
            onSubmitReply={(key, body) => {
              const isFirst = (state.interactions[key]?.length ?? 0) === 0;
              const interaction: Interaction = {
                id: `r-${Date.now()}`,
                threadKey: key,
                target: isFirst ? firstTargetForKey(key) : replyTarget(),
                intent: "comment",
                author: "you",
                authorRole: "user",
                body,
                createdAt: new Date().toISOString(),
                ...buildReplyAnchor(key, cs),
              };
              dispatch({
                type: "ADD_INTERACTION",
                targetKey: key,
                interaction,
              });
              setDrafts((prev) => {
                if (!(key in prev)) return prev;
                const next = { ...prev };
                delete next[key];
                return next;
              });
              setDraftingKey(null);
            }}
            onDeleteReply={(key, replyId) =>
              dispatch({
                type: "DELETE_INTERACTION",
                targetKey: key,
                interactionId: replyId,
              })
            }
            onRetryReply={() => {
              // Demo mode has no agent backend; retry is a no-op. Failed
              // enqueues never happen here in the first place — the prop
              // is required by the Inspector type signature but is dead
              // code in this surface.
            }}
            onVerifyAiNote={(recipe) => {
              setRunRequest((prev) => ({
                tick: (prev?.tick ?? 0) + 1,
                source: recipe.source,
                inputs: recipe.inputs,
              }));
            }}
            agentContext={agentContext}
            interactionsShownInline={false}
          />
        )}
      </div>

      <StatusBar
        viewModel={buildStatusBarViewModel({
          totalFiles: cs.files.length,
          fileIdx,
          totalHunks: file.hunks.length,
          hunkIdx,
          totalLines: hunk.lines.length,
          lineIdx: state.cursor.lineIdx,
          readCoverage,
          reviewedFiles,
          selection: selectionForBar,
          // Demo surface stays on the default hint — context-aware variants
          // are exercised in the live app.
          lineHasAiNote: false,
          lineNoteAcked: false,
          currentFileReadFraction: 0,
          currentFileReviewed: false,
          currentChangesetSignedOff: null,
        })}
      />

      {/* overlays */}
      {guideViewModel && (
        <GuidePrompt viewModel={guideViewModel} onJump={jumpTo} />
      )}
      {showPlan && (
        <div
          className="planview-overlay"
          onClick={() => setShowPlan(false)}
        >
          <div
            className="planview-overlay__box"
            onClick={(e) => e.stopPropagation()}
          >
            <ReviewPlanView
              plan={plan}
              changeset={cs}
              status={planStatus}
              error={planError}
              onGenerateAi={generatePlan}
              onJumpToEntry={(entry) => {
                const f = cs.files.find((ff) => ff.id === entry.fileId);
                if (!f) return;
                const hunkId = entry.hunkId ?? f.hunks[0].id;
                dispatch({
                  type: "SET_CURSOR",
                  cursor: {
                    changesetId: cs.id,
                    fileId: entry.fileId,
                    hunkId,
                    lineIdx: 0,
                  },
                });
                setShowPlan(false);
              }}
              onNavigate={(ev) => {
                const target = resolveEvidenceToCursor(ev, cs, symbolIndex);
                if (!target) return;
                dispatch({ type: "SET_CURSOR", cursor: target });
                setShowPlan(false);
              }}
            />
          </div>
        </div>
      )}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      {showLoad && (
        <LoadModal
          onClose={() => setShowLoad(false)}
          onLoad={(newCs) => {
            dispatch({ type: "LOAD_CHANGESET", changeset: newCs });
            setShowLoad(false);
          }}
        />
      )}
      {showPicker && (
        <PromptPicker
          context={buildAutoFillContext(cs, file, hunk, state.selection)}
          onClose={() => setShowPicker(false)}
          onSubmit={(prompt, rendered) => startPromptRun(prompt, rendered)}
        />
      )}
      <CodeRunner
        currentFilePath={file.path}
        freeOpen={freeRunnerOpen}
        onFreeClose={() => setFreeRunnerOpen(false)}
        runRequest={runRequest}
      />

      {frame.agentCli && <AgentCli content={frame.agentCli} />}
    </div>
  );
}

/**
 * Floating agent-terminal overlay used on the agent-integration frames.
 * Generic naming on purpose — the round-trip is harness-agnostic; any
 * MCP-speaking agent could fill this surface. Rendered with a fixed dark
 * theme regardless of the demo's active theme so it reads as a separate
 * window. Auto-scrolls to the bottom on mount so multi-line transcripts
 * land on the latest entry.
 */
function AgentCli({ content }: { content: AgentCliContent }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [content]);
  return (
    <div className="demo__agent-cli" role="presentation">
      <div className="demo__agent-cli-titlebar">
        <div className="demo__agent-cli-dots">
          <span className="demo__agent-cli-dot demo__agent-cli-dot--r" />
          <span className="demo__agent-cli-dot demo__agent-cli-dot--y" />
          <span className="demo__agent-cli-dot demo__agent-cli-dot--g" />
        </div>
        <div className="demo__agent-cli-title">
          {content.title ?? "agent"}
        </div>
      </div>
      <div className="demo__agent-cli-body" ref={bodyRef}>
        {content.lines.map((line, i) => {
          if (line.kind === "user") {
            return (
              <p
                key={i}
                className="demo__agent-cli-line demo__agent-cli-user"
              >
                {line.text}
              </p>
            );
          }
          if (line.kind === "assistant") {
            return (
              <p
                key={i}
                className="demo__agent-cli-line demo__agent-cli-assistant"
              >
                {line.text}
              </p>
            );
          }
          return (
            <div key={i} className="demo__agent-cli-line">
              <span className="demo__agent-cli-tool-head">{line.tool}</span>
              {line.args && (
                <span className="demo__agent-cli-tool-args"> ({line.args})</span>
              )}
              {line.result && (
                <pre className="demo__agent-cli-tool-result">{line.result}</pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Turn a plan-view evidence reference into a Cursor for navigation.
 * Mirrors the helper in App.tsx.
 */
function resolveEvidenceToCursor(
  ev: EvidenceRef,
  cs: ChangeSet,
  symbols: SymbolIndex,
): Cursor | null {
  switch (ev.kind) {
    case "description":
      return null;
    case "file": {
      const f = cs.files.find((ff) => ff.path === ev.path);
      if (!f || f.hunks.length === 0) return null;
      return {
        changesetId: cs.id,
        fileId: f.id,
        hunkId: f.hunks[0].id,
        lineIdx: 0,
      };
    }
    case "hunk": {
      for (const f of cs.files) {
        const h = f.hunks.find((hh) => hh.id === ev.hunkId);
        if (h) {
          return {
            changesetId: cs.id,
            fileId: f.id,
            hunkId: h.id,
            lineIdx: 0,
          };
        }
      }
      return null;
    }
    case "symbol":
      return symbols.get(ev.name) ?? null;
  }
}
