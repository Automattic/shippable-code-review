// Journey 2 — Review a local worktree. These run against the REAL server:
// a throwaway git repo is built on disk (see _lib/worktree-repo.ts) and the
// server's /api/worktrees/* endpoints scan and diff it for real — no mocks.
// The live-reload tests mutate / delete a real repo mid-test and wait on the
// server's 3s poll cycle.
//
// The folder picker (macOS-only, AppleScript) stays [manual]; we drive the
// "paste path instead" affordance instead.

import {
  test,
  expect,
  expectWorkspaceLoaded,
  dismissPlanOverlay,
} from "./_lib/fixtures";
import { mockEnqueueRejects } from "./_lib/mocks";
import {
  createWorktreeRepo,
  createSplitRepo,
  addCommit,
  type FixtureRepo,
} from "./_lib/worktree-repo";

let repo: FixtureRepo;

test.beforeAll(() => {
  repo = createWorktreeRepo();
});

test.afterAll(() => {
  repo?.cleanup();
});

/** Open LoadModal, paste a fixture repo path, scan, and pick its worktree. */
async function loadFixtureWorktree(
  page: import("@playwright/test").Page,
  repoPath: string,
) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.getByRole("button", { name: /\+ load/ }).click();
  const modal = page.getByRole("dialog", { name: "load changeset" });
  await modal.getByRole("button", { name: "paste path instead" }).click();
  await modal
    .getByPlaceholder("/Users/you/code/my-repo")
    .fill(repoPath);
  await modal.getByRole("button", { name: "scan", exact: true }).click();
  // A fresh `git init` repo has exactly one working tree, on `feat/x`.
  const row = modal.getByRole("button", { name: /feat\/x/ });
  await expect(row).toHaveCount(1);
  await row.click();
  // The modal closes only once the worktree changeset has actually loaded
  // (setShowLoad(false) fires after the fetch resolves). Wait for that —
  // NOT for `.diff`, which is already up from the initial `?cs=42` load.
  await expect(modal).toHaveCount(0);
}

test.describe("Journey 2 — local worktree", () => {
  test("scan + load surfaces the branch's cumulative diff", async ({
    visit,
    page,
  }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await loadFixtureWorktree(page, repo.path);

    // The changeset is the branch's cumulative work: the committed
    // "Friendlier greeting" edit plus the tracked uncommitted edits and the
    // untracked file. Every changed file shows in the sidebar.
    await expect(page.getByText("greeting.ts").first()).toBeVisible();
    await expect(page.getByText("README.md").first()).toBeVisible();
    await expect(page.getByText("notes.txt").first()).toBeVisible();
  });

  test("keyboard navigation moves the cursor across lines and files", async ({
    visit,
    page,
  }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await loadFixtureWorktree(page, repo.path);
    await page.keyboard.press("Escape").catch(() => {}); // dismiss plan overlay

    // Cursor starts on the first file's first line. `j` advances it — the
    // highlighted line's text changes.
    const cursor = page.locator('[aria-current="true"]');
    await expect(cursor).toHaveCount(1);
    const beforeLine = await cursor.textContent();
    await page.keyboard.press("j");
    await expect.poll(() => cursor.textContent()).not.toBe(beforeLine);

    // `]` jumps to the next file — the diff header path changes.
    const path = page.locator(".diff__path");
    const beforeFile = await path.textContent();
    await page.keyboard.press("]");
    await expect.poll(() => path.textContent()).not.toBe(beforeFile);
  });

  test("Shift+M signs off the current file", async ({ visit, page }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await loadFixtureWorktree(page, repo.path);
    await page.keyboard.press("Escape").catch(() => {}); // dismiss plan overlay

    await expect(page.getByLabel("reviewed", { exact: true })).toHaveCount(0);

    await page.keyboard.press("Shift+M");
    await expect(
      page.getByLabel("reviewed", { exact: true }).first(),
    ).toBeVisible();
    // Toggling again clears it.
    await page.keyboard.press("Shift+M");
    await expect(page.getByLabel("reviewed", { exact: true })).toHaveCount(0);
  });

  test("commit-range picker lists the worktree's commits", async ({
    visit,
    page,
  }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await loadFixtureWorktree(page, repo.path);
    await page.keyboard.press("Escape").catch(() => {}); // dismiss plan overlay

    // The ⇄ range topbar button opens the commit-range picker.
    await page.getByRole("button", { name: /range/ }).click();
    // The fixture repo has two commits; each row offers a "just this" shortcut.
    const justThis = page.getByRole("button", { name: "just this" });
    await expect(justThis).toHaveCount(2);
    // Narrowing to a single commit keeps a diff loaded.
    await justThis.first().click();
    await expectWorkspaceLoaded(page);
  });

  test("context expansion: expand bars and full-file view", async ({
    visit,
    page,
  }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await loadFixtureWorktree(page, repo.path);
    await dismissPlanOverlay(page); // fully clear the overlay — we click in the diff

    // The diff shows one file at a time; move to greeting.ts, the long file
    // whose committed + uncommitted edits are far apart → a collapsed gap
    // with an expand bar.
    await page.keyboard.press("]");
    await expect(page.getByRole("main")).toContainText("greeting.ts");

    // For a non-markdown worktree file the bar lazy-fetches; clicking it
    // loads the surrounding context.
    const expandBar = page
      .getByRole("button", { name: /load context|expand \d+ line/ })
      .first();
    await expect(expandBar).toBeVisible();
    await expandBar.click();

    // The full-file toggle shows the whole file, then collapses back to hunks.
    const fullFile = page.getByRole("button", { name: "↗ expand entire file" });
    await expect(fullFile).toBeVisible();
    await fullFile.click();
    await expect(
      page.getByRole("button", { name: "↙ collapse to hunks" }),
    ).toBeVisible();
  });

  test("comment authoring: c opens a composer and the comment renders", async ({
    visit,
    page,
  }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await loadFixtureWorktree(page, repo.path);
    await dismissPlanOverlay(page);

    // `c` on the current line opens the comment composer in the Inspector.
    await page.keyboard.press("c");
    const inspector = page.getByRole("complementary", { name: "inspector" });
    const composer = inspector.getByRole("textbox");
    await expect(composer).toBeVisible();
    await composer.fill("e2e: needs a guard here");
    await composer.press("ControlOrMeta+Enter");

    // The saved comment renders back in the Inspector.
    await expect(inspector).toContainText("e2e: needs a guard here");
  });

  test("pip lifecycle: a worktree comment goes from ◌ queued to ✓ delivered when the agent claims it", async ({
    visit,
    page,
    request,
  }) => {
    // Drives the real two-step server lifecycle: the UI authors a pip, then
    // we stand in for the agent worker by calling /api/agent/interactions with
    // status "unread" (claims + moves to delivered) and /api/agent/replies
    // (posts the agent's response). Catches regressions in interaction-sync,
    // the enqueue path, the delivered-polling loop, and the pip render order.
    const own = createWorktreeRepo();
    try {
      await visit("/?cs=42");
      await expectWorkspaceLoaded(page);
      await loadFixtureWorktree(page, own.path);
      await dismissPlanOverlay(page);

      const inspector = page.getByRole("complementary", { name: "inspector" });
      await page.keyboard.press("c");
      const composer = inspector.getByRole("textbox");
      await expect(composer).toBeVisible();
      await composer.fill("e2e: please confirm");
      await composer.press("ControlOrMeta+Enter");

      // Optimistic queued pip appears immediately on submit, before any
      // round-trip — that's the bug commit 3d448ed fixed.
      await expect(inspector.locator(".reply__pip--queued")).toBeVisible();

      // Stand in for the agent worker. The enqueue POST is asynchronous —
      // the optimistic pip lights up before it lands server-side — so poll
      // /api/agent/interactions (status "unread") until it actually claims
      // something. An unread read is destructive (the server moves entries
      // from pending to delivered); empty responses just mean "not enqueued
      // yet" and we keep waiting.
      let parentId: string | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const r = await request.post("/api/agent/interactions", {
          data: { worktreePath: own.path, status: "unread" },
        });
        if (r.ok()) {
          const body = (await r.json()) as { ids: string[] };
          if (body.ids[0]) {
            parentId = body.ids[0];
            break;
          }
        }
        await page.waitForTimeout(200);
      }
      expect(parentId, "agent pull never claimed an interaction").not.toBeNull();

      const reply = await request.post("/api/agent/replies", {
        data: {
          worktreePath: own.path,
          parentId,
          body: "agent ack — looks fine",
          intent: "ack",
        },
      });
      expect(reply.ok()).toBeTruthy();

      // The 2s delivered-polling loop picks up the new state: the original
      // pip flips to ✓ delivered and the agent's reply appears in the
      // thread. 12s timeout absorbs poll-cycle jitter on a busy CI host.
      await expect(inspector.locator(".reply__pip--delivered")).toBeVisible({
        timeout: 12_000,
      });
      await expect(inspector).toContainText("agent ack — looks fine", {
        timeout: 12_000,
      });
      await expect(inspector.locator(".reply__pip--queued")).toHaveCount(0);
    } finally {
      own.cleanup();
    }
  });

  test("pip lifecycle: enqueue failure shows ⚠ retry; clicking it succeeds", async ({
    visit,
    page,
  }) => {
    // Forces the enqueue POST to 500 so the optimistic ◌ queued is replaced
    // by the ⚠ retry pip. The retry button is the click target the user
    // sees; clicking it after the enqueue endpoint recovers must flip the
    // pip back to ◌ queued without a duplicate comment.
    const own = createWorktreeRepo();
    try {
      await mockEnqueueRejects(page);
      await visit("/?cs=42");
      await expectWorkspaceLoaded(page);
      await loadFixtureWorktree(page, own.path);
      await dismissPlanOverlay(page);

      const inspector = page.getByRole("complementary", { name: "inspector" });
      await page.keyboard.press("c");
      const composer = inspector.getByRole("textbox");
      await expect(composer).toBeVisible();
      await composer.fill("e2e: needs a retry");
      await composer.press("ControlOrMeta+Enter");

      // Error precedence: the failed enqueue dispatches
      // SET_INTERACTION_ENQUEUE_ERROR and the ⚠ retry pip wins over the
      // optimistic ◌ queued.
      await expect(inspector.locator(".reply__pip--errored")).toBeVisible();
      // Exactly one comment in the thread — the failure didn't double-post.
      await expect(inspector.getByText("e2e: needs a retry")).toHaveCount(1);

      // Drop the failure stub so the retry succeeds against the real server.
      await page.unroute("**/api/interactions/enqueue");

      await inspector.locator(".reply__pip--errored").click();
      await expect(inspector.locator(".reply__pip--queued")).toBeVisible();
      await expect(inspector.locator(".reply__pip--errored")).toHaveCount(0);
    } finally {
      own.cleanup();
    }
  });

  test("watch indicator: a watch-tagged agent read lights the 'Agent is watching' row", async ({
    visit,
    page,
    request,
  }) => {
    // The watch-mode counterpart to the pip lifecycle. Lower tiers already
    // cover the HTTP contract (server index.test.ts) and the React render
    // (AgentContextSection.test.tsx) in isolation; only this drives the full
    // wire — an interactions read tagged `watch: true` → the server's
    // `watching` flag → the live /api/agent/replies poll → the panel
    // indicator — in a browser.
    const own = createWorktreeRepo();
    try {
      await visit("/?cs=42");
      await expectWorkspaceLoaded(page);
      await loadFixtureWorktree(page, own.path);
      await dismissPlanOverlay(page);

      const inspector = page.getByRole("complementary", { name: "inspector" });
      // Baseline: a freshly loaded worktree has nobody watching it.
      await expect(inspector.locator(".ac__watching")).toHaveCount(0);

      // Stand in for an agent in watch mode — its poll is an `unread` read
      // tagged watch:true. One is enough; the server treats the worktree as
      // watched for WATCH_TTL_MS.
      const pull = await request.post("/api/agent/interactions", {
        data: { worktreePath: own.path, status: "unread", watch: true },
      });
      expect(pull.ok()).toBeTruthy();

      // The 2s replies poll carries `watching: true` back and the indicator
      // appears. 12s absorbs poll-cycle jitter on a busy CI host.
      await expect(inspector.locator(".ac__watching")).toContainText(
        "Agent is watching — comments deliver live.",
        { timeout: 12_000 },
      );
    } finally {
      own.cleanup();
    }
  });

  test("worktree review progress persists across reload", async ({
    visit,
    page,
  }) => {
    // Asserts read-mark persistence specifically. Worktree file sign-offs have
    // their own test below so this case stays narrow.
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await loadFixtureWorktree(page, repo.path);
    await dismissPlanOverlay(page);

    // Read a few lines, then wait for the debounced session save to land.
    // The condition mirrors hasProgress() — arr.length > 1 ensures the j
    // presses themselves (not just the initial line-0 save) are captured.
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.waitForFunction(() => {
      const raw = localStorage.getItem("shippable:review:v1");
      if (!raw) return false;
      try {
        const s = JSON.parse(raw);
        return Object.values(s.readLines ?? {}).some(
          (arr) => Array.isArray(arr) && arr.length > 1,
        );
      } catch {
        return false;
      }
    });

    // Reopen at `/` — the worktree session resumes from peekSession with the
    // read progress intact (the sidebar's per-file read meter is non-zero).
    await visit("/");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);
    await expect(
      page.getByRole("button", { name: /[1-9]\d*% read/ }).first(),
    ).toBeVisible();
  });

  test("worktree sign-off persists across reload", async ({
    visit,
    page,
  }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await loadFixtureWorktree(page, repo.path);
    await dismissPlanOverlay(page);

    await expect(page.getByLabel("reviewed", { exact: true })).toHaveCount(0);

    await page.keyboard.press("Shift+M");
    await expect(
      page.getByLabel("reviewed", { exact: true }).first(),
    ).toBeVisible();

    // Wait for the debounced session save before navigating away.
    await page.waitForFunction(() => {
      const raw = localStorage.getItem("shippable:review:v1");
      if (!raw) return false;
      try {
        return (JSON.parse(raw).reviewedFiles ?? []).length > 0;
      } catch {
        return false;
      }
    });

    await visit("/");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);
    await expect(
      page.getByLabel("reviewed", { exact: true }).first(),
    ).toBeVisible();
  });

  test("live-reload banner appears when a new commit lands", async ({
    visit,
    page,
  }) => {
    // Own repo — this test mutates it, so keep it off the shared fixture.
    const own = createWorktreeRepo();
    try {
      await visit("/?cs=42");
      await expectWorkspaceLoaded(page);
      await loadFixtureWorktree(page, own.path);
      await page.keyboard.press("Escape").catch(() => {}); // dismiss plan overlay

      // Baseline: the live-reload bar is watching the worktree.
      const liveBar = page.getByRole("status", { name: "live reload" });
      await expect(liveBar).toBeVisible();

      // A new commit lands; the 3s poll picks it up and the banner offers a
      // reload.
      addCommit(own.path);
      await expect(liveBar).toContainText("reload", { timeout: 12_000 });
    } finally {
      own.cleanup();
    }
  });

  test("reload preserves a range load — committed changes don't vanish", async ({
    visit,
    page,
  }) => {
    // Regression for the reload-drops-scope bug: a "last commit + uncommitted"
    // range load that, on reload after a dirty edit, collapsed to dirty-only
    // (git diff HEAD) and dropped the committed file from the view.
    const own = createSplitRepo();
    try {
      await visit("/?cs=42");
      await expectWorkspaceLoaded(page);
      await loadFixtureWorktree(page, own.path);
      await page.keyboard.press("Escape").catch(() => {}); // dismiss plan overlay

      // Re-slice to "last commit + uncommitted" via the range picker: from
      // defaults to the latest commit, to stays at HEAD, and we tick the
      // uncommitted toggle.
      await page.getByRole("button", { name: /range/ }).click();
      const picker = page.locator(".range-picker");
      await picker
        .getByRole("checkbox", { name: "include uncommitted changes" })
        .check();
      await picker.getByRole("button", { name: "load range" }).click();
      // The picker closes only after onApply's fetch resolves, so this is the
      // signal the range load actually landed — and that its live-reload
      // baseline captured the current HEAD. Without it, landCommit() below
      // races the in-flight load and the baseline captures the new sha.
      await expect(picker).toHaveCount(0);
      await expectWorkspaceLoaded(page);

      // The range view holds both the committed file and the dirty-only file.
      await expect(page.getByText("committed.ts").first()).toBeVisible();
      await expect(page.getByText("dirty.ts").first()).toBeVisible();

      // A follow-up commit lands (HEAD moves) while the tree stays dirty —
      // the 3s poll picks up the new sha and the banner offers a reload.
      const liveBar = page.getByRole("status", { name: "live reload" });
      own.landCommit();
      await expect(liveBar).toContainText("reload", { timeout: 12_000 });

      // Reload. Before the fix this collapsed to dirty-only (the tree is
      // dirty) and committed.ts disappeared; now the original range is
      // re-fetched and the committed file stays.
      await liveBar.getByRole("button", { name: "reload" }).click();
      await expect(liveBar).toContainText("watching", { timeout: 12_000 });

      await expect(page.getByText("committed.ts").first()).toBeVisible();
      await expect(page.getByText("dirty.ts").first()).toBeVisible();
    } finally {
      own.cleanup();
    }
  });

  test("unreachable worktree shows the 'no longer reachable' banner", async ({
    visit,
    page,
  }) => {
    const own = createWorktreeRepo();
    try {
      await visit("/?cs=42");
      await expectWorkspaceLoaded(page);
      await loadFixtureWorktree(page, own.path);
      await page.keyboard.press("Escape").catch(() => {}); // dismiss plan overlay
      const liveBar = page.getByRole("status", { name: "live reload" });
      await expect(liveBar).toBeVisible();

      // The worktree vanishes; the next poll 404s and the gone banner shows.
      own.cleanup();
      await expect(liveBar).toContainText("no longer reachable", {
        timeout: 15_000,
      });
    } finally {
      own.cleanup();
    }
  });
});
