// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LiveReloadBar } from "./LiveReloadBar";
import type { WorktreeProvenance, WorktreeState } from "../types";

afterEach(cleanup);

const provenance: WorktreeProvenance = {
  path: "/tmp/wt",
  branch: "feature",
  state: { sha: "aaa", dirty: false, dirtyHash: null },
};

const noop = () => {};

function renderBar(staleNext: WorktreeState, watchDirty: boolean) {
  render(
    <LiveReloadBar
      provenance={provenance}
      enabled
      staleNext={staleNext}
      watchDirty={watchDirty}
      worktreeGone={false}
      busyReloading={false}
      onToggleEnabled={noop}
      onReload={noop}
      onDismissStale={noop}
      onDismissGone={noop}
    />,
  );
}

describe("LiveReloadBar drift message", () => {
  const newCommitDirty: WorktreeState = {
    sha: "bbb",
    dirty: true,
    dirtyHash: "h1",
  };

  it("omits uncommitted edits when the loaded slice excludes them", () => {
    renderBar(newCommitDirty, false);
    expect(screen.getByText("New commit on this worktree")).toBeTruthy();
    expect(screen.queryByText(/uncommitted edits/i)).toBeNull();
  });

  it("mentions uncommitted edits when the loaded slice includes them", () => {
    renderBar(newCommitDirty, true);
    expect(screen.getByText("New commit + uncommitted edits")).toBeTruthy();
  });
});
