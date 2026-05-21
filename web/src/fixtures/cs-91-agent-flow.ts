import type { ChangeSet, DetachedInteraction, Interaction } from "../types";
import { blockCommentKey, userCommentKey } from "../types";

// Powers the "agent integration" segment of the demo reel — see the
// trailing frames in `web/src/components/Demo.tsx`. A tight server-side
// change that gives us three sensible reviewer comments to anchor the
// queue → fetch → reply lifecycle: a line comment, a reply-to-AI-note,
// and a block comment over a deletion run. The diff is intentionally
// small so captioned frames have room to breathe.

export const CS_91: ChangeSet = {
  id: "cs-91",
  title: "Validate worktree path on agent enqueue",
  author: "luiz",
  branch: "fix/agent-enqueue-guard",
  base: "main",
  createdAt: "2026-05-06T09:30:00Z",
  description:
    "Lifts assertGitDir into agent-queue so every enqueue path validates the worktree, not just the HTTP route. Drops the now-redundant check from the route handler.",
  worktreeSource: {
    worktreePath: "/Users/you/code/shippable-agent-flow",
    commitSha: "a3c91d7e2b40fa19c8d05b6f7e1a91e7f0d34c12",
    branch: "fix/agent-enqueue-guard",
  },
  files: [
    {
      id: "cs-91/server/src/agent-queue.ts",
      path: "server/src/agent-queue.ts",
      language: "ts",
      status: "modified",
      hunks: [
        {
          id: "cs-91/server/src/agent-queue.ts#h1",
          header: "@@ -3,9 +3,16 @@ export interface EnqueueArgs",
          oldStart: 3,
          oldCount: 9,
          newStart: 3,
          newCount: 16,
          lines: [
            { kind: "context", text: "import type { Comment, EnqueueArgs } from \"./types\";", oldNo: 3, newNo: 3 },
            { kind: "add", text: "import { assertGitDir } from \"./worktree-validation\";", newNo: 4 },
            { kind: "context", text: "", oldNo: 4, newNo: 5 },
            { kind: "context", text: "const queues = new Map<string, Queue>();", oldNo: 5, newNo: 6 },
            { kind: "context", text: "", oldNo: 6, newNo: 7 },
            { kind: "context", text: "export function enqueueComment(args: EnqueueArgs): { id: string } {", oldNo: 7, newNo: 8 },
            { kind: "context", text: "  const { worktreePath, comment } = args;", oldNo: 8, newNo: 9 },
            { kind: "add", text: "  if (!assertGitDir(worktreePath)) return { id: \"\" };", newNo: 10 },
            { kind: "add", text: "", newNo: 11 },
            { kind: "context", text: "  const queue = queues.get(worktreePath) ?? createQueue();", oldNo: 9, newNo: 12 },
            { kind: "context", text: "  const id = `cmt_${randomId()}`;", oldNo: 10, newNo: 13 },
            { kind: "add", text: "  queue.pending.push({ ...comment, id, enqueuedAt: now() });", newNo: 14 },
            { kind: "context", text: "  queues.set(worktreePath, queue);", oldNo: 11, newNo: 15 },
            { kind: "context", text: "  return { id };", oldNo: 12, newNo: 16 },
          ],
        },
      ],
    },
    // Note: `interactions` and `detachedInteractions` for cs-91 are
    // exposed below as separate exports — fixtures consumers (Demo,
    // gallery) seed them via the LOAD_CHANGESET action's optional
    // interactions arg.
    {
      id: "cs-91/server/src/index.ts",
      path: "server/src/index.ts",
      language: "ts",
      status: "modified",
      hunks: [
        {
          id: "cs-91/server/src/index.ts#h1",
          header: "@@ -41,12 +41,7 @@ app.post(\"/api/agent/enqueue\"",
          oldStart: 41,
          oldCount: 12,
          newStart: 41,
          newCount: 7,
          lines: [
            { kind: "context", text: "app.post(\"/api/agent/enqueue\", async (req, res) => {", oldNo: 41, newNo: 41 },
            { kind: "context", text: "  const args = parseEnqueue(req.body);", oldNo: 42, newNo: 42 },
            { kind: "context", text: "  if (!args) return res.status(400).json({ error: \"bad request\" });", oldNo: 43, newNo: 43 },
            { kind: "del", text: "  // belt-and-suspenders: route also rejects non-git dirs", oldNo: 44 },
            { kind: "del", text: "  if (!assertGitDir(args.worktreePath)) {", oldNo: 45 },
            { kind: "del", text: "    return res.status(400).json({ error: \"not a git worktree\" });", oldNo: 46 },
            { kind: "del", text: "  }", oldNo: 47 },
            { kind: "del", text: "", oldNo: 48 },
            { kind: "context", text: "  const result = enqueueComment(args);", oldNo: 49, newNo: 44 },
            { kind: "context", text: "  res.json(result);", oldNo: 50, newNo: 45 },
            { kind: "context", text: "});", oldNo: 51, newNo: 46 },
          ],
        },
      ],
    },
  ],
};

// Seeded interactions for the agent-flow demo:
//   - a user-authored line comment on the queue file with an agent reply
//     ('accept') threaded under it
//   - an agent-started top-level block comment on the route file
//   - an out-of-hunk agent comment that lands in detachedInteractions
//     (file is in the diff but the cited line falls outside any hunk)
const QUEUE_HUNK = "cs-91/server/src/agent-queue.ts#h1";
const ROUTE_HUNK = "cs-91/server/src/index.ts#h1";

const userLineKey = userCommentKey(QUEUE_HUNK, 6, "c1"); // lineIdx 6 → newNo 10 ("assertGitDir" line)
const agentBlockKey = blockCommentKey(ROUTE_HUNK, 3, 6, "c2"); // newNo n/a — covers the deleted check

const userLineInteraction: Interaction = {
  id: "u-luiz-1",
  threadKey: userLineKey,
  target: "line",
  intent: "request",
  author: "luiz",
  authorRole: "user",
  body: "Move this guard above the queue lookup so we don't allocate an entry for a bad path.",
  createdAt: "2026-05-06T09:32:00Z",
  agentQueueStatus: "delivered",
};

const agentReplyToUser: Interaction = {
  id: "ag-r-1",
  threadKey: userLineKey,
  target: "reply",
  intent: "accept",
  author: "agent",
  authorRole: "agent",
  body: "Reordered — guard is now the first thing the function does.",
  createdAt: "2026-05-06T09:35:00Z",
};

const agentTopLevel: Interaction = {
  id: "ag-tl-1",
  threadKey: agentBlockKey,
  target: "block",
  intent: "comment",
  author: "agent",
  authorRole: "agent",
  body: "Removing the route-level guard relies on assertGitDir being idempotent — flagging in case that ever changes.",
  createdAt: "2026-05-06T09:36:00Z",
};

const agentDetached: Interaction = {
  id: "ag-det-1",
  threadKey: "agent-detached:ag-det-1",
  target: "line",
  intent: "comment",
  author: "agent",
  authorRole: "agent",
  body: "Worth adding a smoke test under tests/queue.ts — but that file isn't in this changeset.",
  createdAt: "2026-05-06T09:37:00Z",
  anchorPath: "tests/queue.ts",
};

export const CS_91_INTERACTIONS: Record<string, Interaction[]> = {
  [userLineKey]: [userLineInteraction, agentReplyToUser],
  [agentBlockKey]: [agentTopLevel],
};

export const CS_91_DETACHED: DetachedInteraction[] = [
  { interaction: agentDetached, threadKey: agentDetached.threadKey },
];

