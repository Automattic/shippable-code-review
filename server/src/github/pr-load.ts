import { parseDiff } from "../../../web/src/parseDiff.ts";
import type {
  ChangeSet,
  DetachedInteraction,
  DiffLine,
  Interaction,
  PrConversationItem,
  PrSource,
} from "../../../web/src/types.ts";
import { blockCommentKey, userCommentKey } from "../../../web/src/types.ts";
import { githubFetch, githubFetchAll } from "./api-client.ts";
import type { PrCoords } from "./url.ts";

interface GhPrMeta {
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  html_url: string;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  user: { login: string };
  changed_files: number;
}

interface GhPrFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  patch?: string;
  previous_filename?: string;
}

interface GhLineComment {
  id: number;
  user: { login: string };
  body: string;
  path: string;
  /** Current new-file line. `null` when the comment is outdated. */
  line: number | null;
  /** Original line at the time the comment was made. */
  original_line: number;
  /** First line of a multi-line comment; null for single-line. */
  start_line: number | null;
  /** Original first line at the time the comment was made; null for single-line. */
  original_start_line?: number | null;
  /** Commit sha the comment was originally written against. Drives "view at <sha7>". */
  original_commit_id: string;
  /** Unified-diff hunk fragment GitHub stores on the comment for context. */
  diff_hunk: string;
  created_at: string;
  html_url: string;
  side: "LEFT" | "RIGHT";
  /** Root comment id when this comment is a reply; absent for top-level. */
  in_reply_to_id?: number;
}

interface GhIssueComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  html_url: string;
}

export interface PrLoadResult {
  changeSet: ChangeSet;
  /** PR review comments that anchor to a line in the current diff. */
  prInteractions: Record<string, Interaction[]>;
  /** PR review comments that no longer anchor (outdated, or moved off the patch view). */
  prDetached: DetachedInteraction[];
}

function fileHeaders(f: GhPrFile): string {
  if (f.status === "added") {
    return `--- /dev/null\n+++ b/${f.filename}\n`;
  }
  if (f.status === "removed") {
    return `--- a/${f.filename}\n+++ /dev/null\n`;
  }
  if (f.status === "renamed") {
    const oldName = f.previous_filename ?? f.filename;
    return `rename from ${oldName}\nrename to ${f.filename}\n--- a/${oldName}\n+++ b/${f.filename}\n`;
  }
  return `--- a/${f.filename}\n+++ b/${f.filename}\n`;
}

function assembleDiffText(files: GhPrFile[]): string {
  return files
    .filter((f) => f.patch)
    .map((f) => {
      const oldName = f.status === "renamed" ? (f.previous_filename ?? f.filename) : f.filename;
      return `diff --git a/${oldName} b/${f.filename}\n${fileHeaders(f)}${f.patch}`;
    })
    .join("\n");
}

/**
 * Build a per-path lookup from file-line-number to (hunkId, lineIdx). Indexed
 * by `newNo` for context/added lines and `oldNo` for deleted lines so we can
 * resolve both RIGHT- and LEFT-side PR comments.
 */
function buildPositionIndex(
  cs: ChangeSet,
): Map<string, Map<number, { hunkId: string; lineIdx: number; side: "RIGHT" | "LEFT" }>> {
  const index = new Map<
    string,
    Map<number, { hunkId: string; lineIdx: number; side: "RIGHT" | "LEFT" }>
  >();
  for (const file of cs.files) {
    const map = new Map<number, { hunkId: string; lineIdx: number; side: "RIGHT" | "LEFT" }>();
    for (const hunk of file.hunks) {
      hunk.lines.forEach((line, lineIdx) => {
        if (line.kind === "del" && line.oldNo !== undefined) {
          map.set(line.oldNo, { hunkId: hunk.id, lineIdx, side: "LEFT" });
        } else if (line.newNo !== undefined) {
          map.set(line.newNo, { hunkId: hunk.id, lineIdx, side: "RIGHT" });
        }
      });
    }
    index.set(file.path, map);
  }
  return index;
}

/** Interaction.anchorContext is documented as "up to 10 lines centered on
 *  the anchor". We honor that here so the Sidebar's detached snippet stays
 *  a glance, not a wall of code. */
const ANCHOR_CONTEXT_BEFORE = 5;
const ANCHOR_CONTEXT_AFTER = 4;

/**
 * Parse a GitHub `diff_hunk` string (a single unified-diff hunk fragment) into
 * `DiffLine[]` and window it to the lines near the comment's anchor. Reuses
 * the shared diff parser by wrapping the fragment as a minimal valid diff.
 *
 * GitHub's `diff_hunk` for a multi-line PR comment can be 30+ lines; without
 * windowing the detached-entry snippet dominates the sidebar.
 */
function parseDiffHunkLines(
  diffHunk: string,
  path: string,
  anchor: { line: number; side: "LEFT" | "RIGHT" },
): DiffLine[] {
  const wrapped = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${diffHunk}`;
  const cs = parseDiff(wrapped, { id: "anchor", title: "anchor" });
  const file = cs.files[0];
  if (!file || file.hunks.length === 0) return [];
  const lines = file.hunks[0].lines;

  // Locate the anchor: RIGHT side comments live on add/context lines (newNo);
  // LEFT side on del/context lines (oldNo). Fall back to the last line, which
  // is GitHub's typical convention for diff_hunk.
  const anchorIdx = lines.findIndex((l) =>
    anchor.side === "RIGHT" ? l.newNo === anchor.line : l.oldNo === anchor.line,
  );
  const center = anchorIdx >= 0 ? anchorIdx : lines.length - 1;
  const lo = Math.max(0, center - ANCHOR_CONTEXT_BEFORE);
  const hi = Math.min(lines.length, center + ANCHOR_CONTEXT_AFTER + 1);
  return lines.slice(lo, hi);
}

export async function loadPr(
  coords: PrCoords,
  token: string,
): Promise<PrLoadResult> {
  const { host, owner, repo, number, apiBaseUrl } = coords;
  const opts = { token, host };
  const repoBase = `/repos/${owner}/${repo}`;

  const [meta, files, lineComments, issueComments] = await Promise.all([
    githubFetch(apiBaseUrl, `${repoBase}/pulls/${number}`, opts).then(
      (r) => r.json as GhPrMeta,
    ),
    githubFetchAll<GhPrFile>(
      apiBaseUrl,
      `${repoBase}/pulls/${number}/files?per_page=100`,
      opts,
    ),
    githubFetchAll<GhLineComment>(
      apiBaseUrl,
      `${repoBase}/pulls/${number}/comments?per_page=100`,
      opts,
    ),
    githubFetchAll<GhIssueComment>(
      apiBaseUrl,
      `${repoBase}/issues/${number}/comments?per_page=100`,
      opts,
    ),
  ]);

  const id = `pr:${host}:${owner}:${repo}:${number}`;
  const state: PrSource["state"] =
    meta.state === "closed" && meta.merged ? "merged" : meta.state;

  const diffText = assembleDiffText(files);

  const cs = parseDiff(diffText, {
    id,
    title: meta.title,
    author: meta.user.login,
    base: meta.base.sha,
    head: meta.head.sha,
  });

  const prSource: PrSource = {
    host,
    owner,
    repo,
    number,
    htmlUrl: meta.html_url,
    headSha: meta.head.sha,
    baseSha: meta.base.sha,
    state,
    title: meta.title,
    body: meta.body ?? "",
    baseRef: meta.base.ref,
    headRef: meta.head.ref,
    lastFetchedAt: new Date().toISOString(),
  };

  if (files.length < meta.changed_files) {
    prSource.truncation = {
      kind: "files",
      reason: `Fetched ${files.length} of ${meta.changed_files} files; GitHub limits the file-list response.`,
    };
  }

  const prConversation: PrConversationItem[] = issueComments.map((c) => ({
    id: c.id,
    author: c.user.login,
    createdAt: c.created_at,
    body: c.body,
    htmlUrl: c.html_url,
  }));

  const positionIndex = buildPositionIndex(cs);

  const prInteractions: Record<string, Interaction[]> = {};
  const prDetached: DetachedInteraction[] = [];

  for (const c of lineComments) {
    const fileMap = positionIndex.get(c.path);
    const hit = c.line !== null ? fileMap?.get(c.line) : undefined;

    if (!hit) {
      // Outdated (line === null) or anchor moved off the patch view —
      // render as a DetachedInteraction so the user sees the original context.
      const anchorContext = c.diff_hunk
        ? parseDiffHunkLines(c.diff_hunk, c.path, {
            line: c.original_line,
            side: c.side,
          })
        : [];
      const detachedKey = `pr-detached:${c.id}`;
      const detachedIx: Interaction = {
        id: `pr-comment:${c.id}`,
        threadKey: detachedKey,
        target: "line",
        intent: "comment",
        author: c.user.login,
        authorRole: "user",
        body: c.body,
        createdAt: c.created_at,
        anchorPath: c.path,
        anchorLineNo: c.original_line,
        anchorContext,
        originType: "committed",
        originSha: c.original_commit_id,
        external: { source: "pr", htmlUrl: c.html_url },
      };
      prDetached.push({ interaction: detachedIx, threadKey: detachedKey });
      continue;
    }

    // Anchored. Single-line vs multi-line determines the reply-key namespace.
    const isMultiLine =
      c.start_line !== null &&
      c.start_line !== undefined &&
      c.start_line !== c.line;

    // A GitHub review thread is the root comment plus its replies; group by
    // the root's id so replies land under it and distinct threads on the
    // same line stay separate.
    const threadId = String(c.in_reply_to_id ?? c.id);

    let key: string;
    let target: Interaction["target"];
    if (isMultiLine) {
      const startHit = fileMap?.get(c.start_line as number);
      if (startHit && startHit.hunkId === hit.hunkId) {
        const lo = Math.min(startHit.lineIdx, hit.lineIdx);
        const hi = Math.max(startHit.lineIdx, hit.lineIdx);
        key = blockCommentKey(hit.hunkId, lo, hi, threadId);
        target = "block";
      } else {
        // Span crosses hunks (rare) — fall back to single-line on the end line.
        key = userCommentKey(hit.hunkId, hit.lineIdx, threadId);
        target = "line";
      }
    } else {
      key = userCommentKey(hit.hunkId, hit.lineIdx, threadId);
      target = "line";
    }

    const interaction: Interaction = {
      id: `pr-comment:${c.id}`,
      threadKey: key,
      target,
      intent: "comment",
      author: c.user.login,
      authorRole: "user",
      body: c.body,
      createdAt: c.created_at,
      external: { source: "pr", htmlUrl: c.html_url },
    };

    if (!prInteractions[key]) prInteractions[key] = [];
    prInteractions[key].push(interaction);
  }

  return {
    changeSet: { ...cs, prSource, prConversation },
    prInteractions,
    prDetached,
  };
}
