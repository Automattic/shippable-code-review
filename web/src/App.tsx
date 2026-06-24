import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import "./App.css";
import { findStub } from "./fixtures";
import { initialState, reducer } from "./state";
import { Welcome } from "./components/Welcome";
import { ReviewWorkspace } from "./components/ReviewWorkspace";
import { LiveReloadBar } from "./components/LiveReloadBar";
import { FindBar } from "./components/FindBar";
import { Toast } from "./components/Toast";
import { useTauriMenu } from "./useTauriMenu";
import {
  focusIfDuplicate,
  onToastEvent,
  setWindowChangeset,
  setWindowTitle,
} from "./multiWindow";
import { useRegisterMcp } from "./useRegisterMcp";
import { NoticeModal } from "./components/NoticeModal";
import { RegisterMcpModal } from "./components/RegisterMcpModal";
import type {
  ChangeSet,
  DetachedInteraction,
  Interaction,
  WorktreeProvenance,
  WorktreeState,
} from "./types";
import {
  getLiveReloadEnabled,
  hasProgress,
  loadSession,
  peekSession,
  saveSession,
  setLiveReloadEnabled,
} from "./persist";
import {
  loadRecents,
  pushRecent,
  type RecentEntry,
  type RecentSource,
} from "./recents";
import { useTheme } from "./useTheme";
import { useWorktreeLiveReload } from "./useWorktreeLiveReload";
import { fetchWorktreeChangeset, type LoadOpts } from "./worktreeChangeset";
import { fetchInteractions } from "./interactionClient";
import { useInteractionSync } from "./useInteractionSync";
import { reportStat } from "./reportStat";

interface BootSeed {
  changesets: ChangeSet[];
  /** Pre-seeded interactions for this changeset (stub fixtures only). */
  interactions: Record<string, Interaction[]>;
  /** Whether to overlay the persisted snapshot onto initialState. */
  applyPersisted: boolean;
  /** What put us here — used to upsert into recents on boot. Null = welcome. */
  source: RecentSource | null;
}

/**
 * Decide what to show on first paint. URL param wins, then a real
 * resumable session (persisted progress + a known changeset), otherwise
 * welcome.
 */
function resolveBoot(): BootSeed {
  const params = new URLSearchParams(window.location.search);
  const wanted = params.get("cs") ?? params.get("c");
  if (wanted) {
    const stub = findStub(wanted);
    if (stub) {
      return {
        changesets: [stub.changeset],
        interactions: { ...stub.interactions },
        applyPersisted: false,
        source: { kind: "stub", code: stub.code },
      };
    }
    // "Open in new window" routes here: the spawning window pushes the
    // changeset to recents and the new window picks it up by id.
    const recent = loadRecents().find((r) => r.id === wanted);
    if (recent && isResumableChangeset(recent.changeset)) {
      return {
        changesets: [recent.changeset],
        interactions: {},
        applyPersisted: true,
        source: recent.source,
      };
    }
  }

  const peeked = peekSession();
  if (peeked && hasProgress(peeked)) {
    const csId = peeked.cursor.changesetId;
    const recent = loadRecents().find((r) => r.id === csId);
    if (recent && isResumableChangeset(recent.changeset)) {
      // Stubs carry ingest-derived interactions (AI notes) in fixture code —
      // not in the DB. Seed them inline so the inspector renders on boot
      // before the per-changeset DB fetch completes.
      const stub = findStub(csId);
      return {
        changesets: [recent.changeset],
        interactions: stub ? { ...stub.interactions } : {},
        applyPersisted: true,
        source: recent.source,
      };
    }
    const stub = findStub(csId);
    if (stub && isResumableChangeset(stub.changeset)) {
      return {
        changesets: [stub.changeset],
        interactions: { ...stub.interactions },
        applyPersisted: true,
        source: { kind: "stub", code: stub.code },
      };
    }
  }

  return {
    changesets: [],
    interactions: {},
    applyPersisted: false,
    source: null,
  };
}

// Stored recents from before the pushRecent guard landed can have empty
// `files`. Treat them as non-resumable so boot falls through to Welcome
// instead of crashing on a cursor we can't anchor.
function isResumableChangeset(cs: ChangeSet): boolean {
  for (const f of cs.files) {
    if (f.hunks.length > 0) return true;
  }
  return false;
}

const TITLE_PREFIX = "Shippable";
const TITLE_MAX = 60;

function windowTitleFor(cs: ChangeSet | null): string {
  if (!cs) return TITLE_PREFIX;
  // Prefer branch — what a reviewer asks for when naming a window.
  // Fall back to the worktree directory basename for detached HEADs so
  // a row of detached windows isn't all "Shippable — (detached)".
  const wt = cs.worktreeSource;
  const label = wt ? (wt.branch ?? basename(wt.worktreePath)) : cs.title;
  return `${TITLE_PREFIX} — ${truncate(label, TITLE_MAX)}`;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export default function App() {
  const [themeId, setThemeId] = useTheme();
  const { findOpen, closeFind } = useTauriMenu();
  const {
    snippets: mcpSnippets,
    error: mcpError,
    open: openMcpSetUp,
    close: closeMcpSetUp,
    dismissError: dismissMcpError,
  } = useRegisterMcp();
  const [boot] = useState<BootSeed>(() => resolveBoot());
  const [hydrated] = useState(() =>
    boot.applyPersisted
      ? loadSession(boot.changesets)
      : { state: null, drafts: {} as Record<string, string> },
  );
  const [state, dispatch] = useReducer(reducer, boot, (b) => {
    const initial = initialState(b.changesets, b.interactions);
    const persisted = hydrated.state;
    if (!persisted) return initial;
    // Boot starts with ingest-derived interactions only; persisted interactions
    // now live in the server DB and are fetched per-changeset elsewhere.
    return {
      ...initial,
      cursor: persisted.cursor,
      readLines: persisted.readLines,
      reviewedFiles: persisted.reviewedFiles,
      reviewedChangesets: persisted.reviewedChangesets,
      dismissedGuides: persisted.dismissedGuides,
      quiz: persisted.quiz,
    };
  });
  const [recents, setRecents] = useState<RecentEntry[]>(() => {
    // On boot with a resolved changeset, upsert it into recents — the
    // next welcome shows it at the top. For the welcome boot (no source)
    // just return the persisted list as-is.
    if (boot.source && boot.changesets.length > 0) {
      return pushRecent(boot.changesets[0], boot.source);
    }
    return loadRecents();
  });
  const [currentSource, setCurrentSource] = useState<RecentSource | null>(boot.source);
  const [drafts, setDrafts] = useState<Record<string, string>>(
    () => hydrated.drafts,
  );
  const [toast, setToast] = useState<string | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  // Cross-component toast bus — lets Welcome / LoadModal / multiWindow
  // surface a notification without prop-drilling. App owns the state.
  useEffect(() => onToastEvent(setToast), []);

  // Debounced persist of state + drafts. The reducer guards against
  // non-LOAD actions when changesets is empty, so saving the welcome
  // sentinel state is harmless — it won't pass hasProgress() on next
  // boot and welcome will reappear.
  useEffect(() => {
    const t = window.setTimeout(() => saveSession(state, drafts), 300);
    return () => window.clearTimeout(t);
  }, [state, drafts]);


  async function handleLoadChangeset(
    cs: ChangeSet,
    interactions: Record<string, Interaction[]>,
    source: RecentSource,
    prData?: {
      prInteractions: Record<string, Interaction[]>;
      prDetached: DetachedInteraction[];
    },
  ) {
    // Duplicate guard: if another window is already showing this id,
    // focus it and skip the in-place swap. No "open anyway" — having the
    // same review live in two windows would diverge progress / comments
    // / marks with no recovery.
    if (await focusIfDuplicate(cs.id)) {
      setToast("Already open in another window — focused it");
      return;
    }
    // Loads coming through this path (paste, URL, PR, worktree) carry no
    // ingest-derived AI annotations today — `interactions` is whatever
    // user-authored / stub-seeded state the caller threads in.
    dispatch({
      type: "LOAD_CHANGESET",
      changeset: cs,
      interactions,
    });
    reportStat("review-started", cs.id);
    if (prData) {
      dispatch({
        type: "MERGE_PR_INTERACTIONS",
        changesetId: cs.id,
        prInteractions: prData.prInteractions,
        prDetached: prData.prDetached,
      });
    }
    setCurrentSource(source);
    setRecents(pushRecent(cs, source));
  }

  // ── Live reload ───────────────────────────────────────────────────────
  // Provenance (path + branch + sha + dirtyHash baseline) lives on the
  // active changeset's worktreeSource. We derive it for the polling hook +
  // banner; null for non-worktree loads (paste/url/upload/stub).
  const activeCs =
    state.changesets.find((c) => c.id === state.cursor.changesetId) ?? null;

  // ── Per-changeset interaction fetch ───────────────────────────────────
  // Interactions live in the server DB, keyed by changeset id. Fetch them
  // once per changeset the first time it becomes active and merge them in
  // via LOAD_CHANGESET, whose reducer keeps any locally-authored entries
  // and only appends DB entries not already held by id. Stub fixtures still
  // seed inline; the merge dedups so a re-fetch can't double them.
  //
  // The effect keys ONLY on `activeCsId` — NOT on `state.changesets`. Every
  // reducer dispatch produces a fresh `changesets` array reference, and an
  // effect that re-ran on that churn would discard an in-flight fetch. We
  // read the changeset list from a ref so the lookup stays current.
  //
  // `appliedCsIds` (not a plain "fetch started" guard) records changesets
  // whose fetch *result has been applied*. StrictMode double-invokes the
  // effect: mount → cleanup (cancels the fetch) → remount. A "started"
  // guard would block the remount's fetch while the cancelled first fetch
  // never applies — interactions silently never load. Keying on "applied"
  // lets the remount re-fetch (a GET; the merge dedups), and the flag still
  // stops a redundant fetch once one genuinely lands.
  const changesetsRef = useRef(state.changesets);
  useEffect(() => {
    changesetsRef.current = state.changesets;
  });
  const activeCsId = activeCs?.id ?? null;

  // Multi-window: tell Rust which changeset this window is showing so a
  // peer window can refuse to open the same id twice. `null` resets the
  // entry when this window goes back to welcome. No-op outside Tauri.
  useEffect(() => {
    void setWindowChangeset(activeCsId);
  }, [activeCsId]);

  // Surface a short identifier — branch / path / title — in the OS
  // window title so users can tell windows apart in the dock and the
  // ⌘` switcher. No-op in browser dev (browser tab title still updates
  // via document.title elsewhere).
  const windowTitle = useMemo(() => windowTitleFor(activeCs), [activeCs]);
  useEffect(() => {
    void setWindowTitle(windowTitle);
  }, [windowTitle]);

  const appliedCsIds = useRef(new Set<string>());
  useEffect(() => {
    if (!activeCsId || appliedCsIds.current.has(activeCsId)) return;
    let cancelled = false;
    fetchInteractions(activeCsId)
      .then((fetched) => {
        if (cancelled) return;
        appliedCsIds.current.add(activeCsId);
        if (fetched.length === 0) return;
        const cs = changesetsRef.current.find((c) => c.id === activeCsId);
        if (!cs) return;
        const byThread: Record<string, Interaction[]> = {};
        for (const ix of fetched) {
          (byThread[ix.threadKey] ??= []).push(ix);
        }
        dispatch({ type: "LOAD_CHANGESET", changeset: cs, interactions: byThread });
      })
      .catch((err: unknown) => {
        console.error("[shippable] interaction fetch failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCsId]);

  // Mirror local user-authored interaction mutations back to the DB. The
  // wrapped dispatch is what the review UI uses; App's own LOAD_CHANGESET /
  // RELOAD_CHANGESET dispatches pass through it untouched.
  const syncedDispatch = useInteractionSync(
    state,
    dispatch,
    activeCsId,
    activeCs?.worktreeSource?.worktreePath ?? null,
  );
  const provenance: WorktreeProvenance | null = useMemo(() => {
    const src = activeCs?.worktreeSource;
    if (!src || !src.state) return null;
    return { path: src.worktreePath, branch: src.branch, state: src.state };
  }, [activeCs]);

  const [liveReloadEnabled, setLiveReloadEnabledState] = useState(true);
  const [staleNext, setStaleNext] = useState<WorktreeState | null>(null);
  const [worktreeGone, setWorktreeGone] = useState(false);
  const [busyReloading, setBusyReloading] = useState(false);
  const [lastProvenancePath, setLastProvenancePath] = useState<string | null>(
    null,
  );

  // "Adjust state during render" when the loaded worktree changes: hydrate
  // the per-worktree toggle and clear stale/gone banners that belonged to
  // the previous worktree. Avoids the cascading-render lint warning that
  // setState-inside-useEffect would trigger.
  const currentPath = provenance?.path ?? null;
  if (lastProvenancePath !== currentPath) {
    setLastProvenancePath(currentPath);
    if (currentPath) {
      setLiveReloadEnabledState(getLiveReloadEnabled(currentPath));
    }
    setStaleNext(null);
    setWorktreeGone(false);
  }

  useWorktreeLiveReload({
    provenance,
    enabled: liveReloadEnabled && !worktreeGone,
    onDrift: (next) => setStaleNext(next),
    onWorktreeGone: () => setWorktreeGone(true),
  });

  function toggleLiveReload() {
    if (!provenance) return;
    const next = !liveReloadEnabled;
    setLiveReloadEnabledState(next);
    setLiveReloadEnabled(provenance.path, next);
    if (!next) setStaleNext(null);
  }

  async function reloadWorktree() {
    if (!provenance || !activeCs || busyReloading) return;
    setBusyReloading(true);
    try {
      // Reload the same slice the user originally loaded. Without this the
      // reload collapsed to dirty-only or the cumulative branch view, dropping
      // whatever scope was picked (e.g. a "last commit + uncommitted" range).
      const src = activeCs.worktreeSource;
      const opts: LoadOpts | undefined = src?.range
        ? { kind: "range", ...src.range }
        : src?.dirty
          ? { kind: "dirty" }
          : undefined;
      const newCs = await fetchWorktreeChangeset(
        { path: provenance.path, branch: provenance.branch },
        opts,
      );
      // RELOAD_CHANGESET (not LOAD_CHANGESET) so the anchoring pass runs:
      // existing replies re-anchor to the new diff or move into the
      // Detached pile. LOAD_CHANGESET would silently orphan them.
      const source: RecentSource = {
        kind: "worktree",
        path: provenance.path,
        branch: provenance.branch,
      };
      dispatch({
        type: "RELOAD_CHANGESET",
        prevChangesetId: activeCs.id,
        changeset: newCs,
      });
      setCurrentSource(source);
      setRecents(pushRecent(newCs, source));
      setStaleNext(null);
    } catch (err) {
      console.error("[shippable] live-reload reload failed:", err);
    } finally {
      setBusyReloading(false);
    }
  }

  const liveReloadBar = provenance ? (
    <LiveReloadBar
      provenance={provenance}
      enabled={liveReloadEnabled}
      staleNext={staleNext}
      worktreeGone={worktreeGone}
      busyReloading={busyReloading}
      onToggleEnabled={toggleLiveReload}
      onReload={reloadWorktree}
      onDismissStale={() => setStaleNext(null)}
      onDismissGone={() => setWorktreeGone(false)}
    />
  ) : null;

  if (state.changesets.length === 0) {
    return (
      <>
        <Welcome
          recents={recents}
          onLoad={handleLoadChangeset}
          onRecentsChange={setRecents}
        />
        <FindBar open={findOpen} onClose={closeFind} />
        {toast && <Toast message={toast} onClose={dismissToast} />}
        {mcpSnippets && (
          <RegisterMcpModal snippets={mcpSnippets} onClose={closeMcpSetUp} />
        )}
        {mcpError && (
          <NoticeModal
            title={mcpError.title}
            message={mcpError.message}
            onClose={dismissMcpError}
          />
        )}
      </>
    );
  }

  return (
    <>
      <ReviewWorkspace
        state={state}
        dispatch={syncedDispatch}
        rawDispatch={dispatch}
        drafts={drafts}
        setDrafts={setDrafts}
        themeId={themeId}
        setThemeId={setThemeId}
        onLoadChangeset={handleLoadChangeset}
        currentSource={currentSource}
        liveReloadBar={liveReloadBar}
        onMcpSetUp={openMcpSetUp}
      />
      <FindBar open={findOpen} onClose={closeFind} />
      {toast && <Toast message={toast} onClose={dismissToast} />}
      {mcpSnippets && (
        <RegisterMcpModal snippets={mcpSnippets} onClose={closeMcpSetUp} />
      )}
      {mcpError && (
        <NoticeModal
          title={mcpError.title}
          message={mcpError.message}
          onClose={dismissMcpError}
        />
      )}
    </>
  );
}
