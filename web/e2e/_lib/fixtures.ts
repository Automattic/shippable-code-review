// Playwright test fixtures. The `app` fixture is the default entry point:
// it stubs the boot probes and exposes a `visit(path?)` helper that waits
// for the gate to fall through (or to surface a deliberate failure mode).

import { test as base, expect, type Page } from "@playwright/test";
import {
  mockAuthList,
  mockHealthy,
  mockPromptsEmpty,
  mockStatsConsent,
  mockStatsEvent,
} from "./mocks";

export interface AppFixture {
  page: Page;
  /** Navigate to `path` (default `/?cs=42`) with boot probes already healthy. */
  visit: (path?: string) => Promise<void>;
}

export interface VisitOpts {
  /** Default true — sets the localStorage skip flag so the boot CredentialsPanel
   *  is bypassed. Set to false for tests that need to exercise the boot panel. */
  skipAnthropic?: boolean;
}

export const test = base.extend<
  AppFixture & {
    visit: (path?: string, opts?: VisitOpts) => Promise<void>;
    autoClearServerAuth: void;
  }
>({
  visit: async ({ page }, use) => {
    // Default boot mocks. Tests that exercise the unhealthy path call
    // `mockHealthDown(page)` BEFORE `visit()` — page.route order matters and
    // later registrations win on the same pattern via `unroute` semantics.
    await mockHealthy(page);
    await mockAuthList(page, []);
    await mockPromptsEmpty(page);
    // Default consent = granted → no welcome banner. Tests that want the
    // banner re-route /api/stats/consent to "undecided" before visit().
    await mockStatsConsent(page, "granted");
    await mockStatsEvent(page);

    await use(async (path = "/?cs=42", opts: VisitOpts = {}) => {
      const skipAnthropic = opts.skipAnthropic !== false;
      if (skipAnthropic) {
        await page.addInitScript(() => {
          try {
            window.localStorage.setItem("shippable:anthropic:skip", "true");
          } catch {}
        });
      }
      await page.goto(path);
    });
  },

  // Auto fixture: after every test, wipe the real server's in-memory auth
  // store. It's shared across the whole run, so a credential one test stores
  // would otherwise leak into the next (a test never seeing the token modal,
  // a boot panel that doesn't re-show). Best-effort — see `clearServerAuth`.
  autoClearServerAuth: [
    async ({ page }, use) => {
      await use();
      await clearServerAuth(page);
    },
    { auto: true },
  ],
});

export { expect };

/** Wait for the boot CredentialsPanel to render — used by Journey 1. The
 *  anthropic key input (placeholder `sk-ant-...`) is only on-screen while the
 *  boot panel is up, so it's a clean observable signal. */
export async function expectBootCredentialsPanel(page: Page): Promise<void> {
  await expect(page.getByPlaceholder("sk-ant-...")).toBeVisible();
}

/** Wait for the workspace to be loaded (diff visible). */
export async function expectWorkspaceLoaded(page: Page): Promise<void> {
  await expect(page.locator(".diff")).toBeVisible({ timeout: 10_000 });
}

/** Dismiss the plan overlay if it's covering the workspace. The overlay
 *  mounts a tick after `.diff` (the plan is computed after the first render),
 *  so wait for it briefly rather than racing a bare count() check — otherwise
 *  it slips in *after* the check and stays open for the rest of the test. */
export async function dismissPlanOverlay(page: Page): Promise<void> {
  const overlay = page.getByRole("dialog", { name: "review plan" });
  const appeared = await overlay
    .waitFor({ state: "visible", timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  await page.keyboard.press("Escape");
  await overlay.waitFor({ state: "hidden" });
}

/** Ensure the real server has an Anthropic key configured, then land in the
 *  workspace. The server's auth store is shared across the whole run, so a
 *  prior test may have already configured one — in that case the boot panel
 *  won't reshow and we just proceed. Drops the default `/api/auth/list` mock
 *  so the real store drives the boot decision. */
export async function ensureAnthropicConfigured(
  page: Page,
  visit: (path?: string, opts?: VisitOpts) => Promise<void>,
  path = "/?cs=42",
): Promise<void> {
  await page.unroute("**/api/auth/list").catch(() => {});
  await visit(path, { skipAnthropic: false });
  const keyInput = page.getByPlaceholder("sk-ant-...");
  // The gate resolves to either the boot panel (no key) or the workspace.
  await Promise.race([
    keyInput.waitFor({ state: "visible" }).catch(() => {}),
    page.locator(".diff").waitFor({ state: "visible" }).catch(() => {}),
  ]);
  if (await keyInput.isVisible().catch(() => false)) {
    await keyInput.fill("sk-ant-e2e-fake");
    await page.getByRole("button", { name: "Save" }).click();
  }
  await expectWorkspaceLoaded(page);
}

/** Clear the real server's in-memory auth store. The store is shared across
 *  the whole run, so tests that write to it (storing keys/tokens) must clean
 *  up in `afterEach` — otherwise a later test inherits the credential and
 *  e.g. never sees the token modal. Runs in-page so the request carries the
 *  allowlisted vite Origin. */
export async function clearServerAuth(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const clear = (credential: unknown) =>
        fetch("/api/auth/clear", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential }),
        }).catch(() => {});
      await clear({ kind: "anthropic" });
      await clear({ kind: "github", host: "github.com" });
      await clear({ kind: "github", host: "ghe.example.com" });
    })
    .catch(() => {});
}
