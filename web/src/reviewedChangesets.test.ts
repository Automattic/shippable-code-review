import { describe, expect, it } from "vitest";
import {
  getChangesetReviewToken,
  initialState,
  isChangesetSignedOff,
  reducer,
} from "./state";
import type {
  ChangeSet,
  DiffFile,
  DiffLine,
  Hunk,
  PrSource,
  WorktreeSource,
} from "./types";

// One test per acceptance case in
// `docs/concepts/review-state.md § Review tokens and revision-scoped sign-off`.
// Case id (W1–W6 / D1–D6) is cited in the test name and reflected in the body
// so a future reader can trace failures back to the contract.

// ── fixture helpers ───────────────────────────────────────────────────────

function diffLine(n: number): DiffLine {
  return { kind: "context", text: `l${n}`, oldNo: n, newNo: n };
}

function makeHunk(id: string): Hunk {
  return {
    id,
    header: "@@ -1,2 +1,2 @@",
    oldStart: 1,
    oldCount: 2,
    newStart: 1,
    newCount: 2,
    lines: [diffLine(1), diffLine(2)],
  };
}

function makeFile(id: string, path = "a.ts"): DiffFile {
  return {
    id,
    path,
    language: "typescript",
    status: "modified",
    hunks: [makeHunk(`${id}/h1`)],
  };
}

function baseCs(id: string): ChangeSet {
  return {
    id,
    title: "t",
    author: "a",
    branch: "b",
    base: "main",
    createdAt: "2026-01-01T00:00:00Z",
    description: "",
    files: [makeFile(`${id}/f1`)],
  };
}

function wtCs(id: string, source: WorktreeSource): ChangeSet {
  return { ...baseCs(id), worktreeSource: source };
}

function prCs(id: string, source: PrSource): ChangeSet {
  return { ...baseCs(id), prSource: source };
}

function wtState(sha: string, dirtyHash: string | null) {
  return { sha, dirty: dirtyHash !== null, dirtyHash };
}

function pr(baseSha: string, headSha: string): PrSource {
  return {
    host: "github.com",
    owner: "o",
    repo: "r",
    number: 1,
    htmlUrl: "https://github.com/o/r/pull/1",
    headSha,
    baseSha,
    state: "open",
    title: "t",
    body: "",
    baseRef: "main",
    headRef: "feat",
    lastFetchedAt: "2026-01-01T00:00:00Z",
  };
}

// ── Want cases ────────────────────────────────────────────────────────────

describe("reviewedChangesets — Want (W1–W6)", () => {
  it("W1: noise refresh preserves sign-off (worktree)", () => {
    const cs = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    });
    let s = initialState([cs]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    // Reload with identical state — same (sha, dirtyHash) pair.
    const cs2 = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    });
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: cs2 });
    expect(isChangesetSignedOff(cs2, s.reviewedChangesets)).toBe(true);
  });

  it("W2: noise refresh preserves sign-off (PR metadata on overlay)", () => {
    const wt: WorktreeSource = {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    };
    const cs: ChangeSet = {
      ...baseCs("cs1"),
      worktreeSource: wt,
      prSource: pr("B0", "H0"),
      prConversation: [],
    };
    let s = initialState([cs]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    // PR conversation refreshes; worktreeSource unchanged → worktree token wins.
    s = reducer(s, {
      type: "MERGE_PR_OVERLAY",
      changesetId: "cs1",
      prSource: pr("B0", "H0"),
      prConversation: [
        {
          id: 1,
          author: "x",
          createdAt: "2026-01-01T00:00:00Z",
          body: "new",
          htmlUrl: "u",
        },
      ],
    });
    const cs2 = s.changesets.find((c) => c.id === "cs1")!;
    expect(isChangesetSignedOff(cs2, s.reviewedChangesets)).toBe(true);
  });

  it("W3: return-to-revision restores sign-off (worktree)", () => {
    const clean = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    });
    const dirty = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", "Y"),
    });
    let s = initialState([clean]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    // Uncommitted edit: token recomputes to wt:A:Y → not signed off.
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: dirty });
    expect(isChangesetSignedOff(dirty, s.reviewedChangesets)).toBe(false);
    // Revert: token returns to wt:A:- → sign-off reappears, no re-confirmation.
    const cleanAgain = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    });
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: cleanAgain });
    expect(isChangesetSignedOff(cleanAgain, s.reviewedChangesets)).toBe(true);
  });

  it("W4: return-to-revision restores sign-off (PR force-push)", () => {
    const h1 = prCs("cs1", pr("B", "H1"));
    const h2 = prCs("cs1", pr("B", "H2"));
    let s = initialState([h1]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: h2 });
    expect(isChangesetSignedOff(h2, s.reviewedChangesets)).toBe(false);
    const h1Again = prCs("cs1", pr("B", "H1"));
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: h1Again });
    expect(isChangesetSignedOff(h1Again, s.reviewedChangesets)).toBe(true);
  });

  it("W5: clean picked range survives HEAD movement (token follows ChangeSet, not display id)", () => {
    // External HEAD movement on the worktree (e.g. `git checkout foo` outside
    // the app) does not, by itself, reload the loaded ChangeSet. The cs object
    // — including its `worktreeSource.state` — is untouched, so the derived
    // token stays at (sha=B, dirtyHash=null) and the sign-off lookup still
    // resolves. MOVE_LINE stands in for "any in-app navigation that isn't a
    // reload"; the live-reload path is covered separately below.
    const cs = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "B",
      branch: "main",
      state: wtState("B", null),
      range: { fromRef: "A", toRef: "B", includeDirty: false },
    });
    let s = initialState([cs]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    s = reducer(s, { type: "MOVE_LINE", delta: 1 });
    expect(isChangesetSignedOff(cs, s.reviewedChangesets)).toBe(true);
    expect(getChangesetReviewToken(cs)).toBe("wt:B:-");
  });

  it("W1 via RELOAD_CHANGESET: live-reload noise refresh preserves sign-off", () => {
    // W1 through LOAD_CHANGESET is covered above. Live-reload uses
    // RELOAD_CHANGESET (App.tsx:336) instead so the anchoring pass runs over
    // existing replies. That reducer rebuilds interactions/detached but must
    // pass `reviewedChangesets` through; this asserts it does.
    const cs = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    });
    let s = initialState([cs]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    // Same id, same token — the poll returned the same state. The reload
    // still runs the anchoring pass.
    const refreshed = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    });
    s = reducer(s, {
      type: "RELOAD_CHANGESET",
      prevChangesetId: "cs1",
      changeset: refreshed,
    });
    expect(isChangesetSignedOff(refreshed, s.reviewedChangesets)).toBe(true);
  });

  it("W6: explicit unsign-off scopes to the current revision", () => {
    const t1 = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    });
    const t2 = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", "Y"),
    });
    let s = initialState([t1]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: t2 });
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    // Both tokens stored.
    expect(s.reviewedChangesets["cs1"]).toEqual(["wt:A:-", "wt:A:Y"]);
    // Unsign-off at T2 removes only T2.
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    expect(s.reviewedChangesets["cs1"]).toEqual(["wt:A:-"]);
    // Back to T1 → still signed off.
    const t1Again = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    });
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: t1Again });
    expect(isChangesetSignedOff(t1Again, s.reviewedChangesets)).toBe(true);
  });
});

// ── Don't-want cases ──────────────────────────────────────────────────────

describe("reviewedChangesets — Don't want (D1–D6)", () => {
  it("D1: no silent carry-over to new worktree content", () => {
    const clean = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    });
    const dirty = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", "Y"),
    });
    let s = initialState([clean]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: dirty });
    expect(isChangesetSignedOff(dirty, s.reviewedChangesets)).toBe(false);
  });

  it("D2: no silent carry-over after PR force-push to new head", () => {
    const h1 = prCs("cs1", pr("B", "H1"));
    const h2 = prCs("cs1", pr("B", "H2"));
    let s = initialState([h1]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: h2 });
    expect(isChangesetSignedOff(h2, s.reviewedChangesets)).toBe(false);
  });

  it("D3: no silent carry-over when PR base moves", () => {
    const before = prCs("cs1", pr("B1", "H"));
    const after = prCs("cs1", pr("B2", "H"));
    let s = initialState([before]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: after });
    expect(isChangesetSignedOff(after, s.reviewedChangesets)).toBe(false);
  });

  it("D4: switching revisions does not destroy prior sign-off (round trip)", () => {
    const t1 = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    });
    const t2 = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", "Y"),
    });
    let s = initialState([t1]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: t2 });
    s = reducer(s, { type: "LOAD_CHANGESET", changeset: t1 });
    expect(isChangesetSignedOff(t1, s.reviewedChangesets)).toBe(true);
  });

  it("D5: PR metadata changes do not clear sign-off (overlay, diff unchanged)", () => {
    const wt: WorktreeSource = {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
      state: wtState("A", null),
    };
    const cs: ChangeSet = {
      ...baseCs("cs1"),
      worktreeSource: wt,
      prSource: pr("B", "H"),
      prConversation: [],
    };
    let s = initialState([cs]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    s = reducer(s, {
      type: "MERGE_PR_OVERLAY",
      changesetId: "cs1",
      prSource: pr("B", "H"),
      prConversation: [
        {
          id: 7,
          author: "x",
          createdAt: "2026-01-02T00:00:00Z",
          body: "hi",
          htmlUrl: "u",
        },
      ],
    });
    const updated = s.changesets.find((c) => c.id === "cs1")!;
    expect(isChangesetSignedOff(updated, s.reviewedChangesets)).toBe(true);
  });

  it("D6: no top-level sign-off affordance when token is null (paste / upload / stub)", () => {
    const cs = baseCs("cs1"); // no worktreeSource, no prSource
    expect(getChangesetReviewToken(cs)).toBeNull();
    let s = initialState([cs]);
    s = reducer(s, { type: "TOGGLE_CHANGESET_REVIEWED", changesetId: "cs1" });
    // Toggle is a no-op when the token is null — no entry added.
    expect(s.reviewedChangesets["cs1"]).toBeUndefined();
    expect(isChangesetSignedOff(cs, s.reviewedChangesets)).toBe(false);
  });

  it("D6 (legacy): worktreeSource without `state` yields a null token", () => {
    // Older persisted recents predate worktreeSource.state. They must not
    // synthesise a fallback that could mis-claim sign-off on a different
    // revision than the reviewer saw.
    const cs = wtCs("cs1", {
      worktreePath: "/w",
      commitSha: "A",
      branch: "main",
    });
    expect(getChangesetReviewToken(cs)).toBeNull();
  });
});
