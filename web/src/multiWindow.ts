// Bridge to the Rust-side window registry and window-spawn command.
// Mirrors the shape of `keychain.ts` — `isTauri()` guard means every export
// degrades to a no-op (or empty result) under browser dev, so callers
// don't need to branch.
//
// In the browser, users never reach these no-ops: the "New Window" / ↗
// affordances in `Welcome.tsx` and `LoadModal.tsx` are gated by
// `supportsNewWindow = isTauri()` and don't render. Users get the
// browser's native tabs/windows on `localhost:5173` instead. The no-ops
// here cover any code path that forgets to gate.

import { isTauri } from "./keychain";

export interface WindowEntry {
  label: string;
  changesetId: string | null;
}

export type DetachedKind = "sidebar" | "inspector";

export interface DetachedChildEntry {
  label: string;
  kind: DetachedKind;
}

const TOAST_EVENT = "shippable:toast";

let cachedLabel: string | null = null;

/** Tauri window label of the current page. `null` in browser dev. */
export async function currentWindowLabel(): Promise<string | null> {
  if (!isTauri()) return null;
  if (cachedLabel) return cachedLabel;
  const { getCurrentWebviewWindow } = await import(
    "@tauri-apps/api/webviewWindow"
  );
  cachedLabel = getCurrentWebviewWindow().label;
  return cachedLabel;
}

/** Spawn a new OS window. Pre-loads with `?cs=<id>` when given so the
 *  new window boots straight into the review. */
export async function openNewWindow(changesetId?: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_new_window", { changesetId: changesetId ?? null });
}

/** Tell Rust which changeset this window is currently showing. Pass null
 *  when the window goes back to the picker / welcome. */
export async function setWindowChangeset(
  changesetId: string | null,
): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_window_changeset", { changesetId });
}

export async function listWindowChangesets(): Promise<WindowEntry[]> {
  if (!isTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WindowEntry[]>("list_window_changesets");
}

/**
 * Pop the sidebar or inspector out as a child window of the calling
 * review window. The Rust side derives the parent label from the calling
 * webview, so the JS side doesn't need to know its own label. Idempotent:
 * if a child of the requested kind already exists for this parent, the
 * existing one is focused.
 */
export async function openDetachedWindow(kind: DetachedKind): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_detached_window", { kind });
}

/**
 * List the detached children currently owned by `parent`. Used by the
 * parent-side bridge to gate "hide docked panel" on the registry, the
 * single source of truth for whether a child actually exists.
 */
export async function listDetachedChildren(
  parent: string,
): Promise<DetachedChildEntry[]> {
  if (!isTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DetachedChildEntry[]>("list_detached_children", { parent });
}

/**
 * Close every detached child currently owned by `parent`. Called when the
 * parent loads a different review — detach is a per-review-session
 * affordance, so stale children get torn down. Each `.close()` schedules
 * a destroy that flows through the same Rust Destroyed arm as a manual
 * close, so the parent's bridge state self-heals via children-changed.
 */
export async function closeDetachedChildrenOf(parent: string): Promise<void> {
  if (!isTauri()) return;
  const { getAllWebviewWindows } = await import(
    "@tauri-apps/api/webviewWindow"
  );
  const prefix = `detached-${parent}-`;
  const all = await getAllWebviewWindows();
  await Promise.all(
    all
      .filter((w) => w.label.startsWith(prefix))
      .map((w) => w.close().catch(() => {})),
  );
}

export async function focusWindow(label: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("focus_window", { label });
}

/** Set the OS window title for this webview. No-op in browser dev. */
export async function setWindowTitle(title: string): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWebviewWindow } = await import(
    "@tauri-apps/api/webviewWindow"
  );
  await getCurrentWebviewWindow().setTitle(title);
}

/**
 * Look up which window — if any — already shows `changesetId`. Returns
 * the label or null. `excludeSelf` is true for in-place loads (re-loading
 * the same id in the current window is a no-op, not a duplicate) and
 * false for new-window spawns (opening a second copy when *this* window
 * already has it is itself a duplicate, just focus self).
 */
export async function findWindowWith(
  changesetId: string,
  { excludeSelf }: { excludeSelf: boolean },
): Promise<string | null> {
  if (!isTauri()) return null;
  const [self, entries] = await Promise.all([
    currentWindowLabel(),
    listWindowChangesets(),
  ]);
  for (const e of entries) {
    if (e.changesetId !== changesetId) continue;
    if (excludeSelf && e.label === self) continue;
    return e.label;
  }
  return null;
}

/**
 * In-place load guard. If another window already has `changesetId`,
 * focus that window and return true so callers can skip the dispatch
 * that would put the current window onto the same review. Returns false
 * otherwise. No-op in browser dev.
 */
export async function focusIfDuplicate(
  changesetId: string,
): Promise<boolean> {
  const label = await findWindowWith(changesetId, { excludeSelf: true });
  if (!label) return false;
  await focusWindow(label);
  return true;
}

/**
 * Used by "open in new window" affordances. Three outcomes:
 *  - if *any* window (including self) already has the id, focus that
 *    window and surface a toast in the current window — no new window.
 *  - otherwise, spawn a new window pointed at the id.
 *
 * Folds "already loaded here" and "already loaded somewhere else" into
 * one path so the user can't accidentally end up with two windows on
 * the same review by spamming the ↗ button.
 */
export async function openChangesetInWindow(
  changesetId: string,
): Promise<"focused-self" | "focused-other" | "opened-new" | "not-tauri"> {
  if (!isTauri()) return "not-tauri";
  const self = await currentWindowLabel();
  const existing = await findWindowWith(changesetId, { excludeSelf: false });
  if (existing) {
    if (existing === self) {
      emitToast("Already open in this window");
      return "focused-self";
    }
    await focusWindow(existing);
    emitToast("Already open in another window — focused it");
    return "focused-other";
  }
  await openNewWindow(changesetId);
  return "opened-new";
}

/** Listener-side helper: hand back the unsubscribe fn. */
export function onToastEvent(handler: (message: string) => void): () => void {
  function listener(e: Event) {
    const ce = e as CustomEvent<{ message: string }>;
    if (ce.detail?.message) handler(ce.detail.message);
  }
  window.addEventListener(TOAST_EVENT, listener);
  return () => window.removeEventListener(TOAST_EVENT, listener);
}

function emitToast(message: string): void {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message } }));
}
