# Comprehension quiz

When the reviewer asks for an AI plan, the server also generates a small set of comprehension questions about the diff. The reviewer answers them as they sign off files; their answer sits next to Claude's expected answer for self-evaluation. The intent is to give a reviewer a low-friction "do I actually understand this?" surface — not to grade them, not to score, not to gate sign-off.

## Goal

What this enables:

- A reviewer who clicked "Send to Claude" gets a handful of questions for the changeset, ranging across whole-changeset, per-file, per-hunk, and per-symbol scope.
- On Shift+M (file mark), a 1/10 dice roll surfaces one randomly-picked question targeting that file (or any hunk/symbol in it). A cooldown suppresses immediate repeat prompts.
- When the future top-level sign-off feature lands, marking a whole changeset always surfaces one changeset-level question.
- The reviewer types an answer, submits, and sees Claude's expected answer beside their own. Three self-eval buttons ("Got it", "Claude's off", "Missed it") record how it went.
- Per-changeset progress (`2 / 6 answered`) persists across reloads.

What this does **not** try to do:

- Grade the reviewer. There is no verdict API call. Match / mismatch is the reviewer's call after they read both answers.
- Gate sign-off. Skipping a quiz still marks the file reviewed. The mark already landed when the dice was rolled.
- Q3 ("write a test for this") — deferred to its own design pass because the Code Runner integration is qualitatively different from the prose comparison of Q1/Q2. The data shape leaves `type: "q3"` reserved from day one so the server can start emitting them without a schema bump.

## Framing

The reveal screen reads "check your understanding," not "you got it right / wrong." When the reviewer's answer diverges from Claude's, the prompt is *"here's what Claude thinks — is it right?"* — not *"you missed this."* Claude does not know everything; the feature is about the reviewer building their own confidence in their reading of the diff, not about Claude as authority.

## Three question types

| Type | What it asks | Target kinds (this cut) |
|---|---|---|
| Q1 | "What does this do?" — short prose | `changeset`, `file` |
| Q2 | "Will this break if we send it X?" — prose with a specific input | `hunk`, `symbol` |
| Q3 | "Write a test for this" — code, runs in the Code Runner | *(deferred)* |

The model is asked to bias output toward Q1 at the changeset and file level, and Q2 at the hunk/symbol level — Q2 needs a concrete function or hunk to be answerable from the diff alone.

## Data model

### Question (server-generated, ride along with the plan)

```ts
type QuestionTarget =
  | { kind: "changeset" }
  | { kind: "file"; path: string }
  | { kind: "hunk"; hunkId: string }
  | { kind: "symbol"; name: string; definedIn: string };

type Question = {
  id: string;                 // stable, model-generated; validated unique per response
  type: "q1" | "q2" | "q3";   // q3 reserved; not generated yet, UI ignores any that appear
  target: QuestionTarget;     // mirrors EvidenceRef; same validator path drops bad refs
  prompt: string;             // shown to the reviewer
  claudeAnswer: string;       // hidden until reveal
};
```

`QuestionTarget` deliberately mirrors `EvidenceRef`. The same evidence validator that drops hallucinated claim refs drops hallucinated question targets — one code path, one rule.

### Persisted reviewer state

Lives on `ReviewState`. Schema bumps `v: 4 → v: 5`. No migration; per the existing exact-version load policy, a `v: 4` snapshot boots empty.

```ts
type QuizState = {
  questions: Record<string /* changesetId */, Question[]>;
  answers: Record<string /* questionId */, {
    answer: string;
    submittedAt: number;
    selfEval: "got_it" | "claude_wrong" | "missed" | null;
  }>;
  active: { questionId: string } | null;   // currently surfaced quiz
  lastQuizAt: number | null;
  asked: string[];                          // question ids already surfaced
};
```

Design notes on the shape:

- **Keyed by `changesetId`, not by review token.** Questions reference files/hunks/symbols by id. When the diff content shifts (force-push, dirty-tree edit), some refs may go stale; on hydration the evidence validator drops stale questions. Re-fetch is one "Send to Claude" click away. The same trade-off applies to the existing plan claims.
- **`asked` is a flat id list, not partitioned per type.** A question seen once is not surfaced again, regardless of type or trigger.
- **`selfEval` can be `null` after submit.** The reveal captures the answer immediately; picking a self-eval bucket is a separate action and may never happen. The answer record survives either way.

### Cooldown

```ts
const COOLDOWN_MS = 10 * 60 * 1000;  // 10 minutes
```

`Date.now() - lastQuizAt < COOLDOWN_MS` blocks the trigger. Skipping a quiz still updates `lastQuizAt` — a skip is "I just saw a quiz prompt," and stacking another immediately is exactly the pile-up we're avoiding. `reset review` clears `lastQuizAt` along with the rest of `ReviewState`.

## Server changes — `server/src/plan.ts`

Extend the existing `PlanResponseSchema`:

```ts
const QuestionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changeset") }),
  z.object({ kind: z.literal("file"), path: z.string() }),
  z.object({ kind: z.literal("hunk"), hunkId: z.string() }),
  z.object({ kind: z.literal("symbol"), name: z.string(), definedIn: z.string() }),
]);

const QuestionSchema = z.object({
  id: z.string(),
  type: z.enum(["q1", "q2"]),     // q3 reserved on the web side
  target: QuestionTargetSchema,
  prompt: z.string(),
  claudeAnswer: z.string(),
});

const PlanResponseSchema = z.object({
  intent: z.array(ClaimSchema),
  entryPoints: z.array(EntryPointSchema),
  questions: z.array(QuestionSchema),  // NEW
});
```

`SYSTEM_PROMPT` grows a "## Comprehension questions" section:

- Asks for 3–8 questions distributed across the changeset.
- Biases distribution: roughly 1 changeset-level Q1, the rest split between file-level Q1 and hunk/symbol-level Q2.
- Requires every `target` to resolve in the same `StructureMap` that claim evidence resolves against.
- States the framing — "the reviewer will compare their answer to yours, then self-evaluate" — so the model writes `claudeAnswer` as a reviewer would, not as documentation.
- For Q2: requires enough specifics (input value, expected behavior) that "would this break?" is answerable from the diff alone.

`assemblePlan` gets a third validator pass mirroring the existing claim/entry-point filter: drop any question whose `target` doesn't resolve. If that leaves zero questions, the plan still returns — questions are best-effort, not a failure mode for the plan call.

### Cache impact

The system prompt grows by ~500 tokens. Anthropic's ephemeral cache prefix shifts, so the first request after deploy is a full miss; subsequent calls repopulate. Per-call token cost rises by ~700 tokens (system + output). Negligible against the diff payload.

## Web flow

### Generation

`usePlan.ts` keeps owning the `/api/plan` lifecycle. The result interface grows:

```ts
export interface UsePlanResult {
  plan: ReviewPlan;
  questions: Question[];          // empty when status is "idle" or "fallback"
  status: PlanStatus;
  // ...
}
```

When the AI plan resolves, the hook also dispatches `STORE_QUESTIONS` so questions outlive the hook (which resets on changeset switch).

### Reducer actions

New actions in `web/src/state.ts`:

```ts
| { type: "STORE_QUESTIONS"; changesetId: string; questions: Question[] }
| { type: "MAYBE_TRIGGER_QUIZ"; changesetId: string; fileId: string;
    now: number; roll: number }
| { type: "DISMISS_QUIZ"; now: number }
| { type: "SUBMIT_QUIZ_ANSWER"; questionId: string; answer: string; now: number }
| { type: "SET_QUIZ_SELF_EVAL"; questionId: string;
    selfEval: "got_it" | "claude_wrong" | "missed" }
```

The reducer stays pure: `now` and `roll` are passed in by the dispatcher, not read inside the reducer.

### Trigger pipeline

```
TOGGLE_FILE_REVIEWED (existing) → dispatcher also fires MAYBE_TRIGGER_QUIZ
                                  with Date.now() and Math.random()
                                  └─ no questions for this changeset → no-op
                                     within cooldown → no-op
                                     eligible = questions where
                                       target.kind === "file" && path === this
                                       || target.kind === "hunk" && hunkId in this file
                                       || target.kind === "symbol" && definedIn === this
                                     minus questions in `asked`
                                     eligible empty → no-op
                                     roll >= 0.1 → no-op (dice miss)
                                     else: set state.quiz.active
```

The dispatcher (a thin wrapper around `dispatch` invoked from the keyboard handler and command palette) reads the clock and the PRNG. Tests inject both.

Off-transition (un-signoff) does **not** trigger. Changeset-target questions are not eligible on file-mark — they wait for the changeset-mark trigger.

`asked` is updated on Submit and on Dismiss (Skip / Esc). It is **not** updated when `active` clears for other reasons — e.g. switching changesets mid-quiz — so the question stays eligible if the reviewer returns.

### Submit / reveal

1. Reviewer types `answer`, hits Submit → `SUBMIT_QUIZ_ANSWER` stores it, updates `lastQuizAt`, adds to `asked`, leaves `active` set (reveal state).
2. Claude's answer reveals beside the reviewer's.
3. Reviewer picks "Got it", "Claude's off", or "Missed it" → `SET_QUIZ_SELF_EVAL` records the bucket. The bucket can stay `null` if the reviewer never picks.
4. A subsequent `DISMISS_QUIZ` (or the next quiz triggering) clears `active`.

Submit is disabled until the textarea has at least one non-whitespace character.

### Changeset-mark trigger (deferred until top-level sign-off lands)

When the top-level changeset sign-off feature lands, it dispatches `MAYBE_TRIGGER_QUIZ` filtered to `target.kind === "changeset"` with no dice roll — changeset-mark is a stronger gesture than file-mark, and there's only one such event per changeset visit. Same reducer, same panel. This plan reserves the data shape but does not implement the trigger.

## UI

The quiz panel slots into the left `Sidebar` (`web/src/components/Sidebar.tsx`) as a new `<section className="panel">` at the **top**, above `PromptRunsPanel`. The existing stack pattern (panel → panel) carries over.

**Resting state** (questions exist, no active quiz): a compact section with header "Comprehension" and a counter like `2 / 6 answered`. Body collapsed.

**Active state** (a quiz just triggered): the section expands in place. Target chip ("About: src/utils/storage.ts" / "About: this changeset"), the prompt, a multiline textarea, Submit and Skip buttons. No overlay, no layout shift outside the sidebar.

**Reveal state** (after Submit): target chip, prompt, reviewer's answer in a quote block, Claude's answer in a second quote block, then the three self-eval buttons.

**Sidebar hidden when a quiz triggers:** auto-show the sidebar (`setShowSidebar(true)`) on first quiz of the session. Doing it every time would override the reviewer's preference; once per session is enough of a nudge.

**One at a time:** if a quiz is already active and another trigger fires, the second is dropped. The cooldown should make this rare; the safety check is in the reducer.

**Esc dismisses** (fires `DISMISS_QUIZ`). No other quiz-specific shortcuts.

## Error handling

- **Plan call fails entirely** → `usePlan` lands in `status: "fallback"`. No questions stored. Quiz panel renders nothing. Retrying "Send to Claude" can populate questions on success.
- **Plan succeeds, `questions` empty or all invalidated** → no panel. Same posture as a plan with zero entry points.
- **Some questions invalidate, others survive** → keep the survivors. Same posture as the existing claim/entry-point filter.
- **localStorage full or unavailable** → existing persist failure path. No quiz-specific handling.
- **Trigger fires before `STORE_QUESTIONS` lands** → reducer exits before the dice roll. Silent no-op.
- **Reviewer switches changesets mid-quiz** → `active` clears with the rest of the per-changeset transient state. Draft answer is lost. Not in scope to autosave.
- **`v: 5` snapshot present** → load. `v: 4` or missing → boot empty (existing exact-version policy).

## Privacy and cost

Already covered by the plan opt-in. "Send to Claude" is the consent moment; questions ride along on that same trip. No additional opt-in, no additional disclosure surface. The feature doc (`docs/features/comprehension-quiz.md`, to be written) calls this out.

## Testing

Per `docs/plans/test-strategy.md`: real reducer, real persist, no mocks of the system under test.

**Reducer (unit, vitest):**

- `STORE_QUESTIONS` lands questions on the correct changeset key.
- `MAYBE_TRIGGER_QUIZ` with no questions → no change.
- `MAYBE_TRIGGER_QUIZ` within cooldown → no change.
- `MAYBE_TRIGGER_QUIZ` with all eligible in `asked` → no change.
- `MAYBE_TRIGGER_QUIZ` past cooldown with `roll = 0.05` → `active` set.
- `MAYBE_TRIGGER_QUIZ` past cooldown with `roll = 0.5` → no change.
- `DISMISS_QUIZ` updates `lastQuizAt`, adds the question id to `asked`, clears `active`.
- `SUBMIT_QUIZ_ANSWER` stores the answer, updates `lastQuizAt`, adds to `asked`, keeps `active`.
- `SET_QUIZ_SELF_EVAL` writes the bucket without touching `active`.

**Evidence validator (unit, vitest):** synthetic ChangeSet + StructureMap, `PlanResponse.questions` mixing resolvable and unresolvable targets; assert which survive.

**Integration (vitest):** real `ReviewState` reducer, real persist round-trip. Hydrate with stored questions, dispatch through the dispatcher wrapper with controlled `rng`, walk submit → reveal → self-eval, assert the persist serializer produces a `v: 5` snapshot that hydrates back.

**E2E (Playwright):** one golden-path journey in `web/e2e/`:

1. Load a fixture changeset.
2. Send to Claude (mock the `/api/plan` response with 3 questions).
3. Mark a file as reviewed with the dice forced to land via a test-mode dispatcher seam (gated on `import.meta.env.MODE === "test"`).
4. Assert the panel opens, type an answer, submit, reveal, click "Got it."
5. Reload the page; assert counter says `1 / 3`, panel collapsed.

**Anti-patterns to avoid** (per the test-strategy doc):

- Don't mock the reducer or its actions.
- Don't mock the persist module — use the real one.
- Don't mock `Math.random` or `Date.now` globally; inject through the dispatcher wrapper.

## Out of scope (this cut)

- **Q3 — "write a test for this".** Code Runner embedding, input-slot detection, "did it run" signal, and rendering Claude's example test alongside the reviewer's are different concerns from the prose flow. Own design pass. The data shape (`type: "q3"`) is reserved so the server can start emitting them without breaking persistence.
- **Changeset-mark trigger UI.** The top-level sign-off feature is not yet built. This plan reserves the data shape and reducer behavior; the trigger wiring lands with that feature.
- **Cooldown configurability.** Constant in code. Not user-tunable.
- **Per-reviewer history across changesets.** A future "how did I do overall" aggregate is plausible but adds scope without near-term need.
- **Multiple AI providers for questions.** Same single-provider posture as the plan. When the plan extends to multi-provider, questions extend with it for free.
- **Grading API.** No verdict call. Reviewer self-evaluates.

## Files of interest

- `server/src/plan.ts` — `PlanResponseSchema` extension, prompt addendum, `assemblePlan` validator extension.
- `web/src/types.ts` — `Question`, `QuestionTarget` shared between front and back; `QuizState` for the reducer.
- `web/src/state.ts` — new actions, reducer cases, `dispatchToggleFileReviewed` wrapper that reads clock/PRNG.
- `web/src/persist.ts` — schema bump `v: 4 → v: 5`, serializer for `quiz` slice.
- `web/src/usePlan.ts` — surface `questions` on the hook result, dispatch `STORE_QUESTIONS` on resolve.
- `web/src/components/Sidebar.tsx` — new `<QuizPanel>` section at the top of the stack.
- `web/src/components/QuizPanel.tsx` (new) — resting / active / reveal states.
- `web/src/components/ReviewWorkspace.tsx` — wire the dispatcher wrapper into the keyboard handler and command palette.
