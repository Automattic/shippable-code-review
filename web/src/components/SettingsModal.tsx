// Portal-mounted modal that hosts the settings-mode CredentialsPanel. Closes
// on backdrop click and Esc. Reuses LoadModal's modal CSS for the frame.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import "./LoadModal.css";
import "./CredentialsPanel.css";
import { CredentialsPanel } from "./CredentialsPanel";

interface Props {
  onClose: () => void;
  inlineComments: boolean;
  onChangeInlineComments: (value: boolean) => void;
  hideNonActiveComments: boolean;
  onChangeHideNonActiveComments: (value: boolean) => void;
  ligatures: boolean;
  onChangeLigatures: (value: boolean) => void;
}

export function SettingsModal({
  onClose,
  inlineComments,
  onChangeInlineComments,
  hideNonActiveComments,
  onChangeHideNonActiveComments,
  ligatures,
  onChangeLigatures,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const content = (
    <div
      className="modal"
      data-testid="settings-backdrop"
      onClick={onClose}
    >
      <div
        className="modal__box modal__box--wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="settings"
      >
        <header className="modal__h">
          <span className="modal__h-label">settings</span>
          <button className="modal__close" onClick={onClose}>
            × close
          </button>
        </header>
        <section className="modal__sec">
          <p className="modal__sec-h">interactions</p>
          <p className="modal__hint">Show review comments inline in the diff</p>
          <button
            className={
              inlineComments
                ? "modal__btn modal__btn--primary"
                : "modal__btn"
            }
            aria-pressed={inlineComments}
            onClick={() => onChangeInlineComments(!inlineComments)}
          >
            Inline comments
          </button>
          <p className="modal__hint" style={{ marginTop: 8 }}>
            With inline comments on, every line's comments show; turn this on to
            show only the active line's.
          </p>
          <button
            className={
              hideNonActiveComments
                ? "modal__btn modal__btn--primary"
                : "modal__btn"
            }
            aria-pressed={hideNonActiveComments}
            onClick={() => onChangeHideNonActiveComments(!hideNonActiveComments)}
          >
            Hide non-active comments
          </button>
        </section>
        <section className="modal__sec">
          <p className="modal__sec-h">display</p>
          <p className="modal__hint">
            Turn off if <code>=&gt;</code>, <code>!=</code>, <code>-&gt;</code>{" "}
            etc. render as merged glyphs and you'd rather see plain characters.
          </p>
          <button
            className={
              ligatures ? "modal__btn modal__btn--primary" : "modal__btn"
            }
            aria-pressed={ligatures}
            onClick={() => onChangeLigatures(!ligatures)}
          >
            Font ligatures
          </button>
        </section>
        <section className="modal__sec">
          <CredentialsPanel mode="settings" />
        </section>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
