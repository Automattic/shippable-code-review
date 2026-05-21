// Comprehension-quiz golden path. The dice is forced (window.__shippableQuizRng
// → 0), /api/plan is mocked to return one file-target question, then we walk
// the full lifecycle: Shift+M → quiz appears → answer → reveal → "Got it" →
// reload → counter sticks and the active textarea is gone.

import { test, expect } from "./_lib/fixtures";
import { mockAuthList } from "./_lib/mocks";

test("comprehension quiz: full submit → reveal → self-eval cycle", async ({
  visit,
  page,
}) => {
  // Force the dice before any app code runs.
  await page.addInitScript(() => {
    (window as unknown as { __shippableQuizRng?: () => number })
      .__shippableQuizRng = () => 0;
  });

  // Pretend the server already has an Anthropic key so the boot panel is
  // skipped and "Send to Claude" goes straight through to the mocked /api/plan.
  await mockAuthList(page, [{ kind: "anthropic" }]);

  // First file in cs-42 is src/types/user.ts — the question targets that path.
  await page.route("**/api/plan", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plan: {
          headline: "test plan",
          intent: [
            { text: "mocked intent", evidence: [{ kind: "description" }] },
          ],
          map: { files: [], symbols: [] },
          entryPoints: [],
        },
        questions: [
          {
            id: "q-test-1",
            type: "q1",
            target: { kind: "file", path: "src/types/user.ts" },
            prompt: "What does this file do?",
            claudeAnswer: "It defines the User and Preferences types.",
          },
        ],
      }),
    }),
  );

  await visit("/?cs=42");

  // Land in the workspace, then send the diff so /api/plan fires and stores
  // the mocked question.
  await expect(page.locator(".diff")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Send to Claude" }).click();

  // Resting state: panel shows up in the sidebar with "Comprehension" header
  // and a 0 / 1 counter.
  const quizPanel = page.locator(".quiz-panel");
  await expect(quizPanel).toBeVisible();
  await expect(quizPanel.getByText("Comprehension")).toBeVisible();
  await expect(quizPanel.locator(".quiz-panel__count")).toHaveText("0 / 1");

  // Cursor lands on the first file (src/types/user.ts). Shift+M triggers
  // MAYBE_TRIGGER_QUIZ with a forced 0 roll → the question becomes active.
  await page.keyboard.press("Shift+M");

  // Active state.
  await expect(quizPanel.getByText("What does this file do?")).toBeVisible();
  const textarea = quizPanel.locator(".quiz-panel__textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill("It loads prefs.");
  await quizPanel.getByRole("button", { name: "Submit" }).click();

  // Reveal: Claude's answer is shown alongside the user's.
  await expect(
    quizPanel.getByText("It defines the User and Preferences types."),
  ).toBeVisible();
  const gotIt = quizPanel.getByRole("button", { name: "Got it" });
  await gotIt.click();
  await expect(gotIt).toHaveAttribute("aria-pressed", "true");

  // The session-save effect is debounced. Wait until the snapshot reflects the
  // self-eval before reloading, otherwise the assertion below races the save.
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("shippable:review:v1");
    if (!raw) return false;
    try {
      const snapshot = JSON.parse(raw) as {
        quiz?: {
          answers?: Record<string, { selfEval?: string | null } | undefined>;
        };
      };
      return snapshot.quiz?.answers?.["q-test-1"]?.selfEval === "got_it";
    } catch {
      return false;
    }
  });

  // Reload: questions + answers survive, counter reads 1 / 1, the active
  // textarea is gone (Reveal stays visible until the next quiz fires).
  await page.reload();
  await expect(page.locator(".diff")).toBeVisible({ timeout: 10_000 });
  const quizPanelAfter = page.locator(".quiz-panel");
  await expect(quizPanelAfter).toBeVisible();
  await expect(quizPanelAfter.locator(".quiz-panel__count")).toHaveText("1 / 1");
  await expect(quizPanelAfter.locator(".quiz-panel__textarea")).toHaveCount(0);
});
