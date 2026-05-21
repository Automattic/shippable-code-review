export const DEFAULT_SHOW_INSPECTOR = true;
export const SHOW_INSPECTOR_STORAGE_KEY = "shippable:show-inspector";

export function getStoredShowInspector(): boolean {
  if (typeof window === "undefined") return DEFAULT_SHOW_INSPECTOR;
  try {
    const raw = window.localStorage.getItem(SHOW_INSPECTOR_STORAGE_KEY);
    return raw === "false" ? false : DEFAULT_SHOW_INSPECTOR;
  } catch {
    return DEFAULT_SHOW_INSPECTOR;
  }
}

export function persistShowInspector(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SHOW_INSPECTOR_STORAGE_KEY, String(value));
  } catch {
    // Storage can fail in private browsing or embedded contexts.
  }
}
