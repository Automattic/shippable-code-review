# Implementation Plan: Structured Comment Fields

Based on: docs/sdd/structured-comment-fields/spec.md

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status: ✅ Complete — all 8 tasks done.** Each was implemented TDD-first and
committed; quality gates green across `web/`, `server/`, `mcp-server/`. See
`implementation-notes.md` for deviations.

## Tasks

### Task 1: MCP handler — accept and validate the three fields
- **Files**: `mcp-server/src/handler.ts`, `mcp-server/src/handler.test.ts`
- **Do**:
  1. Write failing tests in `handler.test.ts`: (a) a top-level
     `handlePostReviewComment` call with no `rationale` returns an `isError`
     result with a clear message; (b) a top-level call with
     `rationale`/`suggestedFix`/`confidence` set forwards all three as keys in
     the `/api/agent/replies` JSON body; (c) a reply-mode call ignores the
     three fields (they do not appear in the posted payload).
  2. Verify the tests fail.
  3. Extend `PostCommentInput` with optional `rationale?: string`,
     `suggestedFix?: string`, `confidence?: "low" | "medium" | "high"`.
  4. In `handlePostReviewComment`, after the `hasParent`/`hasAnchor` mode
     check: when top-level mode, reject with `errorResult(...)` if `rationale`
     is missing or empty. Add present fields to the top-level branch of the
     `payload` record; do not add them in reply mode.
  5. Verify the tests pass.
  6. Commit: `feat(mcp): accept rationale/suggestedFix/confidence on top-level comments`
- **Verify**: `npm test` and `npm run typecheck` pass in `mcp-server/`.
- **Depends on**: none

### Task 2: MCP inputSchema and tool description
- **Files**: `mcp-server/src/index.ts`
- **Do**:
  1. Add three optional fields to the `shippable_post_review_comment`
     `inputSchema`: `rationale` (`z.string().optional()`), `suggestedFix`
     (`z.string().optional()`), `confidence`
     (`z.enum(["low","medium","high"]).optional()`). Give each a `.describe()`
     string that prompts the agent — `rationale` notes it is required for
     top-level posts; `suggestedFix` notes free-form code/text; `confidence`
     explains the three levels.
  2. Update `POST_COMMENT_DESCRIPTION` so the top-level-mode paragraph names
     the three fields and states `rationale` is required.
  3. Verify: `npm run build` and `npm run typecheck` pass in `mcp-server/`;
     the schema matches `PostCommentInput` from Task 1.
  4. Commit: `feat(mcp): document structured comment fields in the tool schema`
- **Depends on**: Task 1

### Task 3: Server agent-queue — persist and project the fields
- **Files**: `server/src/agent-queue.ts`, `server/src/agent-queue.test.ts`
- **Do**:
  1. Write a failing test: a `postTopLevel` call with
     `rationale`/`suggestedFix`/`confidence` set, then `listReplies`, returns a
     top-level wire item carrying all three fields.
  2. Verify it fails.
  3. Add the three fields to `postTopLevel`'s `payload` argument and write them
     into the `payload` bag passed to `postAgentInteraction`. Add `rationale:
     string`, `suggestedFix?: string`, `confidence?: "low"|"medium"|"high"` to
     the top-level variant of `AgentReplyWireItem`. In `listReplies`, read the
     fields from `row.payload` for the top-level branch.
  4. Verify the test passes.
  5. Commit: `feat(server): carry structured fields through the agent channel`
- **Verify**: `npm test` and `npm run typecheck` pass in `server/`.
- **Depends on**: none

### Task 4: Server endpoint — accept the fields on `/api/agent/replies`
- **Files**: `server/src/index.ts`, `server/src/index.test.ts`
- **Do**:
  1. Write a failing integration test (real `createApp()` in-process): a
     top-level `POST /api/agent/replies` with the three fields persists them,
     and a subsequent `GET` returns them; an out-of-enum `confidence` value is
     rejected.
  2. Verify it fails.
  3. In the `/api/agent/replies` handler, read `rationale`/`suggestedFix`/
     `confidence` from the body for top-level posts, light-validate
     `confidence` against the enum, and pass them through to `postTopLevel`.
     Reply-mode posts are untouched. Trust the MCP boundary for the
     `rationale`-required rule (no server re-check).
  4. Verify the test passes.
  5. Commit: `feat(server): accept structured comment fields on the replies endpoint`
- **Verify**: `npm test` and `npm run typecheck` pass in `server/`.
- **Depends on**: Task 3

### Task 5: Web state and types — carry the fields onto `Interaction`
- **Files**: `web/src/types.ts`, `web/src/state.ts`, `web/src/state.test.ts`
- **Do**:
  1. Write a failing test in `state.test.ts`: merging a polled top-level agent
     reply that carries `rationale`/`suggestedFix`/`confidence` produces an
     `Interaction` with those fields set.
  2. Verify it fails.
  3. Add optional `rationale`/`suggestedFix`/`confidence` to the `Interaction`
     type in `types.ts` (with a `Confidence` union type). Add the three fields
     to the top-level variant of `PolledAgentReply` in `state.ts`, and carry
     them through the merge that projects polled replies onto `Interaction`.
  4. Verify the test passes.
  5. Commit: `feat(web): carry structured comment fields into review state`
- **Verify**: `npm run build`, `npm run lint`, `npm test` pass in `web/`.
- **Depends on**: Task 4

### Task 6: AgentRow rendering and styling
- **Files**: `web/src/components/ReplyThread.tsx`, `web/src/components/ReplyThread.css`
- **Do**:
  1. Write a failing component test: an `AgentRow` for a top-level interaction
     with `confidence` set renders a confidence chip; with `rationale` /
     `suggestedFix` set it renders collapsible sections (collapsed by default);
     an interaction without the fields renders none of them.
  2. Verify it fails.
  3. In `AgentRow`, render the `confidence` chip in the head row beside the
     intent glyph/author. Render `rationale` and `suggestedFix` as
     `<details>`/`<summary>` collapsible sections below the body — `rationale`
     via `RichText`, `suggestedFix` in a code block. All three render only when
     present. Add chip (per-level color) and collapsible-section styles to
     `ReplyThread.css`.
  4. Verify the test passes.
  5. Commit: `feat(web): render structured comment fields in AgentRow`
- **Verify**: `npm run build`, `npm run lint`, `npm test` pass in `web/`.
- **Depends on**: Task 5

### Task 7: Documentation
- **Files**: `docs/` (the concept/feature note covering agent comments or the
  MCP tool — locate the existing one, e.g. under `docs/concepts/` or
  `docs/features/`)
- **Do**:
  1. Add a short section describing the three structured fields: what each is,
     that `rationale` is required for top-level agent comments, and that they
     render collapsed in `AgentRow`.
  2. Verify: the note is accurate against the shipped behavior.
  3. Commit: `docs: document structured comment fields`
- **Depends on**: Task 6

### Task 8: Full verification
- **Files**: none (verification only)
- **Do**:
  1. Run quality gates: `npm run build` and `npm run lint` in `web/`;
     `npm run typecheck` in `server/`; `npm test` in `web/`, `server/`, and
     `mcp-server/`; `npm run typecheck` in `mcp-server/`.
  2. Manual end-to-end check in the browser: post a top-level agent comment
     with all three fields (via the MCP tool or a direct `/api/agent/replies`
     call), confirm it renders in `AgentRow` with a confidence chip and
     collapsed `rationale`/`suggestedFix` sections that expand on click, and
     confirm a comment without the fields renders unchanged.
  3. Confirm a top-level MCP call missing `rationale` is rejected.
- **Verify**: all gates green; end-to-end behavior matches the spec.
- **Depends on**: Task 7
