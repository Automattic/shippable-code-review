export const DEFAULT_HIDE_NON_ACTIVE_COMMENTS = false;
export const HIDE_NON_ACTIVE_COMMENTS_STORAGE_KEY =
  "shippable:hide-non-active-comments";

export function getStoredHideNonActiveComments(): boolean {
  if (typeof window === "undefined") return DEFAULT_HIDE_NON_ACTIVE_COMMENTS;
  try {
    const raw = window.localStorage.getItem(
      HIDE_NON_ACTIVE_COMMENTS_STORAGE_KEY,
    );
    return raw === "true" ? true : DEFAULT_HIDE_NON_ACTIVE_COMMENTS;
  } catch {
    return DEFAULT_HIDE_NON_ACTIVE_COMMENTS;
  }
}

export function persistHideNonActiveComments(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      HIDE_NON_ACTIVE_COMMENTS_STORAGE_KEY,
      String(value),
    );
  } catch {
    // Storage can fail in private browsing or embedded contexts.
  }
}
