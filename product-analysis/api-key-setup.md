# API key setup

## 1. Product reasoning & priority

Shippable's headline value (AI-generated plans, streaming review, AI annotations, PR ingest from GitHub Enterprise) is gated on credentials the user owns: an Anthropic API key for AI features and per-host GitHub Personal Access Tokens for PR ingest. Because Shippable is a local, BYOK prototype that bills no one and runs on the user's machine, credential setup is the first thing a brand-new user touches and the only point where they decide whether to trust the app with a long-lived secret. Getting this surface wrong (clunky boot, unclear storage, no escape hatch) torpedoes activation; getting it right (one panel, durable storage on desktop, opt-out for the AI features) is what lets the rest of the product land. The current implementation is already careful — keychain-on-desktop, server-memory-only otherwise, an explicit "skip and use rule-based plan" path, host blocklists, and a reactive PAT prompt at PR-load time — so the priority is to preserve that polish on rebuild, not invent new flows.

**Suggested priority: must-have.** Without credentials there is no AI plan, no streaming review, and no PR ingest — the three things that make Shippable more than a static diff viewer.

## 2. Acceptance criteria for a rebuild

- Anthropic key set in Settings persists across desktop relaunch via Tauri Keychain (service `shippable`, account `ANTHROPIC_API_KEY`); web-only mode keeps the key in server process memory and is intentionally lost on server restart.
- A first-run user with no Anthropic key sees a boot-mode credentials panel that explains where the key is stored and offers an explicit "Skip — use rule-based only" button; the skip choice persists in `localStorage["shippable:anthropic:skip"]` so the boot panel does not re-appear on every reload.
- After boot resolves once in a session, in-session credential changes (rotate / clear from Settings) never unmount the workspace or re-trigger the boot panel — Settings is the only post-onboarding management surface.
- Clearing the Anthropic key from Settings is treated as explicit opt-out: the skip flag is restored so the "AI off" affordance resurfaces.
- The server is the canonical authority on credential policy (host blocklist for GitHub: loopback, RFC1918, link-local incl. IMDS, CGNAT, IPv6 ULA/LL, `::ffff:` mapped). The Tauri keychain bridge applies an account-name shape check (no `:`, `/`, `\`, `@`; valid DNS labels or IPv4 form) but defers policy to the server.
- `useCredentials.set()` calls the server **before** writing the Keychain, so a server reject (e.g. blocked host) surfaces as the API error rather than the raw Tauri "account name not allowed" string, and never leaves a stale Keychain entry behind.
- `useCredentials.clear()` calls the server first; on Keychain-delete failure (user dismissed the macOS prompt) it still refreshes the list and surfaces a panel-level warning that the entry may resurrect on relaunch.
- Boot rehydrate (Tauri only) reads Keychain for `anthropic`, `github:github.com`, and every host in `shippable:githubTrustedHosts:v1`, pushing each hit to `POST /api/auth/set` silently — a miss never opens a modal.
- PR ingest that requires a GitHub PAT opens a reactive `GitHubTokenModal` only when the server returns `github_token_required` (first-time) or `github_auth_failed` (rejected). The cache-hit retry against Keychain is bounded to a single attempt to avoid a token-required → push-cached → retry loop on a stale token.
- Rejection copy in `GitHubTokenModal` branches on a typed hint (`rate-limit | scope | invalid-token`) so a rate-limited user is not told to regenerate a valid PAT.
- Non-`github.com` hosts must pass a one-time trust interstitial naming the API base (`https://<host>/api/v3`) before the user is allowed to paste a token; trusted hosts persist in `localStorage["shippable:githubTrustedHosts:v1"]`.
- `GET /api/auth/list` returns only credential discriminators, never values — `listCredentials()` reads from a Map keyed by encoded store keys (`anthropic`, `github:<host>`).
- The web client validates a setting at the input edge (host present, value non-empty, trimmed lowercase host) but the server re-validates on `POST /api/auth/set`; clients are not trusted with policy.
- The server never reads OS credential storage and never reads `ANTHROPIC_API_KEY` from `process.env` for authoritative behavior; a present env var produces only a one-line warning at boot.

## 3. Existing architecture & system design

### Data model

- `Credential` tagged union (web): `/workspace/web/src/auth/credential.ts:4` — `{ kind: "anthropic" } | { kind: "github"; host: string }`.
- `Credential` mirror (server): `/workspace/server/src/auth/credential.ts:8` — same union; `encodeStoreKey` (`credential.ts:16`) flattens to `"anthropic"` or `"github:<host>"` (lowercased, trimmed). `decodeStoreKey` (`credential.ts:30`) is the inverse and is the basis for `/api/auth/list` ordering.
- Keychain account naming: `keychainAccountFor` (`/workspace/web/src/auth/credential.ts:13`) — `"ANTHROPIC_API_KEY"` or `"GITHUB_TOKEN:<host>"`. This is the single source of truth for boot rehydrate, Settings rotate/clear, and the reactive PR modal.
- Trusted-host registry (web only): `localStorage["shippable:githubTrustedHosts:v1"]` — `string[]` JSON, managed by `/workspace/web/src/githubHostTrust.ts:18-52`.
- Skip flag: `localStorage["shippable:anthropic:skip"]` — `"true" | absent`, owned by `useCredentials` (`/workspace/web/src/auth/useCredentials.tsx:22`).
- Server-side store: in-memory `Map<string,string>` in `/workspace/server/src/auth/store.ts:10`, value `getCredential(...)` only readable by `server/src/plan.ts:163` (`anthropic`), `server/src/review.ts:74` (`anthropic`), and `server/src/index.ts:922,1012` (GitHub host token for PR ingest).

### Current architecture decisions

- **Tauri Keychain is durable.** Rust commands `keychain_get/set/remove` (`/workspace/src-tauri/src/keychain.rs:102-128`) front the macOS Keychain via the `keyring` crate (requires `apple-native` feature; in-memory mock otherwise — see comment at `keychain.rs:1-16`). Service name is fixed (`SERVICE = "shippable"`); the account-name allowlist is the only shape check the bridge performs (`keychain.rs:22-74`).
- **`auth/store.ts` is the runtime cache.** Server-side in-memory map keyed by the flat string from `encodeStoreKey`. The github host blocklist is enforced on write only (`store.ts:48-53`) — preserved verbatim from the old GH-only store. `listCredentials` sorts deterministically and returns only `Credential` shapes (no values).
- **`useCredentials` is the web orchestrator.** Boot effect runs `rehydrate()` (`/workspace/web/src/auth/useCredentials.tsx:82-103`): Tauri-only, walks `[anthropic, github:github.com, ...trustedHosts]`, calls `keychainGet` and pushes hits to `authSet`. Then `refresh()` repulls `/api/auth/list`. `set()` and `clear()` go server-first, Keychain-second — the server is policy; on server reject the Keychain is never touched (`useCredentials.tsx:117-119`); on Keychain-delete failure during `clear()`, the server state is what the UI reflects and an error is re-thrown for the caller to surface (`useCredentials.tsx:140-159`).
- **`POST /api/auth/set` and friends.** `/workspace/server/src/auth/endpoints.ts` parses+normalises `Credential`, applies `setCredential` which enforces the host blocklist. Discriminator errors: `invalid_credential`, `missing_value`, `host_blocked`. The web client wraps these in `AuthClientError` (`/workspace/web/src/auth/client.ts:9`) so callers branch on `discriminator`, not status codes.
- **Boot prompt (Anthropic only).** `ServerHealthGate` (`/workspace/web/src/components/ServerHealthGate.tsx`) shows the boot-mode `CredentialsPanel` when health is `ready`, credentials have loaded, and (no anthropic credential AND skip flag is unset). A `bootResolved` latch (`ServerHealthGate.tsx:39`) ensures the boot panel never re-appears after the workspace has loaded once.
- **Reactive GitHub PAT modal.** `useGithubPrLoad` (`/workspace/web/src/useGithubPrLoad.ts`) drives PR ingest. On `github_token_required`, it tries Keychain once (`useGithubPrLoad.ts:87-94`) then opens `GitHubTokenModal` in `first-time`; on `github_auth_failed` it opens in `rejected` with a typed `hint`. Rejection copy branches on hint (`/workspace/web/src/components/GitHubTokenModal.tsx:180-191`).
- **Trust interstitial for non-github.com hosts.** Both `CredentialsPanel.AddGithubHost` (`/workspace/web/src/components/CredentialsPanel.tsx:317-491`) and `GitHubTokenModal` (`GitHubTokenModal.tsx:89-111`) gate token entry on an "I trust `<host>`" confirmation that names the destination API base. Trust persists to `localStorage["shippable:githubTrustedHosts:v1"]`.

### How it evolved

The architecture doc's "Credential flow" section (`/workspace/docs/architecture.md:28-36`) describes the current shape as "one pattern serves the Anthropic API key and per-host GitHub PATs." The `auth/store.ts` header comment notes it "replaces the GH-only `server/src/github/auth-store.ts`" (`/workspace/server/src/auth/store.ts:1-7`), confirming an earlier per-credential implementation got refactored into a generic typed store keyed by the `Credential` discriminator. The Tauri bridge `keychain.rs:36-46` retains a comment explaining that the server's blocklist is the canonical authority — the bridge's job is shape-checking, not policy — which only makes sense after the unification (server gained the per-credential blocklist; bridge stopped trying to be an enforcement boundary). `process.env.ANTHROPIC_API_KEY` was once authoritative on the server but is now demoted to a one-line warning (`/workspace/server/src/index.ts:1446-1450`); plan/review read solely from `getCredential` (`server/src/plan.ts:163`, `server/src/review.ts:74`). The web/Tauri split has always been a constraint: web-only mode has no Keychain bridge at all (`isTauri()` returns false, `useCredentials.rehydrate` short-circuits the Tauri block), and so credentials live only in server-process memory for as long as the dev server runs — the docs flag this as expected behavior, not a degradation.

### Gaps

- **No BYOK for non-Anthropic AI providers.** `Credential.kind` is closed over `"anthropic" | "github"`. OpenAI / local-model / Bedrock would each require a discriminator change and matching surface in plan/review. The product is "only Claude" today (overview.md:22), so this is a deliberate gap, but a rebuild that wants to keep options open should design the union for extension from the start.
- **No credential validation beyond format.** Setting an Anthropic key writes whatever the user pastes; there is no probe call to Anthropic to verify the key works. The user discovers a bad key the first time they request an AI plan.
- **GitHub token scope feedback is best-effort.** The server returns a typed hint (`rate-limit | scope | invalid-token`) used by rejection copy (`GitHubTokenModal.tsx:180-191`), but there is no preflight scope check — the user only finds out the PAT is missing `read:org` when a private-repo PR ingest fails.
- **No multi-account / org switching.** One PAT per host, period. A reviewer with two GitHub identities (work + personal on github.com) can't keep both.
- **Web-only mode loses everything on server restart.** Documented (CredentialsPanel.tsx:180 — "Credentials live in macOS Keychain (Tauri) or server memory (dev)") but a real hosted deployment shape would need either a session-scoped browser secret or a server-owned encrypted store. Tracked implicitly in `AGENTS.md` deployment-mode notes; no concrete plan in `docs/plans/`.
- **Skip flag is per-machine, per-localStorage origin.** A user who clears site data is re-prompted on next boot; there's no Tauri-side persistence for skip.
- **GitHub-only PR ingest.** GitLab / Bitbucket would each require their own `Credential.kind` and a parallel reactive modal — the modal pattern is GH-specific in its host-trust copy, API-base derivation, and PAT scopes UX (`/workspace/web/src/components/GitHubTokenModal.tsx`).

## 4. Rebuild opportunities

### Data unification

- **The flat-string store key is internal plumbing.** `auth/store.ts` keys a `Map<string,string>` on the encoded form. A typed `Map<Credential, string>` via a structural key (or a `Record<CredentialKind, Map<HostKey, string>>` shape) would let `listCredentials` skip the encode/decode round-trip and would force any new `Credential.kind` to think about its discriminator-and-instance form (anthropic = singleton; github = one per host; openai = one per … account? Project?).
- **One modal, two modes.** `CredentialsPanel` already collapses boot and settings into one component via a `mode` prop (`/workspace/web/src/components/CredentialsPanel.tsx:23-32`). `GitHubTokenModal` is the second surface and overlaps significantly (host trust interstitial, password input with paste-and-save, error copy with a typed hint). A unified `CredentialPrompt` component that takes `{ credential: Credential, reason: "boot" | "first-time" | "rejected" | "settings-add" | "settings-rotate", hint?: ... }` could replace both — same component, four entry surfaces (ServerHealthGate, SettingsModal, useGithubPrLoad, future providers). The shape is already implied by `RowProps` and the `Editing` discriminator in `CredentialsPanel.tsx:27-29`.
- **Three localStorage keys, one concern.** `shippable:anthropic:skip`, `shippable:githubTrustedHosts:v1`, plus per-credential Keychain entries. None of these survives a wipe. A single `shippable:credentialPrefs:v1` JSON blob (per-credential `{ skip?: boolean; trusted?: boolean; lastUsed?: number; lastRejection?: TokenRejectionHint }`) would unify the metadata; the secrets themselves stay where they are (Keychain or server memory). This would also localize the per-credential mute / dismiss state cleanly.
- **Trust state is web-only today.** `githubHostTrust.ts` is pure localStorage. On Tauri the trust list ought to live in a Rust-owned config file (or even the same Keychain bucket) so a wipe of WKWebView storage doesn't strip trust decisions that gated the user past a security interstitial.

### Better architecture

- **One reactive seam, not two paths.** Today there are two ways a credential gets requested: `ServerHealthGate` (proactive, boot, anthropic-only) and `useGithubPrLoad` (reactive, mid-session, github-only). A single `useCredentialPrompts()` hook could expose a queue of `{ credential, reason }` items; both surfaces enqueue, one consumer renders a single modal stack. Server endpoints would standardize on returning a `credential_required: Credential` discriminator (already done for github: `github_token_required` carries `host`; just generalise).
- **Server-first ordering as a single helper.** `useCredentials.set` and `useCredentials.clear` both implement the server-then-keychain ordering by hand. A `withServerThenKeychain(op)` helper would centralise the "server is policy" contract and remove the easy mistake of getting it backwards in a future producer.
- **Move policy out of `useCredentials.tsx`.** The Anthropic-skip flag handling lives inline in `set` and `clear` (`useCredentials.tsx:121-125, 154-158`). A small `anthropicSkipMachine` would make the invariant ("setting clears skip; clearing restores skip") testable in isolation and remove a foot-gun for any future credential kind that wants similar opt-out semantics (e.g. GitHub-as-readonly).
- **Move the reactive PAT modal into `useCredentials`.** `useGithubPrLoad` carries an entire credentialing UX as a side-quest of PR loading: cache-hit retry, modal state, rejection copy. The PR loader's job is to load a PR; the credential prompting belongs in the credentials orchestrator. The fetch error already carries enough information (`discriminator`, `host`, `hint`); routing it through `useCredentials.demand({ kind: "github", host }, { reason })` and awaiting a promise that resolves on save would cut the PR loader down to a try/catch around the API.
- **Don't ship `ANTHROPIC_API_KEY` env reads at all.** The warning at `server/src/index.ts:1446` exists because the env var used to be authoritative. In a rebuild it can be deleted outright — the boot panel is the entry point, and tests can stub `getCredential` directly (as `server/src/review.test.ts:11` already does).

## Sources

- `/workspace/IDEA.md` — original problem statement (BYOK / local-first framing).
- `/workspace/docs/overview.md:22` — "Only Claude. The server defaults to `claude-sonnet-4-6`."
- `/workspace/docs/architecture.md:28-36` — Credential flow shape (Tauri Keychain + `auth/store.ts` + `useCredentials` + boot/reactive modals).
- `/workspace/AGENTS.md` (Deployment modes) — memory-only and no-server-side-clone deployment shapes; rationale for the keychain/server split.
- `/workspace/web/src/auth/credential.ts:4-20` — `Credential` union, `keychainAccountFor`.
- `/workspace/web/src/auth/client.ts:9-70` — `AuthClientError` and `/api/auth/*` HTTP shim.
- `/workspace/web/src/auth/useCredentials.tsx:22-196` — orchestrator: rehydrate, set, clear, skipAnthropic, server-first ordering.
- `/workspace/web/src/keychain.ts:5-32` — `isTauri()` guard and `keychainGet/set/remove` Tauri-invoke wrappers.
- `/workspace/web/src/components/CredentialsPanel.tsx:23-491` — boot+settings panel, AddGithubHost flow with trust interstitial.
- `/workspace/web/src/components/SettingsModal.tsx:1-90` — settings surface hosting the panel.
- `/workspace/web/src/components/GitHubTokenModal.tsx:1-191` — reactive PAT modal with typed hint copy.
- `/workspace/web/src/components/ServerHealthGate.tsx:23-235` — boot gate, `bootResolved` latch, db/unreachable branches.
- `/workspace/web/src/useGithubPrLoad.ts:40-184` — reactive PR ingest + cache-hit-retry + token rejection routing.
- `/workspace/web/src/githubHostTrust.ts:1-52` — trusted-host registry in localStorage.
- `/workspace/server/src/auth/credential.ts:8-40` — server-side `Credential` mirror, `encodeStoreKey`, `decodeStoreKey`.
- `/workspace/server/src/auth/store.ts:1-77` — Map-backed runtime store; host blocklist enforced at write boundary.
- `/workspace/server/src/auth/endpoints.ts:1-89` — `/api/auth/{set,clear,list}` handlers.
- `/workspace/server/src/plan.ts:163-169` and `/workspace/server/src/review.ts:74-80` — server consumers of the Anthropic credential.
- `/workspace/server/src/index.ts:922,1012,1446-1450` — server consumers of GitHub credentials + env-var warning.
- `/workspace/src-tauri/src/keychain.rs:1-203` — Rust Keychain bridge, account-name validator, `apple-native` feature note.
