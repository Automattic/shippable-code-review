// Reusable page.route() handlers. Each function takes a `Page` and installs
// (or overrides) one endpoint. Compose per-test — defaults from `fixtures.ts`
// already cover /api/health, /api/auth/list, /api/prompts.

import type { Page, Route } from "@playwright/test";

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

export async function mockHealthy(page: Page): Promise<void> {
  await page.route("**/api/health", (route) =>
    json(route, 200, { ok: true }),
  );
}

export async function mockHealthDown(page: Page): Promise<void> {
  await page.route("**/api/health", (route) =>
    route.fulfill({ status: 503, body: "down" }),
  );
}

export async function mockAuthList(
  page: Page,
  credentials: Array<{ kind: "anthropic" } | { kind: "github"; host: string }> = [],
): Promise<void> {
  await page.route("**/api/auth/list", (route) =>
    json(route, 200, { credentials }),
  );
}

/** Accept any set/clear call and return success. Tests that want to assert
 *  on the body can pass an `inspect` callback. */
export async function mockAuthWriteable(
  page: Page,
  inspect?: (kind: "set" | "clear", body: unknown) => void,
): Promise<void> {
  await page.route("**/api/auth/set", async (route) => {
    if (inspect) {
      try {
        inspect("set", JSON.parse(route.request().postData() ?? "null"));
      } catch {}
    }
    return json(route, 200, { ok: true });
  });
  await page.route("**/api/auth/clear", async (route) => {
    if (inspect) {
      try {
        inspect("clear", JSON.parse(route.request().postData() ?? "null"));
      } catch {}
    }
    return json(route, 200, { ok: true });
  });
}

export async function mockAuthSetRejects(
  page: Page,
  discriminator: string,
): Promise<void> {
  await page.route("**/api/auth/set", (route) =>
    json(route, 400, { error: discriminator }),
  );
}

/** Fail the next N enqueue requests so the comment-author flow renders the
 *  ⚠ retry pip. Used by the pip-lifecycle e2e to drive the error path
 *  without spinning up a broken server. */
export async function mockEnqueueRejects(
  page: Page,
  status = 500,
): Promise<void> {
  await page.route("**/api/interactions/enqueue", (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({ error: "enqueue failed" }),
    }),
  );
}

export async function mockPromptsEmpty(page: Page): Promise<void> {
  await page.route("**/api/prompts", (route) => json(route, 200, { prompts: [] }));
}

/** Mock the stats-consent endpoints. GET returns the given state; POST always
 *  succeeds (204). The default fixture installs `"granted"` so the welcome
 *  banner stays hidden — tests that want the banner pass `"undecided"`. */
export async function mockStatsConsent(
  page: Page,
  consent: "granted" | "undecided" = "granted",
): Promise<void> {
  await page.route("**/api/stats/consent", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ status: 204, body: "" });
    }
    return json(route, 200, { consent });
  });
}

/** Mock POST /api/stats/event — accepts every bump with 204. */
export async function mockStatsEvent(page: Page): Promise<void> {
  await page.route("**/api/stats/event", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
}

export interface PlanFixture {
  headline: string;
  intent?: Array<{ text: string; evidence: Array<{ kind: string }> }>;
}

export async function mockPlanOk(page: Page, fixture: PlanFixture): Promise<void> {
  await page.route("**/api/plan", (route) =>
    json(route, 200, {
      plan: {
        headline: fixture.headline,
        intent: fixture.intent ?? [
          { text: "Mocked intent.", evidence: [{ kind: "description" }] },
        ],
        map: { files: [], symbols: [] },
        entryPoints: [],
      },
    }),
  );
}

export async function mockPlanError(page: Page, status = 502): Promise<void> {
  await page.route("**/api/plan", (route) =>
    route.fulfill({ status, body: "boom" }),
  );
}

/** Simple JS snippet that opens an SSE stream and writes a few chunks. */
export async function mockReviewStream(page: Page, text: string): Promise<void> {
  await page.route("**/api/review", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: [
        `data: ${JSON.stringify({ type: "delta", text })}`,
        ``,
        `data: ${JSON.stringify({ type: "done" })}`,
        ``,
      ].join("\n"),
    }),
  );
}

export async function mockWorktreeList(
  page: Page,
  worktrees: Array<{
    path: string;
    branch: string;
    head: string;
    isMain: boolean;
  }>,
): Promise<void> {
  await page.route("**/api/worktrees/list", (route) =>
    json(route, 200, { worktrees }),
  );
}

export async function mockWorktreeChangeset(
  page: Page,
  cs: {
    diff: string;
    sha?: string;
    subject: string;
    author?: string;
    date?: string;
    branch?: string;
  },
): Promise<void> {
  await page.route("**/api/worktrees/changeset", (route) =>
    json(route, 200, {
      sha: cs.sha ?? "1234567890abcdef1234567890abcdef12345678",
      author: cs.author ?? "tester",
      date: cs.date ?? "2026-05-04T00:00:00Z",
      branch: cs.branch ?? "feat/x",
      ...cs,
    }),
  );
}

/** A unified diff small enough to inline but big enough that parseDiff
 *  returns at least one file with at least one hunk. */
export const SAMPLE_DIFF = [
  "diff --git a/greeting.ts b/greeting.ts",
  "--- a/greeting.ts",
  "+++ b/greeting.ts",
  "@@ -1,1 +1,1 @@",
  "-const greeting = 'hi';",
  "+const greeting = 'hello';",
  "",
].join("\n");
