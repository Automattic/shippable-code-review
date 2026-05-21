import mermaid from "mermaid";

// Mermaid is a singleton — `mermaid.initialize()` mutates one global config
// object shared by every `mermaid.render()` caller. We have two call sites
// with different trust assumptions:
//
//   - PlanDiagramView renders source we generated ourselves from the changeset
//     graph. It needs `securityLevel: "loose"` because it embeds
//     `click <id> call __shippableDiagramClick(path) "tooltip"` directives;
//     strict mode silently drops those.
//
//   - MarkdownView's ```mermaid block renders source that came from PR files,
//     worktree files, or commit content. That source is attacker-controlled.
//     In loose mode Mermaid will emit `<svg:a xlink:href="javascript:...">`
//     from a `click` directive into the DOM, giving XSS the moment the
//     reviewer clicks the diagram node.
//
// We can't actually split mermaid into two instances, so we (a) reapply the
// right config before each render and (b) strip `click` directives from
// untrusted source. (b) is the real defense — global-config switching is racy
// if two renders interleave; source-level stripping holds regardless.

export function ensureMermaidReadyForTrustedDiagram(): void {
  mermaid.initialize({
    startOnLoad: false,
    theme: "neutral",
    securityLevel: "loose",
    flowchart: { htmlLabels: true, curve: "basis" },
  });
}

export function ensureMermaidReadyForUntrustedMarkdown(): void {
  mermaid.initialize({
    startOnLoad: false,
    theme: "neutral",
    securityLevel: "strict",
    flowchart: { htmlLabels: false, curve: "basis" },
  });
}

// `click` is a flowchart keyword and only appears at the start of a line
// (leading whitespace allowed). Match any line whose first non-whitespace
// token is `click`; that covers `click X "url"`, `click X "url" "tooltip"`,
// `click X call cb(arg) "tooltip"`, `click X href "url"`, and the
// bare-callback form. Node labels live inside `[]`/`()`/`{}` and can't start
// the line, so this won't touch them.
export function stripMermaidClickDirectives(source: string): string {
  return source.replace(/^[ \t]*click[ \t][^\n]*$/gm, "");
}
