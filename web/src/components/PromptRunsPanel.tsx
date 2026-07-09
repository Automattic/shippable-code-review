import "./PromptRunsPanel.css";
import { useState } from "react";
import { CopyButton } from "./CopyButton";

export type PromptRunStatus = "streaming" | "done" | "error";

export interface PromptRunView {
  id: string;
  promptName: string;
  text: string;
  status: PromptRunStatus;
  error?: string;
}

interface Props {
  runs: PromptRunView[];
  onClose: (id: string) => void;
  initialExpandedIds?: string[];
}

export function PromptRunsPanel({
  runs,
  onClose,
  initialExpandedIds,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initialExpandedIds ?? []),
  );
  if (runs.length === 0) return null;
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section className="panel promptruns">
      <header className="panel__h promptruns__h">
        <span>Prompts · {runs.length}</span>
      </header>
      <ul className="panel__list promptruns__list">
        {runs.map((r) => (
          <PromptRunRow
            key={r.id}
            run={r}
            isExpanded={expanded.has(r.id)}
            onToggle={() => toggle(r.id)}
            onClose={() => onClose(r.id)}
          />
        ))}
      </ul>
    </section>
  );
}

interface RowProps {
  run: PromptRunView;
  isExpanded: boolean;
  onToggle: () => void;
  onClose: () => void;
}

function PromptRunRow({ run, isExpanded, onToggle, onClose }: RowProps) {
  const statusLabel =
    run.status === "streaming"
      ? "streaming…"
      : run.status === "error"
        ? "error"
        : "done";
  const preview = makePreview(run.text);
  return (
    <li className={`promptrun ${isExpanded ? "promptrun--open" : ""}`}>
      <div className="promptrun__row">
        <button
          className="promptrun__head"
          onClick={onToggle}
          title={isExpanded ? "collapse" : "expand"}
          aria-expanded={isExpanded}
        >
          <span className="promptrun__chev">{isExpanded ? "▾" : "▸"}</span>
          <span className="promptrun__name">{run.promptName}</span>
          <span
            className={`promptrun__status promptrun__status--${run.status}`}
          >
            {statusLabel}
          </span>
        </button>
        <button
          className="promptrun__close"
          onClick={onClose}
          title="dismiss this run"
          aria-label="dismiss this run"
        >
          ×
        </button>
      </div>
      {!isExpanded && preview && (
        <div className="promptrun__preview" title={preview}>
          {preview}
        </div>
      )}
      {isExpanded && (
        <div className="promptrun__body">
          {run.text.length === 0 && run.status === "streaming" ? (
            <div className="promptrun__body-empty">
              waiting for first token…
            </div>
          ) : (
            <div className="promptrun__body-text">{run.text}</div>
          )}
          {run.status === "error" && run.error && (
            <div className="promptrun__err errrow">
              <span className="errrow__msg">{run.error}</span>
              <CopyButton text={run.error} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function makePreview(text: string): string {
  if (!text) return "";
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return "";
  const lastBreak = trimmed.lastIndexOf("\n");
  const lastLine = lastBreak === -1 ? trimmed : trimmed.slice(lastBreak + 1);
  return lastLine.length > 120 ? lastLine.slice(0, 117) + "…" : lastLine;
}
