#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  handleCheckReviewComments,
  handlePostReviewComment,
} from "./handler.js";

const TOOL_DESCRIPTION =
  "Check Shippable for reviewer interactions. Call this tool when the user mentions reviewing code, pulling reviewer feedback, checking shippable, or asks about review comments. Returns a `<reviewer-feedback>` envelope with one `<interaction id=\"…\" target=\"…\" intent=\"…\" author=\"…\" authorRole=\"…\" file=\"…\" lines=\"…\">…</interaction>` per entry. IMPORTANT: each `<interaction>` carries an `id` attribute — you MUST capture it (alongside the body) so you can later report back via `shippable_post_review_comment`. The `status` argument selects what to fetch: 'unread' returns new interactions and marks them read — the queue drains, so this is the only chance to read those ids; 'delivered' re-reads interactions already marked read; 'all' returns both.";

const POST_COMMENT_DESCRIPTION =
  "Post a review interaction back to Shippable. Two modes, distinguished by which fields you supply:\n\n" +
  "• Reply mode — set `parentInteractionId` (the id from a `<interaction>` element returned by `shippable_check_review_comments`) and `intent` to 'accept' | 'reject' | 'ack'. Use after addressing one of the reviewer's interactions.\n\n" +
  "• Top-level mode — set `target` ('line' | 'block'), `file` (repo-relative path), `lines` (e.g. '118' or '72-79'), and `intent` to 'comment' | 'question' | 'request' | 'blocker'. Use when you noticed something on your own and want to start a fresh thread on a particular line or range.\n\n" +
  "Put your prose in `replyText`. Also call when the user asks you to 'report back to shippable' or similar.";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "@shippable/mcp-server",
    version: "0.0.0",
  });

  server.registerTool(
    "shippable_check_review_comments",
    {
      description: TOOL_DESCRIPTION,
      inputSchema: {
        worktreePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the worktree whose review interactions should be fetched. Defaults to the agent's current working directory.",
          ),
        status: z
          .enum(["unread", "delivered", "all"])
          .describe(
            "Which interactions to fetch. 'unread': new ones, marks them read (drains the queue); 'delivered': ones already read; 'all': both. Required — state your intent on every call.",
          ),
      },
    },
    async ({ worktreePath, status }) => {
      return handleCheckReviewComments({ worktreePath, status });
    },
  );

  server.registerTool(
    "shippable_post_review_comment",
    {
      description: POST_COMMENT_DESCRIPTION,
      inputSchema: {
        parentInteractionId: z
          .string()
          .optional()
          .describe(
            "Reply mode only: the id of the reviewer interaction this reply answers. Capture from a `<interaction id=\"…\">` element returned by `shippable_check_review_comments` — the queue drains on pull. Omit when starting a fresh top-level thread.",
          ),
        target: z
          .enum(["line", "block"])
          .optional()
          .describe(
            "Top-level mode only: 'line' for a single line, 'block' for a range. Required when parentInteractionId is not set.",
          ),
        file: z
          .string()
          .optional()
          .describe(
            "Top-level mode only: repo-relative file path the interaction anchors to. Required when parentInteractionId is not set.",
          ),
        lines: z
          .string()
          .optional()
          .describe(
            "Top-level mode only: the line number ('118') or inclusive range ('72-79') the interaction anchors to. Required when parentInteractionId is not set.",
          ),
        replyText: z
          .string()
          .describe(
            "Free-form prose. Plain text or Markdown; no XML/HTML wrapping needed. Named `replyText` rather than `body` because some model serializers conflate `body` with HTML's `<body>` element and emit `</body>` close tags into the field value.",
          ),
        intent: z
          .enum([
            "accept",
            "reject",
            "ack",
            "comment",
            "question",
            "request",
            "blocker",
          ])
          .describe(
            "Reply intents (use with parentInteractionId): 'accept' if you agreed and acted on it, 'reject' if you disagree and won't, 'ack' if you saw it but no commitment either way. Top-level intents (use with target+file+lines): 'comment' (observation), 'question' (expects an answer), 'request' (expects a code change, non-blocking), 'blocker' (expects a code change AND won't approve until it lands).",
          ),
        worktreePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the worktree the interaction belongs to. Defaults to the agent's current working directory.",
          ),
      },
    },
    async (input) => {
      return handlePostReviewComment(input);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[shippable-mcp-server] fatal:", err);
  process.exit(1);
});
