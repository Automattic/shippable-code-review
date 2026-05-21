import { describe, expect, it } from "vitest";
import { stripMermaidClickDirectives } from "./mermaidClient";

describe("stripMermaidClickDirectives", () => {
  it("removes a click directive with a javascript: URL", () => {
    const input = [
      "flowchart TD",
      '  A[Hello] --> B[World]',
      '  click A "javascript:alert(1)"',
    ].join("\n");
    const out = stripMermaidClickDirectives(input);
    expect(out).not.toMatch(/click\s+A/);
    expect(out).not.toContain("javascript:alert");
    expect(out).toContain("flowchart TD");
    expect(out).toContain("A[Hello]");
  });

  it("removes a click ... call cb(arg) directive", () => {
    const input = [
      "flowchart TD",
      "  A --> B",
      '  click A call cb("path") "Tooltip"',
    ].join("\n");
    const out = stripMermaidClickDirectives(input);
    expect(out).not.toMatch(/click\s+A/);
    expect(out).not.toContain("cb(");
  });

  it("removes a click ... href \"URL\" directive", () => {
    const input = [
      "flowchart TD",
      "  A --> B",
      '  click A href "javascript:alert(1)"',
    ].join("\n");
    const out = stripMermaidClickDirectives(input);
    expect(out).not.toMatch(/click\s+A/);
    expect(out).not.toContain("javascript:alert");
  });

  it("strips multiple click lines and preserves other content", () => {
    const input = [
      "flowchart TD",
      "  A[Start] --> B[Middle]",
      "  B --> C[End]",
      '  click A "javascript:x"',
      '  click B call cb("y")',
      "  classDef red fill:#f00",
    ].join("\n");
    const out = stripMermaidClickDirectives(input);
    expect(out).not.toMatch(/click\s+/);
    expect(out).toContain("classDef red");
    expect(out).toContain("A[Start]");
    expect(out).toContain("B --> C[End]");
  });

  it("ignores leading whitespace before the click keyword", () => {
    const input = [
      "flowchart TD",
      "  A --> B",
      '\t\tclick A "javascript:x"',
      '       click B "javascript:y"',
    ].join("\n");
    const out = stripMermaidClickDirectives(input);
    expect(out).not.toMatch(/click\s+/);
  });

  it("does not strip the word 'click' inside a node label", () => {
    const input = [
      "flowchart TD",
      '  A["Press click to start"] --> B',
    ].join("\n");
    const out = stripMermaidClickDirectives(input);
    expect(out).toContain("Press click to start");
    expect(out).toContain("A[");
  });

  it("does not change source that has no click directives", () => {
    const input = [
      "flowchart TD",
      "  A --> B",
      "  B --> C",
    ].join("\n");
    expect(stripMermaidClickDirectives(input)).toBe(input);
  });

  it("returns an empty string for an empty input", () => {
    expect(stripMermaidClickDirectives("")).toBe("");
  });

  it("strips a click directive after a `;` statement separator", () => {
    // Mermaid's flowchart grammar accepts SEMI as a separator, so this
    // parses as two statements and a line-anchored regex would miss the
    // second one.
    const input = 'flowchart TD\n  A --> B; click A "javascript:alert(1)"';
    const out = stripMermaidClickDirectives(input);
    expect(out).not.toMatch(/click\s+A/);
    expect(out).not.toContain("javascript:");
    expect(out).toContain("A --> B;");
  });

  it("strips multiple click directives chained with `;` on one line", () => {
    const input = 'flowchart TD\n  click A "x"; click B "javascript:y"; A --> B';
    const out = stripMermaidClickDirectives(input);
    expect(out).not.toMatch(/click\s+[AB]/);
    expect(out).not.toContain("javascript:");
    expect(out).toContain("A --> B");
  });
});
