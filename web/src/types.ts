export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  definesSymbols?: string[];
  /** Subset of `definesSymbols` declared with the `export` keyword. */
  exportedSymbols?: string[];
  referencesSymbols?: string[];
  aiReviewed?: boolean;
  /**
   * Ordered from nearest to farthest: the first element is the block
   * immediately enclosing the hunk; each subsequent element is one
   * scope further out (nearest enclosing function → module scope →
   * file top, for example).
   */
  expandAbove?: DiffLine[][];
  expandBelow?: DiffLine[][];
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed";

export interface DiffFile {
  id: string;
  path: string;
  language: string;
  status: FileStatus;
  hunks: Hunk[];
  /** Full file contents for the "expand entire file" view. */
  fullContent?: DiffLine[];
  /**
   * Post-change file content as a single string. The markdown preview uses
   * this to render the file as it'll look once merged. Backed by the
   * `fileContents` map the worktree-changeset endpoint returns; fixtures
   * with `fullContent` already contain the same data, so this is mainly a
   * carrier for diffs we can't reconstruct from hunks alone.
   */
  postChangeText?: string;
}

export type FileRole =
  | "component"
  | "hook"
  | "route"
  | "test"
  | "entity"
  | "type-def"
  | "schema"
  | "migration"
  | "config"
  | "fixture"
  | "prompt"
  | "doc"
  | "style"
  | "code";

export type EdgeKind = "imports" | "tests" | "uses-hook" | "uses-type" | "references";

export interface SymbolShape {
  classes?: number;
  interfaces?: number;
  methods?: number;
  properties?: number;
  functions?: number;
  variables?: number;
  constants?: number;
  enums?: number;
  types?: number;
  modules?: number;
  namespaces?: number;
}

export type SymbolSummaryKind =
  | "Class"
  | "Interface"
  | "Method"
  | "Property"
  | "Function"
  | "Variable"
  | "Constant"
  | "Enum"
  | "Module"
  | "Namespace"
  | "Type";

export interface SymbolSummary {
  name: string;
  kind: SymbolSummaryKind;
  line: number;
}

export interface CodeGraphNode {
  path: string;
  isTest: boolean;
  /**
   * `"changed"` — file the caller asked about (every node in a worktree-scope
   * graph; the changed-file set in a diff-scope graph). `"context"` — an
   * unchanged repo file pulled in because a changed file references symbols
   * defined there. The diagram dims context nodes so the eye still tracks
   * "what the diff actually changed." Absent on legacy persisted graphs;
   * treat as `"changed"` for back-compat.
   */
  role?: "changed" | "context";
  /** Path/extension classifier output alone — never overridden. */
  pathRole: FileRole;
  /** Final classifier output after the LSP-shape upgrade. Equals
   *  `pathRole` when no LSP ran. The renderer uses this; the hover
   *  reveals disagreement when they differ. */
  fileRole: FileRole;
  /** LSP per-file symbol-kind tally. Absent on regex-only nodes. */
  shape?: SymbolShape;
  /** Top-level symbols, for hover-to-peek. Absent on regex-only nodes. */
  symbols?: SymbolSummary[];
  /** Distinct using-file count (post-filtered, matches what the diagram
   *  shows). Absent on regex-only nodes. */
  fanIn?: number;
}

export interface CodeGraphEdge {
  fromPath: string;
  toPath: string;
  labels: string[];
  kind: EdgeKind;
}

export interface CodeGraph {
  scope: "diff" | "repo";
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
}

export interface ChangeSet {
  id: string;
  title: string;
  author: string;
  branch: string;
  base: string;
  createdAt: string;
  description: string;
  files: DiffFile[];
  /**
   * Repo-relative path → URL (typically a data URL) for binary assets that
   * the markdown preview should resolve. Keys must match the path computed
   * from a markdown file's directory plus its relative image reference.
   */
  imageAssets?: Record<string, string>;
  /**
   * Optional dependency graph attached by the ingest path. Pasted/uploaded
   * diffs can derive a diff-scoped graph from changed hunks; worktree-backed
   * loads may attach a repo-scoped graph built from the checkout on disk.
   */
  graph?: CodeGraph;
  /**
   * Set when this ChangeSet was loaded from a local worktree — carries the
   * path + sha so the agent-context panel knows what to fetch. Travelling
   * with the ChangeSet (rather than as separate App state) means the
   * provenance survives page reloads and changeset switches.
   */
  worktreeSource?: WorktreeSource;
  /**
   * Set when this ChangeSet was loaded from a GitHub PR. Carries PR metadata
   * so the header can show title, state, refs, and a Refresh button.
   * May coexist with `worktreeSource` when a local worktree is overlaid with
   * matching PR metadata (worktree↔PR overlay).
   */
  prSource?: PrSource;
  /**
   * Issue-level discussion comments from the PR. Populated only when
   * `prSource` is set; empty array means the PR has no issue comments.
   */
  prConversation?: PrConversationItem[];
  /**
   * Per-commit breakdown for ranges/branches loaded from a worktree. Newest
   * first. Drives the per-commit render in the plan section. Absent on
   * paste/uploaded loads, dirty-only loads, and PR loads (the GitHub commits
   * endpoint isn't wired up yet).
   */
  commits?: ChangeSetCommit[];
}

export interface ChangeSetCommit {
  sha: string;
  shortSha: string;
  subject: string;
  /** Body of the commit message (everything after the subject line). May be empty. */
  body: string;
  author: string;
  date: string;
  parents: string[];
  /** Repo-relative paths touched by this commit. Empty for merges by default. */
  files: string[];
}

export interface Cursor {
  changesetId: string;
  fileId: string;
  hunkId: string;
  lineIdx: number;
}

/**
 * An interaction whose anchor no longer matches anywhere in the new diff.
 * Carries its original key so the persisted shape round-trips cleanly; the
 * interaction is unchanged from when it was authored — its `anchorContext`
 * snippet is what the Sidebar renders.
 */
export interface DetachedInteraction {
  interaction: Interaction;
  /** The thread key (note:/user:/block:/etc.) the interaction was attached to. */
  threadKey: string;
}

/**
 * A character-level subrange inside a single line. Only valid when its host
 * `LineSelection` is collapsed (anchor === head) — multi-line selections are
 * always line-granular. UTF-16 column offsets into `hunk.lines[lineIdx].text`,
 * with `fromCol < toCol`. Captured from the browser's native text selection
 * on mouseup over `.line__text`.
 */
export interface CharRange {
  lineIdx: number;
  fromCol: number;
  toCol: number;
}

/**
 * A contiguous line range within a single hunk, produced by shift-extending
 * the cursor or dragging with the mouse. `anchor` is where the selection
 * started; `head` is its current end. The effective range is
 * min(anchor, head)..max(anchor, head) inclusive. Selection collapses to null
 * on any non-extending move, hunk/file change, or Escape.
 *
 * `charRange` carries an optional sub-line text selection. Present only when
 * `anchor === head`; dropped on any motion that grows the line range and on
 * any cursor-move that collapses selection.
 */
export interface LineSelection {
  hunkId: string;
  anchor: number;
  head: number;
  charRange?: CharRange;
}

export interface ReviewState {
  cursor: Cursor;
  changesets: ChangeSet[];
  /**
   * Lines the cursor has visited, by hunk id. Auto-populated on every
   * cursor move. Renders as a dim gutter rail. Coverage from this map
   * is the "read" signal — informational, not a verdict.
   */
  readLines: Record<string, Set<number>>;
  /**
   * File ids the reviewer has explicitly signed off on, via Shift+M.
   * The single verdict gesture. Toggle: pressing again clears the file.
   */
  reviewedFiles: Set<string>;
  /**
   * Changeset-level sign-off, keyed by `changesetId` and valued by the list
   * of review tokens (`getChangesetReviewToken`) at which sign-off has been
   * given. The current revision reads as signed off iff its token is in the
   * list. Switching revisions is navigation, not invalidation — entries are
   * preserved on changeset load/reload. Toggled by Shift+S. See
   * `docs/concepts/review-state.md § Review tokens and revision-scoped sign-off`.
   */
  reviewedChangesets: Record<string, string[]>;
  dismissedGuides: Set<string>;
  /** keys are thread-target keys; see thread-key helpers */
  interactions: Record<string, Interaction[]>;
  /** Per-hunk count of blocks revealed above; 0 = nothing extra. */
  expandLevelAbove: Record<string, number>;
  expandLevelBelow: Record<string, number>;
  fullExpandedFiles: Set<string>;
  /**
   * File ids the reviewer has switched into rendered-preview mode (markdown
   * files only). Mutually exclusive with `fullExpandedFiles`.
   */
  previewedFiles: Set<string>;
  /** Active shift-extended selection; null when the cursor is a single line. */
  selection: LineSelection | null;
  /**
   * Interactions whose anchor didn't match anywhere in the latest reload of
   * their changeset. Per `docs/plans/worktree-live-reload.md`, the Sidebar
   * surfaces these in a "Detached" group so the thread is still visible even
   * though the line it was attached to is gone.
   */
  detachedInteractions: DetachedInteraction[];
}

// ── Review plan (the "where to begin" primitive) ──────────────────────────
// Every surface that makes a claim about the ChangeSet must carry evidence
// back to the diff. EvidenceRef is the pointer; Claim bundles text + refs.
// UI must refuse to render a claim whose `evidence` array is empty.

export type EvidenceRef =
  | { kind: "description" }
  | { kind: "file"; path: string }
  | { kind: "hunk"; hunkId: string }
  | { kind: "symbol"; name: string; definedIn: string };

export interface Claim {
  text: string;
  evidence: EvidenceRef[];
}

export interface StructureMapFile {
  fileId: string;
  path: string;
  status: FileStatus;
  added: number;
  removed: number;
  isTest: boolean;
}

export interface StructureMapSymbol {
  name: string;
  /** File path where the symbol is defined. */
  definedIn: string;
  /** File paths (within this ChangeSet) that reference it. */
  referencedIn: string[];
  /** True when the symbol is declared with `export` — i.e. part of the file's
   *  public surface. Symbols with `exported: true` are kept in the map even
   *  when `referencedIn` is empty, since they represent API additions whose
   *  consumers may live outside the ChangeSet. */
  exported: boolean;
}

export interface StructureMap {
  files: StructureMapFile[];
  symbols: StructureMapSymbol[];
}

export interface EntryPoint {
  fileId: string;
  hunkId?: string;
  reason: Claim;
}

export interface ReviewPlan {
  /** Verbatim from ChangeSet.title. */
  headline: string;
  /** Rule-based or AI-generated; each claim carries evidence. */
  intent: Claim[];
  map: StructureMap;
  /** Max 3; may be fewer if the diff doesn't warrant more. */
  entryPoints: EntryPoint[];
}

// ── Agent context (Claude Code session matched to a worktree) ────────────
// These mirror the server-side shapes in `server/src/agent-context.ts`. See
// `docs/concepts/agent-context.md` for the wider design.

export interface AgentSessionRef {
  sessionId: string;
  filePath: string;
  startedAt: string;
  lastEventAt: string;
  taskTitle: string | null;
  turnCount: number;
  cwds: string[];
}

export interface AgentToolCallSummary {
  name: string;
  filePath: string | null;
  oneLine: string;
}

export interface AgentMessage {
  uuid: string;
  role: "user" | "assistant" | "system";
  timestamp: string;
  text: string;
  toolCalls: AgentToolCallSummary[];
}

export interface AgentTodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface AgentContextSlice {
  session: AgentSessionRef;
  commitSha: string | null;
  fromTime: string | null;
  toTime: string;
  task: string | null;
  followUps: string[];
  todos: AgentTodoItem[];
  filesTouched: string[];
  messages: AgentMessage[];
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  model: string | null;
}

/**
 * Worktree probe for the live-reload poll. `sha` is the real HEAD sha;
 * `dirtyHash` is null on a clean tree and a digest of `git status --porcelain=v2`
 * otherwise. The pair (sha, dirtyHash) is the comparison key — any change in
 * either signals drift.
 */
export interface WorktreeState {
  sha: string;
  dirty: boolean;
  dirtyHash: string | null;
}

/**
 * Worktree provenance carried alongside a ChangeSet so the agent-context panel
 * knows what to fetch. Set when the changeset was loaded from a worktree;
 * null otherwise (URL ingest, paste, file upload).
 *
 * `state` is the worktree's observed (sha, dirty, dirtyHash) at load time.
 * The live-reload poll diffs against this baseline; null on legacy persisted
 * recents written before the field existed.
 */
export interface WorktreeSource {
  worktreePath: string;
  commitSha: string;
  branch: string | null;
  /**
   * True when the loaded view is `HEAD..working-tree` (uncommitted edits)
   * instead of `HEAD~1..HEAD`. Set by slice (a) of the live-reload plan;
   * comments authored against this view are tagged `originType: "dirty"`.
   * Absent / false means a normal committed view.
   */
  dirty?: boolean;
  /**
   * Set when the load was a range pick (LoadModal "pick range…" or topbar
   * re-slice). The picker prefills from this on next open. `includeDirty` is
   * only honoured server-side when `toRef === "HEAD"`.
   */
  range?: {
    fromRef: string;
    toRef: string;
    includeDirty: boolean;
  };
  state?: WorktreeState;
}

/**
 * Polling-baseline shape passed into the live-reload hook + banner. Derived
 * from the active ChangeSet's `worktreeSource`; null when no worktree is
 * loaded or when state wasn't captured (legacy data).
 */
export interface WorktreeProvenance {
  path: string;
  branch: string | null;
  state: WorktreeState;
}

/**
 * GitHub PR provenance carried alongside a ChangeSet when the diff was loaded
 * from a GitHub (or GHE) pull request. Carries enough metadata to render the
 * PR header and reissue a refresh. May coexist with `worktreeSource` when a
 * local-diff ChangeSet is overlaid with upstream PR metadata.
 */
export interface PrSource {
  host: string;
  owner: string;
  repo: string;
  number: number;
  htmlUrl: string;
  headSha: string;
  baseSha: string;
  state: "open" | "closed" | "merged";
  title: string;
  body: string;
  baseRef: string;
  headRef: string;
  /** ISO timestamp of when this PR data was last fetched from GitHub. */
  lastFetchedAt: string;
  /** Present when GitHub truncated the diff response. */
  truncation?: { kind: "files" | "patch"; reason: string };
}

/** Issue-level (non-line-anchored) PR discussion comment. */
export interface PrConversationItem {
  id: number;
  author: string;
  createdAt: string;
  body: string;
  htmlUrl: string;
}

// ── Review interactions (unified primitive) ──────────────────────────────
// See docs/plans/typed-review-interactions.md. One Interaction subsumes
// every reviewer signal — local user comment, AI note, teammate verdict,
// agent reply, agent-started top-level comment — in one shape.

/** What the interaction attaches to. Topology, not intent.
 *  `reply` covers replies to any parent — the parent's provenance is recoverable
 *  from the `threadKey` prefix (`note:` / `hunkSummary:` / `teammate:` / `user:` /
 *  `block:`) and the head interaction's `authorRole`. */
export type InteractionTarget = "line" | "block" | "reply";

/** Asks start a thread on code, or restate the thread's ask in a reply. */
export type AskIntent = "comment" | "question" | "request" | "blocker";

/**
 * Responses are only valid as replies to other interactions; never start
 * a fresh thread on a line of code.
 */
export type ResponseIntent = "ack" | "unack" | "accept" | "reject";

export type InteractionIntent = AskIntent | ResponseIntent;

/** Category of actor. `user` covers everyone human (local reviewer,
 *  PR-imported reviewers, teammate-ingest); the specific provenance lives
 *  in `author` (display name) and the `threadKey` prefix
 *  (`teammate:` flags an ingest-sourced verdict head). `ai` is the static
 *  annotation pipeline; `agent` is the live dialogue agent. */
export type InteractionAuthorRole = "user" | "ai" | "agent";

/**
 * The unified primitive. One shape for every reviewer signal. The author
 * dimension is encoded in `authorRole`; the role determines persistence
 * behaviour (`authorRole !== "user"` entries are stripped on persist and
 * regenerated from ingest on reload).
 */
export interface Interaction {
  id: string;
  threadKey: string;
  target: InteractionTarget;
  intent: InteractionIntent;
  author: string;
  authorRole: InteractionAuthorRole;
  body: string;
  createdAt: string;

  /** Anchoring — present on user-authored interactions. */
  anchorPath?: string;
  anchorHash?: string;
  anchorContext?: DiffLine[];
  anchorLineNo?: number;
  originSha?: string;
  originType?: "committed" | "dirty";

  /** Provenance — present on PR-imported interactions. */
  external?: { source: "pr"; htmlUrl: string };

  /** Verifier hook — present on some AI-authored interactions. */
  runRecipe?: { source: string; inputs: Record<string, string> };

  /**
   * Queue state mirrored from the server's StoredInteraction:
   *   `pending`   — enqueued to a worktree agent, not yet pulled
   *   `delivered` — the agent has fetched it
   *   absent/null — not enqueued
   */
  agentQueueStatus?: "pending" | "delivered" | null;
  /**
   * Transient client-only flag — the last enqueue request failed at the
   * network level. Drives the ⚠ retry pip; never persisted server-side.
   */
  enqueueError?: boolean;
}

export function isAskIntent(i: InteractionIntent): i is AskIntent {
  return i === "comment" || i === "question" || i === "request" || i === "blocker";
}

export function isResponseIntent(i: InteractionIntent): i is ResponseIntent {
  return i === "ack" || i === "unack" || i === "accept" || i === "reject";
}

/**
 * Validity rule: response intents only ever attach to other interactions
 * (i.e. the `reply` target). Asks attach to code (`line`/`block`) or to
 * other interactions.
 */
export function isValidInteractionPair(
  target: InteractionTarget,
  intent: InteractionIntent,
): boolean {
  if (target === "line" || target === "block") return isAskIntent(intent);
  return true;
}

export function noteKey(hunkId: string, lineIdx: number): string {
  return `${hunkId}:${lineIdx}`;
}
export function lineNoteReplyKey(hunkId: string, lineIdx: number): string {
  return `note:${hunkId}:${lineIdx}`;
}
export function hunkSummaryReplyKey(hunkId: string): string {
  return `hunkSummary:${hunkId}`;
}
export function teammateReplyKey(hunkId: string): string {
  return `teammate:${hunkId}`;
}
/**
 * Fresh user-started comment on a line (not a reply to AI/teammate). The
 * trailing `id` segment makes each comment its own thread — two comments on
 * the same line no longer collapse into one.
 */
export function userCommentKey(hunkId: string, lineIdx: number, id: string): string {
  return `user:${hunkId}:${lineIdx}:${id}`;
}
/**
 * Thread key for a user-started comment on a line range. `lo` and `hi` are
 * inclusive; callers must pass them pre-sorted (lo <= hi) so a key uniquely
 * identifies its range. The trailing `id` segment makes each comment its own
 * thread.
 */
export function blockCommentKey(
  hunkId: string,
  lo: number,
  hi: number,
  id: string,
): string {
  return `block:${hunkId}:${lo}-${hi}:${id}`;
}

/** Unique id segment for a per-comment thread key. */
export function mintCommentId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function userFileCommentKey(fileId: string, newNo: number): string {
  return `userFile:${fileId}:${newNo}`;
}
export function blockFileCommentKey(fileId: string, lo: number, hi: number): string {
  return `blockFile:${fileId}:${lo}-${hi}`;
}

/**
 * Parsed shape of a thread key. `lineIdx` is the anchor line (0 for thread
 * kinds with no line context); block keys also expose lo/hi for the range.
 */
export type ParsedReplyKey =
  | { kind: "note"; hunkId: string; lineIdx: number }
  | { kind: "user"; hunkId: string; lineIdx: number; id: string }
  | { kind: "block"; hunkId: string; lo: number; hi: number; lineIdx: number; id: string }
  | { kind: "userFile"; fileId: string; newNo: number; lineIdx: 0 }
  | { kind: "blockFile"; fileId: string; lo: number; hi: number; lineIdx: 0 }
  | { kind: "hunkSummary"; hunkId: string; lineIdx: 0 }
  | { kind: "teammate"; hunkId: string; lineIdx: 0 };

/**
 * Single source of truth for splitting reply keys back into their parts.
 * Hunk ids may contain `:` (PR csIds are `pr:host:owner:repo:N`), so for
 * suffix-bearing kinds we strip the trailing line/range with `lastIndexOf`.
 * Returns null for unknown kinds or malformed keys.
 */
export function parseReplyKey(key: string): ParsedReplyKey | null {
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const prefix = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  switch (prefix) {
    case "note": {
      const last = rest.lastIndexOf(":");
      if (last < 0) return null;
      const hunkId = rest.slice(0, last);
      if (hunkId.length === 0) return null;
      const lineIdx = parseInt(rest.slice(last + 1), 10);
      if (!Number.isFinite(lineIdx)) return null;
      return { kind: "note", hunkId, lineIdx };
    }
    case "user": {
      // rest is `hunkId:lineIdx:id` — strip the trailing two segments.
      const idColon = rest.lastIndexOf(":");
      if (idColon < 0) return null;
      const id = rest.slice(idColon + 1);
      if (id.length === 0) return null;
      const lineHead = rest.slice(0, idColon);
      const lineColon = lineHead.lastIndexOf(":");
      if (lineColon < 0) return null;
      const hunkId = lineHead.slice(0, lineColon);
      if (hunkId.length === 0) return null;
      const lineIdx = parseInt(lineHead.slice(lineColon + 1), 10);
      if (!Number.isFinite(lineIdx)) return null;
      return { kind: "user", hunkId, lineIdx, id };
    }
    case "block": {
      // rest is `hunkId:lo-hi:id` — strip the trailing two segments.
      const idColon = rest.lastIndexOf(":");
      if (idColon < 0) return null;
      const id = rest.slice(idColon + 1);
      if (id.length === 0) return null;
      const rangeHead = rest.slice(0, idColon);
      const rangeColon = rangeHead.lastIndexOf(":");
      if (rangeColon < 0) return null;
      const hunkId = rangeHead.slice(0, rangeColon);
      if (hunkId.length === 0) return null;
      const range = rangeHead.slice(rangeColon + 1);
      const dash = range.indexOf("-");
      if (dash < 0) return null;
      const lo = parseInt(range.slice(0, dash), 10);
      const hi = parseInt(range.slice(dash + 1), 10);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
      return { kind: "block", hunkId, lo, hi, lineIdx: lo, id };
    }
    case "userFile": {
      const last = rest.lastIndexOf(":");
      if (last < 0) return null;
      const fileId = rest.slice(0, last);
      if (fileId.length === 0) return null;
      const newNo = parseInt(rest.slice(last + 1), 10);
      if (!Number.isFinite(newNo)) return null;
      return { kind: "userFile", fileId, newNo, lineIdx: 0 };
    }
    case "blockFile": {
      const last = rest.lastIndexOf(":");
      if (last < 0) return null;
      const fileId = rest.slice(0, last);
      if (fileId.length === 0) return null;
      const range = rest.slice(last + 1);
      const dash = range.indexOf("-");
      if (dash < 0) return null;
      const lo = parseInt(range.slice(0, dash), 10);
      const hi = parseInt(range.slice(dash + 1), 10);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
      return { kind: "blockFile", fileId, lo, hi, lineIdx: 0 };
    }
    case "hunkSummary":
      if (rest.length === 0) return null;
      return { kind: "hunkSummary", hunkId: rest, lineIdx: 0 };
    case "teammate":
      if (rest.length === 0) return null;
      return { kind: "teammate", hunkId: rest, lineIdx: 0 };
    default:
      return null;
  }
}

// ── Agent interaction queue wire (mirror of server/src/agent-queue.ts) ───
// These shapes travel verbatim across the `/api/agent/*` endpoints. Keep in
// sync with the server-side definitions; they're the wire format for the
// pull channel described in docs/plans/share-review-comments.md.

/**
 * Wire shape of a delivered interaction returned by GET /api/agent/delivered.
 * Mirrors `DeliveredInteraction` in server/src/agent-queue.ts. The web only
 * uses the `id` (the client-authoritative interaction id, matched against a
 * local Interaction) and `deliveredAt` (to render the ✓ delivered pip
 * tooltip).
 */
export interface DeliveredInteraction {
  id: string;
  target: InteractionTarget;
  intent: InteractionIntent;
  author: string;
  authorRole: InteractionAuthorRole;
  /** Repo-relative path. */
  file: string;
  /** `"118"` or `"72-79"` — string so single lines and ranges both fit. */
  lines?: string;
  body: string;
  commitSha: string;
  /** Prior interaction id this entry replaces. `null` when not an edit. */
  supersedes: string | null;
  /** ISO timestamp stamped at enqueue. */
  enqueuedAt: string;
  /** ISO timestamp stamped when the entry was moved out of pending. */
  deliveredAt: string;
  /** Optional provenance link back to GitHub for PR-imported interactions. */
  htmlUrl?: string;
}
