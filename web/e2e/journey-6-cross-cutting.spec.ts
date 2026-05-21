// Journey 6 — Cross-cutting surfaces. Covers the [auto] steps for: keyboard
// help overlay, theme cycling (verify the class flip — visual is [manual]),
// Settings access from the topbar, Add-GitHub-host trust flow, Cmd+K palette,
// recents list on Welcome, ?cs= URL shortcut (also covered in J4).
//
// [manual] steps (FindBar, webview zoom, packaged-DMG behaviour) stay in the
// manual track since they depend on Tauri / native menus.

import { test, expect, expectWorkspaceLoaded, dismissPlanOverlay } from "./_lib/fixtures";
import { mockAuthList, mockAuthWriteable } from "./_lib/mocks";

test.describe("Journey 6 — cross-cutting", () => {
  test.beforeEach(async ({ visit, page }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);
  });

  test("keyboard help: ? opens the help overlay; Escape closes", async ({ page }) => {
    await page.keyboard.press("?");
    const help = page.getByRole("dialog", { name: "keybindings" });
    await expect(help).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
  });

  test("theme cycling: switching themes updates <html data-theme>", async ({ page }) => {
    // getByRole ignores the aria-hidden TopbarActions measurement clone, so no
    // scoping needed — it matches only the live theme picker.
    const themeSelect = page.getByRole("combobox", {
      name: "Select UI and code theme",
    });
    // Default is dark — confirm baseline.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    for (const themeId of ["light", "dollhouse", "dollhouseNoir", "dark"]) {
      await themeSelect.selectOption(themeId);
      await expect(page.locator("html")).toHaveAttribute("data-theme", themeId);
    }

    // Persistence: reload and confirm the last selection survives.
    await themeSelect.selectOption("light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("Cmd+K opens the command palette", async ({ page }) => {
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+KeyK`);
    const palette = page.getByRole("dialog", { name: "command palette" });
    await expect(palette).toBeVisible();
    await expect(palette.getByPlaceholder("search app actions…")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
  });

  test("Settings → Add GitHub host shows the trust step before the token field", async ({ page }) => {
    await page.getByRole("button", { name: "settings" }).click();
    const settings = page.getByRole("dialog", { name: "settings" });
    await expect(settings).toBeVisible();

    await settings.getByRole("button", { name: /Add GitHub host/ }).click();
    // Type a non-github.com host — should land on the trust stage.
    await settings
      .getByPlaceholder("host (e.g. ghe.example.com)")
      .fill("github.example.com");
    // Advance from the host stage to the trust interstitial.
    await settings.getByRole("button", { name: "continue" }).click();

    await expect(
      settings.getByRole("button", { name: /I trust github\.example\.com/ }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("comment nav: n / Shift+N jump the cursor between comment lines", async ({
    page,
  }) => {
    // cs-42 ships with review comments and AI notes. `n` jumps the cursor to
    // the next comment-bearing line; Shift+N returns to the previous one.
    const cursor = page.locator('[aria-current="true"]');
    await page.keyboard.press("n");
    const firstStop = await cursor.textContent();
    await page.keyboard.press("n");
    await expect.poll(() => cursor.textContent()).not.toBe(firstStop);
    await page.keyboard.press("Shift+N");
    await expect.poll(() => cursor.textContent()).toBe(firstStop);
  });
});

test.describe("Journey 6 — standalone entry points", () => {
  test("gallery.html renders the screen catalog", async ({ page, visit }) => {
    await visit("/gallery.html");
    await expect(page.locator(".gallery")).toBeVisible();
    await expect(page.locator(".gallery__nav .gallery__item").first()).toBeVisible();
  });

  test("feature-docs.html renders the per-feature viewer", async ({
    page,
    visit,
  }) => {
    await visit("/feature-docs.html");
    // The default view renders `.feature-docs__workspace`; other views render
    // `.feature-docs` — match either.
    await expect(page.locator('[class^="feature-docs"]').first()).toBeVisible();
  });
});

test.describe("Journey 6 — Settings credential rows", () => {
  test("clearing a GitHub PAT row unsets it", async ({ visit, page }) => {
    // Start with a GitHub host already configured so Settings shows its row.
    await mockAuthList(page, [{ kind: "github", host: "github.com" }]);
    await mockAuthWriteable(page);
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await page.keyboard.press("Escape").catch(() => {}); // dismiss plan overlay

    await page.getByRole("button", { name: "settings" }).click();
    const settings = page.getByRole("dialog", { name: "settings" });
    const clear = settings.getByRole("button", { name: "clear github.com" });
    await expect(clear).toBeVisible();

    // After clearing, the row flips to unset — the clear affordance goes away.
    let cleared = false;
    await page.unroute("**/api/auth/list");
    await page.route("**/api/auth/list", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          credentials: cleared ? [] : [{ kind: "github", host: "github.com" }],
        }),
      }),
    );
    await page.route("**/api/auth/clear", async (route) => {
      cleared = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await clear.click();
    await expect(
      settings.getByRole("button", { name: "clear github.com" }),
    ).toHaveCount(0);
  });
});

test.describe("Journey 6 — Welcome recents", () => {
  test("recents survive a reload and can be dismissed", async ({ page, visit }) => {
    // Exercise the real write path: loading a changeset pushes it into the
    // recents store (App.tsx pushRecent), so no hand-seeded localStorage.
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);

    // Back on Welcome, the just-loaded changeset shows in recents. The open
    // button's name starts with the title; the forget button's starts with
    // "forget" — anchor so we match only the open button.
    await visit("/");
    const recent = page.getByRole("button", {
      name: /^Add user preferences panel/,
    });
    await expect(recent).toBeVisible();

    // Dismissing the entry removes it; the removal persists across reload.
    await page
      .getByRole("button", { name: "forget Add user preferences panel" })
      .click();
    await expect(recent).toHaveCount(0);

    await page.reload();
    await expect(recent).toHaveCount(0);
  });
});

test.describe("Journey 6 — inline interactions", () => {
  test.beforeEach(async ({ visit, page }) => {
    await visit("/?cs=42");
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);
  });

  // The cursor line's inline block is the `.line-inline-threads` div mounted
  // directly under the `aria-current` line. With "hide non-active comments"
  // off (the default), other commented lines render their own blocks too, so
  // tests that mean "the cursor line's block" must scope to this one.
  function cursorBlock(page: import("@playwright/test").Page) {
    return page.locator(
      '[aria-current="true"] + .line-inline-threads',
    );
  }

  // Turn inline-comment rendering on. `i` (Inspector) and `Shift+I` (inline
  // comments) are now independent toggles; inline comments default to off.
  async function enableInlineComments(page: import("@playwright/test").Page) {
    await page.keyboard.press("Shift+I");
    await expect(page.locator(".line__comment").first()).toBeVisible();
  }

  test("Shift+I renders interactions inline in the diff", async ({
    page,
  }) => {
    const inspector = page.getByRole("complementary", { name: "inspector" });
    // Defaults: Inspector shown, inline comments off — nothing inline in the
    // diff and no comment column.
    await expect(inspector).toBeVisible();
    await expect(page.locator(".line-inline-threads")).toHaveCount(0);
    await expect(page.locator(".line__comment")).toHaveCount(0);

    // Turn inline comments on: the comment column appears; the Inspector stays.
    await enableInlineComments(page);
    await expect(inspector).toBeVisible();

    // n lands the cursor on an AI-noted line (cs-42 ships AI notes); that
    // line's note renders inline, beneath the cursor line, as a bare card with
    // no hunk-scoped section chrome.
    await page.keyboard.press("n");
    const region = cursorBlock(page);
    await expect(region).toBeVisible();
    await expect(region.locator(".notes li").first()).toBeVisible();

    // Toggle inline comments back off: the inline blocks and comment column disappear.
    await page.keyboard.press("Shift+I");
    await expect(page.locator(".line-inline-threads")).toHaveCount(0);
    await expect(page.locator(".line__comment")).toHaveCount(0);
  });

  test("the reply composer opens inline", async ({ page }) => {
    await enableInlineComments(page); // inline comments on
    await page.keyboard.press("n"); // cursor → AI-noted line
    await page.keyboard.press("r"); // r opens the reply composer

    const region = cursorBlock(page);
    await expect(region.getByPlaceholder("Write a reply…")).toBeVisible();
  });

  test("the inline-comments preference persists across reload", async ({
    page,
  }) => {
    await enableInlineComments(page);

    await page.reload();
    await expectWorkspaceLoaded(page);
    await dismissPlanOverlay(page);

    // Inline comments survived the reload — the comment column is still present.
    await expect(page.locator(".line__comment").first()).toBeVisible();
    await page.keyboard.press("n");
    await expect(cursorBlock(page)).toBeVisible();
  });

  test("the Settings modal toggles inline comments", async ({ page }) => {
    await page.getByRole("button", { name: "settings" }).click();
    const settings = page.getByRole("dialog", { name: "settings" });
    await expect(settings).toBeVisible();

    await settings
      .getByRole("button", { name: "Inline comments", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    // The choice took effect: the inline render is on, the comment column is present.
    await expect(page.locator(".line__comment").first()).toBeVisible();
  });

  test("noted cursor line: shows the note, no hunk-scoped section header", async ({
    page,
  }) => {
    await enableInlineComments(page); // inline comments on
    await page.keyboard.press("n"); // cursor → first AI-noted line

    const region = cursorBlock(page);
    // The cursor line's own note renders as a bare card.
    await expect(region.locator(".notes li").first()).toBeVisible();
    // No hunk-scoped section chrome — the fix removed these headers from the
    // per-line box.
    await expect(region).not.toContainText("AI concerns in this hunk");
    await expect(region).not.toContainText("Your comments");
  });

  test("non-noted cursor line: comment button present, no thread", async ({
    page,
  }) => {
    await enableInlineComments(page); // inline comments on
    // `n` lands on the FIRST comment-bearing line in the whole cs-42 diff —
    // STORAGE_H2 line index 6 (`try {`). If a fixture change adds an earlier
    // comment, `n` lands elsewhere and the ArrowDown below no longer reaches
    // an empty line.
    await page.keyboard.press("n");
    // Move one line down — index 7 (`return JSON.parse(raw) as Preferences;`)
    // has no AI note or user comment thread in cs-42's fixture data.
    await page.keyboard.press("ArrowDown");

    // No note or comment cards on this line.
    await expect(cursorBlock(page).locator(".notes li")).toHaveCount(0);
    // The "+ comment" affordance lives in the comment column now — the cursor line carries the + comment button.
    await expect(
      page.locator('[aria-current="true"] .line__comment-btn'),
    ).toBeVisible();
  });

  test("hunk-level threads render after the hunk body, not inside the hunk header", async ({
    page,
  }) => {
    await enableInlineComments(page); // inline comments on
    await page.keyboard.press("n"); // cursor → a noted line; its hunk becomes hunk--current

    // The hunk header must never contain `.hunk__inline-threads` — that block
    // belongs after the hunk body as a sibling of `hunk__h`.
    await expect(
      page.locator(".hunk--current .hunk__h .hunk__inline-threads"),
    ).toHaveCount(0);
  });

  // Inline threads project for the selected file only — open the file that
  // carries the two-comment line. The block holding both `ainote--user` cards
  // is PreferencesPanel L7 (compactMode), where cs-42 ships two threads.
  async function twoCommentBlock(page: import("@playwright/test").Page) {
    await enableInlineComments(page); // inline comments on
    await page
      .getByRole("button", { name: "src/components/PreferencesPanel.tsx" })
      .click();
    return page
      .locator(".line-inline-threads", {
        has: page.locator("li.ainote--user"),
      })
      .filter({ has: page.locator("li.ainote--user").nth(1) });
  }

  test("two comments on one line render as two separate cards", async ({
    page,
  }) => {
    const block = await twoCommentBlock(page);
    await expect(block).toHaveCount(1);
    await expect(block.locator("li.ainote--user")).toHaveCount(2);
  });

  test("a reply nests under its own comment, not after all comments", async ({
    page,
  }) => {
    const block = await twoCommentBlock(page);
    const cards = block.locator("li.ainote--user");

    // Only the first thread (c1) carries a reply; the second (c2) is a lone
    // comment. The reply must live inside c1's card — not c2's, not loose.
    const c1 = cards.filter({ hasText: "happy to flip it" });
    const c2 = cards.filter({ hasText: "code comment on why compact mode" });
    await expect(c1.locator(".thread__list--replies")).toHaveCount(1);
    await expect(c2.locator(".thread__list--replies")).toHaveCount(0);
  });

  test("'hide non-active comments' collapses inline threads to the cursor line", async ({
    page,
  }) => {
    await enableInlineComments(page); // inline comments on
    await page.keyboard.press("n"); // land the cursor on a comment-bearing line

    // Default (off): every commented line renders its own inline block.
    const blocks = page.locator(".line-inline-threads");
    const allVisible = await blocks.count();
    expect(allVisible).toBeGreaterThan(1);

    // Turn the setting on via Settings.
    await page.getByRole("button", { name: "settings" }).click();
    const settings = page.getByRole("dialog", { name: "settings" });
    await settings
      .getByRole("button", { name: "Hide non-active comments" })
      .click();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    // Only the cursor line's block survives.
    await expect(blocks).toHaveCount(1);
  });

  test("i toggles the Inspector without affecting inline comments", async ({
    page,
  }) => {
    const inspector = page.getByRole("complementary", { name: "inspector" });
    await enableInlineComments(page); // inline comments on
    await page.keyboard.press("n"); // cursor → an AI-noted line

    // Baseline: Inspector visible, inline render present.
    await expect(inspector).toBeVisible();
    await expect(cursorBlock(page)).toBeVisible();
    await expect(page.locator(".line__comment").first()).toBeVisible();

    // `i` hides the Inspector — the inline blocks and comment column are untouched.
    await page.keyboard.press("i");
    await expect(inspector).toHaveCount(0);
    await expect(cursorBlock(page)).toBeVisible();
    await expect(page.locator(".line__comment").first()).toBeVisible();

    // `i` again shows the Inspector — still no change to the inline render.
    await page.keyboard.press("i");
    await expect(inspector).toBeVisible();
    await expect(cursorBlock(page)).toBeVisible();
    await expect(page.locator(".line__comment").first()).toBeVisible();
  });

  test("Shift+I toggles inline comments without affecting the Inspector", async ({
    page,
  }) => {
    const inspector = page.getByRole("complementary", { name: "inspector" });
    // Baseline: Inspector shown, no inline render, no comment column.
    await expect(inspector).toBeVisible();
    await expect(page.locator(".line-inline-threads")).toHaveCount(0);
    await expect(page.locator(".line__comment")).toHaveCount(0);

    // Shift+I turns inline comments on — the Inspector is unaffected.
    await page.keyboard.press("Shift+I");
    await expect(page.locator(".line__comment").first()).toBeVisible();
    await expect(inspector).toBeVisible();

    // Shift+I again turns inline comments off — the Inspector still stays.
    await page.keyboard.press("Shift+I");
    await expect(page.locator(".line-inline-threads")).toHaveCount(0);
    await expect(page.locator(".line__comment")).toHaveCount(0);
    await expect(inspector).toBeVisible();
  });

  test("inline mode: Inspector shows placeholder and hides thread body; toggling back restores it", async ({
    page,
  }) => {
    const inspector = page.getByRole("complementary", { name: "inspector" });

    // Baseline: Inspector visible, inline comments off — thread body is present.
    await expect(inspector).toBeVisible();
    await expect(inspector.getByText("AI concerns in this hunk")).toBeVisible();
    await expect(
      inspector.getByText("Comments are shown inline in the diff."),
    ).toHaveCount(0);

    // Turn inline comments on — placeholder appears, thread body is gone.
    await page.keyboard.press("Shift+I");
    await expect(inspector).toBeVisible();
    await expect(
      inspector.getByText("Comments are shown inline in the diff."),
    ).toBeVisible();
    await expect(
      inspector.getByText("AI concerns in this hunk"),
    ).toHaveCount(0);

    // Turn inline comments off again — thread body is restored.
    await page.keyboard.press("Shift+I");
    await expect(inspector.getByText("AI concerns in this hunk")).toBeVisible();
    await expect(
      inspector.getByText("Comments are shown inline in the diff."),
    ).toHaveCount(0);
  });

  test("the + comment button opens a composer on the cursor line", async ({
    page,
  }) => {
    await enableInlineComments(page); // inline comments on
    // Land the cursor on a line with no existing thread so the button starts
    // a fresh comment (index 7 in STORAGE_H2 — see the non-noted test above).
    await page.keyboard.press("n");
    await page.keyboard.press("ArrowDown");

    const button = page.locator('[aria-current="true"] .line__comment-btn');
    await expect(button).toBeVisible();
    await button.click();

    // Clicking the button opens the inline draft composer beneath the line.
    await expect(
      cursorBlock(page).getByPlaceholder("Write a reply…"),
    ).toBeVisible();
  });
});
