import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./LoadModal.css";

export interface McpTarget {
  id: string;
  display_name: string;
  config_path: string;
  detected: boolean;
  current_command: string | null;
}

interface Props {
  targets: McpTarget[];
  binaryPath: string;
  onConfirm: (ids: string[]) => void;
  onCancel: () => void;
}

export function RegisterMcpModal({
  targets,
  binaryPath,
  onConfirm,
  onCancel,
}: Props) {
  const initialSelection = useMemo(
    () => new Set(targets.filter((t) => t.detected).map((t) => t.id)),
    [targets],
  );
  const [selected, setSelected] = useState<Set<string>>(initialSelection);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const content = (
    <div className="modal" onClick={onCancel}>
      <div className="modal__box" onClick={(e) => e.stopPropagation()}>
        <header className="modal__h">
          <span className="modal__h-label">Register Shippable MCP</span>
          <button type="button" className="modal__close" onClick={onCancel}>
            × close
          </button>
        </header>
        <section className="modal__sec">
          <p className="modal__hint">
            Pick which clients to register with. Detected clients are
            pre-checked; unchecked ones will be left alone.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
            {targets.map((t) => {
              const isSelected = selected.has(t.id);
              const sameBinary =
                binaryPath !== "" && t.current_command === binaryPath;
              const status = !t.detected
                ? "not detected"
                : t.current_command == null
                  ? "will add new entry"
                  : sameBinary
                    ? "already registered"
                    : "will replace existing entry";
              return (
                <li key={t.id} style={{ padding: "4px 0" }}>
                  <label
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(t.id)}
                      style={{ marginTop: 2 }}
                    />
                    <span style={{ flex: 1 }}>
                      <span style={{ display: "block" }}>{t.display_name}</span>
                      <span
                        className="modal__hint"
                        style={{ display: "block", margin: 0 }}
                      >
                        {t.config_path} — {status}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="modal__hint">
            Binary: <code>{binaryPath || "(resolved at apply time)"}</code>
          </p>
          <div className="modal__row modal__row--end">
            <button type="button" className="modal__btn" onClick={onCancel}>
              cancel
            </button>
            <button
              type="button"
              ref={confirmRef}
              className="modal__btn modal__btn--primary"
              onClick={() => onConfirm(Array.from(selected))}
              disabled={selected.size === 0}
            >
              register ({selected.size})
            </button>
          </div>
        </section>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
