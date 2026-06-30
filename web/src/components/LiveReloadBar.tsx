import "./LiveReloadBar.css";
import type { WorktreeProvenance, WorktreeState } from "../types";

interface Props {
  provenance: WorktreeProvenance;
  enabled: boolean;
  staleNext: WorktreeState | null;
  /** Whether the loaded slice includes uncommitted edits. Gates the dirty
   *  part of the drift message — a slice that excludes them won't load them
   *  on reload, so naming them would mislead. */
  watchDirty: boolean;
  worktreeGone: boolean;
  busyReloading: boolean;
  onToggleEnabled: () => void;
  onReload: () => void;
  onDismissStale: () => void;
  onDismissGone: () => void;
}

/**
 * Sits above the topbar while a worktree changeset is loaded. Three states:
 *   - idle: "watching <branch>" with a pause/resume toggle
 *   - stale: drift detected, primary action reloads via LOAD_CHANGESET
 *   - gone: 3 consecutive poll failures, surfaced once, polling stopped
 */
export function LiveReloadBar({
  provenance,
  enabled,
  staleNext,
  watchDirty,
  worktreeGone,
  busyReloading,
  onToggleEnabled,
  onReload,
  onDismissStale,
  onDismissGone,
}: Props) {
  const branchLabel = provenance.branch ?? "(detached)";

  if (worktreeGone) {
    return (
      <div className="livebar livebar--gone" role="status" aria-label="live reload">
        <span className="livebar__icon">⚠</span>
        <span className="livebar__msg">
          Worktree at <code>{provenance.path}</code> is no longer reachable.
          Live reload stopped.
        </span>
        <button type="button" className="livebar__btn" onClick={onDismissGone}>
          dismiss
        </button>
      </div>
    );
  }

  if (staleNext) {
    return (
      <div className="livebar livebar--stale" role="status" aria-label="live reload">
        <span className="livebar__icon">●</span>
        <span className="livebar__msg">
          {describeDrift(provenance.state, staleNext, watchDirty)}
        </span>
        <button
          type="button"
          className="livebar__btn livebar__btn--primary"
          onClick={onReload}
          disabled={busyReloading}
        >
          {busyReloading ? "reloading…" : "reload"}
        </button>
        <button
          type="button"
          className="livebar__btn"
          onClick={onDismissStale}
          disabled={busyReloading}
          title="hide this banner; live reload stays on"
        >
          dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="livebar" role="status" aria-label="live reload">
      <span className={`livebar__dot ${enabled ? "livebar__dot--on" : ""}`} />
      <span className="livebar__msg livebar__msg--muted">
        {enabled ? "watching " : "paused on "}
        <strong>{branchLabel}</strong>{" "}
        <span className="livebar__path">{provenance.path}</span>
      </span>
      <button
        type="button"
        className="livebar__btn"
        onClick={onToggleEnabled}
        title="toggle live reload for this worktree"
      >
        {enabled ? "pause" : "resume"}
      </button>
    </div>
  );
}

function describeDrift(
  was: WorktreeState,
  now: WorktreeState,
  watchDirty: boolean,
): string {
  if (was.sha !== now.sha) {
    return watchDirty && now.dirty
      ? "New commit + uncommitted edits"
      : "New commit on this worktree";
  }
  if (!was.dirty && now.dirty) return "Uncommitted edits in this worktree";
  if (was.dirty && !now.dirty) return "Uncommitted edits cleared";
  return "Uncommitted edits changed";
}
