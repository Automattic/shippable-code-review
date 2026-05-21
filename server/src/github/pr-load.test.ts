import { describe, it, expect, vi, afterEach } from "vitest";
import { loadPr } from "./pr-load.ts";
import type { PrCoords } from "./url.ts";
import { parseReplyKey } from "../../../web/src/types.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const COORDS: PrCoords = {
  host: "github.com",
  owner: "owner",
  repo: "repo",
  number: 42,
  apiBaseUrl: "https://api.github.com",
  htmlUrl: "https://github.com/owner/repo/pull/42",
};

const TOKEN = "ghp_test";

const PR_META = {
  title: "Fix the bug",
  body: "Describes the fix",
  state: "open",
  merged: false,
  html_url: "https://github.com/owner/repo/pull/42",
  head: { sha: "headsha", ref: "fix-branch" },
  base: { sha: "basesha", ref: "main" },
  user: { login: "author" },
  changed_files: 2,
};

const PR_FILES = [
  {
    filename: "src/foo.ts",
    status: "modified",
    patch: "@@ -1,3 +1,4 @@\n context\n-old line\n+new line\n+added line\n context2",
  },
  {
    filename: "src/bar.ts",
    status: "modified",
    patch: "@@ -10,2 +10,2 @@\n context\n-old bar\n+new bar",
  },
];

const LINE_COMMENTS = [
  {
    id: 100,
    user: { login: "reviewer" },
    body: "This is a comment",
    path: "src/foo.ts",
    line: 3, // newNo in the diff
    original_line: 3,
    start_line: null,
    original_commit_id: "headsha",
    diff_hunk: "@@ -1,3 +1,4 @@\n context\n-old line\n+new line",
    created_at: "2024-01-01T00:00:00Z",
    html_url: "https://github.com/owner/repo/pull/42#discussion_r100",
    side: "RIGHT",
  },
];

const ISSUE_COMMENTS = [
  {
    id: 200,
    user: { login: "author" },
    body: "Great PR!",
    created_at: "2024-01-02T00:00:00Z",
    html_url: "https://github.com/owner/repo/pull/42#issuecomment-200",
  },
];

function makePage(body: unknown, linkNext?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (linkNext) {
    headers.set("Link", `<${linkNext}>; rel="next"`);
  }
  return {
    ok: true,
    status: 200,
    headers,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function stubHappyPath(
  files = PR_FILES,
  lineComments: typeof LINE_COMMENTS = LINE_COMMENTS,
  issueComments: typeof ISSUE_COMMENTS = ISSUE_COMMENTS,
) {
  const mock = vi.fn().mockImplementation((url: string) => {
    if (url.includes("/pulls/42/files")) return makePage(files);
    if (url.includes("/pulls/42/comments")) return makePage(lineComments);
    if (url.includes("/issues/42/comments")) return makePage(issueComments);
    if (url.includes("/pulls/42")) return makePage(PR_META);
    return makePage({}, undefined);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("loadPr — happy path", () => {
  it("sets prSource with correct metadata", async () => {
    stubHappyPath();
    const { changeSet } = await loadPr(COORDS, TOKEN);

    expect(changeSet.prSource).toBeDefined();
    expect(changeSet.prSource!.host).toBe("github.com");
    expect(changeSet.prSource!.owner).toBe("owner");
    expect(changeSet.prSource!.repo).toBe("repo");
    expect(changeSet.prSource!.number).toBe(42);
    expect(changeSet.prSource!.state).toBe("open");
    expect(changeSet.prSource!.title).toBe("Fix the bug");
    expect(changeSet.prSource!.headSha).toBe("headsha");
    expect(changeSet.prSource!.baseSha).toBe("basesha");
    expect(changeSet.prSource!.baseRef).toBe("main");
    expect(changeSet.prSource!.headRef).toBe("fix-branch");
    expect(changeSet.prSource!.htmlUrl).toBe("https://github.com/owner/repo/pull/42");
    expect(typeof changeSet.prSource!.lastFetchedAt).toBe("string");
  });

  it("id is deterministic pr:<host>:<owner>:<repo>:<number>", async () => {
    stubHappyPath();
    const { changeSet } = await loadPr(COORDS, TOKEN);
    expect(changeSet.id).toBe("pr:github.com:owner:repo:42");
  });

  it("parses both files into ChangeSet.files", async () => {
    stubHappyPath();
    const { changeSet } = await loadPr(COORDS, TOKEN);
    expect(changeSet.files).toHaveLength(2);
    const paths = changeSet.files.map((f) => f.path);
    expect(paths).toContain("src/foo.ts");
    expect(paths).toContain("src/bar.ts");
  });

  it("attaches a single-line review comment as a Reply under userCommentKey", async () => {
    stubHappyPath();
    const { changeSet, prInteractions, prDetached } = await loadPr(COORDS, TOKEN);

    expect(prDetached).toEqual([]);
    const keys = Object.keys(prInteractions);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^user:/);

    const replies = prInteractions[keys[0]];
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      id: "pr-comment:100",
      author: "reviewer",
      body: "This is a comment",
      external: {
        source: "pr",
        htmlUrl: "https://github.com/owner/repo/pull/42#discussion_r100",
      },
    });

    // The key encodes a hunk that exists on src/foo.ts.
    const fooFile = changeSet.files.find((f) => f.path === "src/foo.ts")!;
    const hunkIds = fooFile.hunks.map((h) => h.id);
    const parsed = parseReplyKey(keys[0]);
    expect(parsed?.kind).toBe("user");
    expect(hunkIds).toContain((parsed as { hunkId: string }).hunkId);
  });

  it("populates prConversation from issue comments", async () => {
    stubHappyPath();
    const { changeSet } = await loadPr(COORDS, TOKEN);

    expect(changeSet.prConversation).toHaveLength(1);
    expect(changeSet.prConversation![0]).toMatchObject({
      id: 200,
      author: "author",
      body: "Great PR!",
    });
  });
});

describe("loadPr — multi-line comment", () => {
  it("routes a multi-line comment to a blockCommentKey when start and end share a hunk", async () => {
    const multiLineComment = {
      id: 101,
      user: { login: "reviewer" },
      body: "Multi-line comment",
      path: "src/foo.ts",
      line: 4,
      original_line: 4,
      start_line: 2,
      original_commit_id: "headsha",
      diff_hunk: "@@ -1,3 +1,4 @@\n context\n-old line\n+new line\n+added line",
      created_at: "2024-01-01T00:00:00Z",
      html_url: "https://github.com/owner/repo/pull/42#discussion_r101",
      side: "RIGHT",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stubHappyPath(PR_FILES, [multiLineComment as any], ISSUE_COMMENTS);
    const { prInteractions, prDetached } = await loadPr(COORDS, TOKEN);

    expect(prDetached).toEqual([]);
    const keys = Object.keys(prInteractions);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^block:/);
  });
});

describe("loadPr — review threads", () => {
  it("groups a reply under its root thread, separate from another root on the same line", async () => {
    const root = LINE_COMMENTS[0];
    const reply = {
      ...root,
      id: 101,
      body: "A reply",
      in_reply_to_id: 100,
      html_url: "https://github.com/owner/repo/pull/42#discussion_r101",
    };
    const otherRoot = {
      ...root,
      id: 102,
      body: "Unrelated thread, same line",
      html_url: "https://github.com/owner/repo/pull/42#discussion_r102",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stubHappyPath(PR_FILES, [root, reply, otherRoot] as any, ISSUE_COMMENTS);
    const { prInteractions } = await loadPr(COORDS, TOKEN);

    const keys = Object.keys(prInteractions);
    expect(keys).toHaveLength(2);

    const rootKey = keys.find((k) => k.endsWith(":100"))!;
    expect(prInteractions[rootKey].map((i) => i.id)).toEqual([
      "pr-comment:100",
      "pr-comment:101",
    ]);

    const otherKey = keys.find((k) => k.endsWith(":102"))!;
    expect(prInteractions[otherKey].map((i) => i.id)).toEqual(["pr-comment:102"]);
  });
});

describe("loadPr — outdated comments become DetachedReply", () => {
  it("comment with line: null becomes a detached entry with anchorContext", async () => {
    const outdated = {
      id: 102,
      user: { login: "reviewer" },
      body: "stale thought",
      path: "src/foo.ts",
      line: null,
      original_line: 7,
      start_line: null,
      original_commit_id: "oldsha1",
      diff_hunk: "@@ -5,3 +5,3 @@\n surrounding\n-removed in old version\n+added in old version",
      created_at: "2024-01-01T00:00:00Z",
      html_url: "https://github.com/owner/repo/pull/42#discussion_r102",
      side: "RIGHT",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stubHappyPath(PR_FILES, [outdated as any], ISSUE_COMMENTS);
    const { prInteractions, prDetached } = await loadPr(COORDS, TOKEN);

    expect(prInteractions).toEqual({});
    expect(prDetached).toHaveLength(1);
    const d = prDetached[0];
    expect(d.threadKey).toBe("pr-detached:102");
    expect(d.interaction.anchorPath).toBe("src/foo.ts");
    expect(d.interaction.anchorLineNo).toBe(7);
    expect(d.interaction.originType).toBe("committed");
    expect(d.interaction.originSha).toBe("oldsha1");
    expect(d.interaction.external).toEqual({
      source: "pr",
      htmlUrl: "https://github.com/owner/repo/pull/42#discussion_r102",
    });
    expect(d.interaction.anchorContext).toBeDefined();
    expect(d.interaction.anchorContext!.length).toBeGreaterThan(0);
  });

  it("caps anchorContext at 10 lines centered on the anchor", async () => {
    // 30-line diff_hunk simulating a long multi-line comment span.
    const longBody = Array.from({ length: 30 }, (_, i) => ` line${i + 1}`).join("\n");
    const longHunk = `@@ -1,30 +1,30 @@\n${longBody}`;
    const huge = {
      id: 104,
      user: { login: "reviewer" },
      body: "comment on a long range",
      path: "src/foo.ts",
      line: null,
      original_line: 20,
      start_line: null,
      original_commit_id: "oldsha2",
      diff_hunk: longHunk,
      created_at: "2024-01-01T00:00:00Z",
      html_url: "https://github.com/owner/repo/pull/42#discussion_r104",
      side: "RIGHT",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stubHappyPath(PR_FILES, [huge as any], ISSUE_COMMENTS);
    const { prDetached } = await loadPr(COORDS, TOKEN);

    expect(prDetached).toHaveLength(1);
    const ctx = prDetached[0].interaction.anchorContext!;
    expect(ctx.length).toBeLessThanOrEqual(10);
    // The window should include the anchor line (newNo === 20).
    expect(ctx.some((l) => l.newNo === 20)).toBe(true);
  });

  it("comment whose line is no longer in the diff becomes detached too", async () => {
    const offPatch = {
      id: 103,
      user: { login: "reviewer" },
      body: "lines 50–52",
      path: "src/foo.ts",
      line: 50,
      original_line: 50,
      start_line: null,
      original_commit_id: "oldsha2",
      diff_hunk: "@@ -50,1 +50,1 @@\n distant",
      created_at: "2024-01-01T00:00:00Z",
      html_url: "https://github.com/owner/repo/pull/42#discussion_r103",
      side: "RIGHT",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stubHappyPath(PR_FILES, [offPatch as any], ISSUE_COMMENTS);
    const { prInteractions, prDetached } = await loadPr(COORDS, TOKEN);

    expect(prInteractions).toEqual({});
    expect(prDetached).toHaveLength(1);
    expect(prDetached[0].interaction.anchorLineNo).toBe(50);
  });
});

describe("loadPr — truncation", () => {
  it("sets prSource.truncation when files.length < meta.changed_files", async () => {
    const truncatedMeta = { ...PR_META, changed_files: 5 };
    const threeFiles = Array.from({ length: 3 }, (_, i) => ({
      filename: `src/file${i}.ts`,
      status: "modified",
      patch: "@@ -1,1 +1,1 @@\n-old\n+new",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/pulls/42/files")) return makePage(threeFiles);
        if (url.includes("/pulls/42/comments")) return makePage([]);
        if (url.includes("/issues/42/comments")) return makePage([]);
        if (url.includes("/pulls/42")) return makePage(truncatedMeta);
        return makePage({});
      }),
    );
    const { changeSet } = await loadPr(COORDS, TOKEN);

    expect(changeSet.prSource!.truncation).toBeDefined();
    expect(changeSet.prSource!.truncation!.kind).toBe("files");
    expect(changeSet.prSource!.truncation!.reason).toContain("3");
    expect(changeSet.prSource!.truncation!.reason).toContain("5");
  });

  it("does not set truncation when files.length equals meta.changed_files", async () => {
    stubHappyPath();
    const { changeSet } = await loadPr(COORDS, TOKEN);
    expect(changeSet.prSource!.truncation).toBeUndefined();
  });
});

describe("loadPr — comment dropped (path missing) becomes detached", () => {
  it("comment whose path is not in the diff becomes a detached entry", async () => {
    const unknownPathComment = {
      id: 999,
      user: { login: "reviewer" },
      body: "Comment on missing file",
      path: "src/nonexistent.ts",
      line: 1,
      original_line: 1,
      start_line: null,
      original_commit_id: "oldsha3",
      diff_hunk: "@@ -1,1 +1,1 @@\n nothing",
      created_at: "2024-01-01T00:00:00Z",
      html_url: "https://github.com/owner/repo/pull/42#discussion_r999",
      side: "RIGHT" as const,
    };
    stubHappyPath(PR_FILES, [unknownPathComment], ISSUE_COMMENTS);
    const { prInteractions, prDetached } = await loadPr(COORDS, TOKEN);

    expect(prInteractions).toEqual({});
    expect(prDetached).toHaveLength(1);
    expect(prDetached[0].interaction.anchorPath).toBe("src/nonexistent.ts");
  });
});

describe("loadPr — file status synthesis", () => {
  function stubWithFiles(files: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/pulls/42/files")) return makePage(files);
        if (url.includes("/pulls/42/comments")) return makePage([]);
        if (url.includes("/issues/42/comments")) return makePage([]);
        if (url.includes("/pulls/42")) return makePage(PR_META);
        return makePage({});
      }),
    );
  }

  it("added file results in DiffFile.status === 'added'", async () => {
    stubWithFiles([
      {
        filename: "src/new.ts",
        status: "added",
        patch: "@@ -0,0 +1,2 @@\n+line1\n+line2",
      },
    ]);
    const { changeSet } = await loadPr(COORDS, TOKEN);
    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0].status).toBe("added");
    expect(changeSet.files[0].path).toBe("src/new.ts");
  });

  it("removed file results in DiffFile.status === 'deleted'", async () => {
    stubWithFiles([
      {
        filename: "src/gone.ts",
        status: "removed",
        patch: "@@ -1,2 +0,0 @@\n-line1\n-line2",
      },
    ]);
    const { changeSet } = await loadPr(COORDS, TOKEN);
    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0].status).toBe("deleted");
    expect(changeSet.files[0].path).toBe("src/gone.ts");
  });

  it("renamed file results in DiffFile.status === 'renamed' with new path", async () => {
    stubWithFiles([
      {
        filename: "src/new-name.ts",
        status: "renamed",
        previous_filename: "src/old-name.ts",
        patch: "@@ -1,2 +1,2 @@\n context\n-old\n+new",
      },
    ]);
    const { changeSet } = await loadPr(COORDS, TOKEN);
    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0].status).toBe("renamed");
    expect(changeSet.files[0].path).toBe("src/new-name.ts");
  });

  it("modified file results in DiffFile.status === 'modified'", async () => {
    stubWithFiles([PR_FILES[0]]);
    const { changeSet } = await loadPr(COORDS, TOKEN);
    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0].status).toBe("modified");
  });
});

describe("loadPr — state mapping", () => {
  it("maps closed+merged to 'merged'", async () => {
    const mergedMeta = { ...PR_META, state: "closed" as const, merged: true };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/pulls/42/files")) return makePage(PR_FILES);
        if (url.includes("/pulls/42/comments")) return makePage([]);
        if (url.includes("/issues/42/comments")) return makePage([]);
        if (url.includes("/pulls/42")) return makePage(mergedMeta);
        return makePage({});
      }),
    );
    const { changeSet } = await loadPr(COORDS, TOKEN);
    expect(changeSet.prSource!.state).toBe("merged");
  });

  it("maps closed+not merged to 'closed'", async () => {
    const closedMeta = { ...PR_META, state: "closed" as const, merged: false };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/pulls/42/files")) return makePage(PR_FILES);
        if (url.includes("/pulls/42/comments")) return makePage([]);
        if (url.includes("/issues/42/comments")) return makePage([]);
        if (url.includes("/pulls/42")) return makePage(closedMeta);
        return makePage({});
      }),
    );
    const { changeSet } = await loadPr(COORDS, TOKEN);
    expect(changeSet.prSource!.state).toBe("closed");
  });
});
