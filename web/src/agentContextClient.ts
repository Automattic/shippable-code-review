// Thin client over the agent-context endpoints. See server/src/agent-context.ts
// and docs/concepts/agent-context.md for the design.

import { getJson, postJson } from "./apiClient";
import type {
  AgentContextSlice,
  AgentSessionRef,
  DeliveredInteraction,
} from "./types";
import type { PolledAgentReply } from "./state";

export async function listSessionsForWorktree(
  worktreePath: string,
): Promise<AgentSessionRef[]> {
  const { sessions } = await postJson<{ sessions: AgentSessionRef[] }>(
    "/api/worktrees/sessions",
    { path: worktreePath },
  );
  return sessions;
}

export async function fetchMcpStatus(): Promise<{
  installed: boolean;
  /**
   * The `claude mcp add …` command the panel chip should display + copy.
   * Authoritative — comes from the server's path resolver so the chip
   * surfaces a working command even before `@shippable/mcp-server` lands
   * on npm. See `resolveInstallCommand` in `server/src/mcp-status.ts`.
   */
  installCommand: string;
}> {
  return getJson<{ installed: boolean; installCommand: string }>(
    "/api/worktrees/mcp-status",
  );
}

export async function fetchAgentContext(args: {
  worktreePath: string;
  sessionFilePath: string;
  commitSha?: string | null;
}): Promise<AgentContextSlice> {
  const { slice } = await postJson<{ slice: AgentContextSlice }>(
    "/api/worktrees/agent-context",
    {
      path: args.worktreePath,
      sessionFilePath: args.sessionFilePath,
      commitSha: args.commitSha ?? null,
    },
  );
  return slice;
}

// ── Agent comment queue ──────────────────────────────────────────────────
// Enqueue / unenqueue now live in `interactionClient` — the DB row IS the
// queue entry. These two are the read side: `/api/agent/delivered` and
// `/api/agent/replies`, polled by `useDeliveredPolling`. The pull endpoint
// is consumed by the MCP server, not the web client.

export async function fetchDelivered(
  worktreePath: string,
): Promise<DeliveredInteraction[]> {
  const { delivered } = await getJson<{ delivered: DeliveredInteraction[] }>(
    `/api/agent/delivered?path=${encodeURIComponent(worktreePath)}`,
  );
  return delivered;
}

export interface AgentRepliesResult {
  replies: PolledAgentReply[];
  /** True while an agent is in watch mode for this worktree (see WATCH_TTL_MS). */
  watching: boolean;
}

export async function fetchAgentReplies(
  worktreePath: string,
): Promise<AgentRepliesResult> {
  const { replies, watching } = await getJson<{
    replies: PolledAgentReply[];
    watching: boolean;
  }>(`/api/agent/replies?worktreePath=${encodeURIComponent(worktreePath)}`);
  return { replies, watching };
}

/**
 * Convenience: list sessions for a worktree, pick the most recent that
 * matches, fetch its slice for the given commit. Returns null when no
 * matching session exists. The session picker can override this default
 * by passing `pinnedSessionFilePath`.
 */
export async function fetchAgentContextForWorktree(args: {
  worktreePath: string;
  commitSha: string;
  pinnedSessionFilePath?: string | null;
}): Promise<{
  slice: AgentContextSlice;
  candidates: AgentSessionRef[];
} | null> {
  // Dirty views carry a synthetic `dirty:<hash>` marker as commitSha. There's
  // no commit to slice agent context against, and passing the marker through
  // would surface the server's "invalid commit sha" error in the right panel.
  if (args.commitSha.startsWith("dirty:")) return null;
  const candidates = await listSessionsForWorktree(args.worktreePath);
  if (candidates.length === 0) return null;
  const session =
    (args.pinnedSessionFilePath
      ? candidates.find((c) => c.filePath === args.pinnedSessionFilePath)
      : null) ?? candidates[0];
  const slice = await fetchAgentContext({
    worktreePath: args.worktreePath,
    sessionFilePath: session.filePath,
    commitSha: args.commitSha,
  });
  return { slice, candidates };
}
