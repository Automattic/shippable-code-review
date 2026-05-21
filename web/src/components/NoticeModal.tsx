import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "./LoadModal.css";

interface Props {
  title: string;
  message: string;
  details?: string;
  okLabel?: string;
  onClose: () => void;
}

// One-button modal for showing the result of a fire-and-forget action.
// Wry doesn't support window.alert(), so this stands in for it.
export function NoticeModal({
  title,
  message,
  details,
  okLabel = "ok",
  onClose,
}: Props) {
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    okRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "Enter") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const content = (
    <div className="modal" onClick={onClose}>
      <div className="modal__box" onClick={(e) => e.stopPropagation()}>
        <header className="modal__h">
          <span className="modal__h-label">{title}</span>
          <button type="button" className="modal__close" onClick={onClose}>
            × close
          </button>
        </header>
        <section className="modal__sec">
          <p className="modal__hint">{message}</p>
          {details && (
            <pre className="modal__hint" style={{ whiteSpace: "pre-wrap" }}>
              {details}
            </pre>
          )}
          <div className="modal__row modal__row--end">
            <button
              type="button"
              ref={okRef}
              className="modal__btn modal__btn--primary"
              onClick={onClose}
            >
              {okLabel}
            </button>
          </div>
        </section>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
