# Comprehension quiz

When the reviewer asks for an AI plan, the server also generates a set of comprehension questions about the diff. The reviewer answers them as they sign off files and as they sign off the changeset; their answer sits next to Claude's expected answer for self-evaluation. The intent is to give a reviewer a low-friction "do I actually understand this?" surface — not to grade them, not to score, not to gate sign-off.

> This plan replaces the first cut (dice + cooldown). Questions are now surfaced **deterministically on sign-off events**, the question count is **sized to the diff (2–10)**, and the cap is **(files in changeset + 1)**. The history doc lives in `git log` under the `feat/quiz-no-dice` branch.

## Goal

What this enables:

- A reviewer who clicked "Send to Claude" gets a set of questions sized to the diff (2–10), distributed across changeset, per-file, per-hunk, and per-symbol scope.
- On **Shift+M (file mark)**, the first unanswered question targeting that file (file/hunk-in-file/symbol-defined-in-file) surfaces. **One** per file mark — any extras for the same file are held.
- On **Shift+S (changeset sign-off)**, every remaining unanswered question surfaces sequentially: the changeset-level question first, then all held-over file/hunk/symbol questions.
- The reviewer types an answer, submits, and sees Claude's expected answer beside their own. Three self-eval buttons ("Got it", "Claude's off", "Missed it") record how it went.
- Per-changeset progress (`2 / 6 answered`) persists across reloads.
- Inside a Shift+S sequence, the panel shows "Question N of M" and auto-advances on Submit / Skip / dismiss.

What this does **not** try to do:

- Grade the reviewer. There is no verdict API call. Match / mismatch is the reviewer's call after they read both answers.
- Gate sign-off. Skipping a quiz during the Shift+S sequence still completes the sign-off. The sign-off lands when Shift+S is hit; the quiz queue is a pass-through, not a gate.
- Q3 ("write a test for this") — deferred to its own design pass because the Code Runner integration is qualitatively different from the prose comparison of Q1/Q2. The data shape leaves `type: "q3"` reserved from day one so the server can start emitting them without a schema bump.

## Framing

The reveal screen reads "check your understanding," not "you got it right / wrong." When the reviewer's answer diverges from Claude's, the prompt is *"here's what Claude thinks — is it right?"* — not *"you missed this."* Claude does not know everything; the feature is about the reviewer building their own confidence in their reading of the diff, not about Claude as authority.

The original dice mechanic was meant to keep the reviewer honest (you can't dodge a random check). The deterministic replacement preserves that property by binding questions to the sign-off gestures the reviewer is already performing — Shift+M to mark a file, Shift+S to mark the changeset. Skipping a quiz is allowed but the prompt appears unavoidably.

## Three question types

| Type | What it asks | Target kinds |
|---|---|---|
| Q1 | "What does this do?" — short prose | `changeset`, `file` |
| Q2 | "Will this break if we send it X?" — prose with a specific input | `hunk`, `symbol` |
| Q3 | "Write a test for this" — code, runs in the Code Runner | *(deferred)* |

The model is asked to bias output toward Q1 at the changeset and file level, and Q2 at the hunk/symbol level — Q2 needs a concrete function or hunk to be answerable from the diff alone.

## Count rubric

The server prompt asks for **2 to 10 questions**, capped at **(files in changeset + 1)**. The model picks the count using a cognitive-load heuristic — not a LOC table.

**Bias the count up** when the diff introduces new public APIs, new abstractions, cross-module flow, or touches risky surfaces (auth, persistence, IPC, parsing user input, schema changes).

**Bias the count down** for repetitive or mechanical diffs: rename swept across many call sites, config bumps, lockfile-only changes, snapshot-test regeneration, formatter sweeps.

**LOC is a tiebreaker only.** A 50-LOC auth change can warrant 5 questions; a 500-LOC sweep-rename can warrant 2.

**Distribution within the count:**
- Exactly **one changeset-level Q1** (the closer at sign-off).
- The rest as file-level Q1s — one per file — plus 0–2 hunk/symbol Q2s for the richest files.
- Floor of 2 guarantees one of each kind, so a quiz lands regardless of which sign-off gesture the reviewer uses.

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

Lives on `ReviewState`. Schema bumps `v: 6 → v: 7`. No migration; per the existing exact-version load policy, a `v: 6` snapshot boots empty.

```ts
type QuizState = {
  questions: Record<string /* changesetId */, Question[]>;
  answers: Record<string /* questionId */, {
    answer: string;
    submittedAt: number;
    selfEval: "got_it" | "claude_wrong" | "missed" | null;
  }>;
  active: {
    questionId: string;
    /** "single" — fired by a file mark; dismiss clears active.
     *  "sequence" — fired by Shift+S; dismiss advances to the next
     *  unanswered question if any. */
    mode: "single" | "sequence";
  } | null;
  asked: string[];     // question ids already surfaced
};
```

Shape notes:

- **No `lastQuizAt`.** Cooldown is gone; the field would always be dead weight.
- **`mode` on `active`.** Two surfacing rules share one panel; the mode tells the reducer how to behave on Submit/Skip/SelfEval-dismiss. It's load-bearing for the auto-advance.
- **Keyed by `changesetId`.** Same trade-off as before: stale targets get dropped by the evidence validator on hydration; re-fetch via "Send to Claude".
- **`asked` semantics unchanged.** A question seen once is not surfaced again.
- **`selfEval` can stay `null`.** Self-eval is a separate action; the answer survives without it.

## Server changes — `server/src/plan.ts`

The schema is unchanged. The system prompt's "## Comprehension questions" section rewrites:

- Band: **2 to 10** (was 3 to 8).
- Hard cap: **total ≤ (files in changeset + 1)**, instructed in prose.
- Cognitive-load rubric in prose (per "Count rubric" above).
- Distribution: exactly one changeset Q1, the rest file-level Q1s and 0–2 hunk/symbol Q2s.
- Negative list unchanged: no out-of-diff dependencies, no stylistic prompts, nothing answerable from the file list alone.

The plan call's `assemblePlan` validator stays as-is — it already drops questions whose `target` doesn't resolve in the StructureMap.

### Cache impact

The system prompt grows by ~150 tokens net (new rubric prose, no schema change). One-time cache prefix shift; negligible going forward.

## Web flow

### Generation

`usePlan` continues to dispatch `STORE_QUESTIONS` on resolve. No change.

### Reducer actions

`MAYBE_TRIGGER_QUIZ` is **renamed and reshaped** to `TRIGGER_QUIZ_FOR_FILE`. It no longer takes `now` or `roll`:

```ts
| { type: "TRIGGER_QUIZ_FOR_FILE"; changesetId: string; fileId: string }
| { type: "TRIGGER_QUIZ_FOR_CHANGESET"; changesetId: string }
| { type: "DISMISS_QUIZ" }
| { type: "SUBMIT_QUIZ_ANSWER"; questionId: string; answer: string; now: number }
| { type: "SET_QUIZ_SELF_EVAL"; questionId: string; selfEval: QuizSelfEval }
| { type: "CLEAR_QUIZ_ACTIVE" }
```

`DISMISS_QUIZ` drops `now` — no `lastQuizAt` to update.

The reducer stays pure: clock is supplied to `SUBMIT_QUIZ_ANSWER` only.

### Surfacing rules

**`TRIGGER_QUIZ_FOR_FILE` (Shift+M off → on, file f):**
- If `active` set: no-op (one at a time).
- If no questions for the changeset: no-op.
- Pick the first unanswered question whose target is in f (file f, hunk in f, or symbol defined in f), excluding `asked`. If none, no-op.
- Set `active = { questionId, mode: "single" }`.

**`TRIGGER_QUIZ_FOR_CHANGESET` (Shift+S off → on):**
- If `active` set: no-op.
- Pick the first unanswered question, prioritizing changeset-level targets then file/hunk/symbol. Excludes `asked`. If none, no-op.
- Set `active = { questionId, mode: "sequence" }`.

**Dismiss / Skip / SelfEval-then-close in `mode: "single"`:** clear `active`.

**Dismiss / Skip / SelfEval-then-close in `mode: "sequence"`:** find the next unanswered question (same priority as above); if found, set `active = { questionId, mode: "sequence" }`; else clear `active`.

Off-transition (un-signoff) does **not** trigger.

`asked` is updated on Submit and on Dismiss/Skip, just as before.

### Submit / reveal

1. Reviewer types `answer`, hits Submit → `SUBMIT_QUIZ_ANSWER` stores it, adds to `asked`, leaves `active` set with the **same mode**.
2. Claude's answer reveals beside the reviewer's.
3. Reviewer picks "Got it", "Claude's off", or "Missed it" → `SET_QUIZ_SELF_EVAL` records the bucket. The bucket can stay `null` if the reviewer never picks.
4. A `DISMISS_QUIZ` (Skip / Esc / panel close) either clears `active` (single mode) or advances to the next (sequence mode).

Submit is disabled until the textarea has at least one non-whitespace character.

### Dispatcher wiring

`dispatchToggleFileReviewedWithQuiz` is renamed to `dispatchToggleFileReviewed` and simplified:

```ts
function dispatchToggleFileReviewed(
  dispatch: Dispatch<Action>,
  changesetId: string,
  fileId: string,
  wasReviewed: boolean,
) {
  dispatch({ type: "TOGGLE_FILE_REVIEWED", fileId });
  if (wasReviewed) return; // only on off → on
  dispatch({ type: "TRIGGER_QUIZ_FOR_FILE", changesetId, fileId });
}
```

The changeset sign-off path adds a peer dispatcher that fires after the existing `TOGGLE_CHANGESET_REVIEWED`:

```ts
function dispatchToggleChangesetReviewedWithQuiz(
  dispatch: Dispatch<Action>,
  changesetId: string,
  wasReviewed: boolean,
) {
  dispatch({ type: "TOGGLE_CHANGESET_REVIEWED", changesetId });
  if (wasReviewed) return; // only on off → on
  dispatch({ type: "TRIGGER_QUIZ_FOR_CHANGESET", changesetId });
}
```

The PRNG seam (`__shippableQuizRng`) and `QUIZ_DICE_THRESHOLD` / `QUIZ_COOLDOWN_MS` constants are removed.

## UI

QuizPanel keeps the expand-to-list affordance (merged in `feat/quiz-panel-history`):
- Clickable header with chevron and `N / M`.
- Inline list of answered + unanswered rows; click an answered row to re-open its reveal.
- Unanswered rows show only the target label (no prompt — no spoilers).

Two additions:

- **Sequence indicator.** When `active.mode === "sequence"`, render "Question N of M" inside the panel body, computed from `asked ∪ {active.questionId}` over the total question list for the changeset. Disappears outside a sequence.
- **Auto-advance.** Submit → reveal → self-eval → Esc (or Skip) inside a sequence dispatches `DISMISS_QUIZ` which advances; outside a sequence, dismiss just closes. No UI change in the panel for this — the reducer does the work.

## Error handling

- **Plan call fails entirely** → no questions stored. Quiz panel renders nothing. Same as before.
- **Plan succeeds, `questions` empty or all invalidated** → no panel. Same as before.
- **`TRIGGER_QUIZ_FOR_FILE` fires for a file with no eligible Q** → silent no-op.
- **`TRIGGER_QUIZ_FOR_CHANGESET` fires with everything answered** → silent no-op (Shift+S still completes its sign-off).
- **Reviewer Esc-dismisses mid-sequence** → `DISMISS_QUIZ` advances to next. If the reviewer wants out of the sequence entirely, repeat Esc until exhausted, or unmark the changeset. (The latter is *not* a no-op for `reviewedChangesets` but doesn't clear `asked`.)
- **Reviewer switches changesets mid-quiz** → `active` clears with the rest of the per-changeset transient state. Draft answer is lost. Same as before.
- **`v: 7` snapshot present** → load. Anything else (`v: 6`, `v: 5`, missing, corrupt) → boot empty.

## Testing

Per `docs/plans/test-strategy.md`: real reducer, real persist, no mocks of the system under test.

**Reducer (unit, vitest):**
- `TRIGGER_QUIZ_FOR_FILE` no-ops with no questions / no eligible / active already set.
- `TRIGGER_QUIZ_FOR_FILE` sets `active = { questionId, mode: "single" }` to the head of the eligible queue.
- `TRIGGER_QUIZ_FOR_FILE` after one file mark surfaces only the head — a second eligible Q for the same file stays unsurfaced.
- `TRIGGER_QUIZ_FOR_CHANGESET` no-ops with everything answered or active already set.
- `TRIGGER_QUIZ_FOR_CHANGESET` prioritizes changeset-level Q, then falls back to held-over file/hunk/symbol Qs.
- `DISMISS_QUIZ` in `mode: "single"` clears `active`.
- `DISMISS_QUIZ` in `mode: "sequence"` with more unanswered → advances; with none → clears.
- `SUBMIT_QUIZ_ANSWER` → `SET_QUIZ_SELF_EVAL` → `DISMISS_QUIZ` round-trip in both modes.

**Eligibility (unit, vitest):** `eligibleQuestionsForFile` and the new `pickNextForChangeset` helper, exercised against synthetic changesets.

**Persist (unit, vitest):** v:7 round-trip; v:6 snapshot rejected and boots empty; `active.mode` survives serialization.

**Integration (vitest):** real reducer + persist. Generate questions, mark a file, assert one surfaces with `mode: "single"`; dismiss; mark again, assert nothing surfaces (asked). Hit changeset sign-off, assert sequence walks through remaining Qs.

**E2E (Playwright):** update existing golden path to:
1. Mock `/api/plan` with 4 questions (1 changeset + 2 file + 1 hunk).
2. Mark file A → one Q fires deterministically. Submit, self-eval.
3. Mark file B → next file-level Q fires.
4. Hit Shift+S → sequence fires: changeset Q first, then the leftover hunk Q.
5. Reload; assert counter is `4 / 4`, panel collapsed.

**Anti-patterns to avoid** (per the test-strategy doc):
- Don't mock the reducer or its actions.
- Don't mock the persist module — use the real one.
- No clock injection needed for trigger logic now that the dice/cooldown are gone. `Date.now()` is only consulted in `SUBMIT_QUIZ_ANSWER` for the answer's timestamp.

## Out of scope (this cut)

- **Q3 — "write a test for this".** Same posture as the original plan; reserved type, deferred design.
- **Per-reviewer history across changesets.** A future "how did I do overall" aggregate is plausible but adds scope without near-term need.
- **Sequence pacing.** No delay or animation between consecutive prompts in a Shift+S sequence; each replaces the previous on Submit/Skip.
- **Forced ordering by file location.** Within a target kind, questions surface in the order the server emitted them. We do not re-sort by diff position.

## Files of interest

- `server/src/plan.ts` — SYSTEM_PROMPT "## Comprehension questions" section: new band, cap, rubric.
- `web/src/types.ts` — `QuizState`: remove `lastQuizAt`, extend `active` with `mode`.
- `web/src/quiz.ts` — remove `pickRandomQuestion`. Add `pickNextForFile` (deterministic head over eligible) and `pickNextForChangeset` (prioritizes changeset target, falls back to leftovers).
- `web/src/state.ts` — drop `QUIZ_COOLDOWN_MS` / `QUIZ_DICE_THRESHOLD`; replace `MAYBE_TRIGGER_QUIZ` with `TRIGGER_QUIZ_FOR_FILE` and `TRIGGER_QUIZ_FOR_CHANGESET`; teach `DISMISS_QUIZ` / `SUBMIT_QUIZ_ANSWER` to honor `mode`.
- `web/src/persist.ts` — schema bump v:6 → v:7; drop `lastQuizAt` validation; validate `active.mode`.
- `web/src/components/ReviewWorkspace.tsx` — replace `dispatchToggleFileReviewedWithQuiz`; add `dispatchToggleChangesetReviewedWithQuiz`. Remove PRNG seam.
- `web/src/components/QuizPanel.tsx` — add "Question N of M" indicator when `active.mode === "sequence"`.
- `web/src/quiz.test.ts`, `web/src/state.test.ts`, `web/src/persist.test.ts` — update for new actions / shape; drop dice/cooldown tests.
