import { useEffect, useId, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import "./PlanDiagramView.css";
import type { PlanDiagram, PlanDiagramNode } from "../planDiagram";
import type { EvidenceRef, FileRole, SymbolShape } from "../types";
import { CopyButton } from "./CopyButton";
import { ensureMermaidReadyForTrustedDiagram } from "./mermaidClient";

// What each role means in plain language, surfaced as the hover tooltip
// on every node. Reviewers don't need to know about path-floor vs LSP-shape
// classifiers — they need to know what a `component` *is*. Keep these short:
// mermaid renders them as the SVG `title` attribute, which most browsers
// truncate or lay out awkwardly past a single line.
const ROLE_DESCRIPTION: Record<FileRole, string> = {
  component: "UI component — renders something to the screen.",
  hook: "Reusable hook — stateful logic shared across components.",
  route: "Request entry point — where requests or pages land.",
  test: "Test file — exercises behaviour in code under review.",
  entity: "Data class — mostly fields with simple accessors.",
  "type-def": "Types only — interfaces and aliases, no runtime code.",
  schema: "Schema definition — describes the shape of data.",
  migration: "Schema or data migration — ships a one-way change.",
  config: "Configuration — drives behaviour without being code.",
  fixture: "Test fixture — sample data for tests.",
  prompt: "Product prompt — shipped to the AI at runtime.",
  doc: "Documentation — Markdown for humans.",
  style: "Stylesheet.",
  code: "Code.",
};

interface Props {
  diagram: PlanDiagram;
  includeMarkdown: boolean;
  onToggleMarkdown: () => void;
  /** Wire-through to ReviewPlanView's evidence-navigation handler.
   *  Receives an `EvidenceRef` of `kind: "file"` so clicking a node
   *  scrolls the diff to that file. */
  onNavigate?: (ev: EvidenceRef) => void;
}

const MERMAID_CALLBACK_PROP = "__shippableDiagramClick";

declare global {
  interface Window {
    [MERMAID_CALLBACK_PROP]?: (path: string) => void;
  }
}

export function PlanDiagramView({
  diagram,
  includeMarkdown,
  onToggleMarkdown,
  onNavigate,
}: Props) {
  const renderId = useId().replace(/[:]/g, "_");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  const enrichedSource = useMemo(
    () => withClickDirectives(diagram),
    [diagram],
  );

  useEffect(() => {
    ensureMermaidReadyForTrustedDiagram();
    // Mermaid invokes the global named in `click f0 callback "..."`. We
    // register a single dispatcher keyed on path; the diagram embeds
    // `click <id> __shippableDiagramClick "<path>"` per node.
    window[MERMAID_CALLBACK_PROP] = (path: string) => {
      hideMermaidTooltip();
      onNavigate?.({ kind: "file", path });
    };
    return () => {
      delete window[MERMAID_CALLBACK_PROP];
      hideMermaidTooltip();
    };
  }, [onNavigate]);

  useEffect(() => {
    let cancelled = false;
    const target = containerRef.current;
    if (!target) return;
    setRenderError(null);
    mermaid
      .render(`mermaid-${renderId}`, enrichedSource)
      .then((result) => {
        if (cancelled || !target) return;
        target.innerHTML = result.svg;
        if (result.bindFunctions) {
          result.bindFunctions(target);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setRenderError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [enrichedSource, renderId]);

  const hasMarkdown = diagram.markdownCount > 0;
  const markdownToggle = hasMarkdown ? (
    <button
      type="button"
      className="plan-diagram__toggle"
      onClick={onToggleMarkdown}
      aria-pressed={includeMarkdown}
      title={
        includeMarkdown
          ? "Hide markdown files from the diagram"
          : `Include ${diagram.markdownCount} markdown file${diagram.markdownCount === 1 ? "" : "s"} in the diagram`
      }
    >
      {includeMarkdown ? "hide docs" : "show docs"}
    </button>
  ) : null;

  if (diagram.nodes.length === 0) {
    return (
      <section className="plan-diagram">
        <DiagramTabs />
        <div className="plan-diagram__head">
          <div>
            <div className="plan-diagram__title">Map</div>
            <div className="plan-diagram__hint">
              {hasMarkdown && !includeMarkdown
                ? "Only markdown files in this change — toggle to include them."
                : "No files in this change."}
            </div>
          </div>
          {markdownToggle}
        </div>
      </section>
    );
  }

  return (
    <section className="plan-diagram">
      <DiagramTabs />
      <div className="plan-diagram__head">
        <div>
          <div className="plan-diagram__title">Map</div>
          <div className="plan-diagram__hint">
            {diagram.scope === "repo"
              ? "Generated from the current worktree checkout. Changed files stay highlighted; unchanged repo neighbors give the wider map."
              : diagram.nodes.some((node) => node.role === "context")
                ? "Generated from the current diff. Dimmed nodes are unchanged repo files the diff reaches into."
                : "Generated from the current diff. Click a node to jump to that file in the diff."}
          </div>
        </div>
        <div className="plan-diagram__head-actions">
          {markdownToggle}
          <CopyButton text={diagram.mermaid} title="Copy Mermaid diagram source" />
        </div>
      </div>

      <div className="plan-diagram__canvas">
        {renderError ? (
          <div className="plan-diagram__error">
            <p>Couldn't render the diagram:</p>
            <pre>{renderError}</pre>
          </div>
        ) : null}
        <div
          ref={containerRef}
          className="plan-diagram__mermaid"
          aria-label="Code map for the current changeset"
        />
      </div>

      <details className="plan-diagram__source">
        <summary>Mermaid source</summary>
        <pre className="plan-diagram__code">
          <code>{enrichedSource}</code>
        </pre>
      </details>
    </section>
  );
}

function DiagramTabs() {
  // Static placeholders — see docs/plans/diagram-typed-file-graph.md.
  return (
    <div className="plan-diagram__tabs" role="tablist" aria-label="Diagram types">
      <button
        type="button"
        role="tab"
        aria-selected="true"
        className="plan-diagram__tab plan-diagram__tab--active"
      >
        Map
      </button>
      <button
        type="button"
        role="tab"
        aria-disabled="true"
        disabled
        className="plan-diagram__tab"
        title="Class diagram needs symbol-level capture (methods, fields per class)."
      >
        Class
      </button>
      <button
        type="button"
        role="tab"
        aria-disabled="true"
        disabled
        className="plan-diagram__tab"
        title="State diagram needs control-flow extraction we don't capture today."
      >
        State
      </button>
      <button
        type="button"
        role="tab"
        aria-disabled="true"
        disabled
        className="plan-diagram__tab"
        title="Sequence diagram needs call-trace data we don't capture today."
      >
        Sequence
      </button>
      <button
        type="button"
        role="tab"
        aria-disabled="true"
        disabled
        className="plan-diagram__tab"
        title="ER diagram needs schema parsing we don't capture today."
      >
        ER
      </button>
    </div>
  );
}

function withClickDirectives(diagram: PlanDiagram): string {
  // The diagram source already encodes nodes + classes + edges. We append
  // one `click <id> call cb(path) "tooltip"` per node so mermaid wires
  // up the click handler AND a hover tooltip in the same directive. The
  // `call cb(arg)` form is what passes our argument through; the bare
  // `click <id> cb` form would route the third arg into the tooltip slot
  // and the callback would only receive the node id.
  const lines = diagram.nodes.map((node) => {
    const path = mermaidArg(node.path);
    const tooltip = mermaidArg(tooltipFor(node));
    return `  click ${node.id} call ${MERMAID_CALLBACK_PROP}(${path}) ${tooltip}`;
  });
  return `${diagram.mermaid}\n${lines.join("\n")}`;
}

function tooltipFor(node: PlanDiagramNode): string {
  const description = ROLE_DESCRIPTION[node.fileRole];
  const shapeText = formatShape(node.shape);
  return shapeText ? `${description}  ${shapeText}` : description;
}

function formatShape(shape: SymbolShape | undefined): string | null {
  if (!shape) return null;
  const parts: string[] = [];
  const push = (count: number | undefined, singular: string, plural: string): void => {
    if (!count) return;
    parts.push(`${count} ${count === 1 ? singular : plural}`);
  };
  push(shape.classes, "class", "classes");
  push(shape.interfaces, "interface", "interfaces");
  push(shape.methods, "method", "methods");
  push(shape.properties, "property", "properties");
  push(shape.functions, "function", "functions");
  push(shape.types, "type", "types");
  push(shape.enums, "enum", "enums");
  push(shape.constants, "constant", "constants");
  push(shape.variables, "variable", "variables");
  if (parts.length === 0) return null;
  return parts.slice(0, 3).join(", ");
}

function hideMermaidTooltip(): void {
  // Mermaid attaches a single `<div class="mermaidTooltip">` to <body> and
  // toggles its opacity via d3 mouseover/mouseout handlers. When a click
  // navigates away, the SVG node unmounts before mouseout fires and the
  // tooltip stays pinned at full opacity — even after the plan modal
  // closes. Remove it; mermaid recreates it on the next hover.
  document.querySelectorAll(".mermaidTooltip").forEach((el) => el.remove());
}

function mermaidArg(text: string): string {
  // Both `cb(arg)` args and the trailing tooltip are quoted strings in
  // mermaid's flowchart directive parser. Escape backslashes and the quote
  // char so multi-word labels and unusual paths don't break parsing.
  return `"${text.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
