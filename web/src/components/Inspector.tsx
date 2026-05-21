import "./Inspector.css";
import type {
  AgentContextSlice,
  AgentSessionRef,
  Cursor,
  DeliveredInteraction,
  Interaction,
  LineSelection,
  PrConversationItem,
  PrSource,
  WorktreeSource,
} from "../types";
import type { SymbolIndex } from "../symbols";
import { CodeText } from "./CodeText";
import type { InspectorViewModel } from "../view";
import { InlineThreadStack } from "./InlineThreadStack";
import { AgentContextSection } from "./AgentContextSection";
import { useEffect, useRef, useState } from "react";
import {
  loadGithubPr,
  lookupPrForBranch,
  GithubFetchError,
  GH_ERROR_MESSAGES,
} from "../githubPrClient";
import {
  asTokenRejectionHint,
  type TokenRejectionHint,
} from "../useGithubPrLoad";
import { openExternal } from "../openExternal";
import type { PrMatch } from "../githubPrClient";

/**
 * Props for the agent-context section. The whole bundle is optional — when a
 * changeset wasn't loaded from a worktree (URL ingest, paste, file upload)
 * the parent passes `undefined` and the section doesn't render.
 */
export interface AgentContextProps {
  slice: AgentContextSlice | null;
  candidates: AgentSessionRef[];
  selectedSessionFilePath: string | null;
  loading: boolean;
  error: string | null;
  /**
   * Whether a `shippable` MCP entry is detected in the user's Claude
   * Code config, plus the `claude mcp add …` command the install chip
   * should display + copy. `null` while the fetch is in flight or has
   * failed. The `installCommand` field is authoritative — slice-3 follow-up
   * routes the panel through the server-side resolver so the chip uses
   * the working local-build line until the npm publish in §7 lands.
   */
  mcpStatus: { installed: boolean; installCommand: string } | null;
  /**
   * Newest-first list of delivered comments for this worktree. Drives the
   * Delivered (N) details block at the bottom of the panel and (via the
   * pip seam threaded through to ReplyThread) the per-reply ✓ glyph.
   */
  delivered: DeliveredInteraction[];
  /**
   * ISO timestamp of the most recent successful `fetchDelivered` call. `null`
   * before any successful poll — banner shows "—" in that case. Used by the
   * panel-level failure banner to render "last checked X min ago."
   */
  lastSuccessfulPollAt: string | null;
  /**
   * True when the most recent `fetchDelivered` call errored. Drives the
   * panel-level "Agent status unavailable" banner; pips freeze in place.
   */
  deliveredError: boolean;
  /**
   * True while an agent is in watch mode for this worktree. Drives the
   * panel's "Agent is watching" indicator.
   */
  watching: boolean;
  /**
   * Agent-started threads (top-level Interactions whose first entry is
   * authored by the agent). Drives the "Comments" rollup at the bottom
   * of the panel — a sidebar overview separate from the inline render
   * in the DiffView.
   */
  agentStartedThreads: Array<{ threadKey: string; head: Interaction }>;
  onPickSession: (sessionFilePath: string) => void;
  onRefresh: () => void;
}

interface Props {
  viewModel: InspectorViewModel;
  symbols: SymbolIndex;
  /**
   * Per-key draft bodies. The composer is fully controlled by this map —
   * closing the composer (Esc / close button) does not clear the entry,
   * so reopening restores what the user typed.
   */
  draftBodies: Record<string, string>;
  onJump: (c: Cursor) => void;
  /**
   * Clicking a block-scoped comment should re-select its range so the user
   * sees what they're replying to. Plain line threads use onJump and leave
   * selection collapsed.
   */
  onJumpToBlock?: (cursor: Cursor, selection: LineSelection) => void;
  onToggleAck: (hunkId: string, lineIdx: number) => void;
  onStartDraft: (key: string) => void;
  /** Mint a fresh `user:`/`block:` thread key and open its composer. */
  onStartNewComment: () => void;
  /** Close the composer without discarding the draft. */
  onCloseDraft: () => void;
  onChangeDraft: (key: string, body: string) => void;
  onSubmitReply: (key: string, body: string) => void;
  /** Delete a reply by id within the given thread. UI gates this to
   *  user-authored entries; the reducer enforces no other contracts. */
  onDeleteReply: (key: string, replyId: string) => void;
  /**
   * Retry the enqueue for an Interaction whose previous attempt errored. Wired
   * from the errored pip in ReplyThread. The handler in the parent looks
   * up the Interaction by id, re-derives the payload, and POSTs without
   * `supersedes` — the original POST never landed an id, so there's no
   * predecessor to replace.
   */
  onRetryReply: (key: string, replyId: string) => void;
  /**
   * Open the runner for a given AI note's `runRecipe`. Wired to the
   * `▷ verify` button rendered on notes that have a recipe attached;
   * notes without one don't render the button.
   */
  onVerifyAiNote: (recipe: { source: string; inputs: Record<string, string> }) => void;
  /**
   * Agent-context props bundle. Undefined means "no worktree source for this
   * changeset" — the section is hidden entirely. See AgentContextProps.
   */
  agentContext?: AgentContextProps;
  /**
   * Worktree provenance for the active ChangeSet. When present, the Inspector
   * fires a branch-lookup to see if there's a matching open PR and renders
   * a pill offering to overlay it.
   */
  worktreeSource?: WorktreeSource;
  /**
   * Whether the active ChangeSet already has an applied PR overlay. When true,
   * the pill hides itself.
   */
  prSource?: PrSource | null;
  /**
   * Dispatch handler for applying the PR overlay. Receives the metadata
   * (prSource, prConversation) and the bucketed PR-sourced replies so the
   * parent can dispatch MERGE_PR_OVERLAY + MERGE_PR_REPLIES.
   */
  onMergePrOverlay?: (
    changesetId: string,
    prSource: PrSource,
    prConversation: PrConversationItem[],
    prInteractions: Record<string, import("../types").Interaction[]>,
    prDetached: import("../types").DetachedInteraction[],
  ) => void;
  /**
   * Called when the pill click fails with a GitHub auth error. The parent
   * opens the token modal for the given host+reason and re-runs the retry
   * callback after the user supplies a token.
   */
  onAuthError?: (
    host: string,
    reason: "first-time" | "rejected",
    retry: () => Promise<void>,
    hint?: TokenRejectionHint,
  ) => void;
  /**
   * The changeset id of the active worktree-loaded ChangeSet. Used as the
   * target id for MERGE_PR_OVERLAY dispatch.
   */
  changesetId?: string;
  /**
   * Issue-level PR conversation items. Populated when the changeset was loaded
   * from a GitHub PR; absent/empty otherwise.
   */
  prConversation?: PrConversationItem[];
  /** Number of comment stops in the changeset; 0 disables the nav buttons. */
  commentCount: number;
  onPrevComment: () => void;
  onNextComment: () => void;
  /** Cursor sits on a line with an AI note — gates the a / r hint chips. */
  lineHasAiNote: boolean;
  /**
   * When true, interaction threads are already rendered inline in the diff.
   * The thread body (InlineThreadStack) is replaced with a brief placeholder
   * so the same content doesn't appear twice.
   */
  interactionsShownInline: boolean;
}

export function Inspector({
  viewModel,
  symbols,
  draftBodies,
  onJump,
  onJumpToBlock,
  onToggleAck,
  onStartDraft,
  onStartNewComment,
  onCloseDraft,
  onChangeDraft,
  onSubmitReply,
  onDeleteReply,
  onRetryReply,
  onVerifyAiNote,
  agentContext,
  prConversation,
  worktreeSource,
  prSource,
  onMergePrOverlay,
  changesetId,
  onAuthError,
  commentCount,
  onPrevComment,
  onNextComment,
  lineHasAiNote,
  interactionsShownInline,
}: Props) {
  const vm = viewModel;
  const draftFor = (key: string) => draftBodies[key] ?? "";

  // Keep the AI note for the current line on screen as the cursor moves.
  // Mirrors what DiffView already does for the cursor itself — without
  // this, the "current" highlight in the inspector can drift off the top
  // when the hunk has many notes.
  const currentNoteRef = useRef<HTMLLIElement | null>(null);
  const currentNoteLineIdx =
    vm.aiNoteRows.find((r) => r.isCurrent)?.lineIdx ?? null;
  useEffect(() => {
    if (currentNoteLineIdx === null) return;
    currentNoteRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentNoteLineIdx]);

  // The location card duplicates the line text that the matching AI
  // note already shows when the cursor is on a noted line — collapse to
  // the path-only label in that case so the inspector doesn't repeat
  // itself. When there's no matching note, the code preview earns its
  // space back as the only "what am I looking at" cue.
  const cursorOnNote = currentNoteLineIdx !== null;

  // Index delivered comments by id once so each ReplyThread's pip lookup
  // is O(1). `undefined` when the agent-context bundle is absent (no
  // worktree loaded) — ReplyThread treats it as "no delivered ids known"
  // which is the right default for the fixture/URL-ingest case.
  const deliveredById: Record<string, DeliveredInteraction> | undefined =
    agentContext
      ? Object.fromEntries(agentContext.delivered.map((d) => [d.id, d]))
      : undefined;

  // PR pill: look up matching open PR for the worktree branch once on mount.
  // Hidden when: no worktreeSource, prSource already applied, or no PR found.
  const [pillMatch, setPillMatch] = useState<PrMatch | null>(null);
  const [pillBusy, setPillBusy] = useState(false);
  const [pillError, setPillError] = useState<string | null>(null);

  const worktreePath = worktreeSource?.worktreePath ?? null;
  useEffect(() => {
    let cancelled = false;
    // Clear stale match immediately on path change, then start the new lookup.
    void (async () => {
      setPillMatch(null);
      if (!worktreePath) return;
      try {
        const { matched } = await lookupPrForBranch(worktreePath);
        if (!cancelled) setPillMatch(matched);
      } catch (err) {
        // Silently swallow; pill just doesn't appear.
        console.warn("[Inspector] branch-lookup failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [worktreePath]);


  async function handlePillClick() {
    if (!pillMatch || !changesetId || !onMergePrOverlay) return;
    setPillBusy(true);
    setPillError(null);
    try {
      const result = await loadGithubPr(pillMatch.htmlUrl);
      setPillBusy(false);
      onMergePrOverlay(
        changesetId,
        result.changeSet.prSource!,
        result.changeSet.prConversation ?? [],
        result.prInteractions,
        result.prDetached,
      );
    } catch (err) {
      setPillBusy(false);
      if (err instanceof GithubFetchError) {
        if (err.discriminator === "github_token_required") {
          onAuthError?.(err.host ?? "github.com", "first-time", () => handlePillClick());
        } else if (err.discriminator === "github_auth_failed") {
          onAuthError?.(
            err.host ?? "github.com",
            "rejected",
            () => handlePillClick(),
            asTokenRejectionHint(err.hint),
          );
        } else {
          setPillError(
            GH_ERROR_MESSAGES[err.discriminator] ?? "Couldn't load PR overlay.",
          );
        }
      } else {
        setPillError("Couldn't load PR overlay.");
      }
    }
  }

  // Show the pill when: worktreeSource is set, prSource not yet applied, lookup found a PR.
  const showPill = worktreeSource != null && !prSource && pillMatch != null;

  return (
    <aside className="inspector" aria-label="inspector">
      <header className="inspector__h">
        <span className="inspector__h-label">inspector</span>
        <span className="inspector__h-viewer">viewing as @you</span>
        <span className="inspector__h-nav" aria-label="comment navigation">
          <button
            type="button"
            className="inspector__h-nav-btn"
            onClick={onPrevComment}
            disabled={commentCount === 0}
            title={
              commentCount === 0
                ? "no comments in this changeset"
                : "previous comment (N)"
            }
            aria-label="previous comment"
          >
            ‹
          </button>
          <span className="inspector__h-nav-label">
            {commentCount === 0 ? "no comments" : `${commentCount} comment${commentCount === 1 ? "" : "s"}`}
          </span>
          <button
            type="button"
            className="inspector__h-nav-btn"
            onClick={onNextComment}
            disabled={commentCount === 0}
            title={
              commentCount === 0
                ? "no comments in this changeset"
                : "next comment (n)"
            }
            aria-label="next comment"
          >
            ›
          </button>
        </span>
        <span className="inspector__h-hint">
          <kbd>i</kbd>
          {lineHasAiNote && (
            <>
              {" · "}<kbd>a</kbd> ack · <kbd>r</kbd> reply
            </>
          )}
        </span>
      </header>

      {agentContext && (
        <AgentContextSection
          slice={agentContext.slice}
          candidates={agentContext.candidates}
          selectedSessionFilePath={agentContext.selectedSessionFilePath}
          loading={agentContext.loading}
          error={agentContext.error}
          symbols={symbols}
          mcpStatus={agentContext.mcpStatus}
          delivered={agentContext.delivered}
          lastSuccessfulPollAt={agentContext.lastSuccessfulPollAt}
          deliveredError={agentContext.deliveredError}
          watching={agentContext.watching}
          agentStartedThreads={agentContext.agentStartedThreads}
          onJump={onJump}
          onPickSession={agentContext.onPickSession}
          onRefresh={agentContext.onRefresh}
        />
      )}

      {showPill && (
        <div className="inspector__pr-pill">
          <button
            className="inspector__pr-pill-btn"
            disabled={pillBusy}
            onClick={handlePillClick}
          >
            {pillBusy
              ? "Loading PR overlay…"
              : `Matching PR: #${pillMatch!.number} — ${pillMatch!.title}`}
          </button>
          {pillError && (
            <span className="inspector__pr-pill-err">{pillError}</span>
          )}
        </div>
      )}

      {prConversation && prConversation.length > 0 && (
        <PrConversationSection items={prConversation} />
      )}

      <section className="inspector__sec">
        <div className="inspector__loc">{vm.locationLabel}</div>
        {!cursorOnNote && (
          <div className={`inspector__code inspector__code--${vm.lineKind}`}>
            <span className="inspector__code-sign">{vm.lineSign}</span>
            {vm.lineText ? <CodeText text={vm.lineText} language={vm.language} /> : " "}
          </div>
        )}
      </section>

      {interactionsShownInline ? (
        <section className="inspector__sec">
          <p className="inspector__empty">Comments are shown inline in the diff.</p>
        </section>
      ) : (
        <InlineThreadStack
          vm={vm}
          sections="all"
          symbols={symbols}
          draftFor={draftFor}
          deliveredById={deliveredById}
          worktreePath={worktreePath}
          currentNoteRef={currentNoteRef}
          onJump={onJump}
          onJumpToBlock={onJumpToBlock}
          onToggleAck={onToggleAck}
          onStartDraft={onStartDraft}
          onStartNewComment={onStartNewComment}
          onCloseDraft={onCloseDraft}
          onChangeDraft={onChangeDraft}
          onSubmitReply={onSubmitReply}
          onDeleteReply={onDeleteReply}
          onRetryReply={onRetryReply}
          onVerifyAiNote={onVerifyAiNote}
        />
      )}
    </aside>
  );
}

// ── PR conversation (issue-level discussion, read-only) ───────────────────────

function PrConversationSection({ items }: { items: PrConversationItem[] }) {
  return (
    <details className="inspector__sec inspector__pr-conv">
      <summary className="inspector__sec-h inspector__pr-conv-summary">
        PR conversation ({items.length})
      </summary>
      <ul className="notes">
        {items.map((item) => (
          <li key={item.id} className="ainote ainote--info">
            <div className="ainote__head">
              <span className="inspector__pr-conv-author">@{item.author}</span>
              <span className="ainote__summary ainote__summary--muted">
                <time dateTime={item.createdAt} title={item.createdAt}>
                  {humanAgo(item.createdAt)}
                </time>
              </span>
              <span className="ainote__actions">
                <a
                  href={item.htmlUrl}
                  onClick={(e) => {
                    e.preventDefault();
                    void openExternal(item.htmlUrl);
                  }}
                  className="ainote__ack"
                  title="Open on GitHub"
                >
                  ↗
                </a>
              </span>
            </div>
            <div className="ainote__detail">{item.body}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function humanAgo(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return "—";
  }
}
