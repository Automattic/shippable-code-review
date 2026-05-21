# Implementation Notes — Structured Comment Fields

The implementation followed `spec.md` closely. One requirements-vs-spec wording
mismatch was resolved in favour of the spec; the rest are decisions that filled
the spec's open questions.

## Deviations from Spec

### `rationale`-required enforced as a runtime handler check, not zod validation
- **Spec said**: `spec.md` ("Open Questions Resolved" → "Required-field
  enforcement") specifies the check lives **at the MCP handler as a runtime
  check for top-level mode, with the zod field staying `.optional()`**.
  `requirements.md` item 2, written earlier, says the call is "rejected at the
  MCP boundary (zod validation)".
- **Implementation does**: enforces `rationale` with a runtime check in
  `handlePostReviewComment`, alongside the existing `hasParent`/`hasAnchor`
  mode check. The zod field stays `.optional()` (reply mode does not need it).
- **Reason**: a zod `.optional()` field cannot express "required only in
  top-level mode". The runtime check mirrors how `target`/`file`/`lines` are
  already handled. This matches `spec.md`; `requirements.md`'s "(zod
  validation)" parenthetical is superseded.
- **Impact**: none for users — a top-level call without `rationale` is still
  rejected at the MCP boundary with a clear message. The error is returned as
  an `isError` tool result, not a zod schema error.

## Notes

- **Validation error wording** (spec open question): the required-`rationale`
  message is `"A top-level review comment must include a non-empty `rationale`
  explaining why it matters."`
- **`confidence` rendering** (spec open question): chip-only, per the stated
  default. The `AgentRow` border is not tinted by confidence.
- **Pre-existing test updated**: `mcp-server/src/handler.test.ts`'s "POSTs with
  target+file+lines" test predated the feature and posted a top-level comment
  without `rationale`; it was updated to supply `rationale` now that the field
  is required.
- **Empty-value handling**: present-but-empty `suggestedFix` / `rationale` are
  treated as absent at each layer (handler forwards non-empty only; the server
  store and `listReplies` include them only when non-empty). `confidence` is
  carried only when it matches the enum.
- **Process — pre-existing build breakage**: midway through Task 5, `npm run
  build` in `web/` failed on three errors in `state.ts` / `view.ts` left by an
  earlier commit (`b4cfd3d`, which widened `ParsedReplyKey`) — unrelated to this
  feature. The fix landed on `main` (`a9a8ba5 fix(state,view): pass through
  file-anchored thread keys`); the feature branch was rebased onto it and all
  gates then passed. No feature code was changed to work around it.

## Post-ship changes

- **`AgentRow` bypassed for thread heads** (fixed): rebasing onto main's
  inline-interactions change routed every thread *head* through the user-row
  renderer. A top-level agent comment is a head, so it skipped `AgentRow` and
  none of the structured fields rendered. `AgentRow` gained an `asItem` prop so
  a head renders as a `<div>` and a nested reply as a `<li>`; the head branch
  now dispatches agent-authored heads to `AgentRow`.
- **`suggestedFix` renders as prose, not a code block**: `spec.md` and
  `requirements.md` item 6 specified a code block. In practice agents often
  leave a prose-only `suggestedFix`, which looked wrong wrapped in a monospace
  container. It now renders via the `RichText` renderer in a normal
  `.agent-reply__detail-body`, the same as `rationale` — `RichText` still turns
  `` `backtick` `` spans into `<code>` and triple-backtick fences into code
  blocks (language-tagged fences are syntax-highlighted via Shiki; untagged
  ones render plain), so code stays legible. The `suggestedFix` schema
  description tells the agent to backtick its code and language-tag fences.

## Verification

- Quality gates green: `web/` build + lint + 597 tests; `server/` typecheck +
  428 tests; `mcp-server/` typecheck + 44 tests.
- End-to-end wire check against a running server: a top-level
  `POST /api/agent/replies` with all three fields returned `200`, and the
  subsequent `GET` projected `rationale` / `suggestedFix` / `confidence` back
  from `payload_json`; an out-of-enum `confidence` was rejected with `400
  "confidence must be low | medium | high"`. The MCP-side rejection of a
  missing `rationale` and the `AgentRow` rendering are covered by automated
  tests (`handler.test.ts`, `ReplyThread.test.tsx`).
