export const DEFAULT_INLINE_COMMENTS = false;
export const INLINE_COMMENTS_STORAGE_KEY = "shippable:inline-comments";

export function getStoredInlineComments(): boolean {
  if (typeof window === "undefined") return DEFAULT_INLINE_COMMENTS;
  try {
    const raw = window.localStorage.getItem(INLINE_COMMENTS_STORAGE_KEY);
    return raw === "true" ? true : DEFAULT_INLINE_COMMENTS;
  } catch {
    return DEFAULT_INLINE_COMMENTS;
  }
}

export function persistInlineComments(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INLINE_COMMENTS_STORAGE_KEY, String(value));
  } catch {
    // Storage can fail in private browsing or embedded contexts.
  }
}
