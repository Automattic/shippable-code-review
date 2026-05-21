# Structured Comment Fields — Requirements

## Goal

Make agent-authored review comments self-explanatory at a glance, so a human
reviewer rarely has to re-prompt the agent for "why?" or "how would you fix
it?". Achieved flow-agnostically by extending the one chokepoint every review
skill passes through — the `shippable_post_review_comment` MCP tool — rather
than relying on any particular review skill to volunteer richer prose.

## Requirements

1. Add three fields to `shippable_post_review_comment`'s `inputSchema`, applied
   to **top-level mode only** (`target: "line" | "block"`):
   - `rationale` — **required** in top-level mode. Why the comment matters.
   - `suggestedFix` — optional. A free-form code/text string.
   - `confidence` — optional. Enum `"low" | "medium" | "high"`.
2. A top-level `shippable_post_review_comment` call that omits `rationale` is
   rejected at the MCP boundary (zod validation) with a clear error message.
3. The `POST_COMMENT_DESCRIPTION` prose is updated so the agent understands the
   new fields and when to supply them.
4. The new fields travel over the wire to the local server's
   `/api/agent/replies` endpoint and are accepted there for top-level posts.
5. The fields persist in the `interactions` table's `payload_json` bag — no DB
   schema migration, no new hot columns.
6. `AgentRow` renders the fields collapsed by default: a glance shows body +
   intent glyph + a `confidence` chip; `rationale` and `suggestedFix` are
   expandable sections. `suggestedFix` renders in a code block.
7. Reply-mode posts (`accept` / `reject` / `ack`) carry none of the new fields
   and are unchanged end to end.
8. Agent interactions stored without the new fields — pre-existing rows and all
   reply-mode rows — render exactly as they do today.

## Constraints

- The new fields apply only to the agent → human direction (top-level
  agent-authored comments). The MCP tool is the flow-agnostic lever; no review
  skill needs to cooperate.
- Storage must use `payload_json`; no `ALTER TABLE`, no `CURRENT_VERSION` bump.
- Keep the added schema surface small — over-structuring fights
  flow-agnosticism across diverse review skills. Three fields, one required.
- `confidence` is a three-value enum, not a numeric score — numeric scores
  invite false precision in a prototype.
- Quality gates: `npm run build` and `npm run lint` in `web/` pass;
  `npm run typecheck` in `server/` passes; MCP-server `npm test` / `typecheck`
  pass.

## Out of Scope

- A `severity` field — `intent` (`request` vs `blocker`) already carries that.
- Reply-mode (`accept` / `reject` / `ack`) structured fields.
- The human-authored review composer in the web UI — no new fields there.
- An applyable-patch UI for `suggestedFix` (structured diff, anchoring,
  one-click apply, conflict handling). `suggestedFix` is read-and-apply-manually
  free-form text.
- Round-tripping the new fields to/from GitHub.
- Surfacing the new fields back to the agent in the `<reviewer-feedback>`
  envelope (agent rows are not part of the reviewer-feedback queue).

## Open Questions

- Wording of the required-`rationale` validation error — final copy is a
  spec/implementation detail.
- Whether `confidence` should also tint the `AgentRow` border or only render as
  a chip — leave to spec; default is chip-only.

## Related Code / Patterns Found

- `mcp-server/src/index.ts:27-31` — `POST_COMMENT_DESCRIPTION`; `:86-144` —
  `shippable_post_review_comment` registration and `inputSchema`. Where the
  three new fields are declared.
- `mcp-server/src/handler.ts:227-365` — `PostCommentInput` and
  `handlePostReviewComment`; the reply-vs-top-level branch (`hasParent` /
  `hasAnchor`) and the wire payload it builds for `/api/agent/replies`.
- `server/src/index.ts:1145-1278` — the `/api/agent/replies` POST endpoint:
  field validation and the call into `postTopLevel`.
- `server/src/agent-queue.ts:237-261` — `postTopLevel` already stuffs
  `{ file, lines }` into the `payload` bag; the new fields extend that bag.
- `server/src/db/interaction-store.ts:16-32, 210-246` — `StoredInteraction`,
  `AgentInteractionInput`, `postAgentInteraction`; `payload_json` is the
  no-migration storage path.
- `web/src/state.ts:41-65, 1020-1166` — `PolledAgentReply` wire shape and the
  merge of polled agent replies into review state.
- `web/src/components/ReplyThread.tsx:204-254` — `AgentRow` and `intentGlyph`;
  the component that gains the confidence chip and the collapsible sections.
- `web/src/components/RichText.tsx` — non-Markdown prose/code renderer; reuse
  for `rationale` and the `suggestedFix` code block.
- `web/src/components/ReplyThread.css:201-265` — per-intent `AgentRow` styling;
  where chip and collapsible-section styles will be added.
- `docs/plans/typed-review-interactions.md` — precedent: the project's
  established "typed signal beats prose convention" bet (the `intent` field).
