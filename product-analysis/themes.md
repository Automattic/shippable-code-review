# Themes

## 1. Product reasoning & priority

Code-review tooling lives in dense text surfaces for hours at a time, so the visual layer is not decoration — it's the substrate for comprehension. Shippable already serves four hand-tuned packs (Light, Dark, Dollhouse, Dollhouse Noir) plus ten Shiki-derived presets (Catppuccin Mocha/Latte, Tokyo Night, Dracula, Nord, One Dark Pro, Rosé Pine + Dawn, Solarized Dark/Light) through a single token model: CSS variables on `:root` drive both chrome and syntax highlighting, and Shiki's two render themes (`github-light` / `github-dark-dimmed`) follow the active color scheme. The investment in a token system (one switch flips chrome + syntax + diff semantics) means themes are cheap to add and cheap to live with. The Dollhouse pair signals that brand personality matters — themes are part of how Shippable distinguishes itself from grey-on-grey GitHub. None of this is product-critical (a single fixed dark theme would work), but rebuilding without theme support would feel like a regression to anyone who's spent time in the tool. The token system is also a load-bearing dependency for other surfaces (MarkdownView, DiffView highlight overlays, syntax showcase) so it warrants protection on rebuild.

**Suggested priority: nice-to-have.** Themes don't sell the product, but the token system underneath is structurally important — drop the pickers, keep the tokens.

## 2. Acceptance criteria for a rebuild

- A user picks a theme once; the choice persists across reloads via `localStorage["shippable:theme"]` (key from `tokens.ts:171`); default is `"dark"`.
- Switching a theme is instant: CSS variables are set on `document.documentElement` (`applyThemeToRoot`, `tokens.ts:202-210`), Shiki's render theme is updated (`setHighlightTheme`, `highlight.ts:47-49`), and no component remounts.
- Each `ThemeDefinition` (`tokens.ts:3-7`) is `{ label, colorScheme: "light"|"dark", vars: Record<string,string> }` and declares the full token set: `bg`, `bg-1`, `bg-2`, `bg-3`, `fg`, `fg-dim`, `fg-mute`, `accent`, `green`, `green-bg`, `red`, `red-bg`, `yellow`, `magenta`, `blue`, `border`, `border-active`, `cursor-bg`, `reviewed-bg`, `reviewed-mark`, `font-mono`, and ten `syntax-*` slots.
- `bg` / `bg-1` are the base surface; `bg-2` raises one step (topbars, panel chrome); `bg-3` raises two steps (selected rows, raised cards). The concept doc explicitly forbids components inventing undeclared surface tokens (`docs/concepts/theme-token-system.md:12`).
- The same token set drives both UI and syntax highlighting — switching themes never desynchronises chrome and code colors.
- `applyThemeToRoot` also sets `color-scheme` (browser form controls, scrollbars), and writes `data-theme` + `data-color-scheme` dataset attributes — CSS scoped by `[data-color-scheme="dark"]` (e.g. `DiffView.css:378,384`) responds without a per-theme stylesheet.
- The ThemePicker is a plain native `<select>` (`ThemePicker.tsx:9-31`) wired through `useTheme` (`useTheme.ts:10-20`); options come from `THEME_OPTIONS` (`tokens.ts:173-177`) so adding a theme adds an option automatically.
- Shiki theme mapping: hand-tuned themes route to `github-dark-dimmed` (dark) or `github-light` (light) (`highlight.ts:25-43`); Shiki-derived themes use their own bundled theme name. A `colorMode` override at call time (`shikiThemeFor`) lets a single-color-scheme surface (e.g. an always-dark inspector preview) opt out of the active theme's color mode.
- An unknown stored theme id falls back to `DEFAULT_THEME_ID` (`tokens.ts:179-191`); ignoring invalid persisted state never throws.
- Boot must apply the theme before paint to avoid a color-flash; `useTheme` runs `applyThemeToRoot` in `useEffect` (acceptable for prototype but visible on first paint until cleared).
- The Shiki theme adapter (`shikiThemes.ts:54-166`) takes an upstream `ShikiTheme` and synthesises a full `ThemeDefinition` — preserving diff semantics by hue-checking `terminal.ansiGreen` / `terminal.ansiRed` (`shikiThemes.ts:107-108`) so a teal-as-green or rose-as-red palette doesn't poison `--green-bg` / `--red-bg`.

## 3. Existing architecture & system design

### Data model

- `ThemeDefinition`: `/workspace/web/src/tokens.ts:3-7` — `{ label, colorScheme, vars: Record<string,string> }`.
- Hand-tuned theme pack (the four named in architecture.md:252): `HAND_TUNED_THEMES` in `/workspace/web/src/tokens.ts:12-161`, satisfies `Record<string, ThemeDefinition>`.
- Shiki-adapted packs: `SHIKI_ADAPTED_THEMES` in `/workspace/web/src/shikiThemes.ts:50-52`, produced by `adaptShikiTheme` from upstream `@shikijs/themes/*` modules.
- Combined registry: `THEMES = { ...SHIKI_ADAPTED_THEMES, ...HAND_TUNED_THEMES }` in `/workspace/web/src/tokens.ts:163-166`. Hand-tuned entries win on collision because they're spread last.
- `ThemeId = string` (`tokens.ts:168`); `DEFAULT_THEME_ID = "dark"` (`tokens.ts:170`); `THEME_STORAGE_KEY = "shippable:theme"` (`tokens.ts:171`).
- Variable names are flat keys (no nested map). A `ThemeDefinition.vars` entry of `{"bg": "#0b0e14"}` is materialised as `--bg: #0b0e14` on `:root` (`tokens.ts:202-210`).

### Current architecture decisions

- **One token set drives chrome and syntax.** A single `vars` map per theme declares both UI surfaces (`bg-*`, `fg-*`, `border*`, `accent`) and the ten `syntax-*` slots. Components read either via `var(--bg)` style or by relying on Shiki rendering with the active theme. There is no parallel "syntax theme" object.
- **CSS variables on `:root`, set imperatively.** No CSS-only theme files; no `@media (prefers-color-scheme)` (verified — only `data-color-scheme` selectors are used, e.g. `DiffView.css:378,384`, `MarkdownView.css:18,25`). `applyThemeToRoot` writes every variable on every switch, which is O(tokens) and trivial.
- **`useTheme` is the only orchestrator.** `/workspace/web/src/useTheme.ts:10-20` reads `getStoredThemeId()` on mount, runs `applyThemeToRoot` + `persistThemeId` + `setHighlightTheme` inside `useEffect`. The `ThemePicker` is purely presentational (`ThemePicker.tsx:9-31`) and called from `App.tsx:159`, `Gallery.tsx:21`, `Demo.tsx:34`, `ReviewWorkspace.tsx:1670`, `feature-docs.tsx:326,462` — the picker itself doesn't own state.
- **Shiki sets a fixed pair of render themes plus per-theme overrides.** `highlight.ts:25-33` maps the four hand-tuned ids to two Shiki names (`github-dark-dimmed` / `github-light`); the ten Shiki-derived ids use their own theme name from the upstream module. `shikiThemeFor` (`highlight.ts:53-58`) supports an explicit `colorMode` override so a surface that wants to force "light snippet inside a dark app" can.
- **Shiki adapter synthesises tokens with safeguards.** `adaptShikiTheme` (`shikiThemes.ts:54-166`):
  - Always derives `border`, `fg-dim`, `fg-mute` via `mix(fg, bg, t)` — theme-provided candidates are unreliable (Catppuccin's `descriptionForeground === foreground`; Tokyo Night's `border` is darker than its `bg`).
  - Picks accent via `pickSaturated` over `button.background`, `focusBorder`, terminal magenta/blue — skips low-sat candidates so Dracula's gray-blue focus border doesn't poison `--accent`.
  - Picks green/red via `pickInHue` from terminal colors with hue gates so teal-as-green / rose-as-red palettes don't render diff-add/diff-remove with the wrong hue.
  - Flattens alpha against `bg` for surface tints (`flattenAlpha`) — themes encode soft tints with alpha (e.g. Rosé Pine's 8% selection background); stripping alpha gives an opaque blob that's too saturated.
  - Reads `tokenColors` for syntax slots (`findScope`), falling back to the synthesised hue palette when a scope is missing.
- **Dataset attributes for `[data-color-scheme]` queries.** `applyThemeToRoot` writes `el.dataset.theme = themeId` and `el.dataset.colorScheme = theme.colorScheme` (`tokens.ts:208-209`); used by `DiffView.css` highlight overlays and `MarkdownView.css` prose styling to swap per-mode rules without per-theme stylesheets.

### How it evolved

`docs/concepts/theme-token-system.md` confirms the design intent: one token map per theme, applied as CSS variables at the root, persisted in localStorage, and prescriptive about surface elevation (`bg`/`bg-1` base, `bg-2`/`bg-3` raised). The mention of "components should not invent undeclared surface tokens" implies prior cleanup — there must have been a moment where components were declaring colors locally, and the rule is the cure. The Shiki adapter shows scar tissue from real theme bugs (every comment block in `shikiThemes.ts:65-127` documents a specific theme that misbehaved if treated naïvely): Tokyo Night ships a border darker than its background; Dracula's focus border is gray-blue; Catppuccin's description and foreground collapse; Rose Pine encodes selection background with alpha. The hue gates on green/red (`shikiThemes.ts:107-108`) are explicitly defending the diff-add/diff-remove semantics — a comment notes "Rosé Pine" by name. The four hand-tuned themes (Light, Dark, Dollhouse, Dollhouse Noir) likely predate the Shiki adapter; the architecture doc's Themes section (`architecture.md:252-253`) lists only those four, while `tokens.ts:163-166` quietly registers ten more via the spread. The desktop deployment shape doesn't change theme semantics — themes are purely browser state via localStorage, identical in dev/Tauri.

### Gaps

- **No per-changeset / per-fixture theme override.** Useful for screenshots, fixture catalog, or a "compare this diff in light mode" gesture. Demo (`Demo.tsx:1688`) and Gallery (`Gallery.tsx:61`) host their own pickers but they all write to the same `useTheme` state.
- **No system-preference following.** `prefers-color-scheme` is not consulted anywhere (grep-confirmed). A first-run user on a light OS gets the dark theme by default; the app does not auto-pick light vs. dark.
- **No accessibility / contrast guard.** Hand-tuned themes were eyeballed; Shiki-adapted themes have `pickSaturated` and `pickInHue` but no WCAG contrast check between `--fg` and `--bg`, or between `--accent` and `--bg-2`. A theme can ship illegible.
- **No "follow system, pick light + dark separately" UX.** Common in editor apps (VS Code, JetBrains). Today, a user has exactly one active theme.
- **Theme picker lives in three places.** `App.tsx`, `Gallery.tsx`, `Demo.tsx`, `ReviewWorkspace.tsx`, plus the static feature-docs renderings. Each consumer wires `value`/`onChange` separately. No common home (e.g. inside `SettingsModal`).
- **`ThemeId` is `string`, not a union.** `isThemeId` (`tokens.ts:179-181`) is a runtime guard, but TypeScript can't catch a typo like `themeId: "dakr"`. A union derived from `keyof typeof THEMES` would.
- **No FOUC mitigation.** First paint runs initial state via `useState(() => getStoredThemeId())` but the effect doesn't run until after the first render, so the very first frame uses CSS defaults (the `var(--bg, #0b0e14)` fallback in `index.css:7`). A pre-React inline-script reading localStorage and setting variables would eliminate the flash.

## 4. Rebuild opportunities

### Data unification

- **One source of truth, already.** Tokens are not duplicated between CSS variables and TS constants. The TS map IS the source; CSS reads via `var(--name)`. There is no parallel `colors.ts` file or SCSS variable bundle — `grep -rln '\\-\\-bg' web/src/*.css` returns 38 files but all of them consume from `:root`, not declare their own. This is the right shape and worth preserving on rebuild.
- **Shiki theme mapping is dual-state.** `SHIKI_THEME_BY_ID` (`highlight.ts:25-33`) hand-maps the four hand-tuned themes to a Shiki render theme, and lazily maps each Shiki-derived id to its own bundled theme name (built from `SHIKI_THEME_MODULES`). The hand-tuned overrides could be inlined as an optional field on `ThemeDefinition` (`shikiThemeName?: string`) so the picker definition carries its render-theme mapping next to its tokens, instead of a parallel table in `highlight.ts`.
- **Theme-prefs are spread across keys.** `shippable:theme` (the id). There's no separate trusted-host / preference key for theme. Combining with a future `shippable:prefs:v1` JSON could roll in `themeId`, `interactionViewMode` (`web/src/interactionViewMode.ts`), and other UI prefs into one persisted document — but only if the trade-off (one schema-versioned record, rehydrate strategy) is worth it; today the keys are independent and that's fine.

### Better architecture

- **Make `ThemeId` a union derived from the registry.** `type ThemeId = keyof typeof THEMES;` — then `THEMES` becomes the only place to register, the picker is typed, and `isThemeId` becomes a `value in THEMES` predicate. The current `ThemeId = string` (`tokens.ts:168`) is genuinely unsafe and exists only to accommodate the union of two object literals; declaring the registry with `as const satisfies Record<…>` would give a real union.
- **Pre-React boot script for theme.** A 10-line inline `<script>` in `index.html` that reads `shippable:theme` and writes the CSS variables to `:root` before React mounts. Removes FOUC; nothing else changes.
- **One `ThemePicker` consumer.** Centralize via context or a `useThemeContext` hook; the picker reads the active id from context and calls `setThemeId` directly. Eliminates the `value`/`onChange` plumbing through `App.tsx` → `ReviewWorkspace.tsx` (`ReviewWorkspace.tsx:1670`) and the duplicated wiring in Gallery/Demo.
- **Promote `colorScheme` follow-system as a first-class theme.** A `ThemeId = "system"` synthetic that resolves at apply-time to a chosen `themeIdLight` / `themeIdDark` pair (default to Light / Dark hand-tuned packs). Matches VS Code's behavior; one extra option in the picker; a `matchMedia("(prefers-color-scheme: dark)")` listener in `useTheme`.
- **Move theme into the Settings modal.** `SettingsModal` (`/workspace/web/src/components/SettingsModal.tsx`) already hosts `CredentialsPanel`; embedding the picker alongside makes Settings the singular preferences surface and removes the topbar theme picker (or keeps it as a shortcut). This also frees the topbar for review-relevant actions.
- **Add a contrast / WCAG check on adapter output.** `adaptShikiTheme` already does a lot of synthetic work; one more pass that asserts `contrast(fg, bg) >= 4.5` and `contrast(green, green-bg-flattened) >= 3` would catch the next bad theme before it ships. Failures could either fall back to derived defaults or refuse to register the theme. Boring, defensive, no new dependencies (a 20-line WCAG contrast function does it).
- **Carry a `previewSwatch` set per theme.** The native `<select>` (`ThemePicker.tsx:9-31`) can't preview. A custom dropdown could render a four-swatch row (`bg`, `bg-2`, `accent`, `fg`) per option. Cheap UX uplift; the tokens are already keyed correctly.

## Sources

- `/workspace/IDEA.md` and `/workspace/docs/overview.md` — product positioning that justifies investment in the visual layer.
- `/workspace/docs/architecture.md:252-253` — Themes section (Light, Dark, Dollhouse, Dollhouse Noir) — does not mention the ten Shiki-derived themes, so the doc is partially out of date relative to `tokens.ts`.
- `/workspace/docs/concepts/theme-token-system.md` — token-model intent: CSS variables on root, persist in localStorage, surface elevation rules.
- `/workspace/web/src/tokens.ts:1-211` — `ThemeDefinition` type, `HAND_TUNED_THEMES` (Dark / Dollhouse Noir / Dollhouse / Light), combined `THEMES`, `applyThemeToRoot` writing CSS vars + `color-scheme` + `data-*` attributes, localStorage round-trip.
- `/workspace/web/src/shikiThemes.ts:1-273` — Shiki theme adapter; `adaptShikiTheme` synthesising chrome tokens from upstream theme JSON with `pickSaturated`/`pickInHue`/`flattenAlpha` safeguards.
- `/workspace/web/src/highlight.ts:1-58` — Shiki theme name mapping (`SHIKI_THEME_BY_ID`, `shikiThemeFor`), `setHighlightTheme` hook.
- `/workspace/web/src/useTheme.ts:1-20` — orchestrator hook.
- `/workspace/web/src/components/ThemePicker.tsx:1-31` — native `<select>` picker.
- `/workspace/web/src/components/DiffView.css:378,384` — `:root[data-color-scheme="…"]` selectors driven by `applyThemeToRoot`.
- `/workspace/web/src/components/MarkdownView.css:3,18,25,29-33` — same pattern in markdown prose.
- `/workspace/web/src/App.tsx:159`, `Gallery.tsx:21,61`, `Demo.tsx:34,1688`, `ReviewWorkspace.tsx:1670`, `feature-docs.tsx:326,462` — picker consumers.
- `/workspace/web/src/index.css:1-9` — `:root` `var(--bg, …)` fallback for first paint.
