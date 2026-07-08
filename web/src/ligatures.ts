export const DEFAULT_LIGATURES = true;
export const LIGATURES_STORAGE_KEY = "shippable:ligatures";

export function getStoredLigatures(): boolean {
  if (typeof window === "undefined") return DEFAULT_LIGATURES;
  try {
    const raw = window.localStorage.getItem(LIGATURES_STORAGE_KEY);
    return raw === "false" ? false : DEFAULT_LIGATURES;
  } catch {
    return DEFAULT_LIGATURES;
  }
}

export function persistLigatures(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LIGATURES_STORAGE_KEY, String(value));
  } catch {
    // Storage can fail in private browsing or embedded contexts.
  }
}
