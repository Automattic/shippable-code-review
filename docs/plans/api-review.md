# Server API design review

## Why this exists

The HTTP surface in `server/src/index.ts` grew one endpoint at a time as features landed. It works — the frontend is the only client today — but the shape is inconsistent in ways that will hurt as soon as a second client appears (the MCP server already is one), and the README listing reads like a memory aid for whoever wrote it.

This is the punch list of design issues + the proposed fixes. It's a plan, not a change set; nothing here ships before we agree the change is worth the churn.

## Inconsistencies worth fixing

### 1. POST-as-query

Most `/api/worktrees/*` endpoints take a JSON body but don't mutate state — they're queries.

- `POST /api/worktrees/list` — body `{ dir }`, returns the list.
- `POST /api/worktrees/changeset` — body `{ path, ref? }`, returns a `ChangeSet`.
- `POST /api/worktrees/graph` — body `{ path, ref? }`, returns the graph.
- `POST /api/worktrees/sessions` — body `{ path }`, returns sessions.

POST-with-body was easier than encoding paths into URLs (paths can contain `/` and unprintables), but it costs us caching, cleaner curl examples, and the convention "POST means side effect."

**Proposal:** keep POST. Document the *why* (paths-in-URL is fragile across the macOS / Windows split we'll see when worktrees include weird characters). Don't pretend they're idempotent in retry semantics.

### 2. Body key drift: `path` vs `worktreePath`

`/api/worktrees/*` takes `{ path }`. `/api/agent/*` takes `{ worktreePath }`. Same value, two names. Picked up because the agent endpoints landed later and someone wanted to be more explicit; the cost is that any client that touches both has to remember the split.

**Proposal:** standardise on `{ worktreePath }` everywhere. The `/api/worktrees/*` endpoints can keep accepting `{ path }` as a deprecation alias for one release to avoid breaking the frontend in a single PR.

### 3. HTTP status vs. discriminated `status`

`POST /api/definition` returns:

- HTTP 200 with `{ status: "ok", definitions: [...] }` on success
- HTTP 200 with `{ status: "unsupported", reason }` when LSP isn't available
- HTTP 502 with `{ status: "error", error }` when LSP crashed

Two channels for the same information. A 502 with `status: "error"` is doubly redundant; a 200 with `status: "unsupported"` is fine for the dispatcher to interpret but strange for an HTTP-level observer.

**Proposal:** pick one.

- *Option A — HTTP-first:* drop `status`, use HTTP codes (200 success, 422 unsupported, 502 backend failure). Body is the payload (`{ definitions: [...] }`) or `{ error: ..., reason: ... }`.
- *Option B — discriminator-first:* always return HTTP 200 (except for malformed requests / auth failures), keep `status` as the source of truth. This is closer to GraphQL / RPC and makes client code uniform.

Lean Option B because the dispatcher already branches on `status`, and the "unsupported" case is genuinely not an error — it's a fact about the server's capabilities. Document the convention and apply it across `/api/plan`, `/api/library/refresh`, the `/api/agent/*` family.

### 4. Capability/lookup race

`GET /api/definition/capabilities` is a separate call from `POST /api/definition`. The frontend uses the former to render the `def: …` chip and to gate the click handler. Capabilities can change between the calls (LSP binary uninstalled, sidecar restarted). The lookup endpoint already returns `status: "unsupported"` with a reason — capabilities is duplicated information.

**Proposal:** keep both endpoints (the chip needs the answer before the user clicks), but make the *lookup* response carry the same capability shape on `unsupported`, so the frontend can update the chip on the fly without a separate refetch.

### 5. Per-language capabilities (shipped)

**Status: shipped.** The response shape is `DefinitionCapabilities { languages: DefinitionLanguageCapability[]; requiresWorktree: boolean }` at `web/src/definitionTypes.ts:67`. PHP module is live (`server/src/languages/php.ts`); the chip resolves per-file via `findCapabilityForLanguage`.

`getDefinitionCapabilities()` reports a flat `available: boolean` plus a flat `supportedLanguages: string[]`. With one language and one binary, that's enough. With PHP coming, "TS available, PHP not installed" can't be expressed.

**Proposal:** the response shape becomes:

```ts
interface DefinitionCapabilities {
  // Per-language availability with reason when unavailable.
  languages: Array<{
    id: "ts" | "tsx" | "js" | "jsx" | "php" | "phtml" | …;
    available: boolean;
    resolver: string | null;     // "typescript-language-server", "intelephense", …
    reason?: string;             // why unavailable, when applicable
  }>;
  requiresWorktree: true;        // unchanged
}
```

The chip-rendering code in `ReviewWorkspace.tsx` already does per-file branching; this just gives it real data. Tracked as a hard prerequisite in [`lsp-php.md`](lsp-php.md).

### 6. No structured errors anywhere

Every error body is `{ error: string }`. The frontend formats it into a toast or peek panel; that's fine for humans. The MCP server can't programmatically distinguish "LSP not installed" (user fixable) from "LSP crashed" (retry might work) from "file not found" (probably a bug in the request).

**Proposal:** add an optional `code` alongside `error` for endpoints whose callers will branch:

```ts
{ error: "intelephense exited (code=1)", code: "lsp_crashed" }
{ error: "typescript-language-server not found", code: "lsp_not_installed" }
{ error: "file not found in workspace root: foo.ts", code: "file_not_in_workspace" }
```

Codes are advisory; clients that don't care keep using `error`.

### 7. `/api/agent/interactions` returns rendered XML

The MCP queue's fetch endpoint returns `{ payload: string, ids: [...] }`. `payload` is a pre-rendered XML string that the MCP server hands the agent verbatim. Fine for that one client; awkward for anything else (the gallery debugger, future webhook bridge).

**Proposal:** add `comments: Comment[]` to the response alongside `payload`. The MCP server keeps using `payload` (no change there); other clients consume the structured form. `formatPayload()` already exists; this is a one-line `index.ts` change.

### 8. Resource shape vs. RPC shape

The endpoint surface mixes two conventions:

- RPC-ish: `/api/library/refresh`, `/api/agent/enqueue`, `/api/worktrees/list`
- Resource-ish: `/api/definition` (POST does the lookup), `/api/health`

Picking one wholesale is a flag day. Don't do it. *Do* avoid mixing them within a feature: `/api/agent/enqueue` + `/api/agent/interactions` + `/api/agent/unenqueue` is fine; if we ever add `POST /api/agent` we should resist.

### 9. `workspaceRoot` dual sourcing

`POST /api/definition` accepts `{ workspaceRoot? }` in the body and falls back to `SHIPPABLE_WORKSPACE_ROOT` env var. Two sources of truth means weird precedence questions (env wins? body wins?). Today body wins, which is right, but it isn't documented.

**Proposal:** keep the dual sourcing — the env var is genuinely useful for non-worktree diffs in dev — but document precedence in the request type's JSDoc *and* in the README's API table.

## Cosmetic / nice-to-have

- **OpenAPI sketch.** The frontend already imports the request/response types directly. A generated OpenAPI doc would just duplicate them. Skip until we have a non-TS client.
- **Versioning.** `Accept: application/vnd.shippable.v1+json` is overkill at one client. When the second client appears, version the *unstable* endpoints (definition, agent queue) explicitly.
- **CORS preflight noise.** Every endpoint goes through `classifyRequestOrigin` + `classifyFetchSite`. The implementation is fine; the *test* coverage is uneven. Pin it down before any other CORS-adjacent change.

## What this plan doesn't propose

- Renaming endpoints. The cost (frontend churn, hooks in agent-context-panel) outweighs the benefit until we have a public contract.
- Splitting `server/src/index.ts` into per-feature route modules. Worth doing eventually; not a design issue, a file-size issue.
- A general-purpose RPC framework. Plain HTTP + typed request/response is fine for this size.

## Order of operations

1. ~~Per-language capabilities (#5).~~ **Shipped** alongside the PHP module.
2. Structured error codes (#6) — additive, safe to ship in the same PR as the PHP module.
3. Body key normalization (#2) — additive, deprecation alias kept for one release.
4. HTTP-vs-discriminator decision (#3). Apply it across the family in one pass once decided.
5. Capability/lookup response sharing (#4). The capability shape is now fixed, so this is unblocked.
6. README cross-reference (#9). Already partially done in the table; finish when #4 lands.

Items 7 and 8 land opportunistically; they're not blocking anything.
