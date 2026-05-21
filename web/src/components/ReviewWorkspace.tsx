import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode } from "react";
import {
  buildCommentStops,
  changesetCoverage,
  fileCoverage,
  firstTargetForKey,
  getChangesetReviewToken,
  isAckedByMe,
  isChangesetSignedOff,
  replyTarget,
  reviewedFilesCount,
  selectAckedNotes,
} from "../state";
import type { Action } from "../state";
import {
  fetchDefinition,
  fetchDefinitionCapabilities,
  findCapabilityForLanguage,
  isProgrammingLanguage,
  type DefinitionCapabilities,
  type DefinitionClickTarget,
  type DefinitionLocation,
} from "../definitionNav";
import { maybeSuggest } from "../guide";
import { usePlan } from "../usePlan";
import { Sidebar } from "./Sidebar";
import { DiffView } from "./DiffView";
import { StatusBar } from "./StatusBar";
import { GuidePrompt } from "./GuidePrompt";
import { HelpOverlay } from "./HelpOverlay";
import { Inspector } from "./Inspector";
import { LineContextMenu, type ContextMenuItem } from "./LineContextMenu";
import { LoadModal } from "./LoadModal";
import { RangePicker } from "./RangePicker";
import { ReviewPlanView } from "./ReviewPlanView";
import { CodeRunner } from "./CodeRunner";
import { ThemePicker } from "./ThemePicker";
import { TopbarActions, type TopbarAction } from "./TopbarActions";
import { SettingsModal } from "./SettingsModal";
import { useCredentials } from "../auth/useCredentials";
import { keychainAccountFor } from "../auth/credential";
import { PromptPicker } from "./PromptPicker";
import { CommandPalette } from "./CommandPalette";
import { ConfirmModal } from "./ConfirmModal";
import { type PromptRunView } from "./PromptRunsPanel";
import { buildAutoFillContext, type Prompt } from "../promptStore";
import { runPrompt } from "../promptRun";
import { buildSymbolIndex } from "../symbols";
import type { SymbolIndex } from "../symbols";
import type {
  AgentContextSlice,
  AgentSessionRef,
  ChangeSet,
  Cursor,
  DetachedInteraction,
  DiffFile,
  EvidenceRef,
  Interaction,
  PrSource,
  ReviewState,
  WorktreeSource,
} from "../types";
import { blockCommentKey, lineNoteReplyKey, userCommentKey } from "../types";
import {
  fetchAgentContextForWorktree,
  fetchMcpStatus,
} from "../agentContextClient";
import {
  enqueueInteraction,
  unenqueueInteraction,
  upsertInteraction,
} from "../interactionClient";
import { buildReplyAnchor } from "../anchor";
import {
  fetchWorktreeChangeset,
  fetchWorktreeCommits,
  type LoadOpts,
} from "../worktreeChangeset";
import { useDeliveredPolling } from "../useDeliveredPolling";
import { KEYMAP, type ActionId } from "../keymap";
import { clearSession } from "../persist";
import type { ThemeId } from "../tokens";
import type { RecentSource } from "../recents";
import { loadGithubPr, GithubFetchError } from "../githubPrClient";
import {
  asTokenRejectionHint,
  type TokenRejectionHint,
} from "../useGithubPrLoad";
import { GitHubTokenModal } from "./GitHubTokenModal";
import { isTauri, keychainGet } from "../keychain";
import { openDetachedWindow } from "../multiWindow";
import { fetchFileAt } from "../fileAt";
import {
  buildDiffViewModel,
  buildSidebarViewModel,
  buildStatusBarViewModel,
  buildGuidePromptViewModel,
  buildInspectorViewModel,
} from "../view";
import { newReviewerInteractionId, selectIngestSignals } from "../interactions";

interface Props {
  state: ReviewState;
  dispatch: Dispatch<Action>;
  /** Raw (unsynced) reducer dispatch. Used only by the worktree submit path,
   *  which manages its own upsert→enqueue sequence; going through the synced
   *  dispatch there would fire a concurrent duplicate upsert. */
  rawDispatch: Dispatch<Action>;
  drafts: Record<string, string>;
  setDrafts: (
    updater: (prev: Record<string, string>) => Record<string, string>,
  ) => void;
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
  /** Called when LoadModal parses a fresh changeset — App handles dispatch
   *  + recents upsert. `prData` is present only on GitHub PR loads. */
  onLoadChangeset: (
    cs: ChangeSet,
    interactions: Record<string, Interaction[]>,
    source: RecentSource,
    prData?: {
      prInteractions: Record<string, Interaction[]>;
      prDetached: DetachedInteraction[];
    },
  ) => void;
  currentSource: RecentSource | null;
  /** Live-reload banner slot. App owns the polling hook + drift state and
   *  renders the banner; we accept it as a ReactNode so this component stays
   *  free of worktree/live-reload concerns. Null when no worktree changeset
   *  is loaded. */
  liveReloadBar?: ReactNode;
}

export function ReviewWorkspace({
  state,
  dispatch,
  rawDispatch,
  drafts,
  setDrafts,
  themeId,
  setThemeId,
  onLoadChangeset,
  currentSource,
  liveReloadBar,
}: Props) {
  const credentials = useCredentials();
  const hasAnthropicCredential = credentials.list.some(
    (c) => c.kind === "anthropic",
  );
  const showAiOffChip =
    !hasAnthropicCredential && credentials.anthropicSkipped;
  const [showHelp, setShowHelp] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showInspector, setShowInspector] = useState(true);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showLoad, setShowLoad] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showRangePicker, setShowRangePicker] = useState(false);
  const [rangePickerBusy, setRangePickerBusy] = useState(false);
  const [rangePickerErr, setRangePickerErr] = useState<string | null>(null);
  const [freeRunnerOpen, setFreeRunnerOpen] = useState(false);
  const [runRequest, setRunRequest] = useState<{
    tick: number;
    source: string;
  } | null>(null);
  const [showPlan, setShowPlan] = useState(true);
  const [draftingKey, setDraftingKey] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    hunkId: string;
    lineIdx: number;
  } | null>(null);
  const [mouseTip, setMouseTip] = useState<string | null>(null);
  const [runs, setRuns] = useState<PromptRunView[]>([]);
  const [sidebarWide, setSidebarWide] = useState(false);
  const [definitionCapabilities, setDefinitionCapabilities] =
    useState<DefinitionCapabilities | null>(null);
  const [definitionCapabilitiesError, setDefinitionCapabilitiesError] =
    useState<string | null>(null);
  const [definitionPeek, setDefinitionPeek] = useState<DefinitionPeekState>({
    kind: "idle",
  });

  const runControllersRef = useRef<Map<string, AbortController>>(new Map());
  const mouseTipTimeoutRef = useRef<number | null>(null);
  // Per-(csId,fileId) in-flight hydration promises. Memoised across renders
  // so racing clicks coalesce into one fetch instead of N.
  const hydrationPromisesRef = useRef<Map<string, Promise<void>>>(new Map());

  const cs = state.changesets.find((c) => c.id === state.cursor.changesetId)!;
  const file = cs.files.find((f) => f.id === state.cursor.fileId)!;
  const hunk = file.hunks.find((h) => h.id === state.cursor.hunkId)!;

  // Lazy-fetch post-change source for files the worktree-changeset endpoint
  // didn't ship content for (everything but `.md` today). The wt-source +
  // non-deleted gates mirror the optimistic affordances the view model
  // shows; without them this is a no-op.
  async function ensureFileHydrated(target: DiffFile): Promise<void> {
    if (target.fullContent) return;
    if (target.status === "deleted") return;
    const source = cs.worktreeSource;
    if (!source) return;
    const key = `${cs.id}:${target.id}`;
    let p = hydrationPromisesRef.current.get(key);
    if (!p) {
      p = (async () => {
        const content = await fetchFileAt({
          worktreePath: source.worktreePath,
          sha: source.commitSha,
          file: target.path,
        });
        dispatch({
          type: "HYDRATE_FILE",
          changesetId: cs.id,
          fileId: target.id,
          postChangeText: content,
        });
      })().catch((err) => {
        // Swallow — the optimistic bar will keep showing and the user can
        // try again. Surfacing a banner here would be louder than the bug
        // (a binary file being clicked on, say); a console line is enough.
        console.warn(`[expand-hunks] hydration failed for ${target.path}:`, err);
      }).finally(() => {
        hydrationPromisesRef.current.delete(key);
      });
      hydrationPromisesRef.current.set(key, p);
    }
    await p;
  }
  const canHydrateExpansion =
    !!cs.worktreeSource && file.status !== "deleted" && !file.fullContent;
  const line = hunk.lines[state.cursor.lineIdx];
  const symbolIndex = buildSymbolIndex(cs);
  const clickableSymbols = new Set(symbolIndex.keys());

  // Agent-context state. Provenance lives on cs.worktreeSource so it
  // survives reloads and changeset switches; the slice/sessions/error are
  // transient and per-cs.
  const [agentSlice, setAgentSlice] = useState<AgentContextSlice | null>(null);
  const [agentSessions, setAgentSessions] = useState<AgentSessionRef[]>([]);
  const [pinnedSession, setPinnedSession] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentRefreshTick, setAgentRefreshTick] = useState(0);

  // PR refresh state — tracks per-cs whether a refresh is in flight,
  // and whether the last refresh failed with auth-rejected (surfaces a banner).
  const [prRefreshBusy, setPrRefreshBusy] = useState(false);
  const [prAuthRejected, setPrAuthRejected] = useState<{
    csId: string;
    host: string;
    hint?: string;
  } | null>(null);
  const [prRefreshTokenModal, setPrRefreshTokenModal] = useState<{
    host: string;
    reason: "first-time" | "rejected";
    pendingHtmlUrl: string;
    /** When set, runs instead of re-fetching pendingHtmlUrl after token entry. */
    pendingAction?: () => Promise<void>;
    /** Server-side hint for the rejection (rate-limit / scope / invalid-token);
     *  threaded through so the modal renders accurate copy. */
    hint?: TokenRejectionHint;
  } | null>(null);

  // MCP-install status with retry+backoff. The dev server's port briefly
  // disappears during `tsx watch` reloads; a single attempt can hit
  // ECONNREFUSED and leave the banner stuck "unknown". After ~31s of
  // attempts we give up silently — the install affordance stays visible
  // until the user dismisses it.
  const [mcpStatus, setMcpStatus] = useState<{
    installed: boolean;
    installCommand: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const tryFetch = () => {
      fetchMcpStatus()
        .then((s) => {
          if (!cancelled) setMcpStatus(s);
        })
        .catch(() => {
          if (cancelled) return;
          attempt += 1;
          if (attempt >= 5) return;
          const delay = Math.min(1000 * 2 ** attempt, 10000);
          timer = window.setTimeout(tryFetch, delay);
        });
    };
    tryFetch();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const activeWorktreeSource: WorktreeSource | null = cs.worktreeSource ?? null;
  const wtPath = activeWorktreeSource?.worktreePath ?? null;
  const wtSha = activeWorktreeSource?.commitSha ?? null;

  // Polling runs while the panel is mounted AND the tab is visible — see
  // docs/sdd/agent-reply-support/spec.md for why per-comment outstanding
  // gates are unsound under multi-reply.
  const {
    delivered: deliveredComments,
    agentReplies: polledAgentReplies,
    lastSuccessfulPollAt: deliveredLastSuccessAt,
    error: deliveredErrorState,
  } = useDeliveredPolling({ worktreePath: wtPath });

  // Reconcile polled agent entries into state.interactions. The reducer
  // handles both reply-shaped (parentId) and top-level (file+lines)
  // envelopes; it's idempotent so we don't dedupe before dispatching.
  useEffect(() => {
    if (polledAgentReplies.length === 0) return;
    dispatch({ type: "MERGE_AGENT_REPLIES", polled: polledAgentReplies });
  }, [polledAgentReplies, dispatch]);


  const wantedFetchKey =
    wtPath && wtSha
      ? `${wtPath}|${wtSha}|${pinnedSession ?? ""}|${agentRefreshTick}`
      : null;
  // "Adjusting state during render" pattern (mirrors usePlan): when the
  // fetch key transitions, flip loading/error synchronously here so the
  // effect body stays free of sync setState.
  const [lastFetchKey, setLastFetchKey] = useState<string | null>(null);
  if (lastFetchKey !== wantedFetchKey) {
    setLastFetchKey(wantedFetchKey);
    if (wantedFetchKey) {
      setAgentLoading(true);
      setAgentError(null);
    } else {
      setAgentLoading(false);
    }
  }
  useEffect(() => {
    if (!wantedFetchKey || !wtPath || !wtSha) return;
    let cancelled = false;
    fetchAgentContextForWorktree({
      worktreePath: wtPath,
      commitSha: wtSha,
      pinnedSessionFilePath: pinnedSession,
    })
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setAgentSlice(null);
          setAgentSessions([]);
        } else {
          setAgentSlice(res.slice);
          setAgentSessions(res.candidates);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setAgentError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setAgentLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // wtPath/wtSha/pinnedSession are folded into wantedFetchKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedFetchKey]);
  const {
    plan,
    status: planStatus,
    error: planError,
    generate: generatePlan,
  } = usePlan(cs);
  const jumpTo = (c: Cursor) => dispatch({ type: "SET_CURSOR", cursor: c });

  async function handlePrRefresh(htmlUrl: string) {
    setPrRefreshBusy(true);
    setPrAuthRejected(null);
    try {
      const result = await loadGithubPr(htmlUrl);
      dispatch({
        type: "LOAD_CHANGESET",
        changeset: result.changeSet,
      });
      dispatch({
        type: "MERGE_PR_INTERACTIONS",
        changesetId: result.changeSet.id,
        prInteractions: result.prInteractions,
        prDetached: result.prDetached,
      });
    } catch (e) {
      if (e instanceof GithubFetchError) {
        if (e.discriminator === "github_auth_failed") {
          setPrAuthRejected({ csId: cs.id, host: e.host ?? "github.com", hint: e.hint });
        } else if (e.discriminator === "github_token_required" && e.host) {
          // Mirrors the flow in LoadModal.tsx: try Keychain first on Tauri;
          // on hit, push to server and retry silently. On miss, open the
          // token modal with a pendingAction so the user can supply it once.
          if (isTauri()) {
            const cached = await keychainGet(
              keychainAccountFor({ kind: "github", host: e.host }),
            );
            if (cached) {
              await credentials.set({ kind: "github", host: e.host }, cached);
              // Retry: release busy state after the recursive call resolves.
              setPrRefreshBusy(false);
              return handlePrRefresh(htmlUrl);
            }
          }
          setPrRefreshTokenModal({
            host: e.host,
            reason: "first-time",
            pendingHtmlUrl: htmlUrl,
            pendingAction: () => handlePrRefresh(htmlUrl),
            // first-time prompts carry no hint
          });
        }
        // Other discriminators: swallow silently; button becomes available again.
      }
    } finally {
      setPrRefreshBusy(false);
    }
  }

  async function handlePrRefreshTokenSubmit(
    host: string,
    token: string,
  ): Promise<void> {
    await credentials.set({ kind: "github", host }, token);
    const pendingUrl = prRefreshTokenModal?.pendingHtmlUrl ?? "";
    const pendingAction = prRefreshTokenModal?.pendingAction;
    setPrRefreshTokenModal(null);
    setPrAuthRejected(null);
    if (pendingAction) {
      await pendingAction();
    } else if (pendingUrl) {
      await handlePrRefresh(pendingUrl);
    }
  }

  const suggestion = maybeSuggest(cs, state);
  const lineNoteAcked = isAckedByMe(
    state,
    state.cursor.hunkId,
    state.cursor.lineIdx,
  );
  const ackedSet = selectAckedNotes(state);
  const ingestSignals = selectIngestSignals(state);
  const lineHasAiNote = !!ingestSignals.aiNoteByLine[
    `${state.cursor.hunkId}:${state.cursor.lineIdx}`
  ];

  const palettePredicates: Record<string, boolean> = {
    hasSuggestion: !!suggestion,
    lineHasAiNote,
    hasSelection: !!state.selection,
    hasPlan: showPlan,
    hasPicker: showPicker,
    hasCommandPalette: showCommandPalette,
  };

  // Mouse interactions on the diff are disabled while a modal-style overlay
  // owns input. Symbol jumps still work — those go through LineText's own
  // click handler, not our delegated pointer plumbing.
  const interactionsEnabled =
    !showHelp &&
    !showPlan &&
    !showLoad &&
    !showPicker &&
    !showCommandPalette &&
    !freeRunnerOpen;

  // A modal opening on top of an open right-click menu should dismiss it;
  // the menu itself can't observe the overlays so the parent does it. The
  // alternative — closing from every modal opener — would scatter this
  // concern across many setShow…(true) callsites.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing one piece of UI state when its precondition flips false
    if (!interactionsEnabled) setContextMenu(null);
  }, [interactionsEnabled]);

  function runAction(action: ActionId) {
    const preserveSelection = draftingKey?.startsWith("block:") ?? false;
    switch (action) {
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
      case "NEXT_COMMENT":
        dispatch({ type: "MOVE_TO_COMMENT", delta: 1 });
        break;
      case "PREV_COMMENT":
        dispatch({ type: "MOVE_TO_COMMENT", delta: -1 });
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
      case "TOGGLE_CHANGESET_REVIEWED":
        dispatch({
          type: "TOGGLE_CHANGESET_REVIEWED",
          changesetId: state.cursor.changesetId,
        });
        break;
      case "START_REPLY":
        setDraftingKey(
          lineNoteReplyKey(state.cursor.hunkId, state.cursor.lineIdx),
        );
        setShowInspector(true);
        break;
      case "START_COMMENT": {
        const sel = state.selection;
        const key =
          sel && sel.hunkId === state.cursor.hunkId && sel.anchor !== sel.head
            ? blockCommentKey(
                sel.hunkId,
                Math.min(sel.anchor, sel.head),
                Math.max(sel.anchor, sel.head),
              )
            : userCommentKey(state.cursor.hunkId, state.cursor.lineIdx);
        setDraftingKey(key);
        setShowInspector(true);
        break;
      }
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
        if (!suggestion) break;
        dispatch({ type: "DISMISS_GUIDE", guideId: suggestion.id });
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
      case "OPEN_COMMAND_PALETTE":
        setShowCommandPalette(true);
        break;
      case "CLOSE_COMMAND_PALETTE":
        setShowCommandPalette(false);
        break;
      case "RUN_SELECTION": {
        const sel = state.selection;
        const lines =
          sel && sel.hunkId === hunk.id
            ? hunk.lines.slice(
                Math.min(sel.anchor, sel.head),
                Math.max(sel.anchor, sel.head) + 1,
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
      case "PREV_CHANGESET":
        dispatch({
          type: "SWITCH_CHANGESET",
          changesetId: cycleChangeset(
            state.changesets,
            state.cursor.changesetId,
            -1,
          ),
        });
        break;
      case "NEXT_CHANGESET":
        dispatch({
          type: "SWITCH_CHANGESET",
          changesetId: cycleChangeset(
            state.changesets,
            state.cursor.changesetId,
            1,
          ),
        });
        break;
    }
  }

  function flashMouseTip(chord: string, label: string) {
    if (mouseTipTimeoutRef.current !== null) {
      window.clearTimeout(mouseTipTimeoutRef.current);
    }
    setMouseTip(`tip: next time press ${chord} for ${label}`);
    mouseTipTimeoutRef.current = window.setTimeout(() => {
      setMouseTip(null);
      mouseTipTimeoutRef.current = null;
    }, 2600);
  }
  const currentWorkspaceRoot =
    currentSource?.kind === "worktree"
      ? currentSource.path
      : (cs.worktreeSource?.worktreePath ?? null);
  const definitionScopeKey = `${cs.id}:${file.id}:${currentWorkspaceRoot ?? ""}`;
  const definitionCapability = findCapabilityForLanguage(definitionCapabilities, file.language);
  const canUseServerDefinitions =
    currentWorkspaceRoot !== null &&
    definitionCapability?.available === true;
  const allowAnyIdentifier = canUseServerDefinitions;

  useEffect(() => {
    let cancelled = false;
    void fetchDefinitionCapabilities()
      .then((capabilities) => {
        if (cancelled) return;
        setDefinitionCapabilities(capabilities);
        setDefinitionCapabilitiesError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setDefinitionCapabilities({
          languages: [],
          requiresWorktree: true,
          anyAvailable: false,
        });
        setDefinitionCapabilitiesError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showHelp && e.key !== "?" && e.key !== "Escape") return;
      if (showPlan && !["p", "?", "Escape"].includes(e.key)) return;
      if (showPicker && e.key !== "Escape") return;
      // The palette has its own keyboard handlers; the global keymap only
      // needs to handle Escape as a fallback when focus has escaped the
      // palette's box (e.g. after clicking outside the input).
      if (showCommandPalette && e.key !== "Escape") return;

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

      const entry = KEYMAP.find(
        (km) =>
          km.key === e.key &&
          (km.shift === undefined ? true : km.shift === e.shiftKey) &&
          (km.meta ?? false) === e.metaKey &&
          (km.ctrl ?? false) === e.ctrlKey &&
          (km.when === undefined ? true : palettePredicates[km.when]),
      );

      if (!entry) return;

      e.preventDefault();
      runAction(entry.action);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // palettePredicates and runAction are rebuilt every render; including
    // them would cause the effect to re-register each render anyway. The
    // explicit deps below already cover everything either of them reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showHelp,
    showPlan,
    showPicker,
    showCommandPalette,
    state.cursor,
    state.changesets,
    state.selection,
    suggestion,
    line,
    draftingKey,
    hunk.id,
    hunk.lines,
    dispatch,
  ]);

  useEffect(
    () => () => {
      if (mouseTipTimeoutRef.current !== null) {
        window.clearTimeout(mouseTipTimeoutRef.current);
      }
    },
    [],
  );

  const readCoverage = changesetCoverage(cs, state.readLines);
  const reviewedFiles = reviewedFilesCount(cs, state.reviewedFiles);
  const fileIdx = cs.files.findIndex((f) => f.id === file.id);
  const hunkIdx = file.hunks.findIndex((h) => h.id === hunk.id);
  const guideViewModel = suggestion
    ? buildGuidePromptViewModel(suggestion, symbolIndex, cs.id)
    : null;

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
        onText: (chunk) => patchRun((r) => ({ ...r, text: r.text + chunk })),
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

  async function handleSymbolClick(target: DefinitionClickTarget) {
    const inDiffTarget = symbolIndex.get(target.symbol);
    if (inDiffTarget) {
      dispatch({ type: "SET_CURSOR", cursor: inDiffTarget });
      setDefinitionPeek({ kind: "idle" });
      return;
    }

    if (currentWorkspaceRoot === null) {
      setDefinitionPeek({
        kind: "unsupported",
        symbol: target.symbol,
        message: "Load the diff from a local worktree before asking the server for definitions.",
        scopeKey: definitionScopeKey,
      });
      return;
    }
    if (!definitionCapability) {
      const supported = definitionCapabilities?.languages
        .map((l) => l.id.toUpperCase())
        .join(", ") ?? "none";
      setDefinitionPeek({
        kind: "unsupported",
        symbol: target.symbol,
        message: `No language module handles ${file.language} yet. Supported: ${supported}.`,
        scopeKey: definitionScopeKey,
      });
      return;
    }
    if (!definitionCapability.available) {
      setDefinitionPeek({
        kind: "unsupported",
        symbol: target.symbol,
        message: definitionCapability.reason ?? "Definition lookup is unavailable.",
        scopeKey: definitionScopeKey,
      });
      return;
    }
    if (!canUseServerDefinitions) {
      setDefinitionPeek({
        kind: "unsupported",
        symbol: target.symbol,
        message: "Definition lookup is still initializing.",
        scopeKey: definitionScopeKey,
      });
      return;
    }

    setDefinitionPeek({ kind: "loading", symbol: target.symbol, scopeKey: definitionScopeKey });
    try {
      const response = await fetchDefinition({
        file: target.file,
        language: target.language,
        line: target.line,
        col: target.col,
        workspaceRoot: currentWorkspaceRoot,
      });
      if (response.status === "unsupported") {
        setDefinitionPeek({
          kind: "unsupported",
          symbol: target.symbol,
          message: response.reason,
          scopeKey: definitionScopeKey,
        });
        return;
      }
      if (response.status === "error") {
        setDefinitionPeek({
          kind: "error",
          symbol: target.symbol,
          message: response.error,
          scopeKey: definitionScopeKey,
        });
        return;
      }
      const jumpTarget = response.definitions
        .map((definition) => resolveDefinitionToCursor(cs, definition))
        .find((cursor): cursor is Cursor => cursor !== null);
      if (jumpTarget) {
        dispatch({ type: "SET_CURSOR", cursor: jumpTarget });
        setDefinitionPeek({ kind: "idle" });
        return;
      }
      setDefinitionPeek({
        kind: "results",
        symbol: target.symbol,
        definitions: response.definitions,
        scopeKey: definitionScopeKey,
      });
    } catch (err) {
      setDefinitionPeek({
        kind: "error",
        symbol: target.symbol,
        message: err instanceof Error ? err.message : String(err),
        scopeKey: definitionScopeKey,
      });
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__metadata">
          <span className="topbar__brand">shippable</span>
          <span className="topbar__sep">│</span>
          <span className="topbar__id">{cs.id}</span>
          <span className="topbar__title">
            {cs.prSource ? cs.prSource.title : cs.title}
          </span>
          <PlanChip
            isOpen={showPlan}
            plan={plan}
            reviewedFiles={state.reviewedFiles}
            onToggle={() => {
              flashMouseTip("p", "the review plan");
              setShowPlan((v) => !v);
            }}
          />
          <span className="topbar__sep">│</span>
          {cs.prSource ? (
            <PrTopbarMeta
              prSource={cs.prSource}
              refreshBusy={prRefreshBusy}
              onRefresh={() => handlePrRefresh(cs.prSource!.htmlUrl)}
            />
          ) : (
            <>
              <span className="topbar__branch">
                {cs.branch} → {cs.base}
              </span>
              {cs.worktreeSource && (
                <button
                  type="button"
                  className={`topbar__btn topbar__btn--range ${showRangePicker ? "topbar__btn--on" : ""}`}
                  onClick={() => setShowRangePicker((v) => !v)}
                  title="pick a SHA range to review"
                  disabled={rangePickerBusy}
                >
                  <span className="topbar__btn-label">⇄ range</span>
                </button>
              )}
            </>
          )}
          <DefinitionStatusChip
            currentSource={currentSource}
            fileLanguage={file.language}
            capabilities={definitionCapabilities}
            fetchError={definitionCapabilitiesError}
          />
          <span className="topbar__author">@{cs.author}</span>
        </div>
        <TopbarActions
          leading={{
            node: <ThemePicker value={themeId} onChange={setThemeId} />,
            menuLabel: "theme",
          }}
          items={([
            ...(showAiOffChip
              ? [
                  {
                    id: "ai-off",
                    label: "AI off",
                    glyph: "✦",
                    title: "AI is disabled — click to enable",
                    pinned: true,
                    priority: 15,
                    onClick: () => setShowSettings(true),
                  },
                ]
              : []),
            {
              id: "sidebar",
              label: "files",
              glyph: "▤",
              kbd: "f",
              title: "toggle the file list (f)",
              active: showSidebar,
              priority: 31,
              onClick: () => {
                flashMouseTip("f", "the file list");
                setShowSidebar((v) => !v);
              },
            },
            {
              id: "inspector",
              label: "inspector",
              glyph: "◫",
              kbd: "i",
              title: "toggle the inspector (i)",
              active: showInspector,
              priority: 30,
              onClick: () => {
                flashMouseTip("i", "the inspector");
                setShowInspector((v) => !v);
              },
            },
            {
              id: "run",
              label: "run",
              glyph: "▷",
              kbd: "⇧R",
              title: "open a free code runner — type or paste a snippet (shift+R)",
              priority: 20,
              onClick: () => {
                flashMouseTip("⇧R", "the free code runner");
                setFreeRunnerOpen(true);
              },
            },
            {
              id: "load",
              label: "load",
              glyph: "+",
              kbd: "⇧L",
              title: "load a changeset from URL, file, or paste (shift+L)",
              priority: 50,
              onClick: () => {
                flashMouseTip("⇧L", "load changeset");
                setShowLoad(true);
              },
            },
            {
              id: "help",
              label: "help",
              kbd: "?",
              title: "open shortcut help (?)",
              priority: 10,
              onClick: () => {
                flashMouseTip("?", "help");
                setShowHelp(true);
              },
            },
            {
              id: "settings",
              label: "settings",
              glyph: "⚙",
              title: "manage Anthropic + GitHub credentials",
              priority: 5,
              onClick: () => setShowSettings(true),
            },
            {
              id: "reset",
              label: "reset review",
              title: "clear persisted progress and reload",
              danger: true,
              pinned: true,
              priority: 100,
              onClick: () => setShowResetConfirm(true),
            },
          ] as TopbarAction[])}
        />
      </header>

      {showRangePicker && cs.worktreeSource && (
        <div className="topbar-popover">
          {rangePickerErr && (
            <div className="topbar-popover__err">{rangePickerErr}</div>
          )}
          <RangePicker
            worktreePath={cs.worktreeSource.worktreePath}
            fetchCommits={fetchWorktreeCommits}
            defaultFromRef={cs.worktreeSource.range?.fromRef}
            defaultToRef={cs.worktreeSource.range?.toRef ?? "HEAD"}
            defaultIncludeDirty={cs.worktreeSource.range?.includeDirty}
            busy={rangePickerBusy}
            onApply={async (opts: LoadOpts) => {
              if (!cs.worktreeSource) return;
              setRangePickerBusy(true);
              setRangePickerErr(null);
              try {
                const newCs = await fetchWorktreeChangeset(
                  {
                    path: cs.worktreeSource.worktreePath,
                    branch: cs.worktreeSource.branch,
                  },
                  opts,
                );
                onLoadChangeset(newCs, {}, {
                  kind: "worktree",
                  path: cs.worktreeSource.worktreePath,
                  branch: cs.worktreeSource.branch,
                });
                setShowRangePicker(false);
              } catch (e) {
                setRangePickerErr(e instanceof Error ? e.message : String(e));
              } finally {
                setRangePickerBusy(false);
              }
            }}
            onCancel={() => setShowRangePicker(false)}
            onJustThis={async (sha: string) => {
              if (!cs.worktreeSource) return;
              setRangePickerBusy(true);
              setRangePickerErr(null);
              try {
                const newCs = await fetchWorktreeChangeset(
                  {
                    path: cs.worktreeSource.worktreePath,
                    branch: cs.worktreeSource.branch,
                  },
                  { kind: "ref", ref: sha },
                );
                onLoadChangeset(newCs, {}, {
                  kind: "worktree",
                  path: cs.worktreeSource.worktreePath,
                  branch: cs.worktreeSource.branch,
                });
                setShowRangePicker(false);
              } catch (e) {
                setRangePickerErr(e instanceof Error ? e.message : String(e));
              } finally {
                setRangePickerBusy(false);
              }
            }}
          />
        </div>
      )}

      {liveReloadBar}

      {cs.prSource?.truncation && (
        <div className="topbar__truncation-banner">
          Diff truncated by GitHub: {cs.prSource.truncation.reason}
        </div>
      )}

      {prAuthRejected && prAuthRejected.csId === cs.id && (
        <div className="topbar__truncation-banner topbar__truncation-banner--warn">
          Token for {prAuthRejected.host} was rejected
          {prAuthRejected.hint ? ` (${hintText(prAuthRejected.hint)})` : ""}.{" "}
          <button
            className="topbar__banner-btn"
            onClick={() =>
              setPrRefreshTokenModal({
                host: prAuthRejected.host,
                reason: "rejected",
                pendingHtmlUrl: cs.prSource?.htmlUrl ?? "",
                hint: asTokenRejectionHint(prAuthRejected.hint),
              })
            }
          >
            Re-enter to retry
          </button>
          <button
            className="topbar__banner-btn"
            aria-label="Dismiss"
            onClick={() => setPrAuthRejected(null)}
          >
            ×
          </button>
        </div>
      )}

      {prRefreshTokenModal && (
        <GitHubTokenModal
          host={prRefreshTokenModal.host}
          reason={prRefreshTokenModal.reason}
          hint={prRefreshTokenModal.hint}
          onSubmit={handlePrRefreshTokenSubmit}
          onCancel={() => setPrRefreshTokenModal(null)}
        />
      )}

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
              const f = cs.files.find((ff) => ff.id === fileId)!;
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
            onDetach={
              isTauri() ? () => void openDetachedWindow("sidebar") : undefined
            }
          />
        )}
        <div className="reviewpane">
          <DefinitionPeek
            peek={definitionPeek.kind !== "idle" && definitionPeek.scopeKey === definitionScopeKey
              ? definitionPeek
              : { kind: "idle" }}
            onDismiss={() => setDefinitionPeek({ kind: "idle" })}
          />
          <DiffView
            viewModel={buildDiffViewModel({
              file,
              currentHunkId: hunk.id,
              cursorLineIdx: state.cursor.lineIdx,
              read: state.readLines,
              isFileReviewed: state.reviewedFiles.has(file.id),
              acked: ackedSet,
              replies: state.interactions,
              expandLevelAbove: state.expandLevelAbove,
              expandLevelBelow: state.expandLevelBelow,
              fileFullyExpanded: state.fullExpandedFiles.has(file.id),
              filePreviewing: state.previewedFiles.has(file.id),
              imageAssets: cs.imageAssets,
              selection: state.selection,
              signals: ingestSignals,
              canHydrateExpansion,
            })}
            onSetExpandLevel={async (hunkId, dir, level) => {
              await ensureFileHydrated(file);
              dispatch({ type: "SET_EXPAND_LEVEL", hunkId, dir, level });
            }}
            onToggleExpandFile={async (fileId) => {
              await ensureFileHydrated(file);
              dispatch({ type: "TOGGLE_EXPAND_FILE", fileId });
            }}
            onTogglePreviewFile={(fileId) =>
              dispatch({ type: "TOGGLE_PREVIEW_FILE", fileId })
            }
            clickableSymbols={clickableSymbols}
            allowAnyIdentifier={allowAnyIdentifier}
            onSymbolClick={handleSymbolClick}
            interactionsEnabled={interactionsEnabled}
            onLineFocus={(hunkId, lineIdx, opts) => {
              const targetCursor: Cursor = {
                changesetId: cs.id,
                fileId: file.id,
                hunkId,
                lineIdx,
              };
              if (opts.extend) {
                // Extend from existing selection's anchor (if any) or the
                // current cursor. Mirrors keyboard shift+arrow.
                const sel = state.selection;
                const anchor =
                  sel && sel.hunkId === hunkId
                    ? sel.anchor
                    : state.cursor.hunkId === hunkId
                      ? state.cursor.lineIdx
                      : lineIdx;
                dispatch({
                  type: "SET_CURSOR",
                  cursor: targetCursor,
                  selection: { hunkId, anchor, head: lineIdx },
                });
              } else {
                dispatch({ type: "SET_CURSOR", cursor: targetCursor });
              }
            }}
            onLineSelectRange={(hunkId, anchor, head) => {
              dispatch({
                type: "SET_CURSOR",
                cursor: {
                  changesetId: cs.id,
                  fileId: file.id,
                  hunkId,
                  lineIdx: head,
                },
                selection: { hunkId, anchor, head },
              });
            }}
            onLineCharSelect={(hunkId, lineIdx, fromCol, toCol) => {
              // Move cursor onto the line first so the read-rail tracks the
              // user's intent. SET_LINE_CHAR_RANGE then sets the substring
              // selection without disturbing the cursor.
              dispatch({
                type: "SET_CURSOR",
                cursor: {
                  changesetId: cs.id,
                  fileId: file.id,
                  hunkId,
                  lineIdx,
                },
              });
              dispatch({
                type: "SET_LINE_CHAR_RANGE",
                hunkId,
                lineIdx,
                fromCol,
                toCol,
              });
            }}
            onLineContextMenu={(hunkId, lineIdx, x, y) => {
              const sel = state.selection;
              const inSelection =
                sel &&
                sel.hunkId === hunkId &&
                lineIdx >= Math.min(sel.anchor, sel.head) &&
                lineIdx <= Math.max(sel.anchor, sel.head);
              if (!inSelection) {
                dispatch({
                  type: "SET_CURSOR",
                  cursor: {
                    changesetId: cs.id,
                    fileId: file.id,
                    hunkId,
                    lineIdx,
                  },
                });
              }
              setContextMenu({ x, y, hunkId, lineIdx });
            }}
          />
        </div>
        {showInspector && (
          <Inspector
            viewModel={buildInspectorViewModel({
              file,
              hunk,
              line,
              cursor: state.cursor,
              symbols: symbolIndex,
              acked: ackedSet,
              replies: state.interactions,
              draftingKey,
              signals: ingestSignals,
              detachedInteractions: state.detachedInteractions,
            })}
            commentCount={buildCommentStops(cs, state.interactions).length}
            onPrevComment={() => dispatch({ type: "MOVE_TO_COMMENT", delta: -1 })}
            onNextComment={() => dispatch({ type: "MOVE_TO_COMMENT", delta: 1 })}
            lineHasAiNote={lineHasAiNote}
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
            onCloseDraft={() => setDraftingKey(null)}
            onChangeDraft={(key, body) =>
              setDrafts((prev) => ({ ...prev, [key]: body }))
            }
            onSubmitReply={(key, body) => {
              const createdAt = new Date();
              const interactionId = newReviewerInteractionId();
              const isFirst = (state.interactions[key]?.length ?? 0) === 0;
              const interaction: Interaction = {
                id: interactionId,
                threadKey: key,
                target: isFirst ? firstTargetForKey(key) : replyTarget(),
                intent: "comment",
                author: "you",
                authorRole: "user",
                body,
                createdAt: createdAt.toISOString(),
                ...buildReplyAnchor(key, cs),
                // Optimistically mark as queued so the pip appears immediately
                // in the submit→delivered window. The server's enqueue POST
                // sets the same column server-side; no mismatch risk.
                ...(activeWorktreeSource ? { agentQueueStatus: "pending" } : {}),
              };
              // Worktree path: bypass the sync hook — this code manages its
              // own upsert→enqueue sequence, and going through syncedDispatch
              // would fire a concurrent duplicate upsert for the same row.
              // Non-worktree path: go through the sync hook (its upsert is the
              // only persistence path for paste/url/upload changesets).
              const addAction = {
                type: "ADD_INTERACTION" as const,
                targetKey: key,
                interaction,
              };
              if (activeWorktreeSource) {
                rawDispatch(addAction);
              } else {
                dispatch(addAction);
              }
              setDrafts((prev) => {
                if (!(key in prev)) return prev;
                const next = { ...prev };
                delete next[key];
                return next;
              });
              setDraftingKey(null);
              // When a worktree is loaded, enqueue the interaction for the
              // agent. The DB row must exist before /enqueue can reference
              // it, so upsert here and enqueue on success rather than
              // racing the background sync. Non-worktree loads (paste/url/
              // upload) just persist the interaction; no pip appears.
              if (activeWorktreeSource) {
                const worktreePath = activeWorktreeSource.worktreePath;
                upsertInteraction(interaction, cs.id)
                  .then(() => enqueueInteraction(interactionId, worktreePath))
                  .catch((err: unknown) => {
                    console.error("[shippable] enqueue failed:", err);
                    // Surface the failure as a retry pip; the interaction
                    // itself stays in place so nothing is lost.
                    dispatch({
                      type: "SET_INTERACTION_ENQUEUE_ERROR",
                      targetKey: key,
                      interactionId,
                      error: true,
                    });
                  });
              }
            }}
            onRetryReply={(key, replyId) => {
              // Errored-pip retry. The original upsert may have failed too
              // (that's why we're retrying), so re-upsert first to guarantee
              // the row exists before re-enqueueing.
              if (!activeWorktreeSource) return;
              const ix = state.interactions[key]?.find((entry) => entry.id === replyId);
              if (!ix) return;
              const worktreePath = activeWorktreeSource.worktreePath;
              // Optimistically clear the error so the pip flips back to ◌
              // queued the moment the user clicks; restore it on failure.
              dispatch({
                type: "SET_INTERACTION_ENQUEUE_ERROR",
                targetKey: key,
                interactionId: replyId,
                error: false,
              });
              upsertInteraction(ix, cs.id)
                .then(() => enqueueInteraction(replyId, worktreePath))
                .catch((err: unknown) => {
                  console.error("[shippable] retry enqueue failed:", err);
                  dispatch({
                    type: "SET_INTERACTION_ENQUEUE_ERROR",
                    targetKey: key,
                    interactionId: replyId,
                    error: true,
                  });
                });
            }}
            onDeleteReply={(key, replyId) => {
              // Unenqueue first when the interaction is still pending — the
              // agent hasn't pulled it, so it should leave the queue
              // cleanly. (DELETE_INTERACTION's sync would drop the row too,
              // but unenqueue is the explicit, race-free signal and a
              // no-op 404 if the row's already gone.) Delivered entries
              // stay in the agent's hands; we only drop the local view.
              const target = state.interactions[key]?.find((ix) => ix.id === replyId);
              if (
                target?.agentQueueStatus === "pending" &&
                activeWorktreeSource
              ) {
                unenqueueInteraction(replyId).catch((err: unknown) => {
                  console.error("[shippable] unenqueue failed:", err);
                });
              }
              dispatch({ type: "DELETE_INTERACTION", targetKey: key, interactionId: replyId });
            }}
            onVerifyAiNote={(recipe) => {
              setRunRequest((prev) => ({
                tick: (prev?.tick ?? 0) + 1,
                source: recipe.source,
                inputs: recipe.inputs,
              }));
            }}
            agentContext={
              activeWorktreeSource
                ? {
                    slice: agentSlice,
                    candidates: agentSessions,
                    selectedSessionFilePath:
                      pinnedSession ?? agentSlice?.session.filePath ?? null,
                    loading: agentLoading,
                    error: agentError,
                    mcpStatus,
                    delivered: deliveredComments,
                    lastSuccessfulPollAt: deliveredLastSuccessAt,
                    deliveredError: deliveredErrorState,
                    agentStartedThreads: agentStartedThreads(state.interactions),
                    onPickSession: (fp) => setPinnedSession(fp),
                    onRefresh: () => setAgentRefreshTick((t) => t + 1),
                  }
                : undefined
            }
            prConversation={cs.prConversation}
            worktreeSource={activeWorktreeSource ?? undefined}
            prSource={cs.prSource}
            changesetId={cs.id}
            onMergePrOverlay={(csId, prSource, prConversation, prInteractions, prDetached) => {
              dispatch({
                type: "MERGE_PR_OVERLAY",
                changesetId: csId,
                prSource,
                prConversation,
              });
              dispatch({
                type: "MERGE_PR_INTERACTIONS",
                changesetId: csId,
                prInteractions,
                prDetached,
              });
            }}
            onAuthError={(host, reason, retry, hint) => {
              setPrRefreshTokenModal({
                host,
                reason,
                pendingHtmlUrl: "",
                pendingAction: retry,
                hint,
              });
            }}
            onDetach={
              isTauri() ? () => void openDetachedWindow("inspector") : undefined
            }
          />
        )}
      </div>

      {guideViewModel && (
        <GuidePrompt viewModel={guideViewModel} onJump={jumpTo} />
      )}
      {showPlan && (
        <div className="planview-overlay" onClick={() => setShowPlan(false)}>
          <div
            className="planview-overlay__box"
            role="dialog"
            aria-modal="true"
            aria-label="review plan"
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
              onFilterToCommit={
                cs.worktreeSource
                  ? async (sha) => {
                      if (!cs.worktreeSource) return;
                      try {
                        const newCs = await fetchWorktreeChangeset(
                          {
                            path: cs.worktreeSource.worktreePath,
                            branch: cs.worktreeSource.branch,
                          },
                          { kind: "ref", ref: sha },
                        );
                        onLoadChangeset(newCs, {}, {
                          kind: "worktree",
                          path: cs.worktreeSource.worktreePath,
                          branch: cs.worktreeSource.branch,
                        });
                        setShowPlan(false);
                      } catch (e) {
                        console.error("filter to commit failed", e);
                      }
                    }
                  : undefined
              }
            />
          </div>
        </div>
      )}
      <CodeRunner
        currentFilePath={file.path}
        freeOpen={freeRunnerOpen}
        onFreeClose={() => setFreeRunnerOpen(false)}
        runRequest={runRequest}
      />
      {showPicker && (
        <PromptPicker
          context={buildAutoFillContext(cs, file, hunk, state.selection)}
          onClose={() => setShowPicker(false)}
          onSubmit={(prompt, rendered) => startPromptRun(prompt, rendered)}
        />
      )}
      {contextMenu &&
        (() => {
          const sel = state.selection;
          const range =
            sel && sel.hunkId === contextMenu.hunkId
              ? {
                  lo: Math.min(sel.anchor, sel.head),
                  hi: Math.max(sel.anchor, sel.head),
                }
              : { lo: contextMenu.lineIdx, hi: contextMenu.lineIdx };
          const readSet = state.readLines[contextMenu.hunkId] ?? new Set<number>();
          let allRead = true;
          for (let i = range.lo; i <= range.hi; i++) {
            if (!readSet.has(i)) {
              allRead = false;
              break;
            }
          }
          const replyEnabled =
            !sel &&
            !!ingestSignals.aiNoteByLine[
              `${contextMenu.hunkId}:${contextMenu.lineIdx}`
            ];
          const items: ContextMenuItem[] = [
            {
              id: "comment",
              label: "Comment",
              shortcut: "c",
              enabled: true,
              onSelect: () => runAction("START_COMMENT"),
            },
            {
              id: "prompt",
              label: "Run prompt…",
              shortcut: "/",
              enabled: true,
              onSelect: () => runAction("OPEN_PROMPT_PICKER"),
            },
            {
              id: "reply-ai",
              label: "Reply to AI",
              shortcut: "r",
              enabled: replyEnabled,
              onSelect: () => runAction("START_REPLY"),
            },
            {
              id: allRead ? "mark-unread" : "mark-read",
              label: allRead ? "Mark as unread" : "Mark as read",
              enabled: true,
              onSelect: () =>
                dispatch({
                  type: allRead ? "MARK_LINES_UNREAD" : "MARK_LINES_READ",
                  hunkId: contextMenu.hunkId,
                  loLineIdx: range.lo,
                  hiLineIdx: range.hi,
                }),
            },
          ];
          return (
            <LineContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              items={items}
              onClose={() => setContextMenu(null)}
            />
          );
        })()}
      {showCommandPalette && (
        <CommandPalette
          predicates={palettePredicates}
          onClose={() => setShowCommandPalette(false)}
          onPick={(action) => {
            setShowCommandPalette(false);
            runAction(action);
          }}
        />
      )}
      {showResetConfirm && (
        <ConfirmModal
          title="Reset review session?"
          message="Read marks, sign-offs, comments, and drafts will be cleared."
          confirmLabel="reset"
          danger
          onConfirm={() => {
            clearSession();
            window.location.reload();
          }}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}
      {showHelp && (
        <HelpOverlay
          context={buildHelpContext({
            hasSelection:
              !!state.selection && state.selection.hunkId === state.cursor.hunkId,
            lineHasAiNote,
            lineNoteAcked,
            currentFileReadFraction: fileCoverage(file, state.readLines),
            currentFileReviewed: state.reviewedFiles.has(file.id),
            showInspector,
          })}
          onClose={() => setShowHelp(false)}
        />
      )}
      {showLoad && (
        <LoadModal
          onClose={() => setShowLoad(false)}
          onLoad={(newCs, source, prData) => {
            onLoadChangeset(newCs, {}, source, prData);
            // Clear any prior slice/sessions so the fresh load doesn't
            // briefly show the previous worktree's transcript while the
            // new fetch runs. Provenance lives on cs.worktreeSource.
            setPinnedSession(null);
            setAgentSlice(null);
            setAgentSessions([]);
            setAgentError(null);
            setShowLoad(false);
          }}
        />
      )}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
      <StatusBar
        transientHint={mouseTip}
        viewModel={buildStatusBarViewModel({
          totalFiles: cs.files.length,
          fileIdx,
          totalHunks: file.hunks.length,
          hunkIdx,
          totalLines: hunk.lines.length,
          lineIdx: state.cursor.lineIdx,
          readCoverage,
          reviewedFiles,
          selection: selectionForStatusBar(hunk, state.selection),
          lineHasAiNote,
          lineNoteAcked,
          currentFileReadFraction: fileCoverage(file, state.readLines),
          currentFileReviewed: state.reviewedFiles.has(file.id),
          currentChangesetSignedOff:
            getChangesetReviewToken(cs) === null
              ? null
              : isChangesetSignedOff(cs, state.reviewedChangesets),
        })}
      />
    </div>
  );
}

type DefinitionPeekState =
  | { kind: "idle" }
  | { kind: "loading"; symbol: string; scopeKey: string }
  | { kind: "unsupported"; symbol: string; message: string; scopeKey: string }
  | { kind: "error"; symbol: string; message: string; scopeKey: string }
  | {
      kind: "results";
      symbol: string;
      definitions: DefinitionLocation[];
      scopeKey: string;
    };

/**
 * Filter `state.interactions` to threads the agent started — first entry
 * is agent-authored, no user-authored ask at the head. Returns one entry
 * per thread (the head). Drives the AgentContextSection "Comments"
 * rollup.
 */
function agentStartedThreads(
  interactions: Record<string, Interaction[]>,
): Array<{ threadKey: string; head: Interaction }> {
  const out: Array<{ threadKey: string; head: Interaction }> = [];
  for (const [threadKey, list] of Object.entries(interactions)) {
    if (list.length === 0) continue;
    const head = list[0];
    if (head.authorRole !== "agent") continue;
    out.push({ threadKey, head });
  }
  // Sort newest first by the head's createdAt.
  out.sort((a, b) => b.head.createdAt.localeCompare(a.head.createdAt));
  return out;
}

function DefinitionStatusChip({
  currentSource,
  fileLanguage,
  capabilities,
  fetchError,
}: {
  currentSource: RecentSource | null;
  fileLanguage: string;
  capabilities: DefinitionCapabilities | null;
  fetchError: string | null;
}) {
  // Hide entirely for non-programming files (markdown, json, yaml, …).
  // Plan-symbols.md L11: a "JS/TS only" chip on a markdown file is worse
  // than nothing.
  if (!isProgrammingLanguage(fileLanguage)) return null;

  if (capabilities === null && !fetchError) {
    return (
      <span
        className="topbar__meta-chip topbar__meta-chip--muted"
        title="Checking definition-navigation support."
      >
        def: checking
      </span>
    );
  }

  if (currentSource?.kind !== "worktree") {
    return (
      <span
        className="topbar__meta-chip topbar__meta-chip--muted"
        title="Load this diff from a local worktree before asking the server for definitions."
      >
        def: worktree only
      </span>
    );
  }

  if (fetchError) {
    return (
      <span
        className="topbar__meta-chip topbar__meta-chip--bad"
        title={`Couldn't reach the server for capabilities: ${fetchError}`}
      >
        def: unreachable
      </span>
    );
  }

  const cap = findCapabilityForLanguage(capabilities, fileLanguage);

  // Programming language we *could* handle in principle, but no module
  // claims it. Show the supported set so the user can see what's missing.
  if (!cap) {
    const supported = capabilities!.languages
      .filter((l) => l.available)
      .map((l) => l.id.toUpperCase());
    if (supported.length === 0) {
      return (
        <span
          className="topbar__meta-chip topbar__meta-chip--bad"
          title="No language servers are currently configured. See the README for setup."
        >
          def: unavailable
        </span>
      );
    }
    return (
      <span
        className="topbar__meta-chip topbar__meta-chip--muted"
        title={`Supported here: ${supported.join(", ")}. ${fileLanguage} isn't wired up yet.`}
      >
        {`def: ${supported.join(", ")} only`}
      </span>
    );
  }

  if (cap.available) {
    return (
      <span
        className="topbar__meta-chip topbar__meta-chip--ok"
        title={`Go-to-definition uses ${cap.resolver ?? cap.id} against the loaded worktree root.`}
      >
        {`def: ${cap.id.toUpperCase()} LSP`}
      </span>
    );
  }

  return (
    <span
      className="topbar__meta-chip topbar__meta-chip--bad"
      title={cap.reason ?? `Definition lookup unavailable for ${cap.id}.`}
    >
      {`def: ${cap.id.toUpperCase()} unavailable`}
    </span>
  );
}

function DefinitionPeek({
  peek,
  onDismiss,
}: {
  peek: DefinitionPeekState;
  onDismiss: () => void;
}) {
  if (peek.kind === "idle") return null;

  return (
    <section className={`definition-peek definition-peek--${peek.kind}`}>
      <div className="definition-peek__header">
        <strong>definition</strong>
        {" symbol "}
        <code>{peek.symbol}</code>
        <button
          type="button"
          className="definition-peek__close"
          onClick={onDismiss}
          aria-label="close definition peek"
          title="close (Esc)"
        >
          ×
        </button>
      </div>
      {peek.kind === "loading" && (
        <div className="definition-peek__body">Resolving against the workspace root…</div>
      )}
      {peek.kind === "unsupported" && (
        <div className="definition-peek__body">{peek.message}</div>
      )}
      {peek.kind === "error" && (
        <div className="definition-peek__body">{peek.message}</div>
      )}
      {peek.kind === "results" && (
        <div className="definition-peek__body">
          {peek.definitions.length === 0 ? (
            <div>No definition result came back from the language server.</div>
          ) : (
            peek.definitions.map((definition) => (
              <article key={`${definition.uri}:${definition.line}:${definition.col}`}>
                <div className="definition-peek__path">
                  {definition.file}:{definition.line + 1}
                </div>
                <pre className="definition-peek__preview">
                  {definition.preview || "No preview available."}
                </pre>
              </article>
            ))
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Turn a plan-view evidence reference into a Cursor for navigation.
 * Returns null for "description" (unreachable via click) and for refs that
 * don't resolve — the caller should treat null as "do nothing".
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
    case "symbol": {
      return symbols.get(ev.name) ?? null;
    }
  }
}

function resolveDefinitionToCursor(
  cs: ChangeSet,
  definition: DefinitionLocation,
): Cursor | null {
  if (!definition.workspaceRelativePath) return null;
  const file = cs.files.find((entry) => entry.path === definition.workspaceRelativePath);
  if (!file) return null;
  for (const hunk of file.hunks) {
    const lineIdx = hunk.lines.findIndex((line) => line.newNo === definition.line + 1);
    if (lineIdx === -1) continue;
    return {
      changesetId: cs.id,
      fileId: file.id,
      hunkId: hunk.id,
      lineIdx,
    };
  }
  return null;
}

function cycleChangeset(
  list: { id: string }[],
  currentId: string,
  delta: number,
): string {
  if (list.length <= 1) return currentId;
  const i = list.findIndex((c) => c.id === currentId);
  const n = list.length;
  return list[(i + delta + n) % n].id;
}

function selectionForStatusBar(
  hunk: { id: string; lines: { oldNo?: number; newNo?: number }[] },
  selection: { hunkId: string; anchor: number; head: number } | null,
): { lo: number; hi: number; loLineNo: number; hiLineNo: number } | null {
  if (!selection || selection.hunkId !== hunk.id) return null;
  const lo = Math.min(selection.anchor, selection.head);
  const hi = Math.max(selection.anchor, selection.head);
  const loLine = hunk.lines[lo];
  const hiLine = hunk.lines[hi];
  return {
    lo,
    hi,
    loLineNo: loLine?.newNo ?? loLine?.oldNo ?? lo + 1,
    hiLineNo: hiLine?.newNo ?? hiLine?.oldNo ?? hi + 1,
  };
}

/** Map the hint discriminator to a human-readable parenthetical. */
function hintText(hint: string): string {
  switch (hint) {
    case "rate-limit":
      return "rate limit hit";
    case "scope":
      return "check scope";
    case "invalid-token":
      return "check expiry/scope";
    default:
      return hint;
  }
}

function buildHelpContext({
  hasSelection,
  lineHasAiNote,
  lineNoteAcked,
  currentFileReadFraction,
  currentFileReviewed,
  showInspector,
}: {
  hasSelection: boolean;
  lineHasAiNote: boolean;
  lineNoteAcked: boolean;
  currentFileReadFraction: number;
  currentFileReviewed: boolean;
  showInspector: boolean;
}) {
  if (hasSelection) {
    return {
      title: "right now: selection active",
      rows: [
        { chord: "c", label: "start a comment on this selection" },
        { chord: "e", label: "run the selected code in the runner" },
        { chord: "/", label: "run a prompt on the selected code" },
        { chord: "Esc", label: "collapse the selection" },
      ],
      hint: "Selection commands are local to the diff. App-wide commands live under ⌘K / ⌃K.",
    };
  }

  if (lineHasAiNote && !lineNoteAcked) {
    return {
      title: "right now: AI note on this line",
      rows: [
        { chord: "a", label: "ack or un-ack the note" },
        { chord: "r", label: "reply to the note" },
        { chord: "c", label: "start your own comment on this line" },
      ],
      hint: "This section changes with context. The table below is still the full key sheet.",
    };
  }

  if (currentFileReadFraction >= 1 && !currentFileReviewed) {
    return {
      title: "right now: file is ready to sign off",
      rows: [
        { chord: "⇧m", label: "mark this file reviewed" },
        { chord: "]/[", label: "move to the next or previous file" },
        { chord: "p", label: "reopen the plan before moving on" },
      ],
      hint: "Signing off is separate from cursor visits. Read marks are automatic; review verdicts are not.",
    };
  }

  return {
    title: "right now: app-level actions",
    rows: [
      { chord: "⌘k/⌃k", label: "open the command palette for app actions" },
      { chord: "p", label: "toggle the review plan" },
      {
        chord: "i",
        label: showInspector ? "hide the inspector" : "reopen the inspector",
      },
      { chord: "⇧l", label: "load a changeset" },
      { chord: "⇧r", label: "open the free code runner" },
    ],
    hint: "Use ? for the full shortcut sheet. Use ⌘K / ⌃K when you want app-level commands instead of diff navigation.",
  };
}

/**
 * Renders PR-specific topbar metadata: state badge, last-fetched time,
 * and a refresh button. Only rendered when cs.prSource is set.
 */
function PrTopbarMeta({
  prSource,
  refreshBusy,
  onRefresh,
}: {
  prSource: PrSource;
  refreshBusy: boolean;
  onRefresh: () => void;
}) {
  const stateClass =
    prSource.state === "open"
      ? "topbar__meta-chip--ok"
      : prSource.state === "merged"
        ? "topbar__meta-chip--good"
        : "topbar__meta-chip--muted";

  const fetchedTime = formatHHMM(prSource.lastFetchedAt);

  return (
    <>
      <span className="topbar__branch">
        {prSource.headRef} → {prSource.baseRef}
      </span>
      <span className={`topbar__meta-chip ${stateClass}`}>
        {prSource.state}
      </span>
      <span
        className="topbar__meta-chip topbar__meta-chip--muted"
        title={prSource.lastFetchedAt}
      >
        fetched {fetchedTime}
      </span>
      <button
        type="button"
        className="topbar__btn"
        onClick={onRefresh}
        disabled={refreshBusy}
        title="Refresh PR diff and comments from GitHub"
      >
        <span className="topbar__btn-label">
          {refreshBusy ? "refreshing…" : "↻ refresh"}
        </span>
      </button>
    </>
  );
}

function formatHHMM(iso: string): string {
  try {
    const d = new Date(iso);
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  } catch {
    return "—";
  }
}

/**
 * Persistent plan summary in the topbar. Shows "plan · X/N" where X is
 * the number of suggested entry-point files the reviewer has signed off
 * on (Shift+M) and N is the total number of entries. Click toggles the
 * plan modal — same gesture as `p`.
 */
function PlanChip({
  isOpen,
  plan,
  reviewedFiles,
  onToggle,
}: {
  isOpen: boolean;
  plan: { entryPoints: { fileId: string }[] } | null;
  reviewedFiles: Set<string>;
  onToggle: () => void;
}) {
  const total = plan?.entryPoints.length ?? 0;
  const done =
    plan?.entryPoints.filter((e) => reviewedFiles.has(e.fileId)).length ?? 0;
  const allDone = total > 0 && done === total;
  return (
    <button
      className={`topbar__btn topbar__btn--plan ${
        isOpen ? "topbar__btn--on" : ""
      } ${allDone ? "topbar__btn--done" : ""}`}
      onClick={onToggle}
      title="open the review plan (p)"
      type="button"
    >
      <span className="topbar__btn-label">
        ◇ plan{total > 0 ? ` · ${done}/${total}` : ""}
      </span>
      <kbd>p</kbd>
    </button>
  );
}
