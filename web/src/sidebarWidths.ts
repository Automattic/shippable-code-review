export const DEFAULT_SIDEBAR_WIDTH = 320;
export const DEFAULT_INSPECTOR_WIDTH = 340;

const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 640;
const INSPECTOR_MIN = 260;
const INSPECTOR_MAX = 560;

const SIDEBAR_WIDTH_STORAGE_KEY = "shippable:sidebar-width";
const INSPECTOR_WIDTH_STORAGE_KEY = "shippable:inspector-width";

const clamp = (px: number, min: number, max: number): number =>
  Math.round(Math.min(max, Math.max(min, px)));

export const clampSidebarWidth = (px: number): number =>
  clamp(px, SIDEBAR_MIN, SIDEBAR_MAX);
export const clampInspectorWidth = (px: number): number =>
  clamp(px, INSPECTOR_MIN, INSPECTOR_MAX);

function readWidth(
  key: string,
  fallback: number,
  clampFn: (px: number) => number,
): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? clampFn(n) : fallback;
  } catch {
    return fallback;
  }
}

function writeWidth(key: string, value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Storage can fail in private browsing or embedded contexts.
  }
}

export const getStoredSidebarWidth = (): number =>
  readWidth(SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH, clampSidebarWidth);
export const getStoredInspectorWidth = (): number =>
  readWidth(
    INSPECTOR_WIDTH_STORAGE_KEY,
    DEFAULT_INSPECTOR_WIDTH,
    clampInspectorWidth,
  );

export const persistSidebarWidth = (value: number): void =>
  writeWidth(SIDEBAR_WIDTH_STORAGE_KEY, value);
export const persistInspectorWidth = (value: number): void =>
  writeWidth(INSPECTOR_WIDTH_STORAGE_KEY, value);
