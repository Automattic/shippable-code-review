// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";

afterEach(cleanup);

describe("CommandPalette", () => {
  it("shows only global app actions", () => {
    render(
      <CommandPalette
        predicates={{}}
        onClose={vi.fn()}
        onPick={vi.fn()}
      />,
    );

    expect(screen.getByText("see keybindings")).toBeTruthy();
    expect(screen.getByText("toggle the inspector")).toBeTruthy();
    expect(screen.getByText("toggle inline comments")).toBeTruthy();
    expect(screen.getByText("where to start (plan)")).toBeTruthy();
    expect(screen.getByText("load a changeset (URL / file / paste)")).toBeTruthy();
    expect(screen.getByText("open the free code runner")).toBeTruthy();

    expect(screen.queryByText("next line")).toBeNull();
    expect(screen.queryByText("previous hunk")).toBeNull();
    expect(screen.queryByText("run a prompt on the current selection")).toBeNull();
    expect(screen.queryByText("sign off on current file (toggle)")).toBeNull();
  });
});
