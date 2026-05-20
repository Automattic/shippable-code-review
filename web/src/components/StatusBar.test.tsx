// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";

afterEach(cleanup);

describe("StatusBar", () => {
  it("prefers a transient tip over the default or selection hint", () => {
    render(
      <StatusBar
        transientHint="tip: next time press ⇧R for the free code runner"
        viewModel={{
          lineDisplay: "line 1/10",
          hunkDisplay: "hunk 1/2",
          fileDisplay: "file 1/3",
          readDisplay: "read 10%",
          filesDisplay: "reviewed 0/3",
          changesetSignOffDisplay: null,
          changesetSignedOff: false,
          selectionHint: "selection L10-L12 · c to comment",
          defaultHint: "j/k line · ]/[ file · ? help",
        }}
      />,
    );

    expect(
      screen.getByText("tip: next time press ⇧R for the free code runner"),
    ).toBeTruthy();
    expect(screen.queryByText("selection L10-L12 · c to comment")).toBeNull();
    expect(screen.queryByText("j/k line · ]/[ file · ? help")).toBeNull();
  });

  it("renders the revision-scoped changeset sign-off cell when available", () => {
    render(
      <StatusBar
        viewModel={{
          lineDisplay: "line 1/10",
          hunkDisplay: "hunk 1/2",
          fileDisplay: "file 1/3",
          readDisplay: "read 10%",
          filesDisplay: "reviewed 0/3",
          changesetSignOffDisplay: "changeset ✓",
          changesetSignedOff: true,
          selectionHint: null,
          defaultHint: "j/k line · ]/[ file · ? help",
        }}
      />,
    );

    const cell = screen.getByText("changeset ✓");
    expect(cell.getAttribute("title")).toBe(
      "changeset signed off at this revision · Shift+S to toggle",
    );
    expect(cell.className).toContain("statusbar__cell--changeset-on");
  });

  it("hides the changeset sign-off cell when the changeset has no stable token", () => {
    render(
      <StatusBar
        viewModel={{
          lineDisplay: "line 1/10",
          hunkDisplay: "hunk 1/2",
          fileDisplay: "file 1/3",
          readDisplay: "read 10%",
          filesDisplay: "reviewed 0/3",
          changesetSignOffDisplay: null,
          changesetSignedOff: false,
          selectionHint: null,
          defaultHint: "j/k line · ]/[ file · ? help",
        }}
      />,
    );

    expect(screen.queryByText(/^changeset/)).toBeNull();
  });
});
