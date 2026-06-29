// Journey 5 — AI features inside a review. The plan + prompt-run paths run end
// to end: real boot panel → real /api/plan + /api/review → fake upstream
// (scripts/fake-upstream.mjs). Inspector notes and the code runner are
// hermetic (cs-42 ships AI notes; the WASM runner is client-side). The
// rate-limit branch page.route()s a 429 — a failure mode that's impractical to
// trigger for real.

import {
  test,
  expect,
  expectWorkspaceLoaded,
  ensureAnthropicConfigured,
  dismissPlanOverlay,
} from "./_lib/fixtures";
import { mockAuthList } from "./_lib/mocks";

test.describe("Journey 5 — AI features", () => {
  test("plan: Send to Claude runs /api/plan through to the fake upstream", async ({
    visit,
    page,
  }) => {
    // Real path: a key in the server's auth store makes the plan auto-fire,
    // hitting the real /api/plan — which calls the fake upstream and feeds its
    // structured output back through the server's assemblePlan.
    await ensureAnthropicConfigured(page, visit);

    // The plan overlay is open by default. With a key configured the AI plan
    // auto-fires (no explicit gesture) and replaces the rule-based plan; its
    // intent claim carries the fake upstream's marker text.
    await expect(
      page.getByRole("heading", { name: /Add user preferences panel/ }),
    ).toBeVisible();
    await expect(page.getByText(/FAKE-PLAN:/)).toBeVisible();
  });

  test("free runner: Shift+R opens an empty one-off runner", async ({
    visit,
    page,
  }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);

    await page.keyboard.press("Shift+R");
    const runner = page.locator(".coderunner--free");
    await expect(runner).toBeVisible();
    await expect(runner.locator(".coderunner__shape")).toHaveText("free runner");
    // Language picker offers the WASM-backed runtimes.
    await expect(runner.locator(".coderunner__lang")).toBeVisible();
  });

  test("Inspector AI notes: a acks, r opens a reply composer", async ({
    visit,
    page,
  }) => {
    // cs-42 ships AI notes — no AI call needed. `n` jumps the cursor to the
    // first note-bearing line; the a/r keymaps only fire on `lineHasAiNote`.
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);

    await page.keyboard.press("n");
    const cursor = page.locator('[aria-current="true"]');
    // landed on a line that carries an AI note
    await expect(cursor).toHaveAttribute("data-ai-severity", /.+/);

    // `a` acks the note: the line's data-acked flips AND the Inspector grows
    // a "✓ acked" affordance. Pressing it again clears both.
    await page.keyboard.press("a");
    await expect(cursor).toHaveAttribute("data-acked", "true");
    await expect(page.getByRole("button", { name: "✓ acked" })).toBeVisible();
    await page.keyboard.press("a");
    await expect(cursor).not.toHaveAttribute("data-acked", "true");
    await expect(page.getByRole("button", { name: "✓ acked" })).toHaveCount(0);

    // `r` opens the reply composer in the Inspector.
    await page.keyboard.press("r");
    await expect(page.getByPlaceholder("Write a reply…")).toBeVisible();
  });

  test("code runner: e opens the inline runner on a TS hunk", async ({
    visit,
    page,
  }) => {
    // cs-42's first file is a .ts file; `e` runs the current hunk.
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);

    await page.keyboard.press("e");
    const runner = page.locator(".coderunner--open");
    await expect(runner).toBeVisible();
    await expect(runner.locator(".coderunner__lang")).toBeVisible();
  });

  test("prompt picker: / opens it; running a prompt streams via /api/review", async ({
    visit,
    page,
  }) => {
    // Real path: a key configured, open the picker (real prompt library), run
    // the first built-in prompt — /api/review streams from the fake upstream.
    await ensureAnthropicConfigured(page, visit);
    await dismissPlanOverlay(page);

    await page.keyboard.press("/");
    await expect(page.getByPlaceholder("search prompts…")).toBeVisible();
    await page.getByRole("listbox").getByRole("option").first().click();
    await page.getByRole("button", { name: "run", exact: true }).click();

    // The run row appears and settles streaming… → done; expanding it shows
    // the fake upstream's streamed marker text.
    const run = page.locator(".promptrun").first();
    await expect(run.locator(".promptrun__status")).toHaveText("done", {
      timeout: 10_000,
    });
    await run.getByRole("button", { expanded: false }).click();
    await expect(run.locator(".promptrun__body")).toContainText("FAKE-REVIEW:");
  });

  test("rate-limit: a 429 from /api/review surfaces a clear error", async ({
    visit,
    page,
  }) => {
    // page.route() the 429 — the server's per-IP rate limit is impractical to
    // trip in a test, and this exercises the client's error rendering.
    await mockAuthList(page, [{ kind: "anthropic" }]);
    await page.route("**/api/review", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "rate limit exceeded" }),
      }),
    );
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);

    await page.keyboard.press("/");
    await expect(page.getByPlaceholder("search prompts…")).toBeVisible();
    await page.getByRole("listbox").getByRole("option").first().click();
    await page.getByRole("button", { name: "run", exact: true }).click();

    const run = page.locator(".promptrun").first();
    await expect(run.locator(".promptrun__status--error")).toBeVisible();
    // The error detail lives in the expanded body.
    await run.getByRole("button", { expanded: false }).click();
    await expect(run.locator(".promptrun__err")).toContainText("429");
  });

  test("plan: clicking an evidence reference jumps the cursor", async ({
    visit,
    page,
  }) => {
    await ensureAnthropicConfigured(page, visit);
    // The AI plan auto-fires once the key is configured; wait for its marker.
    await expect(page.getByText(/FAKE-PLAN:/)).toBeVisible();

    // The fake plan's claim cites src/utils/storage.ts — clicking that
    // reference (scoped to the plan dialog, not the sidebar file row) jumps
    // the cursor into the file.
    await page
      .getByRole("dialog", { name: "review plan" })
      .getByRole("button", { name: "src/utils/storage.ts" })
      .first()
      .click();
    await expect(page.getByRole("main")).toContainText("src/utils/storage.ts");
  });

  test("Inspector ack + reply persist across reload", async ({
    visit,
    page,
  }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);

    // Ack a note and leave a reply on it.
    await page.keyboard.press("n");
    await page.keyboard.press("a");
    await expect(page.getByRole("button", { name: "✓ acked" })).toBeVisible();
    await page.keyboard.press("r");
    const composer = page.getByPlaceholder("Write a reply…");
    await composer.fill("e2e: looks intentional");

    // Set up the response wait before submitting so we don't miss the POST.
    // Interactions now live in the server DB (not localStorage), so we wait
    // for the reply's POST to /api/interactions to confirm it's persisted.
    const waitForReplyPersisted = page.waitForResponse((r) => {
      if (!r.url().includes("/api/interactions")) return false;
      if (r.request().method() !== "POST") return false;
      const data = r.request().postDataJSON() as { body?: string } | null;
      return data?.body === "e2e: looks intentional";
    });
    await composer.press("ControlOrMeta+Enter");
    await expect(page.getByText("e2e: looks intentional")).toBeVisible();
    await waitForReplyPersisted;

    // Also wait for the debounced session snapshot to save (cursor moved to
    // the note line via `n`, so lineIdx > 0 once the save fires).
    await page.waitForFunction(() => {
      const raw = localStorage.getItem("shippable:review:v1");
      if (!raw) return false;
      try {
        return (JSON.parse(raw)?.cursor?.lineIdx ?? 0) > 0;
      } catch {
        return false;
      }
    });
    await visit("/");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);
    await expect(page.getByRole("button", { name: "✓ acked" })).toBeVisible();
    await expect(page.getByText("e2e: looks intentional")).toBeVisible();
  });

  test("plan diagram: generate opens the diagram with type tabs", async ({
    visit,
    page,
  }) => {
    await ensureAnthropicConfigured(page, visit);
    // Once the AI plan is ready the static file map collapses under "all files"
    // (ReviewPlanView's CollapsedMapSection); expand it to reach the diagram
    // affordance, then generate.
    const planDialog = page.getByRole("dialog", { name: "review plan" });
    await planDialog.getByText(/all files \(\d+\)/).click();
    await planDialog.getByRole("button", { name: "generate diagram" }).click();
    await expect(
      page.getByRole("tablist", { name: "Diagram types" }),
    ).toBeVisible();
  });

  test("inline runner: e runs a hunk and shows output", async ({
    visit,
    page,
  }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);

    // Move to src/utils/storage.ts — a hunk with real runnable code — and run
    // it with `e`. Running produces output (logs / return / error) in-panel.
    await page.keyboard.press("]");
    await expect(page.getByRole("main")).toContainText("src/utils/storage.ts");
    await page.keyboard.press("e");

    const runner = page.locator(".coderunner--open");
    await expect(runner).toBeVisible();
    await runner.locator(".coderunner__run").first().click();
    await expect(runner.locator(".coderunner__out")).toBeVisible();
  });

  test("prompt runs panel: widen and dismiss controls", async ({
    visit,
    page,
  }) => {
    await ensureAnthropicConfigured(page, visit);
    await dismissPlanOverlay(page);
    await page.keyboard.press("/");
    await page.getByRole("listbox").getByRole("option").first().click();
    await page.getByRole("button", { name: "run", exact: true }).click();

    const run = page.locator(".promptrun").first();
    await expect(run).toBeVisible();
    // The panel widens and narrows…
    await page.getByRole("button", { name: /widen the sidebar/ }).click();
    await page.getByRole("button", { name: /narrow the sidebar/ }).click();
    // …and the run can be dismissed.
    await page.getByRole("button", { name: "dismiss this run" }).click();
    await expect(run).toHaveCount(0);
  });

  test("prompt editor: fork a built-in, edit, save, delete", async ({
    visit,
    page,
  }) => {
    await ensureAnthropicConfigured(page, visit);
    await dismissPlanOverlay(page);
    await page.keyboard.press("/");
    await expect(page.getByPlaceholder("search prompts…")).toBeVisible();

    // Fork a built-in prompt into an editable user copy, tweak it, save.
    await page.getByRole("button", { name: "fork" }).first().click();
    await page
      .getByPlaceholder("Short summary shown in the picker")
      .fill("e2e edited copy");
    await page.getByRole("button", { name: "save", exact: true }).click();
    await expect(page.getByText("e2e edited copy")).toBeVisible();

    // Deleting the user override restores the library default.
    await page.getByRole("button", { name: "edit" }).first().click();
    await page.getByRole("button", { name: "delete" }).click();
    await page.getByRole("button", { name: "yes" }).click();
    await expect(page.getByText("e2e edited copy")).toHaveCount(0);
  });
});
