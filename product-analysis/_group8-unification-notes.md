# Group 8 cross-cutting unification notes

Both api-key-setup and themes are **persistence + prompt** features: a small piece of user-owned state, a place to set it, and a deployment-shape-dependent durable store. Their architectures rhyme in places worth unifying.

- **Three localStorage keys per area, no single prefs document.**
  - api-key: `shippable:anthropic:skip` (`useCredentials.tsx:22`), `shippable:githubTrustedHosts:v1` (`githubHostTrust.ts:1`).
  - themes: `shippable:theme` (`tokens.ts:171`).
  - Plus `shippable:interactionViewMode`, recents, drafts, etc. elsewhere.
  - Consider one schema-versioned `shippable:prefs:v1` JSON for non-secret user prefs; secrets stay in Keychain / server memory.

- **Two surfaces per area, mostly duplicated.**
  - api-key: `CredentialsPanel` (boot + settings via `mode` prop) + `GitHubTokenModal` (reactive). Same shape — password-input row, host-trust interstitial, typed error copy.
  - themes: `ThemePicker` rendered in `App.tsx`, `ReviewWorkspace.tsx`, `Gallery.tsx`, `Demo.tsx`, `feature-docs.tsx`. Same component, five wirings.
  - Both would benefit from a single context-driven consumer (the picker / prompt reads state from context, callers stop passing `value` / `onChange`).

- **Deployment-shape degradation is uneven and undocumented at the type level.**
  - api-key has explicit fallbacks: Tauri Keychain when `isTauri()`, server memory otherwise. The `CredentialsPanel` even renders the hint copy "Credentials live in macOS Keychain (Tauri) or server memory (dev)" (`CredentialsPanel.tsx:180`).
  - themes has no equivalent — `localStorage` only, identical in web and Tauri. A "follow OS color-scheme" affordance in Tauri would need Rust-side wiring to the system appearance event; today that bridge doesn't exist.
  - Useful future move: a small `pref<T>(key, { tauri?, server? })` helper that knows which store to reach for, so feature code doesn't repeat `isTauri()` ladders.

- **Server-first ordering is a real invariant; only api-key encodes it.**
  - `useCredentials.set/clear` calls the server before the Keychain so policy lives in one place (server). Themes don't have a server policy yet, but if they ever did (e.g. enforced "default-dark for screenshot mode") the pattern would generalise.

- **Both areas duplicate or denormalise the discriminator at boundaries.**
  - api-key: `Credential` wire shape (`{kind, host?}`), flat store key (`anthropic`/`github:<host>`), Tauri account name (`ANTHROPIC_API_KEY`/`GITHUB_TOKEN:<host>`). Three encodings, three encode/decode functions.
  - themes: `THEMES` keys are `string`; `ThemeId = string` at the type level; runtime `isThemeId` is the only guard.
  - Both would tighten with a derived union (`ThemeId = keyof typeof THEMES`; `Credential = … as const`) and one canonical encoder.

- **Same anti-pattern: env-var fallbacks that the docs say are dead.**
  - `server/src/index.ts:1446-1450` warns about `ANTHROPIC_API_KEY` env var but no longer reads it for behavior. On rebuild, delete the warning and the historical compatibility surface — the boot panel is the entry point.
  - No theme env-var equivalent.

- **One verdict for the rebuild: keep the token model; collapse the prompts.**
  - The theme token model (one map, CSS variables on `:root`, persisted id, single picker) is already as boring and unified as it should be. Preserve it.
  - The credential surface has the right shape (typed union, server-policy, keychain-durable) but two prompt components doing 80% the same job. One reactive credential queue + one prompt component would cut surface area without losing capability.
