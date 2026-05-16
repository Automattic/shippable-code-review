import "./StatusBar.css";
import type { StatusBarViewModel } from "../view";

interface Props {
  viewModel: StatusBarViewModel;
  transientHint?: string | null;
}

export function StatusBar({ viewModel, transientHint }: Props) {
  return (
    <footer className="statusbar">
      <span className="statusbar__cell">{viewModel.lineDisplay}</span>
      <span className="statusbar__cell">{viewModel.hunkDisplay}</span>
      <span className="statusbar__cell">{viewModel.fileDisplay}</span>
      <span
        className="statusbar__cell statusbar__cell--read"
        title="cursor visits — auto-tracked"
      >
        {viewModel.readDisplay}
      </span>
      <span
        className="statusbar__cell statusbar__cell--cov"
        title="files signed off via Shift+M"
      >
        {viewModel.filesDisplay}
      </span>
      {viewModel.changesetSignOffDisplay !== null && (
        <span
          className={
            "statusbar__cell statusbar__cell--changeset" +
            (viewModel.changesetSignedOff
              ? " statusbar__cell--changeset-on"
              : "")
          }
          title="changeset signed off at this revision · Shift+S to toggle"
        >
          {viewModel.changesetSignOffDisplay}
        </span>
      )}
      <span className="statusbar__spacer" />
      {transientHint ? (
        <span className="statusbar__hint statusbar__hint--tip">
          {transientHint}
        </span>
      ) : viewModel.selectionHint ? (
        <span className="statusbar__hint statusbar__hint--selection">
          {viewModel.selectionHint}
        </span>
      ) : (
        <span className="statusbar__hint">{viewModel.defaultHint}</span>
      )}
    </footer>
  );
}
