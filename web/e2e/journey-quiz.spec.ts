// Comprehension-quiz golden path. The dice is forced (window.__shippableQuizRng
// → 0), /api/plan is mocked to return one file-target question, then we walk
// the full lifecycle: Shift+M → quiz appears → answer → reveal → "Got it" →
// reload → counter sticks and the active textarea is gone.

import {
  test,
  expect,
  dismissPlanOverlay,
  expectWorkspaceLoaded,
} from "./_lib/fixtures";
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
  // skipped and the plan auto-fires through to the mocked /api/plan.
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

  // Land in the workspace. With a key configured the plan auto-fires through
  // to the mocked /api/plan, storing the mocked question — no explicit gesture.
  await expect(page.locator(".diff")).toBeVisible({ timeout: 10_000 });

  // Resting state: panel shows up in the sidebar with "Comprehension" header
  // and a 0 / 1 counter (gates on the question being stored).
  const quizPanel = page.locator(".quiz-panel");
  await expect(quizPanel).toBeVisible();
  await expect(quizPanel.getByText("Comprehension")).toBeVisible();
  await expect(quizPanel.locator(".quiz-panel__count")).toHaveText("0 / 1");

  // The plan overlay is open by default and swallows global keys; dismiss it so
  // Shift+M reaches the keymap.
  await dismissPlanOverlay(page);

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
  // Self-eval collapses the panel back to its resting state (a62238c): the
  // reveal and its buttons unmount, and the counter advances to 1 / 1.
  await quizPanel.getByRole("button", { name: "Got it" }).click();
  await expect(quizPanel.getByRole("button", { name: "Got it" })).toHaveCount(0);
  await expect(quizPanel.locator(".quiz-panel__count")).toHaveText("1 / 1");

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

  // Reload via the bare `/` path — NOT `?cs=42`. An explicit `?cs=` URL always
  // loads the fixture fresh (App.tsx resolveBoot → applyPersisted: false);
  // booting `/` falls through to peekSession() and resumes the persisted
  // snapshot, which is how a real reload restores progress. Questions + answers
  // survive, counter reads 1 / 1, and the panel is back in its collapsed
  // resting state (no active textarea).
  await visit("/");
  await expectWorkspaceLoaded(page);
  const quizPanelAfter = page.locator(".quiz-panel");
  await expect(quizPanelAfter).toBeVisible();
  await expect(quizPanelAfter.locator(".quiz-panel__count")).toHaveText("1 / 1");
  await expect(quizPanelAfter.locator(".quiz-panel__textarea")).toHaveCount(0);
});
