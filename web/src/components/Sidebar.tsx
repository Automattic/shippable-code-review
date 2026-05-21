import "./Sidebar.css";
import type { SidebarFileItem, SidebarViewModel } from "../view";
import type { QuizSelfEval } from "../types";
import { PromptRunsPanel, type PromptRunView } from "./PromptRunsPanel";
import { QuizPanel } from "./QuizPanel";

interface Props {
  viewModel: SidebarViewModel;
  onPickFile: (fileId: string) => void;
  /** Click on a file's comment badge — jumps to the first comment in that file. */
  onJumpToFirstComment: (fileId: string) => void;
  runs: PromptRunView[];
  onCloseRun: (id: string) => void;
  wide: boolean;
  onToggleWide: () => void;
  /** When set, renders a ↗ button that pops this panel into its own OS
   *  window. Undefined hides the affordance — browser mode and the gallery
   *  preview both rely on that to keep the chrome out of contexts where it
   *  has nowhere to land. */
  onDetach?: () => void;
  onQuizSubmit?: (questionId: string, answer: string) => void;
  onQuizDismiss?: () => void;
  onQuizSelfEval?: (questionId: string, selfEval: QuizSelfEval) => void;
}

export function Sidebar({
  viewModel,
  onPickFile,
  onJumpToFirstComment,
  runs,
  onCloseRun,
  wide,
  onToggleWide,
  onDetach,
  onQuizSubmit,
  onQuizDismiss,
  onQuizSelfEval,
}: Props) {
  return (
    <aside className="sidebar" aria-label="changed files">
      {onDetach && (
        <div className="sidebar__chrome">
          <button
            type="button"
            className="sidebar__detach"
            onClick={onDetach}
            title="Pop the file list into its own window"
            aria-label="Detach file list"
          >
            ↗
          </button>
        </div>
      )}
      <QuizPanel
        changesetId={viewModel.changesetId}
        quiz={viewModel.quiz}
        onSubmit={onQuizSubmit ?? (() => {})}
        onDismiss={onQuizDismiss ?? (() => {})}
        onSelfEval={onQuizSelfEval ?? (() => {})}
      />
      <PromptRunsPanel
        runs={runs}
        onClose={onCloseRun}
        wide={wide}
        onToggleWide={onToggleWide}
      />
      <section className="panel">
        <header className="panel__h">Files</header>
        {viewModel.files.length === 0 && (
          <div className="panel__empty">No files in this changeset.</div>
        )}
        <ul className="panel__list">
          {viewModel.files.map((f) => (
            <li
              key={f.fileId}
              className={`row-wrap ${f.isCurrent ? "row-wrap--active" : ""} ${
                f.isReviewed ? "row-wrap--file-reviewed" : ""
              }`}
            >
              <button
                className={`row ${f.isCurrent ? "row--active" : ""} ${
                  f.isReviewed ? "row--file-reviewed" : ""
                }`}
                onClick={() => onPickFile(f.fileId)}
                title={titleFor(f)}
              >
                <span
                  className="row__check"
                  aria-label={f.isReviewed ? "reviewed" : "not reviewed"}
                >
                  {f.isReviewed ? "✓" : " "}
                </span>
                <Meter readPct={f.readPct} meterBar={f.meterBar} />
                <span className={`row__status row__status--${f.status}`}>
                  {f.statusChar}
                </span>
                <span className="row__label">{f.path}</span>
              </button>
              {f.commentCount > 0 && (
                <button
                  type="button"
                  className="row__comments"
                  onClick={() => onJumpToFirstComment(f.fileId)}
                  aria-label={`jump to first of ${f.commentCount} comment${f.commentCount === 1 ? "" : "s"}`}
                  title={`jump to first comment (${f.commentCount} in this file)`}
                >
                  <span className="row__comments-glyph" aria-hidden="true">❝</span>
                  <span className="row__comments-count">{f.commentCount}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

function titleFor(f: SidebarFileItem): string {
  const parts = [f.path];
  if (f.isReviewed) parts.push("reviewed");
  parts.push(`read ${f.readPct}%`);
  if (f.commentCount > 0) {
    parts.push(`${f.commentCount} comment${f.commentCount === 1 ? "" : "s"}`);
  }
  return parts.join(" — ");
}

/**
 * Meter shows the reviewer's reading progress as an 8-block bar plus a
 * percentage. Reading is a "where have I been" signal — never a verdict —
 * so the bar is always neutral; the verdict (reviewed) is communicated
 * separately by the file-row tint and the leading checkmark.
 */
function Meter({ readPct, meterBar }: { readPct: number; meterBar: string }) {
  return (
    <span className="meter" aria-label={`${readPct}% read`}>
      <span className="meter__bar">{meterBar}</span>
      <span className="meter__pct">{readPct.toString().padStart(3)}%</span>
    </span>
  );
}
