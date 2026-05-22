import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./LoadModal.css";

/**
 * One client-install snippet. Shippable no longer writes to user configs;
 * the modal hands the snippet to the user, who pastes it themselves.
 * `kind` discriminates command-line (Claude Code CLI) from JSON/TOML
 * file-paste blocks (Claude Desktop, Codex, Cursor, Windsurf).
 */
export type McpSnippet = {
  id: string;
  display_name: string;
  config_path: string;
  detected: boolean;
  current_command: string | null;
} & (
  | { kind: "command"; value: string }
  | { kind: "json"; value: string }
  | { kind: "toml"; value: string }
);

interface Props {
  snippets: McpSnippet[];
  onClose: () => void;
}

export function RegisterMcpModal({ snippets, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const content = (
    <div className="modal" onClick={onClose}>
      <div
        className="modal__box"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 640 }}
      >
        <header className="modal__h">
          <span className="modal__h-label">Set up Shippable MCP</span>
          <button type="button" className="modal__close" onClick={onClose}>
            × close
          </button>
        </header>
        <section className="modal__sec">
          <p className="modal__hint">
            Copy the snippet for each client you use, paste it where indicated,
            and restart that client. Shippable doesn't modify your configs —
            you own the change.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
            {snippets.map((s) => (
              <SnippetRow key={s.id} snippet={s} />
            ))}
          </ul>
          <div className="modal__row modal__row--end">
            <button
              type="button"
              ref={closeRef}
              className="modal__btn modal__btn--primary"
              onClick={onClose}
            >
              done
            </button>
          </div>
        </section>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

function SnippetRow({ snippet }: { snippet: McpSnippet }) {
  const status = describeStatus(snippet);
  const pasteHint =
    snippet.kind === "command"
      ? "Run in terminal:"
      : `Paste into ${snippet.config_path} (inside the mcpServers ${
          snippet.kind === "toml" ? "table" : "object"
        }):`;

  return (
    <li
      style={{
        padding: "10px 0",
        borderTop: "1px solid var(--rule, rgba(0,0,0,0.08))",
      }}
    >
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
      >
        <strong>{snippet.display_name}</strong>
        <span className="modal__hint" style={{ margin: 0 }}>
          {status}
        </span>
      </div>
      <div className="modal__hint" style={{ margin: "4px 0 6px" }}>
        {pasteHint}
      </div>
      <CopyBlock text={snippet.value} multiline={snippet.kind !== "command"} />
    </li>
  );
}

function describeStatus(s: McpSnippet): string {
  if (!s.detected) return "not detected";
  if (s.current_command == null) return "detected — no entry yet";
  return `currently points at ${s.current_command}`;
}

function CopyBlock({
  text,
  multiline,
}: {
  text: string;
  multiline: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard denied — leave state alone so the user can select manually.
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
      <pre
        style={{
          flex: 1,
          margin: 0,
          padding: "8px 10px",
          background: "var(--code-bg, rgba(0,0,0,0.04))",
          borderRadius: 4,
          fontSize: 12,
          whiteSpace: multiline ? "pre" : "pre-wrap",
          overflowX: "auto",
        }}
      >
        <code>{text}</code>
      </pre>
      <button
        type="button"
        className="modal__btn"
        onClick={() => void copy()}
        style={{ alignSelf: "flex-start" }}
        title="click to copy"
      >
        {copied ? "copied ✓" : "copy"}
      </button>
    </div>
  );
}
