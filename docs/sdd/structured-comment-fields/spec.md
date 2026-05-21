# Spec: Structured Comment Fields

## Goal

Make agent-authored review comments self-explanatory at a glance. By adding
three fields — `rationale`, `suggestedFix`, `confidence` — to the
`shippable_post_review_comment` MCP tool's top-level mode, any review skill an
agent runs produces comments a human can understand without re-prompting the
agent. The MCP tool is the flow-agnostic chokepoint: every skill posts through
it, so shaping its schema shapes every comment.

## Requirements Summary

- Add `rationale` (required), `suggestedFix` (optional), `confidence`
  (optional, `low|medium|high`) to `shippable_post_review_comment` **top-level
  mode only** (`target: "line" | "block"`).
- A top-level call missing `rationale` is rejected at the MCP boundary with a
  clear error.
- Fields travel to `/api/agent/replies`, persist in the `interactions` table's
  `payload_json` bag (no schema migration), and reach the web app.
- `AgentRow` renders them collapsed by default: glance = body + intent +
  `confidence` chip; `rationale` and `suggestedFix` are expandable.
- Reply-mode posts and pre-existing rows are unchanged and render as today.
- No `severity` field; no human-composer change; no applyable-patch UI; no
  GitHub round-trip; not surfaced back to the agent in `<reviewer-feedback>`.

## Chosen Approach

**Discrete fields, threaded explicitly.**

Each of the three fields is a distinct, individually-named field at every layer
it passes through — MCP `inputSchema`, the HTTP payload to `/api/agent/replies`,
the `payload_json` bag, the GET wire shape, web state, and `AgentRow` props.

This was chosen over a single bundled `detail` object for one decisive reason:
the per-field `.describe()` strings in the MCP `inputSchema` *are* the prompt
surface that elicits good data from the agent. Three top-level fields, each with
its own description, give the model three clear, individually-prompted slots to
fill. A nested object collapses that into one parameter and weakens the
elicitation — which is the whole point of the feature. Discrete fields also keep
the "`rationale` required in top-level mode" rule a simple runtime check,
mirroring the existing `target`/`file`/`lines` validation pattern.

### Alternatives Considered

- **Bundled `detail` object** — one nested object carrying all three fields,
  passed opaquely through each layer. Fewer type edits, trivially extensible,
  but weakens the per-field prompting and muddies conditional-required
  validation. Rejected.
- **Prose-convention only (no schema fields)** — instruct the agent via the
  tool description to format the body in a fixed structure. Rejected during
  research: soft, prone to prompt drift, and produces a longer wall of prose
  rather than glanceable structure.

## Technical Details

### Architecture

The fields ride the existing agent → human channel end to end. Nothing new is
introduced structurally; each layer that already carries `body`/`intent`/`file`
gains three sibling fields. Storage reuses the `interactions.payload_json` bag —
the same mechanism `postTopLevel` already uses for `file`/`lines` — so there is
no DB migration and no `CURRENT_VERSION` bump.

Validation of the one required field (`rationale` in top-level mode) lives at
the MCP handler, alongside the existing `hasParent`/`hasAnchor` mode check. The
zod field itself stays `.optional()` (reply mode does not need it); the handler
runtime-enforces it for top-level posts. This mirrors how `target`/`file`/
`lines` are already `.optional()` in zod and runtime-checked in the handler.

### Data Flow

1. Agent calls `shippable_post_review_comment` in top-level mode with
   `rationale` (and optionally `suggestedFix` / `confidence`).
2. `handlePostReviewComment` resolves top-level mode and rejects the call if
   `rationale` is missing/empty.
3. The handler POSTs the three fields (those present) as flat keys in the
   `/api/agent/replies` JSON body.
4. The endpoint forwards them to `postTopLevel`, which writes them into the
   `payload` bag of `postAgentInteraction` → `payload_json`.
5. The web app polls `GET /api/agent/replies`; `listReplies` projects the
   fields from `payload_json` onto the top-level `AgentReplyWireItem`.
6. `state.ts` merge carries them onto the `Interaction`; `AgentRow` renders the
   `confidence` chip and the collapsible `rationale` / `suggestedFix` sections.

Pre-existing rows and reply-mode rows simply lack the payload keys; every
downstream read is conditional, so they render exactly as before.

### Key Components

- **MCP `inputSchema`** — three new optional fields; `rationale` and
  `suggestedFix` as `z.string()`, `confidence` as
  `z.enum(["low","medium","high"])`. `POST_COMMENT_DESCRIPTION` updated to
  explain them and that `rationale` is required for top-level posts.
- **`handlePostReviewComment`** — runtime-enforces `rationale` for top-level
  mode; forwards present fields into the HTTP payload; ignores them in reply
  mode.
- **`/api/agent/replies` endpoint** — accepts the three fields on top-level
  posts, light-validates `confidence` against the enum, passes them to
  `postTopLevel`. Trusts the MCP boundary for the `rationale`-required rule.
- **`postTopLevel` + `AgentReplyWireItem`** — `payload` argument and the
  top-level wire variant gain the three fields; `listReplies` reads them back.
- **`Interaction` type + `state.ts` merge** — optional `rationale`,
  `suggestedFix`, `confidence` on the interaction; merge projects them.
- **`AgentRow`** — `confidence` chip in the head row; `rationale` and
  `suggestedFix` as collapsible sections (`<details>`/`<summary>` — works in
  Wry/WKWebView). `suggestedFix` rendered as a code block; `rationale` via the
  existing `RichText` renderer.

### File Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `mcp-server/src/index.ts` | modify | Add `rationale`/`suggestedFix`/`confidence` to `shippable_post_review_comment` `inputSchema` with `.describe()` prompt text; update `POST_COMMENT_DESCRIPTION`. |
| `mcp-server/src/handler.ts` | modify | Extend `PostCommentInput`; enforce `rationale` for top-level mode; forward present fields into the `/api/agent/replies` payload; ignore in reply mode. |
| `mcp-server/src/handler.test.ts` | modify | Cover required-`rationale` rejection, top-level pass-through, reply-mode ignores the fields. |
| `server/src/index.ts` | modify | `/api/agent/replies` accepts the three fields on top-level posts; light `confidence` enum validation; pass to `postTopLevel`. |
| `server/src/agent-queue.ts` | modify | `postTopLevel` `payload` arg + top-level `AgentReplyWireItem` variant gain the three fields; `listReplies` reads them from `payload`. |
| `server/src/index.test.ts` | modify | Endpoint accepts/persists/returns the fields; `confidence` validation. |
| `web/src/types.ts` | modify | `Interaction` gains optional `rationale`/`suggestedFix`/`confidence`. |
| `web/src/state.ts` | modify | `PolledAgentReply` top-level variant + merge carry the three fields. |
| `web/src/components/ReplyThread.tsx` | modify | `AgentRow` renders the `confidence` chip and collapsible `rationale`/`suggestedFix` sections. |
| `web/src/components/ReplyThread.css` | modify | Chip styles per confidence level; collapsible-section styles. |
| `docs/concepts/` or `docs/features/` | modify | Note the structured fields where agent comments / the MCP tool are documented. |

## Out of Scope

- A `severity` field (`intent` already covers request vs blocker).
- Structured fields on reply-mode posts (`accept`/`reject`/`ack`).
- The human-authored review composer in the web UI.
- An applyable-patch UI for `suggestedFix` (diff anchoring, one-click apply,
  conflict handling). It is read-and-apply-manually free-form text.
- GitHub round-trip of the new fields.
- Surfacing the fields back to the agent in the `<reviewer-feedback>` envelope.

## Open Questions Resolved

- **Plumbing shape** — discrete per-field threading, not a bundled object, to
  preserve per-field `.describe()` prompting.
- **`confidence` representation** — `low|medium|high` enum, not a numeric
  score, to avoid false precision in a prototype.
- **`severity`** — dropped; `intent` carries the same signal.
- **Required-field enforcement** — at the MCP handler (runtime check for
  top-level mode), with the zod field staying `.optional()`. The server trusts
  that boundary and does not re-require `rationale`.
- **Collapsible mechanism** — `<details>`/`<summary>`, which works in
  Wry/WKWebView (unlike `window.confirm`/`alert`).

## Open Questions for Planning

- Final wording of the required-`rationale` validation error.
- Whether `confidence` also tints the `AgentRow` border or renders chip-only
  (default: chip-only).
