/**
 * view.ts — pure functions from ReviewState slices + domain objects to
 * pre-computed view models. No DOM, no React, no dispatch.
 *
 * Components below this layer are pure presenters: they receive a view model
 * and render it without computing anything.
 */

import type {
  DiffFile,
  DiffLine,
  LineKind,
  Cursor,
  DetachedInteraction,
  FileStatus,
  Interaction,
  LineSelection,
  ParsedReplyKey,
  QuizState,
} from "./types";
import {
  lineNoteReplyKey,
  hunkSummaryReplyKey,
  teammateReplyKey,
  parseReplyKey,
} from "./types";
import { hunkCoverage, fileCoverage } from "./state";
import type { IngestSignals } from "./interactions";
import type { GuideSuggestion } from "./guide";
import type { SymbolIndex } from "./symbols";

// View-layer projection of an AI per-line note. Source-of-truth lives in
// state.interactions; the view model carries just the bits the renderer
// needs (severity glyph, summary headline, optional detail / runRecipe).
export type AiNoteSeverity = "info" | "question" | "warning";
export interface AiNote {
  severity: AiNoteSeverity;
  summary: string;
  detail?: string;
  runRecipe?: { source: string; inputs: Record<string, string> };
}

// ─── Line-level view model ────────────────────────────────────────────────────

export interface DiffLineViewModel {
  /** Original kind — drives CSS class and sign glyph. */
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  /** True when this is the cursor position. */
  isCursor: boolean;
  /** True when the cursor has visited this line. Drives the dim "read" rail. */
  isRead: boolean;
  /** True when this line falls inside the active shift-extended selection. */
  isSelected: boolean;
  /** The AI note attached to this line, or undefined. Built by view.ts from
   *  the seam's `aiNoteByLine` lookup — the diff itself no longer carries it. */
  aiNote?: AiNote;
  /** True when the AI note has been acknowledged. */
  isAcked: boolean;
  /** True when the user has started a comment thread on this line. */
  hasUserComment: boolean;
  /**
   * Pre-computed glyph for the AI/comment column.
   * "✓" | "!" | "?" | "✦" | """ | " "
   */
  aiGlyph: string;
}

// ─── Expand-bar state ─────────────────────────────────────────────────────────

export interface ExpandBarViewModel {
  /** Number of context-expansion blocks currently revealed. */
  level: number;
  /** Total number of blocks available. */
  maxLevel: number;
  /** Line count in the next block (shown on the expand button). */
  nextSize: number;
  /**
   * Optimistic placeholder: file source isn't loaded yet, so we don't know
   * how many lines / blocks exist. Click triggers a lazy hydration fetch,
   * after which the bar replaces itself with the real `level/maxLevel/nextSize`
   * shape.
   */
  pending?: boolean;
}

// ─── Hunk-level view model ────────────────────────────────────────────────────

export interface HunkViewModel {
  id: string;
  header: string;
  /** 0–1 fraction of lines visited. */
  coverage: number;
  /** True when this hunk is the focused hunk (cursor is inside it). */
  isCurrent: boolean;

  // Metadata badges
  aiReviewed: boolean;
  aiSummary?: string;
  teammateReview?: {
    user: string;
    verdict: "approve" | "comment";
    note?: string;
  };
  definesSymbols: string[];
  referencesSymbols: string[];

  // Expand-context bars (undefined when no expand blocks exist for that direction)
  expandAbove?: ExpandBarViewModel;
  expandBelow?: ExpandBarViewModel;

  /**
   * Context lines to render *above* the hunk body (already ordered
   * top-to-bottom: farthest block first, nearest block last).
   */
  contextAbove: DiffLine[];

  /**
   * Context lines to render *below* the hunk body.
   */
  contextBelow: DiffLine[];

  /** The hunk's own lines with all per-line state pre-computed. */
  lines: DiffLineViewModel[];
}

// ─── File-level view model ────────────────────────────────────────────────────

export interface FullFileThreadViewModel {
  threadKey: string;
  messages: {
    id: string;
    author: string;
    authorRole: string;
    body: string;
  }[];
}

export interface FullFileLineViewModel {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  /** Pre-computed sign glyph ("+" | "-" | " "). */
  sign: string;
  /** Comment threads anchored to this line, shown inline in full-file view.
   *  Covers hunk-anchored `user:`/`block:` threads (mapped via the line's
   *  newNo) and file-line `userFile:` threads. Empty for most lines. */
  threads: FullFileThreadViewModel[];
}

export interface DiffViewModel {
  /** File path for the header. */
  path: string;
  /** Language hint for syntax highlighting. */
  language: string;
  /** File status badge text. */
  status: string;
  /** File ID (needed for toggle-expand-file callback). */
  fileId: string;
  /** True when the reviewer has signed off on this file. */
  isFileReviewed: boolean;
  /** True when a full-file expand is available for this file. */
  canExpandFile: boolean;
  /** True when the file is currently in full-expand mode. */
  fileFullyExpanded: boolean;
  /**
   * When fileFullyExpanded is true, this contains the full file lines
   * pre-rendered with sign glyphs. Empty array otherwise.
   */
  fullFileLines: FullFileLineViewModel[];
  /** Per-hunk view models (empty when fileFullyExpanded is true). */
  hunks: HunkViewModel[];
  /** True when the file is currently in rendered-preview mode (markdown only). */
  filePreviewing: boolean;
  /** True when this file's language can be rendered as markdown preview. */
  canPreview: boolean;
  /** Post-change source string for the markdown preview, when previewing. */
  previewSource: string;
  /** Repo-relative image asset map, threaded from the changeset. */
  imageAssets?: Record<string, string>;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

export interface BuildDiffViewModelArgs {
  file: DiffFile;
  currentHunkId: string;
  cursorLineIdx: number;
  /** Auto-tracked read lines (cursor visits). Drives the dim gutter rail. */
  read: Record<string, Set<number>>;
  /** True when the reviewer has signed off on the current file. */
  isFileReviewed: boolean;
  acked: Set<string>;
  replies: Record<string, string[]> | Record<string, unknown[]>;
  expandLevelAbove: Record<string, number>;
  expandLevelBelow: Record<string, number>;
  fileFullyExpanded: boolean;
  filePreviewing: boolean;
  /**
   * Image assets the markdown preview can resolve relative paths against.
   * Threaded through from the enclosing ChangeSet.
   */
  imageAssets?: Record<string, string>;
  /** Active shift-extended selection, or null. */
  selection?: LineSelection | null;
  /**
   * Per-line / per-hunk AI + teammate signals. Built once by the caller via
   * `selectIngestSignals(state)`; the view model reads from these lookups
   * instead of inline fields on the diff structure.
   */
  signals?: IngestSignals;
  /**
   * The enclosing changeset can lazy-fetch this file's source on demand
   * (i.e. it has a worktreeSource and the file isn't deleted). Drives the
   * optimistic placeholder bars/Source-tab that show before hydration runs.
   */
  canHydrateExpansion?: boolean;
}

/**
 * Group comment threads by the post-change line they sit on, for full-file
 * rendering. Hunk-anchored `user:`/`block:` threads map through the hunk line's
 * `newNo`; `userFile:` threads carry it directly. Del-line and cross-file
 * threads (no `newNo` on this file) drop out — they stay visible in hunk mode.
 * AI-note annotations (`note:`) keep their existing glyph rendering and aren't
 * repeated here.
 */
function fullFileThreadsByNewNo(
  file: DiffFile,
  replies: Record<string, Interaction[]> | Record<string, string[]> | Record<string, unknown[]>,
): Map<number, FullFileThreadViewModel[]> {
  const hunkLineNewNo = new Map<string, number>();
  for (const h of file.hunks) {
    h.lines.forEach((l, i) => {
      if (l.newNo !== undefined) hunkLineNewNo.set(`${h.id}:${i}`, l.newNo);
    });
  }
  const out = new Map<number, FullFileThreadViewModel[]>();
  for (const [key, list] of Object.entries(replies)) {
    if (!list || list.length === 0) continue;
    const parsed = parseReplyKey(key);
    if (!parsed) continue;
    let newNo: number | undefined;
    if (parsed.kind === "userFile") {
      if (parsed.fileId !== file.id) continue;
      newNo = parsed.newNo;
    } else if (parsed.kind === "user") {
      newNo = hunkLineNewNo.get(`${parsed.hunkId}:${parsed.lineIdx}`);
    } else if (parsed.kind === "block") {
      newNo = hunkLineNewNo.get(`${parsed.hunkId}:${parsed.lo}`);
    }
    if (newNo === undefined) continue;
    const messages = (list as Interaction[]).map((ix) => ({
      id: ix.id,
      author: ix.author,
      authorRole: ix.authorRole,
      body: ix.body,
    }));
    const arr = out.get(newNo);
    if (arr) arr.push({ threadKey: key, messages });
    else out.set(newNo, [{ threadKey: key, messages }]);
  }
  return out;
}

export function buildDiffViewModel({
  file,
  currentHunkId,
  cursorLineIdx,
  read,
  isFileReviewed,
  acked,
  replies,
  expandLevelAbove,
  expandLevelBelow,
  fileFullyExpanded,
  filePreviewing,
  imageAssets,
  selection,
  signals,
  canHydrateExpansion,
}: BuildDiffViewModelArgs): DiffViewModel {
  const aiNoteByLine = signals?.aiNoteByLine ?? {};
  const aiSummaryByHunk = signals?.aiSummaryByHunk ?? {};
  const teammateByHunk = signals?.teammateByHunk ?? {};
  const hydrationPending = !!canHydrateExpansion && !file.fullContent;
  const canExpandFile = !!file.fullContent || hydrationPending;
  const canPreview =
    file.language === "markdown" && (!!file.fullContent || !!file.postChangeText);
  const previewing = filePreviewing && canPreview;
  // Prefer the explicit post-change string (from worktree-loaded changesets)
  // over reconstructing from fullContent — same data, no per-line filtering.
  const previewSource = previewing
    ? file.postChangeText ??
      (file.fullContent ?? [])
        .filter((line) => line.kind !== "del")
        .map((line) => line.text)
        .join("\n")
    : "";

  // Pre-compute full-file lines only when needed.
  const threadsByNewNo =
    fileFullyExpanded && !previewing && file.fullContent
      ? fullFileThreadsByNewNo(file, replies)
      : new Map<number, FullFileThreadViewModel[]>();
  const fullFileLines: FullFileLineViewModel[] =
    fileFullyExpanded && !previewing && file.fullContent
      ? file.fullContent.map((line) => ({
          kind: line.kind,
          text: line.text,
          oldNo: line.oldNo,
          newNo: line.newNo,
          sign:
            line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ",
          threads:
            line.newNo !== undefined
              ? (threadsByNewNo.get(line.newNo) ?? [])
              : [],
        }))
      : [];

  // Build hunk view models.
  const hunks: HunkViewModel[] = fileFullyExpanded || previewing
    ? []
    : file.hunks.map((hunk) => {
        const isCurrent = hunk.id === currentHunkId;
        const readForHunk = read[hunk.id] ?? new Set<number>();
        // Hunk-header % shows read coverage. The verdict signal lives at
        // the file level; per-hunk we just expose progress.
        const coverage = hunkCoverage(hunk, read);

        // Expand-above: blocks ordered farthest-first for top-to-bottom rendering.
        const aboveBlocks = hunk.expandAbove ?? [];
        const belowBlocks = hunk.expandBelow ?? [];
        const levelAbove = expandLevelAbove[hunk.id] ?? 0;
        const levelBelow = expandLevelBelow[hunk.id] ?? 0;

        // Flatten revealed above blocks (slice(0, levelAbove) then reverse so
        // farthest appears at the top of the rendered output).
        const contextAbove: DiffLine[] = aboveBlocks
          .slice(0, levelAbove)
          .reduceRight<DiffLine[]>((acc, block) => acc.concat(block), []);

        const contextBelow: DiffLine[] = belowBlocks
          .slice(0, levelBelow)
          .reduce<DiffLine[]>((acc, block) => acc.concat(block), []);

        const expandAbove: ExpandBarViewModel | undefined =
          aboveBlocks.length > 0
            ? {
                level: levelAbove,
                maxLevel: aboveBlocks.length,
                nextSize:
                  levelAbove < aboveBlocks.length
                    ? aboveBlocks[levelAbove].length
                    : 0,
              }
            : hydrationPending && hunk.newStart > 1
              ? { level: 0, maxLevel: 0, nextSize: 0, pending: true }
              : undefined;

        // Below: until we've seen the file we can't tell whether the hunk
        // ends at EOF, so render the placeholder unconditionally — the bar
        // disappears post-hydrate if there really was nothing below.
        const expandBelow: ExpandBarViewModel | undefined =
          belowBlocks.length > 0
            ? {
                level: levelBelow,
                maxLevel: belowBlocks.length,
                nextSize:
                  levelBelow < belowBlocks.length
                    ? belowBlocks[levelBelow].length
                    : 0,
              }
            : hydrationPending
              ? { level: 0, maxLevel: 0, nextSize: 0, pending: true }
              : undefined;

        // Selection range — only applies when it targets this hunk.
        const selForHunk =
          selection && selection.hunkId === hunk.id ? selection : null;
        const selLo = selForHunk
          ? Math.min(selForHunk.anchor, selForHunk.head)
          : -1;
        const selHi = selForHunk
          ? Math.max(selForHunk.anchor, selForHunk.head)
          : -1;

        // Lines carrying at least one user comment thread — prefix-scan
        // `user:<hunkId>:<lineIdx>:<id>` keys, since the id segment makes
        // each comment its own key.
        const userCommentLines = new Set<number>();
        for (const [k, list] of Object.entries(replies)) {
          if ((list?.length ?? 0) === 0) continue;
          const parsed = parseReplyKey(k);
          if (parsed?.kind === "user" && parsed.hunkId === hunk.id)
            userCommentLines.add(parsed.lineIdx);
        }

        // Build per-line view models.
        const lines: DiffLineViewModel[] = hunk.lines.map((line, i) => {
          const isAcked = acked.has(`${hunk.id}:${i}`);
          const hasUserComment = userCommentLines.has(i);
          const aiNote = aiNoteByLine[`${hunk.id}:${i}`];
          const sev = aiNote?.severity;

          const aiGlyph = isAcked
            ? "✓"
            : sev === "warning"
              ? "!"
              : sev === "question"
                ? "?"
                : sev
                  ? "✦"
                  : hasUserComment
                    ? "“"
                    : " ";

          return {
            kind: line.kind,
            text: line.text,
            oldNo: line.oldNo,
            newNo: line.newNo,
            isCursor: isCurrent && i === cursorLineIdx,
            isRead: readForHunk.has(i),
            isSelected: selForHunk !== null && i >= selLo && i <= selHi,
            aiNote,
            isAcked,
            hasUserComment,
            aiGlyph,
          };
        });

        return {
          id: hunk.id,
          header: hunk.header,
          coverage,
          isCurrent,
          aiReviewed: hunk.aiReviewed ?? false,
          aiSummary: aiSummaryByHunk[hunk.id],
          teammateReview: teammateByHunk[hunk.id],
          definesSymbols: hunk.definesSymbols ?? [],
          referencesSymbols: hunk.referencesSymbols ?? [],
          expandAbove,
          expandBelow,
          contextAbove,
          contextBelow,
          lines,
        };
      });

  return {
    path: file.path,
    language: file.language,
    status: file.status,
    fileId: file.id,
    isFileReviewed,
    canExpandFile,
    fileFullyExpanded: fileFullyExpanded && !previewing,
    fullFileLines,
    hunks,
    filePreviewing: previewing,
    canPreview,
    previewSource,
    imageAssets,
  };
}

// ─── Sidebar view model ───────────────────────────────────────────────────────

export interface SidebarFileItem {
  fileId: string;
  path: string;
  status: FileStatus;
  /** Pre-computed status character: "A" | "M" | "D" | "R" | "?". */
  statusChar: string;
  /** True when the reviewer has signed off on this file. The verdict signal. */
  isReviewed: boolean;
  /** 0–1 fraction of lines the cursor has visited. */
  readCoverage: number;
  /** Pre-computed read percentage, e.g. 42. */
  readPct: number;
  /** Pre-computed read meter (8-block bar): e.g. "█████░░░". */
  meterBar: string;
  /** True when this is the file the cursor is currently in. */
  isCurrent: boolean;
  /**
   * Number of replies posted across this file's hunks — any thread kind
   * (user/block/note/hunkSummary/teammate). 0 when the file has none.
   */
  commentCount: number;
}

export interface SidebarViewModel {
  files: SidebarFileItem[];
  changesetId: string;
  quiz: QuizState;
}

function fileStatusChar(s: string): string {
  switch (s) {
    case "added":    return "A";
    case "modified": return "M";
    case "deleted":  return "D";
    case "renamed":  return "R";
    default:         return "?";
  }
}

export interface BuildSidebarViewModelArgs {
  files: Array<{ id: string; path: string; status: FileStatus; hunks: { id: string; lines: unknown[] }[] }>;
  currentFileId: string;
  changesetId: string;
  readLines: Record<string, Set<number>>;
  reviewedFiles: Set<string>;
  quiz: QuizState;
  /**
   * Interaction threads, keyed as in `types.ts` (`user:HUNK:LINE`,
   * `block:HUNK:LO-HI`, `note:HUNK:LINE`, `hunkSummary:HUNK`,
   * `teammate:HUNK`). Used to compute each file's comment count.
   * Defaults to none.
   */
  interactions?: Record<string, Interaction[]>;
}

/**
 * Count Interactions whose thread keys resolve to one of the files.
 * Skips ingest-sourced entries (AI / teammate) so the sidebar number
 * tracks user-driven activity, not the always-on AI annotations.
 */
function buildCommentCounts(
  files: BuildSidebarViewModelArgs["files"],
  interactions: Record<string, Interaction[]>,
): Map<string, number> {
  const hunkToFile = new Map<string, string>();
  for (const f of files) for (const h of f.hunks) hunkToFile.set(h.id, f.id);
  const counts = new Map<string, number>();
  for (const [key, list] of Object.entries(interactions)) {
    const parsed = parseReplyKey(key);
    if (!parsed) continue;
    const fileId =
      parsed.kind === "userFile" || parsed.kind === "blockFile"
        ? parsed.fileId
        : hunkToFile.get(parsed.hunkId);
    if (!fileId) continue;
    // Count user-driven activity: local replies and agent posts. The
    // teammate-verdict head on a `teammate:` thread is now also
    // `authorRole: "user"` but isn't local activity — skip it
    // structurally (it's the head, not a reply).
    const userish = list.filter((ix) => {
      if (ix.authorRole === "agent") return true;
      if (ix.authorRole !== "user") return false;
      if (key.startsWith("teammate:") && ix.target !== "reply") return false;
      return true;
    }).length;
    if (userish === 0) continue;
    counts.set(fileId, (counts.get(fileId) ?? 0) + userish);
  }
  return counts;
}

export function buildSidebarViewModel({
  files,
  currentFileId,
  changesetId,
  readLines,
  reviewedFiles,
  quiz,
  interactions = {},
}: BuildSidebarViewModelArgs): SidebarViewModel {
  const commentCounts = buildCommentCounts(files, interactions);
  const fileItems: SidebarFileItem[] = files.map((f) => {
    const readCoverage = fileCoverage(f, readLines);
    const readPct = Math.round(readCoverage * 100);
    // 8 blocks gives a finer signal than 4 — the old bar collapsed
    // 25–50% into a single block, which read as more progress than there was.
    const blocks = Math.round(readCoverage * 8);
    const meterBar = "█".repeat(blocks) + "░".repeat(8 - blocks);
    return {
      fileId: f.id,
      path: f.path,
      status: f.status,
      statusChar: fileStatusChar(f.status),
      isReviewed: reviewedFiles.has(f.id),
      readCoverage,
      readPct,
      meterBar,
      isCurrent: f.id === currentFileId,
      commentCount: commentCounts.get(f.id) ?? 0,
    };
  });

  return {
    files: fileItems,
    changesetId,
    quiz,
  };
}

// ─── StatusBar view model ─────────────────────────────────────────────────────

export interface StatusBarViewModel {
  /** 1-based current line number. */
  lineDisplay: string;
  /** 1-based current hunk number / total hunks. */
  hunkDisplay: string;
  /** 1-based current file number / total files. */
  fileDisplay: string;
  /** "read NN%" — fraction of lines the cursor has visited. */
  readDisplay: string;
  /** "files X/Y" — how many files the reviewer has signed off on. */
  filesDisplay: string;
  /**
   * Changeset-level sign-off cell. Null when the changeset has no stable
   * review token (paste / upload / stub / fixture / legacy worktree without
   * captured state) — the StatusBar hides the cell in that case (D6).
   * Otherwise: "changeset ✓" when signed off at the current revision,
   * "changeset" when not.
   */
  changesetSignOffDisplay: string | null;
  /**
   * True iff the current changeset's review token is in
   * `reviewedChangesets[csId]`. Drives the cell's "on" styling. Always
   * false when `changesetSignOffDisplay` is null.
   */
  changesetSignedOff: boolean;
  /**
   * "selection L12–L18 · c to comment" when the reviewer has an active
   * shift-extended selection. Null otherwise. Replaces the trailing hint
   * temporarily so the affordance is paired with the selection state.
   */
  selectionHint: string | null;
  /**
   * The trailing-hint text shown when no selection is active. The builder
   * picks the message from context — an unacked AI note on the cursor line
   * surfaces ack/reply; a fully-read file surfaces sign-off; otherwise the
   * standard menu. Keeps the most useful key one glance away instead of
   * burying it in the `?` overlay.
   */
  defaultHint: string;
}

export interface BuildStatusBarViewModelArgs {
  /** Total number of files in the changeset. */
  totalFiles: number;
  /** 0-based index of the current file in the changeset files array. */
  fileIdx: number;
  /** Total number of hunks in the current file. */
  totalHunks: number;
  /** 0-based index of the current hunk in the current file. */
  hunkIdx: number;
  /** Total number of lines in the current hunk. */
  totalLines: number;
  /** 0-based cursor line index within the current hunk. */
  lineIdx: number;
  /** 0–1 overall changeset read fraction (cursor visits). */
  readCoverage: number;
  /** Count of files the reviewer has signed off on. */
  reviewedFiles: number;
  /**
   * Active shift-extended selection (or null). When set, the status
   * bar emits a selectionHint instead of leaving the user to discover
   * the block-comment affordance from Help.
   */
  selection: { lo: number; hi: number; loLineNo: number; hiLineNo: number } | null;
  /** True when the cursor line carries an AI note. */
  lineHasAiNote: boolean;
  /** True when that AI note has already been acked. */
  lineNoteAcked: boolean;
  /** 0–1 read fraction for the current file. 1 when fully visited. */
  currentFileReadFraction: number;
  /** True when the reviewer has signed off on the current file. */
  currentFileReviewed: boolean;
  /**
   * Null when the current changeset has no stable review token; the
   * StatusBar hides the cell in that case (D6). Otherwise the boolean is
   * the sign-off state at the current revision.
   */
  currentChangesetSignedOff: boolean | null;
}

const DEFAULT_HINT =
  "? full help · ⌘K commands · j/k line · ]/[ file · c comment · ⇧M sign off";

export function buildStatusBarViewModel({
  totalFiles,
  fileIdx,
  totalHunks,
  hunkIdx,
  totalLines,
  lineIdx,
  readCoverage,
  reviewedFiles,
  selection,
  lineHasAiNote,
  lineNoteAcked,
  currentFileReadFraction,
  currentFileReviewed,
  currentChangesetSignedOff,
}: BuildStatusBarViewModelArgs): StatusBarViewModel {
  // Priority: an unacked note on the current line is the most actionable
  // signal — surface r/a first. Then, when the whole changeset has been
  // read but no top-level verdict is in yet, nudge ⇧S (the terminal action).
  // Otherwise, if just the current file is fully read but not signed off,
  // nudge ⇧M. Fall back to the standard menu. The changeset nudge gates on
  // `=== false` so it skips both the already-signed case and the null-token
  // case where the cell is hidden.
  let defaultHint: string;
  if (lineHasAiNote && !lineNoteAcked) {
    defaultHint = "a ack · r reply · c comment · ]/[ file · ? help";
  } else if (readCoverage >= 1 && currentChangesetSignedOff === false) {
    defaultHint = "⇧S sign off changeset · / prompt · ? help";
  } else if (currentFileReadFraction >= 1 && !currentFileReviewed) {
    defaultHint = "⇧M sign off this file · ]/[ next file · / prompt · ? help";
  } else {
    defaultHint = DEFAULT_HINT;
  }

  return {
    lineDisplay: `line ${lineIdx + 1}/${totalLines}`,
    hunkDisplay: `hunk ${hunkIdx + 1}/${totalHunks}`,
    fileDisplay: `file ${fileIdx + 1}/${totalFiles}`,
    readDisplay: `read ${Math.round(readCoverage * 100)}%`,
    filesDisplay: `reviewed ${reviewedFiles}/${totalFiles}`,
    changesetSignOffDisplay:
      currentChangesetSignedOff === null
        ? null
        : currentChangesetSignedOff
          ? "changeset ✓"
          : "changeset",
    changesetSignedOff: currentChangesetSignedOff === true,
    selectionHint: selection
      ? `selection L${selection.loLineNo}–L${selection.hiLineNo} · c to comment`
      : null,
    defaultHint,
  };
}

// ─── GuidePrompt view model ───────────────────────────────────────────────────

/**
 * A pre-tokenized segment of the guide suggestion reason text.
 * Plain text, inline-code, and symbol link segments map directly to the
 * same rendered output that RichText would produce — without needing the
 * live SymbolIndex at render time.
 */
export type RichSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "symbol"; text: string; target: Cursor }
  | { kind: "code-symbol"; text: string; target: Cursor };

export interface GuidePromptViewModel {
  id: string;
  /** Pre-tokenized reason text for rendering without SymbolIndex. */
  segments: RichSegment[];
  /** Pre-resolved jump target for the primary suggestion action. */
  targetCursor: Cursor;
}

// Mirrors the tokenization in RichText.tsx so the presenter produces the
// same output without needing the live SymbolIndex.
const TICK_RE = /`([^`]+)`/g;
const IDENT_RE = /([A-Za-z_$][A-Za-z0-9_$]*)/g;

function scanPlainSegments(text: string, symbols: SymbolIndex): RichSegment[] {
  const out: RichSegment[] = [];
  let lastEnd = 0;
  for (const m of text.matchAll(IDENT_RE)) {
    const start = m.index ?? 0;
    const name = m[1];
    const target = symbols.get(name);
    if (!target) continue;
    if (start > lastEnd) {
      out.push({ kind: "text", text: text.slice(lastEnd, start) });
    }
    out.push({ kind: "symbol", text: name, target });
    lastEnd = start + name.length;
  }
  if (lastEnd < text.length) {
    out.push({ kind: "text", text: text.slice(lastEnd) });
  }
  return out;
}

function tokenizeReason(text: string, symbols: SymbolIndex): RichSegment[] {
  const parts: RichSegment[] = [];
  let lastEnd = 0;
  for (const m of text.matchAll(TICK_RE)) {
    const start = m.index ?? 0;
    if (start > lastEnd) {
      parts.push(...scanPlainSegments(text.slice(lastEnd, start), symbols));
    }
    const inner = m[1];
    const target = symbols.get(inner.trim());
    if (target) {
      parts.push({ kind: "code-symbol", text: inner, target });
    } else {
      parts.push({ kind: "code", text: inner });
    }
    lastEnd = start + m[0].length;
  }
  if (lastEnd < text.length) {
    parts.push(...scanPlainSegments(text.slice(lastEnd), symbols));
  }
  return parts;
}

export function buildGuidePromptViewModel(
  suggestion: GuideSuggestion,
  symbolIndex: SymbolIndex,
  currentChangeSetId: string,
): GuidePromptViewModel | null {
  if (!suggestion) return null;

  const segments = tokenizeReason(suggestion.reason, symbolIndex);
  const targetCursor: Cursor = {
    changesetId: currentChangeSetId,
    fileId: suggestion.toFileId,
    hunkId: suggestion.toHunkId,
    lineIdx: suggestion.toLineIdx,
  };

  return {
    id: suggestion.id,
    segments,
    targetCursor,
  };
}

// ─── Inspector view model ─────────────────────────────────────────────────────

/** A single AI note row in the Inspector's "AI concerns" panel. */
export interface AiNoteRowItem {
  /** 0-based line index within the hunk — used as key and for jump callbacks. */
  lineIdx: number;
  /** 1-based display line number (prefers newNo over oldNo, falls back to lineIdx+1). */
  lineNo: number;
  severity: AiNoteSeverity;
  /** Pre-computed severity glyph: "!" | "?" | "i". */
  sevGlyph: string;
  summary: string;
  detail?: string;
  isAcked: boolean;
  /** True when this line is the cursor position. */
  isCurrent: boolean;
  /** Thread key for this note (passed to onStartDraft / onSubmitReply). */
  replyKey: string;
  /** Existing replies on this note's thread. */
  replies: Interaction[];
  /** True when the draft composer is open for this note. */
  isDrafting: boolean;
  /** Jump target that lands on this note's line. */
  jumpTarget: Cursor;
  /**
   * Pre-flighted recipe for the runner — drives the `▷ verify` button.
   * Undefined when the AI note has no recipe attached.
   */
  runRecipe?: {
    source: string;
    inputs: Record<string, string>;
  };
}

/** A single user-started comment thread row. */
export interface UserCommentRowItem {
  /** Anchor line (start of the range for block threads). */
  lineIdx: number;
  lineNo: number;
  /**
   * When present, this thread spans lineIdx..rangeHiLineIdx inclusive — a
   * block comment. UI should render the label as "L{lineNo}–L{rangeHiLineNo}".
   */
  rangeHiLineIdx?: number;
  rangeHiLineNo?: number;
  /** Thread key for this user comment. */
  threadKey: string;
  replies: Interaction[];
  isDrafting: boolean;
  /** True when the cursor is on (or within, for block threads) this row. */
  isCurrent: boolean;
  jumpTarget: Cursor;
}

export interface InspectorViewModel {
  // ── Location section ───────────────────────────────────────────────────
  /** Display string: "path/file.ts:42" or just "path/file.ts". */
  locationLabel: string;
  language: string;
  lineKind: LineKind;
  lineText: string;
  lineSign: string;

  // ── AI concerns panel ──────────────────────────────────────────────────
  /** Whether any AI notes exist on this hunk. */
  hasAiNotes: boolean;
  /** "none" or "N/M acked". */
  aiNoteCountLabel: string;
  aiNoteRows: AiNoteRowItem[];
  /**
   * When the cursor is NOT on a noted line but the hunk has notes, this
   * points at the nearest one. Renders as a small clickable chip in the
   * AI section header so the count is paired with a navigation cue.
   * null when there are no notes, or when the cursor is already on one.
   */
  nextNoteHint: {
    label: string;
    jumpTarget: Cursor;
  } | null;

  // ── AI hunk summary panel (absent when hunk has no aiSummary) ──────────
  aiSummary: string | null;
  /** Thread key for the hunk summary thread. */
  aiSummaryReplyKey: string | null;
  aiSummaryReplies: Interaction[];
  aiSummaryIsDrafting: boolean;
  /** Jump target for "click to jump to the top of this hunk". */
  aiSummaryJumpTarget: Cursor | null;

  // ── Teammate review panel (absent when hunk has no teammateReview) ─────
  teammate: {
    user: string;
    verdict: "approve" | "comment";
    verdictGlyph: string;
    note?: string;
    verdictClass: string;
    replyKey: string;
    replies: Interaction[];
    isDrafting: boolean;
    jumpTarget: Cursor;
  } | null;

  // ── User comments panel ────────────────────────────────────────────────
  /** "none" or "N thread(s)". */
  userCommentCountLabel: string;
  userCommentRows: UserCommentRowItem[];
  /** Whether a new-thread button should be shown for the current line. */
  showNewCommentCta: boolean;
  /** 1-based line number of the cursor line (for the "+ comment on L…" CTA). */
  currentLineNo: number;
  /** Cursor hunk + line — the "+ comment" CTA mints a fresh thread key here. */
  cursorHunkId: string;
  cursorLineIdx: number;
  /** True when a draft is open on the current line but no thread exists yet. */
  showDraftStub: boolean;
  draftStubRow: UserCommentRowItem | null;

  // ── Detached threads (file-scoped) ─────────────────────────────────────
  /**
   * Threads on this file whose anchor didn't survive the latest reload.
   * Grouped by their original threadKey so multi-reply threads stay
   * together. Empty when nothing on this file is detached.
   */
  detachedThreads: DetachedThreadRowItem[];
}

/**
 * A detached-thread card in the Inspector. The line anchor is gone, so we
 * surface what we still have: the captured snippet, the original line ref,
 * and the original SHA for the "view at" affordance.
 */
export interface DetachedThreadRowItem {
  /** Original thread key the messages were posted to. Stable React key. */
  threadKey: string;
  /** All messages on this detached thread, in author order. */
  replies: Interaction[];
  /** Repo-relative path the thread was anchored to; "" for anchorless legacy entries. */
  anchorPath: string;
  /** 1-based anchor line if the original interaction captured one. */
  anchorLineNo?: number;
  /** Captured code context, ready to render in a snippet block. */
  snippetLines: { kind: LineKind; text: string; sign: string }[];
  /** "committed" | "dirty" from the head interaction — drives the caption. */
  originType: "committed" | "dirty";
  /** Full origin sha; "" when none was captured (view-at hides itself). */
  originSha: string;
  /** First 7 chars of `originSha`; "" when none. */
  originSha7: string;
  /** True when a draft composer is open on this thread. */
  isDrafting: boolean;
}

export interface BuildInspectorViewModelArgs {
  /** The file the cursor is in. */
  file: DiffFile;
  /** The hunk the cursor is in. */
  hunk: { id: string; lines: DiffLine[] };
  /** The line at the cursor position. */
  line: DiffLine;
  /** Full cursor (needed to build jump targets). */
  cursor: Cursor;
  /** Symbol index for this changeset (passed through to ReplyThread unchanged). */
  symbols: SymbolIndex;
  /** Set of acked note keys (format: `${hunkId}:${lineIdx}`). */
  acked: Set<string>;
  /** All interaction threads keyed by reply-target key. */
  replies: Record<string, Interaction[]>;
  /** The reply key currently being drafted, or null. */
  draftingKey: string | null;
  /**
   * AI per-line / per-hunk + teammate signals, built by
   * `selectIngestSignals(state)`. Defaults to empty when callers haven't
   * threaded a state through (transitional — tests and a couple of demo
   * harnesses still pass {}).
   */
  signals?: IngestSignals;
  /**
   * Interactions whose anchor didn't survive the latest reload. The
   * Inspector filters down to those on the current file. Defaults to none.
   */
  detachedInteractions?: DetachedInteraction[];
}

/** Context shared by the row builders below — the bits both call sites read. */
interface RowBuildContext {
  cursor: Cursor;
  acked: Set<string>;
  replies: Record<string, Interaction[]>;
  draftingKey: string | null;
}

/**
 * Build one `AiNoteRowItem` from a noted line. Shared by
 * `buildInspectorViewModel` and `buildLineThreadsProjection` so the two
 * row shapes can't drift.
 */
function buildAiNoteRow(
  hunk: { id: string; lines: DiffLine[] },
  lineIdx: number,
  note: AiNote,
  { cursor, acked, replies, draftingKey }: RowBuildContext,
): AiNoteRowItem {
  const l = hunk.lines[lineIdx];
  const rkey = lineNoteReplyKey(hunk.id, lineIdx);
  return {
    lineIdx,
    lineNo: l?.newNo ?? l?.oldNo ?? lineIdx + 1,
    severity: note.severity,
    sevGlyph:
      note.severity === "warning" ? "!" :
      note.severity === "question" ? "?" : "i",
    summary: note.summary,
    detail: note.detail,
    isAcked: acked.has(`${hunk.id}:${lineIdx}`),
    isCurrent: hunk.id === cursor.hunkId && lineIdx === cursor.lineIdx,
    replyKey: rkey,
    replies: replies[rkey] ?? [],
    isDrafting: draftingKey === rkey,
    jumpTarget: { ...cursor, hunkId: hunk.id, lineIdx },
    runRecipe: note.runRecipe,
  };
}

/**
 * Build one `UserCommentRowItem` from a parsed `user:`/`block:` key. Shared
 * by `buildInspectorViewModel` and `buildLineThreadsProjection`. Draft policy
 * (which keys to scan) lives at the call site, not here.
 */
function buildUserCommentRow(
  parsed: Extract<ParsedReplyKey, { kind: "user" | "block" }>,
  hunk: { id: string; lines: DiffLine[] },
  threadKey: string,
  { cursor, replies, draftingKey }: RowBuildContext,
): UserCommentRowItem {
  if (parsed.kind === "user") {
    const l = hunk.lines[parsed.lineIdx];
    return {
      lineIdx: parsed.lineIdx,
      lineNo: l?.newNo ?? l?.oldNo ?? parsed.lineIdx + 1,
      threadKey,
      replies: replies[threadKey] ?? [],
      isDrafting: draftingKey === threadKey,
      isCurrent: hunk.id === cursor.hunkId && parsed.lineIdx === cursor.lineIdx,
      jumpTarget: { ...cursor, hunkId: hunk.id, lineIdx: parsed.lineIdx },
    };
  }
  const loLine = hunk.lines[parsed.lo];
  const hiLine = hunk.lines[parsed.hi];
  return {
    lineIdx: parsed.lo,
    lineNo: loLine?.newNo ?? loLine?.oldNo ?? parsed.lo + 1,
    rangeHiLineIdx: parsed.hi,
    rangeHiLineNo: hiLine?.newNo ?? hiLine?.oldNo ?? parsed.hi + 1,
    threadKey,
    replies: replies[threadKey] ?? [],
    isDrafting: draftingKey === threadKey,
    isCurrent:
      hunk.id === cursor.hunkId &&
      cursor.lineIdx >= parsed.lo &&
      cursor.lineIdx <= parsed.hi,
    jumpTarget: { ...cursor, hunkId: hunk.id, lineIdx: parsed.lo },
  };
}

export function buildInspectorViewModel({
  file,
  hunk,
  line,
  cursor,
  acked,
  replies,
  draftingKey,
  signals,
  detachedInteractions = [],
}: BuildInspectorViewModelArgs): InspectorViewModel {
  const aiNoteByLine = signals?.aiNoteByLine ?? {};
  const aiSummaryByHunk = signals?.aiSummaryByHunk ?? {};
  const teammateByHunk = signals?.teammateByHunk ?? {};
  // ── Location ────────────────────────────────────────────────────────────
  const lineNo = line.newNo ?? line.oldNo;
  const locationLabel = lineNo ? `${file.path}:${lineNo}` : file.path;
  const lineSign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";

  // ── AI note rows ────────────────────────────────────────────────────────
  const noteLinesWithIdx = hunk.lines
    .map((l, i) => ({ l, i, note: aiNoteByLine[`${hunk.id}:${i}`] }))
    .filter((entry): entry is { l: DiffLine; i: number; note: AiNote } => !!entry.note);

  const rowCtx: RowBuildContext = { cursor, acked, replies, draftingKey };
  const aiNoteRows: AiNoteRowItem[] = noteLinesWithIdx.map(({ i, note }) =>
    buildAiNoteRow(hunk, i, note, rowCtx),
  );

  const ackedCount = aiNoteRows.filter((r) => r.isAcked).length;
  const aiNoteCountLabel =
    aiNoteRows.length === 0
      ? "none"
      : `${ackedCount}/${aiNoteRows.length} acked`;

  // Find the nearest note to the cursor when the cursor isn't on one.
  // Prefers below; falls back to above. The chip in the inspector header
  // becomes the only "do something" affordance when notes exist but
  // none target the current line.
  const cursorOnNote = aiNoteRows.some((r) => r.isCurrent);
  let nextNoteHint: InspectorViewModel["nextNoteHint"] = null;
  if (!cursorOnNote && aiNoteRows.length > 0) {
    const below = aiNoteRows.find((r) => r.lineIdx > cursor.lineIdx);
    const above = [...aiNoteRows]
      .reverse()
      .find((r) => r.lineIdx < cursor.lineIdx);
    const target = below ?? above;
    if (target) {
      const arrow = below ? "↓" : "↑";
      nextNoteHint = {
        label: `${arrow} L${target.lineNo}`,
        jumpTarget: target.jumpTarget,
      };
    }
  }

  // ── AI hunk summary ─────────────────────────────────────────────────────
  const summaryReplyKey = hunkSummaryReplyKey(hunk.id);
  const aiSummary = aiSummaryByHunk[hunk.id] ?? null;
  const aiSummaryJumpTarget: Cursor | null = aiSummary
    ? { ...cursor, hunkId: hunk.id, lineIdx: 0 }
    : null;

  // ── Teammate ────────────────────────────────────────────────────────────
  const trKey = teammateReplyKey(hunk.id);
  const teammateSignal = teammateByHunk[hunk.id];
  const teammate: InspectorViewModel["teammate"] = teammateSignal
    ? {
        user: teammateSignal.user,
        verdict: teammateSignal.verdict,
        verdictGlyph: teammateSignal.verdict === "approve" ? "✓" : "💬",
        note: teammateSignal.note,
        verdictClass:
          teammateSignal.verdict === "approve" ? "info" : "question",
        replyKey: trKey,
        replies: replies[trKey] ?? [],
        isDrafting: draftingKey === trKey,
        jumpTarget: { ...cursor, hunkId: hunk.id, lineIdx: 0 },
      }
    : null;

  // ── User comment threads ────────────────────────────────────────────────
  const curHunkLine = hunk.lines[cursor.lineIdx];
  const currentLineNo =
    curHunkLine?.newNo ?? curHunkLine?.oldNo ?? cursor.lineIdx + 1;

  // A "new-comment draft" — a `user:` draft on the cursor line with no
  // messages yet. It drives the cursor-line stub, not a normal row, so the
  // "+ comment" CTA collapses into a composer. Block/line drafts with
  // messages, or drafts on other lines, are ordinary threads below.
  const draftParsed = draftingKey ? parseReplyKey(draftingKey) : null;
  const isNewCommentDraft =
    !!draftParsed &&
    draftParsed.kind === "user" &&
    draftParsed.hunkId === hunk.id &&
    draftParsed.lineIdx === cursor.lineIdx &&
    (replies[draftingKey!]?.length ?? 0) === 0;

  // Every `user:`/`block:` thread anchored in this hunk — prefix-scan
  // `replies` (and any in-progress `draftingKey`), since the id segment
  // means a line no longer maps to a single key.
  const threadKeys = new Set<string>();
  for (const [k, list] of Object.entries(replies)) {
    if ((list?.length ?? 0) > 0) threadKeys.add(k);
  }
  if (draftingKey && !isNewCommentDraft) threadKeys.add(draftingKey);

  // The new-comment draft key is excluded from `threadKeys` above — it drives
  // the draft stub, not an ordinary row — so every key here builds a real row.
  const userCommentRows: UserCommentRowItem[] = [];
  for (const key of threadKeys) {
    const parsed = parseReplyKey(key);
    // userFile/blockFile keys are file-anchored, not hunk-line threads.
    if (!parsed || (parsed.kind !== "user" && parsed.kind !== "block")) continue;
    if (parsed.hunkId !== hunk.id) continue;
    userCommentRows.push(buildUserCommentRow(parsed, hunk, key, rowCtx));
  }
  userCommentRows.sort((a, b) => a.lineIdx - b.lineIdx);

  const showNewCommentCta = !isNewCommentDraft;
  const showDraftStub = isNewCommentDraft;

  const draftStubRow: UserCommentRowItem | null = isNewCommentDraft
    ? {
        lineIdx: cursor.lineIdx,
        lineNo: currentLineNo,
        threadKey: draftingKey!,
        replies: [],
        isDrafting: true,
        isCurrent: true,
        jumpTarget: { ...cursor, hunkId: hunk.id, lineIdx: cursor.lineIdx },
      }
    : null;

  const userCommentCountLabel =
    userCommentRows.length === 0
      ? "none"
      : `${userCommentRows.length} thread${userCommentRows.length > 1 ? "s" : ""}`;

  // ── Detached threads on this file ──────────────────────────────────────
  // Group by original threadKey so multi-reply threads render together.
  // Caption/snippet come from the head (oldest) interaction in the group;
  // later replies inherit the same anchor by construction.
  //
  // Two buckets surface here: interactions whose anchorPath matches the
  // current file, and "anchorless" entries with no anchorPath at all
  // (legacy persisted shape). The anchorless ones appear on every file
  // because we have no better home for them.
  const detachedByThread = new Map<string, Interaction[]>();
  for (const d of detachedInteractions) {
    const p = d.interaction.anchorPath;
    const anchorless = !p;
    if (!anchorless && p !== file.path) continue;
    let arr = detachedByThread.get(d.threadKey);
    if (!arr) {
      arr = [];
      detachedByThread.set(d.threadKey, arr);
    }
    arr.push(d.interaction);
  }
  const detachedThreads: DetachedThreadRowItem[] = [];
  for (const [threadKey, msgs] of detachedByThread) {
    // Local replies posted after the thread was detached land in the
    // normal interactions map under the same key — pull them in so the
    // conversation reads as one thread.
    const liveReplies = replies[threadKey] ?? [];
    const merged = [...msgs, ...liveReplies].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const head = merged[0];
    const snippetLines = (head.anchorContext ?? []).map((l) => ({
      kind: l.kind,
      text: l.text,
      sign: l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ",
    }));
    detachedThreads.push({
      threadKey,
      replies: merged,
      anchorPath: head.anchorPath ?? "",
      anchorLineNo: head.anchorLineNo,
      snippetLines,
      originType: head.originType ?? "committed",
      originSha: head.originSha ?? "",
      originSha7: head.originSha ? head.originSha.slice(0, 7) : "",
      isDrafting: draftingKey === threadKey,
    });
  }
  // Sort anchored rows first (by their line), then anchorless ones at the
  // end (no useful order — fall back to threadKey).
  detachedThreads.sort((a, b) => {
    const aAnchored = !!a.anchorPath;
    const bAnchored = !!b.anchorPath;
    if (aAnchored !== bAnchored) return aAnchored ? -1 : 1;
    return (
      (a.anchorLineNo ?? 0) - (b.anchorLineNo ?? 0) ||
      a.threadKey.localeCompare(b.threadKey)
    );
  });

  return {
    locationLabel,
    language: file.language,
    lineKind: line.kind,
    lineText: line.text,
    lineSign,

    hasAiNotes: aiNoteRows.length > 0,
    aiNoteCountLabel,
    aiNoteRows,
    nextNoteHint,

    aiSummary,
    aiSummaryReplyKey: aiSummary ? summaryReplyKey : null,
    aiSummaryReplies: aiSummary ? (replies[summaryReplyKey] ?? []) : [],
    aiSummaryIsDrafting: draftingKey === summaryReplyKey,
    aiSummaryJumpTarget,

    teammate,

    userCommentCountLabel,
    userCommentRows,
    showNewCommentCta,
    currentLineNo,
    cursorHunkId: hunk.id,
    cursorLineIdx: cursor.lineIdx,
    showDraftStub,
    draftStubRow,

    detachedThreads,
  };
}

/**
 * Threads anchored to one diff line: the AI note(s) and user-comment thread(s)
 * whose anchor is `(hunkId, lineIdx)`. `isCursor` marks the cursor line — its
 * inline block additionally carries the "+ comment" CTA / draft composer,
 * which come from the cursor-scoped `InspectorViewModel`, not from here.
 */
export interface LineThreadsEntry {
  hunkId: string;
  lineIdx: number;
  isCursor: boolean;
  aiNoteRows: AiNoteRowItem[];
  userCommentRows: UserCommentRowItem[];
}

/**
 * Per-line thread projection covering every hunk of one file. Unlike
 * `buildInspectorViewModel` (cursor-hunk only), this lets the inline render
 * mount a thread block under any line, anywhere in the diff. Pure function
 * of the file's hunks + interaction state.
 */
export type LineThreadsProjection = LineThreadsEntry[];

export interface BuildLineThreadsProjectionArgs {
  /** Every hunk of the file shown in DiffView. */
  hunks: { id: string; lines: DiffLine[] }[];
  cursor: Cursor;
  acked: Set<string>;
  replies: Record<string, Interaction[]>;
  draftingKey: string | null;
  signals?: IngestSignals;
}

/**
 * Build the per-line thread projection for a whole file. Walks every hunk's
 * AI-note signals and every `user:`/`block:` thread, bucketing them by
 * anchor line. Block threads anchor to their `hi` (last) line. Empty lines
 * are omitted — only lines with at least one thread appear.
 */
export function buildLineThreadsProjection({
  hunks,
  cursor,
  acked,
  replies,
  draftingKey,
  signals,
}: BuildLineThreadsProjectionArgs): LineThreadsProjection {
  const aiNoteByLine = signals?.aiNoteByLine ?? {};
  const byLine = new Map<string, LineThreadsEntry>();

  const entryFor = (hunkId: string, lineIdx: number): LineThreadsEntry => {
    const mapKey = `${hunkId}:${lineIdx}`;
    let entry = byLine.get(mapKey);
    if (!entry) {
      entry = {
        hunkId,
        lineIdx,
        isCursor: hunkId === cursor.hunkId && lineIdx === cursor.lineIdx,
        aiNoteRows: [],
        userCommentRows: [],
      };
      byLine.set(mapKey, entry);
    }
    return entry;
  };

  const rowCtx: RowBuildContext = { cursor, acked, replies, draftingKey };

  for (const hunk of hunks) {
    // AI notes — one per noted line.
    hunk.lines.forEach((_l, i) => {
      const note = aiNoteByLine[`${hunk.id}:${i}`];
      if (!note) return;
      entryFor(hunk.id, i).aiNoteRows.push(buildAiNoteRow(hunk, i, note, rowCtx));
    });
  }

  // User comment threads — prefix-scan every `user:`/`block:` key (plus an
  // open draft) and bucket by anchor line. A line no longer maps to a single
  // key, so a scan is the only way to find every thread.
  const hunkById = new Map(hunks.map((h) => [h.id, h]));
  const threadKeys = new Set<string>();
  for (const [k, list] of Object.entries(replies)) {
    if ((list?.length ?? 0) > 0) threadKeys.add(k);
  }
  // Skip an empty new-comment draft on the cursor line: it drives the inline
  // composer (sourced from the cursor InspectorViewModel), not an ordinary
  // row — including it here would render a stray empty card. Mirrors
  // `buildInspectorViewModel`'s `isNewCommentDraft` exclusion.
  const draftParsed = draftingKey ? parseReplyKey(draftingKey) : null;
  const isNewCommentDraft =
    !!draftParsed &&
    draftParsed.kind === "user" &&
    draftParsed.hunkId === cursor.hunkId &&
    draftParsed.lineIdx === cursor.lineIdx &&
    (replies[draftingKey!]?.length ?? 0) === 0;
  if (draftingKey && !isNewCommentDraft) threadKeys.add(draftingKey);

  for (const key of threadKeys) {
    const parsed = parseReplyKey(key);
    // userFile/blockFile keys are file-anchored, not hunk-line threads.
    if (!parsed || (parsed.kind !== "user" && parsed.kind !== "block")) continue;
    const hunk = hunkById.get(parsed.hunkId);
    if (!hunk) continue;
    // A block thread has no single line — anchor it to its last line (hi)
    // so the projection and the cursor-line render agree. Line threads
    // keep their single anchor line.
    const anchorLine = parsed.kind === "block" ? parsed.hi : parsed.lineIdx;
    entryFor(hunk.id, anchorLine).userCommentRows.push(
      buildUserCommentRow(parsed, hunk, key, rowCtx),
    );
  }

  for (const entry of byLine.values()) {
    entry.aiNoteRows.sort((a, b) => a.lineIdx - b.lineIdx);
    entry.userCommentRows.sort((a, b) =>
      a.threadKey.localeCompare(b.threadKey),
    );
  }
  return [...byLine.values()].sort(
    (a, b) =>
      a.hunkId.localeCompare(b.hunkId) || a.lineIdx - b.lineIdx,
  );
}

/**
 * Narrow a line-threads projection to cursor-active threads — used when
 * "hide non-active comments" is on. `row.isCurrent` already encodes
 * "active": the cursor is on the line (AI note / line comment) or within
 * the range (block comment). Entries left with no active rows are dropped;
 * a kept block row still lives in its `hi`-line entry, so an active block
 * renders at the hunk's last line.
 */
export function filterActiveLineThreads(
  projection: LineThreadsProjection,
): LineThreadsProjection {
  const out: LineThreadsProjection = [];
  for (const entry of projection) {
    const aiNoteRows = entry.aiNoteRows.filter((r) => r.isCurrent);
    const userCommentRows = entry.userCommentRows.filter((r) => r.isCurrent);
    if (aiNoteRows.length === 0 && userCommentRows.length === 0) continue;
    out.push({ ...entry, aiNoteRows, userCommentRows });
  }
  return out;
}
