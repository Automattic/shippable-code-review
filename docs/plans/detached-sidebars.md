# Detached sidebars

Shippable's left sidebar (files + prompt runs) and right inspector (AI notes, comments, agent context) are where the output of conversations and AI-agent actions surfaces. On a single monitor they compete with the diff for horizontal space; on multiple monitors they're stuck on the wrong one. This plan lets a reviewer pop either sidebar out as its own OS window — same component, same interactions, just rendered in a child window owned by the parent reviewer.

This is a focused extension of [`multi-window.md`](./multi-window.md): reuses the registry, the `WindowEvent::Destroyed` cascade, and the `tauri://localhost` same-origin guarantee. The only architectural addition is a parent ↔ child event channel that ferries view models in one direction and dispatch actions in the other.

## Goal

What this enables:

- A `↗ Detach` affordance on each sidebar's header pops the panel out as a child window of the current reviewer.
- The host window collapses the slot while the panel is detached, reusing the existing `showSidebar` / `showInspector` path so the diff gets the room.
- The detached window is bound to its parent reviewer: it always reflects that reviewer's state, regardless of which other review windows are focused.
- Closing the parent closes its detached children. Closing a detached child re-docks the panel in the parent, even if the user had manually hidden it before detaching — the visible action ("close that window") most naturally maps to "put it back."
- Every interaction available in the docked panel works identically in the detached one — picking a file, jumping to a comment, expanding a thread, submitting a reply, closing a prompt run, retrying a delivery.

What it explicitly does *not* try to do:

- Mirroring both ways (docked + detached at the same time). The host hides its slot while a child is open. One interactive surface per panel-instance.
- Following whichever review window is focused. The detach is bound to its parent at open time; no global "active review" bus.
- Detaching individual sub-panels (Files only, AgentContext only). Whole-sidebar at a time. A future change could split further.
- A browser-mode equivalent. Multi-window is Tauri-only; this rides on the same gate (`isTauri()`). Browser users get the affordance hidden, same as `supportsNewWindow` today.
- Persisting a detached child across launches. Cold start always begins fully docked.
- Preserving detach across review-switches in the same parent window. Going back to the picker and loading another review collapses any children. Detach is a per-review-session affordance — easier to implement and matches "no restoration across launches."
- Saving per-kind window sizes / positions across opens. Nice-to-have, but out of scope.

## What already works (so the plan is smaller than it looks)

The multi-window slice did most of the structural work:

- **Same-origin spawning.** `WebviewWindowBuilder` with `WebviewUrl::App` already produces a child page on `tauri://localhost`, which means shared localStorage, no `Origin: null`, and no CORS escape. `multi-window.md` and `server/src/index.ts:1313-1356` both spell out why this matters; the detached window will use the identical mechanism, just with a different HTML entry.
- **A window registry with cascade-close.** `WindowRegistryState` in `src-tauri/src/lib.rs:60-67` already maps `label → changesetId`. The `WindowEvent::Destroyed` arm at `lib.rs:409-423` already drops entries on close and quits the app when the last window goes away. Adding a `parent: Option<String>` and `kind: WindowKind` to each entry, plus iterating siblings on destroy, is the entirety of the Rust-side state change.
- **A view-model layer that's already serializable.** `buildSidebarViewModel` and `buildInspectorViewModel` in `web/src/view.ts` already return plain objects (file lists, hunk references, comment rows). They're computed every render from the parent's `ReviewState`. The detached child can render against the same view-model shape with no component fork.
- **A bridge module pattern.** `web/src/multiWindow.ts` already wraps `@tauri-apps/api/core` invokes behind an `isTauri()` guard. The new commands will live in the same file.
- **The Tauri event bus.** `Emitter` is already imported and used at `lib.rs:297-330` for sidecar lifecycle events. Parent ↔ child app-side events route through `@tauri-apps/api/event::{emit, listen}` with no Rust changes for messaging itself.

The real work: one new HTML entry, one new React mount, the parent-side push/listen bridge, and the registry extension.

## The slices

**(a) Detach foundation — Rust + new entry point.** A new HTML entry at `web/detached.html` + Vite entry at `web/src/detached.tsx` that mounts `<DetachedHost>` only (no review machinery, no `App` shell). `<DetachedHost>` reads `kind` and `parent` from `location.search`, subscribes to `shippable:detach-state:<parent>` for view-model pushes, and renders `<Sidebar>` or `<Inspector>` against the most recent snapshot. A new Tauri command `open_detached_window({ parent, kind })` builds a `WebviewWindowBuilder` pointed at `/detached.html?kind=…&parent=…`, with the label `detached-<parent>-<kind>`. Window default size scales per kind (sidebar ~360×800, inspector ~480×900); cascade offset from the parent. The registry entry gains `parent: Option<String>` and `kind: WindowKind { Review, Sidebar, Inspector }`. *Done when:* a stub command spawns an empty detached window from a parent review window, the parent's label is in the URL, and closing the parent closes the child via the existing Destroyed arm extended to cascade. *Blocking next:* (b) and (c) depend on the entry existing.

**(b) Sidebar detach — wire the left sidebar.** A `DetachBridge` component mounted inside `ReviewWorkspace` that, when the parent has a sidebar child registered, emits `shippable:detach-state:<self>` on every change of `{ sidebarVM, runs, sidebarWide }`. The detached `<DetachedHost>` mounts `<Sidebar>` with those props and translates its callbacks into emits on `shippable:detach-action:<parent>` (`pick-file`, `jump-to-first-comment`, `close-run`, `toggle-wide`). The parent listens, routes each action to the same handlers the docked sidebar uses today. The detach button on the sidebar header (and a re-attach button in the detached window) toggles a `detached.sidebar` flag — when set, the host hides the docked sidebar via the existing `showSidebar=false` path. *Done when:* clicking ↗ on the sidebar header opens a detached window showing the same file list, clicking a file in the detached window moves the cursor in the parent's diff, and closing the detached window restores the docked sidebar.

**(c) Inspector detach — wire the right sidebar.** Same shape as (b), with the larger action surface: `jumpToBlock`, `toggleAck`, `startDraft`, `closeDraft`, `changeDraft`, `submitReply`, `retryReply`, `deleteReply`, `prevComment`, `nextComment`, `pickSession`, `refresh`, `verify`, `verifyAiNote`, plus the agent-context props (`mcpStatus`, `delivered`, `lastSuccessfulPollAt`, `deliveredError`). All callbacks become emits, keyed by an action `type` discriminant. The parent's listener does a single `switch` on `type` and calls into the same dispatchers `ReviewWorkspace` already wires for the docked Inspector. Local-only state inside the detached window (e.g. transient UI like expanded sections, scroll position) stays in the child — only state owned by `ReviewState` round-trips. *Done when:* the inspector in a detached window is functionally interchangeable with the docked one: draft a reply, submit, watch the pip change to ✓ delivered, all from the detached window.

**(d) Re-attach UX + edge polish.** A keyboard shortcut on the parent (`⌘⇧[` for sidebar, `⌘⇧]` for inspector) toggles detach. App menu gains `View → Detach Sidebar` and `View → Detach Inspector` (with the same accelerators) via the existing `src-tauri/src/menu.rs` builder — same pattern as `shippable:new-window`: a `MenuItemBuilder` with id `shippable:detach-sidebar` / `shippable:detach-inspector`, `action_for` maps them to action strings, the frontend's existing `shippable:menu` listener routes to the same toggle the header button calls. Both items are disabled when the focused window isn't a review window. The detached window has a header bar with the panel name, a `↙ Re-attach` button, and the parent's title for context ("Inspector — feat/auto-mode-sandbox"). Trying to detach a sidebar that is already detached focuses the existing child (mirroring the duplicate-detection idiom from multi-window). Browser users see the host menu items / buttons hidden via `isTauri()`. *Done when:* every entry point (header button, shortcut, menu item) does the right thing and the user can't end up in a state where a sidebar is "detached" but no detached window exists.

## Architecture sketch

```
┌─ Parent (review window: "window-3", cs: pr-42) ──────────────────┐
│                                                                  │
│  ReviewWorkspace                                                  │
│   ├─ state, reducer, all the handlers we already have            │
│   ├─ build{Sidebar,Inspector}ViewModel(state, ...)               │
│   │                                                              │
│   ├─ <Sidebar>      shown only when no sidebar child registered  │
│   ├─ <Inspector>    shown only when no inspector child           │
│   │                                                              │
│   └─ <DetachBridge>                                              │
│        ├─ on snapshot change                                     │
│        │    → emit('shippable:detach-state:window-3',            │
│        │           { kind, snapshot })                           │
│        └─ listen 'shippable:detach-action:window-3'              │
│             → route to existing handlers (dispatch, setDraft…)   │
└────────────────────────┬─────────────────────────────────────────┘
                         │  Tauri event bus (same app, same origin)
                         ▼
┌─ Child "detached-window-3-inspector" ────────────────────────────┐
│  /detached.html?kind=inspector&parent=window-3                   │
│                                                                  │
│  <DetachedHost>                                                  │
│   ├─ const [snapshot, setSnapshot] = useState(null)              │
│   ├─ listen('shippable:detach-state:window-3')                   │
│   │    → setSnapshot(payload)                                    │
│   ├─ snapshot ? <Inspector vm={...}                              │
│   │    onJumpToBlock={(c,s)=> emit('...:action:window-3',        │
│   │                              {type:'jump-to-block', c, s})}  │
│   │    onSubmitReply={(k,b)=> emit(..., {type:'submit-reply'…})} │
│   │    /> : <DetachedLoading/>                                   │
│   └─                                                              │
└──────────────────────────────────────────────────────────────────┘

         ┌─ Rust (src-tauri/src/lib.rs) ───────────────────────────┐
         │  WindowRegistryState                                    │
         │    by_label: HashMap<String, RegistryEntry>             │
         │      ├─ changeset_id: Option<String>                    │
         │      ├─ parent:       Option<String>     // new         │
         │      └─ kind:         WindowKind         // new         │
         │  commands:                                              │
         │    open_new_window(opts)                                │
         │    open_detached_window({parent, kind})  // new         │
         │    set_window_changeset(id)                             │
         │    list_window_changesets()                             │
         │    list_detached_children(parent)        // new         │
         │    focus_window(label)                                  │
         │  RunEvent::WindowEvent { Destroyed, label }:            │
         │    drop entry; if entry.kind == Review, close children  │
         └─────────────────────────────────────────────────────────┘
```

**Crucial property: same React component, two host trees.** Detached child mounts the *exact* `<Sidebar>` and `<Inspector>` already used today. We do not fork them. Their `Props` are the contract. Anything not serializable (e.g. `RefObject`, `SymbolIndex` — see below) is either replaced by a serializable shadow or recreated in the child as needed.

## Wire format

Two events per parent window.

**`shippable:detach-state:<parent>`** — parent → child push, one per kind:

```ts
type DetachStateMsg =
  | { kind: "sidebar";  snapshot: SidebarSnapshot }
  | { kind: "inspector"; snapshot: InspectorSnapshot };

interface SidebarSnapshot {
  viewModel: SidebarViewModel;       // already a plain object
  runs: PromptRunView[];             // already a plain object
  wide: boolean;
}

interface InspectorSnapshot {
  viewModel: InspectorViewModel;     // already a plain object
  commentCount: number;
  lineHasAiNote: boolean;
  draftBodies: Record<string, string>;
  agentContextProps: AgentContextProps; // already plain (see Inspector.tsx:44-)
  // Non-serializable companions handled separately (see "Non-serializable props" below).
}
```

The parent emits whenever the snapshot changes (gated by `useMemo` + structural equality on the snapshot's top-level fields, so we don't re-emit on identity-only changes from React re-renders).

**`shippable:detach-action:<parent>`** — child → parent dispatch:

```ts
type DetachActionMsg =
  | { kind: "sidebar"; action: SidebarAction }
  | { kind: "inspector"; action: InspectorAction };

type SidebarAction =
  | { type: "pick-file"; fileId: string }
  | { type: "jump-to-first-comment"; fileId: string }
  | { type: "close-run"; id: string }
  | { type: "toggle-wide" };

type InspectorAction =
  | { type: "jump"; cursor: Cursor }
  | { type: "jump-to-block"; cursor: Cursor; selection?: LineSelection }
  | { type: "toggle-ack"; hunkId: string; lineIdx: number }
  | { type: "start-draft"; key: string }
  | { type: "close-draft" }
  | { type: "change-draft"; key: string; body: string }
  | { type: "submit-reply"; key: string; body: string }
  | { type: "retry-reply"; key: string; replyId: string }
  | { type: "delete-reply"; key: string; replyId: string }
  | { type: "prev-comment" }
  | { type: "next-comment" }
  | { type: "pick-session"; sessionFilePath: string }
  | { type: "refresh" }
  | { type: "verify-ai-note"; recipe: { source: string; inputs: Record<string, string> } };
```

One discriminated union per kind, one `switch` per kind in the parent's listener, each case calls the exact handler the docked component already calls today. The parent's `useEffect` that subscribes is the single integration point.

**Lifecycle.** The parent has to know when it has a detached child (so it can hide its docked slot and start emitting state). Two complementary signals:

- `shippable:detach-ready:<parent>` — emitted by the child on mount with `{ kind }`. The parent registers the kind as "detached" and the slot collapses.
- `shippable:detach-children-changed:<parent>` — emitted by the Rust side from the extended `WindowEvent::Destroyed` arm whenever a child window of this parent goes away. The parent re-queries `list_detached_children(parent)` and updates its set of detached kinds. The Rust side is the source of truth on whether a child window actually exists; the JS-side `set` only mirrors it.

The Rust-side signal is what makes the close ✕ on a detached window work end-to-end without the child having to be careful about firing a closing event before its window destroys itself.

## Non-serializable props

A handful of `Inspector` props can't cross the wire as-is. Each gets a targeted treatment:

- **`SymbolIndex`** (`web/src/symbols.ts`) — currently passed by reference. Rebuilt in the child by re-running the symbol-index loader against the same changeset, *or* (cheaper) read from a window-scoped cache the loader already populates. Decision goes in the implementation plan; both are viable. The view-model already pre-resolves most symbol look-ups for display, so the live `SymbolIndex` is needed mostly for click-through.
- **`RefObject`s for scroll containers** — `web/src/components/Inspector.tsx` uses refs to focus/scroll within itself. These are child-local; they're created in `<DetachedHost>` exactly the way `ReviewWorkspace` creates them today.
- **`commentStops`** — derived from `buildCommentStops(cs, state.interactions)`. The parent sends the count; the child re-derives the list from the snapshot's view-model. If that turns out to be insufficient for a prev/next jump in the detached window, we send the stop list alongside the snapshot. Concrete decision in slice (c).

## State that lives in the child

A few things stay in the child rather than mirroring across:

- The detached window's own scroll position.
- Hover/focus state inside the panel.
- A throttled debounce on resize-driven re-renders.

`ReviewState` always lives in the parent. The child never owns truth.

## Things to watch out for

- **Wire chatter.** `buildInspectorViewModel` runs on every parent re-render. Without gating, we emit on every keystroke and selection move. The bridge memoizes the snapshot and only emits when a structural compare against the last-sent value detects a diff. Same idiom as `view.test.ts` already exercises for the view-model layer.
- **Origin parity.** New child window MUST use `WebviewUrl::App("detached.html".into())`, not a blob/data URL, or `server/src/index.ts:1313-1356` rejects its requests as `Origin: null`. Same trap documented in `multi-window.md`.
- **Wry/WKWebView dialog limits.** No `window.confirm` / `window.alert` / blob downloads in the detached window. The header's re-attach button is an in-app element; same constraint as the multi-window toast.
- **Registry consistency on parent close.** The `WindowEvent::Destroyed` arm at `src-tauri/src/lib.rs:409-423` must cascade-close children before it checks `app_handle.webview_windows().is_empty()` for last-window quit. Otherwise the parent close fires the quit branch before the children's own Destroyed events arrive.
- **Race between detach and re-attach.** If the user spams ↗ rapidly, the parent could emit a second `open_detached_window` while the first is still spawning. Rust returns the existing label (idempotent open) and the child-side `focus_window` runs unconditionally. Same idiom as multi-window's duplicate-focus path.
- **Snapshot identity vs structural change.** React re-renders churn object identities even when contents don't change. The bridge's structural-compare must look at the leaves (`files`, `runs`, `viewModel.userCommentRows`, …). Tests in `view.test.ts` already cover the view-model invariants; we extend with bridge-level "no emit on identity churn" tests.
- **localStorage write fan-out.** A reply submitted in the detached window updates `ReviewState` in the parent, which writes `shippable:review:v1` — already keyed by changeset id and already shared per-origin. No code change here; just listing it because it's the boundary where docked-vs-detached parity is most visible to the user.

## File map (anticipated)

```
src-tauri/src/
  lib.rs                                # extend WindowRegistryState, add open_detached_window
  menu.rs                               # add View → Detach Sidebar / Detach Inspector items + action_for mapping
src-tauri/
  tauri.conf.json                       # whitelist /detached.html as a valid app URL if needed

web/
  detached.html                         # new entry, sibling of index.html / gallery.html
web/src/
  detached.tsx                          # new mount: <DetachedHost>
  multiWindow.ts                        # add open_detached_window, list_detached_children
  detachBridge.ts                       # new: parent-side emit/listen wiring (snapshot diff, action routing)
  detachedHost.tsx                      # new: child-side mount that renders <Sidebar> | <Inspector>
web/src/components/
  Sidebar.tsx                           # no change to component; add header detach button
  Sidebar.css                           # detach button styles
  Inspector.tsx                         # no change to component; add header detach button
  Inspector.css                         # detach button styles
  ReviewWorkspace.tsx                   # mount DetachBridge; gate <Sidebar>/<Inspector> on "no child registered"
```

The only components edited are the headers of `Sidebar` and `Inspector` (one button each). All new logic is additive: `detached.html`, `detached.tsx`, `detachBridge.ts`, `detachedHost.tsx`, plus three additions in `multiWindow.ts` and `lib.rs`, and two new menu items in `menu.rs`.

## Testing

- **View-model snapshot stability.** Extend `view.test.ts` with structural-diff cases: rebuilding a snapshot from an unchanged `ReviewState` produces a snapshot that compares equal under the bridge's structural-equality function. This is the test that catches accidental wire chatter.
- **Action round-trip.** A bridge-level test that emits each `SidebarAction` / `InspectorAction` and asserts the parent calls the corresponding existing handler with the right args. No DOM, no Tauri — just the listener mounted around a stub `ReviewWorkspace`-shaped handler map. Pure integration test, follows `docs/plans/test-strategy.md`.
- **Sidebar/inspector parity.** A higher-tier integration test (in-process `createApp()`-style per the test-strategy doc) that renders the docked panel, applies a sequence of user actions, then renders the detached panel against the same `ReviewState` and asserts identical output. Same shape as the multi-window duplicate-detection tests.
- **Manual UI exercise.** UI changes per `AGENTS.md` rule — opening the detached panel, exercising every callback, watching the parent update. No CI for UI yet; this is reviewer discipline.
