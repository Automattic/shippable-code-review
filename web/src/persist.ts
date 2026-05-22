/**
 * persist.ts — single-key, schema-versioned localStorage persistence
 * for the review session. Hydrates on boot, debounced-saves on change.
 *
 * Why a single key (`shippable:review:v1`) and not a key-per-changeset:
 * the data already namespaces by hunkId / fileId (those embed the cs id),
 * so a single blob loads everything the user has touched. Cheap to clear
 * and trivial to inspect with devtools.
 *
 * Why not Zustand / React Query / etc: this is throwaway prototype glue.
 * Interactions have moved to the server DB; this module now persists ONLY
 * review progress (cursor, readLines, reviewedFiles, dismissedGuides, drafts).
 */

import type { ChangeSet, Cursor, QuizState, ReviewState } from "./types";

const STORAGE_KEY = "shippable:review:v1";

/**
 * Per-worktree live-reload toggle. Keyed by absolute worktree path so
 * pausing on one tree doesn't pause others. Default-on for first encounter
 * (a missing key returns true). Stored in its own JSON object rather than
 * folded into the review snapshot — toggle state outlives any single review
 * and shouldn't get reset by `clearSession()`.
 */
const LIVE_RELOAD_TOGGLE_KEY = "shippable:liveReload:v1";

function readLiveReloadMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LIVE_RELOAD_TOGGLE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function getLiveReloadEnabled(worktreePath: string): boolean {
  const map = readLiveReloadMap();
  return map[worktreePath] ?? true;
}

export function setLiveReloadEnabled(
  worktreePath: string,
  enabled: boolean,
): void {
  try {
    const map = readLiveReloadMap();
    map[worktreePath] = enabled;
    localStorage.setItem(LIVE_RELOAD_TOGGLE_KEY, JSON.stringify(map));
  } catch {
    // ignore — toggle persistence is a nice-to-have
  }
}

// Head schema version is 6. Snapshots whose `v` isn't exactly 6 are rejected
// at load and the store boots empty. The prototype has no users to migrate.
// v3 → v4: interactions and detachedInteractions removed (moved to SQLite).
// v4 → v5: reviewedChangesets added (revision-scoped changeset sign-off,
// see docs/concepts/review-state.md § Review tokens).
// v5 → v6: quiz slice added (comprehension questions + answers + cooldown,
// see docs/plans/comprehension-quiz.md).

/** What we actually serialize — Sets become arrays, ephemeral fields drop. */
interface PersistedSnapshot {
  v: 6;
  cursor: Cursor;
  /** Set<number> → number[] per hunk id. */
  readLines: Record<string, number[]>;
  reviewedFiles: string[];
  /** changesetId → review tokens at which sign-off was given for that cs. */
  reviewedChangesets: Record<string, string[]>;
  dismissedGuides: string[];
  drafts: Record<string, string>;
  quiz: QuizState;
}

/** What hydration returns after validation. Both fields default to "no
 *  change from blank slate" when the snapshot is missing or invalid. */
export interface HydratedSession {
  state: {
    cursor: Cursor;
    readLines: Record<string, Set<number>>;
    reviewedFiles: Set<string>;
    reviewedChangesets: Record<string, string[]>;
    dismissedGuides: Set<string>;
    quiz: QuizState;
  } | null;
  drafts: Record<string, string>;
}

/**
 * Build the JSON-safe snapshot. Caller decides when to write — typically
 * a debounced effect on state/drafts change.
 */
export function buildSnapshot(
  state: ReviewState,
  drafts: Record<string, string>,
): PersistedSnapshot {
  const readLines: Record<string, number[]> = {};
  for (const [hunkId, set] of Object.entries(state.readLines)) {
    if (set.size === 0) continue;
    readLines[hunkId] = Array.from(set).sort((a, b) => a - b);
  }
  const reviewedChangesets: Record<string, string[]> = {};
  for (const [csId, tokens] of Object.entries(state.reviewedChangesets)) {
    if (tokens.length === 0) continue;
    reviewedChangesets[csId] = [...tokens];
  }
  return {
    v: 6,
    cursor: state.cursor,
    readLines,
    reviewedFiles: Array.from(state.reviewedFiles).sort(),
    reviewedChangesets,
    dismissedGuides: Array.from(state.dismissedGuides).sort(),
    drafts,
    quiz: state.quiz,
  };
}

/** Best-effort save. Swallows storage errors (private mode, quota) silently. */
export function saveSession(
  state: ReviewState,
  drafts: Record<string, string>,
): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buildSnapshot(state, drafts)));
  } catch {
    // ignore — persistence is a nice-to-have, not load-bearing
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Raw snapshot read without changeset validation. Used at boot to decide
 * which changeset to hydrate (the snapshot's cursor.changesetId tells us
 * what to look up in stubs/recents), before we have a changesets array
 * to pass to loadSession. Returns null if the storage entry is missing
 * or malformed.
 */
export function peekSession(): PersistedSnapshot | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isPersistedSnapshot(parsed) ? parsed : null;
}

/**
 * Heuristic for "the user actually did something." Just visiting the app
 * triggers a debounced save of the seeded state (cursor on line 0, one
 * read line), so existence-of-snapshot alone isn't a useful signal — we
 * need to look at what's *in* it.
 */
export function hasProgress(s: PersistedSnapshot): boolean {
  if (s.reviewedFiles.length > 0) return true;
  for (const arr of Object.values(s.reviewedChangesets)) {
    if (arr.length > 0) return true;
  }
  for (const arr of Object.values(s.readLines)) {
    if (arr.length > 1) return true;
  }
  for (const v of Object.values(s.drafts)) {
    if (v && v.trim()) return true;
  }
  // Cursor moved beyond line 0 — user navigated the diff (e.g. jumped to a
  // note with `n`). lineIdx = 0 is the default initial position; anything
  // higher means deliberate engagement, even before a second line is read.
  if (s.cursor.lineIdx > 0) return true;
  return false;
}

/**
 * Read + validate the persisted snapshot. Returns hydrated state shaped
 * to overlay onto initialState. Cursor is validated against the loaded
 * changesets — if the persisted file/hunk no longer exists, we fall back
 * to the default cursor (caller passes null).
 */
export function loadSession(changesets: ChangeSet[]): HydratedSession {
  const empty: HydratedSession = { state: null, drafts: {} };
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return empty;
  }
  if (!raw) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isPersistedSnapshot(parsed)) return empty;
  const snapshot = parsed;

  // Validate the cursor against current changesets — fixtures change
  // between runs (or the user loaded an entirely different set).
  const cursor = validateCursor(snapshot.cursor, changesets);

  // Rehydrate Sets and Maps. Drop entries whose hunk/file ids don't
  // exist in the current changesets — stale data from older fixtures
  // shouldn't poison the current session. (We don't drop them on save —
  // user might switch back to the older changeset later.)
  const validHunkIds = collectHunkIds(changesets);
  const validFileIds = collectFileIds(changesets);

  const readLines: Record<string, Set<number>> = {};
  for (const [hunkId, arr] of Object.entries(snapshot.readLines)) {
    if (!validHunkIds.has(hunkId)) continue;
    readLines[hunkId] = new Set(arr.filter((n) => Number.isFinite(n)));
  }

  // No valid persisted cursor and no usable fallback in the current
  // changesets — return null state so the caller knows nothing to overlay.
  // Hits the welcome boot (no changesets) AND the poisoned-recent path
  // where the only changeset has no files / no hunks.
  const resolvedCursor = cursor ?? defaultCursor(changesets);
  if (!resolvedCursor) return empty;

  // reviewedChangesets is keyed by changesetId, not by a structure that varies
  // per load. Entries for changesets not currently loaded are kept so a future
  // load of the same changeset (recents, re-open) re-reads sign-off without
  // re-confirmation. Tokens are validated lazily — a stale token simply won't
  // match the current revision's derived token.
  const reviewedChangesets: Record<string, string[]> = {};
  for (const [csId, tokens] of Object.entries(snapshot.reviewedChangesets)) {
    if (tokens.length === 0) continue;
    reviewedChangesets[csId] = [...tokens];
  }

  return {
    state: {
      cursor: resolvedCursor,
      readLines,
      reviewedFiles: new Set(snapshot.reviewedFiles.filter((id) => validFileIds.has(id))),
      reviewedChangesets,
      dismissedGuides: new Set(snapshot.dismissedGuides),
      quiz: snapshot.quiz,
    },
    drafts: filterDraftsByHunk(snapshot.drafts, validHunkIds),
  };
}

// ─── helpers ────────────────────────────────────────────────────────────

function isPersistedSnapshot(x: unknown): x is PersistedSnapshot {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (
    o.v !== 6 ||
    typeof o.cursor !== "object" ||
    typeof o.readLines !== "object" ||
    !Array.isArray(o.reviewedFiles) ||
    typeof o.reviewedChangesets !== "object" || o.reviewedChangesets === null ||
    !Array.isArray(o.dismissedGuides) ||
    typeof o.drafts !== "object" ||
    typeof o.quiz !== "object" || o.quiz === null
  ) {
    return false;
  }
  for (const tokens of Object.values(o.reviewedChangesets as Record<string, unknown>)) {
    if (!Array.isArray(tokens)) return false;
    for (const t of tokens) if (typeof t !== "string") return false;
  }
  const q = o.quiz as Record<string, unknown>;
  if (
    !q.questions || typeof q.questions !== "object" ||
    !q.answers || typeof q.answers !== "object" ||
    (q.active !== null && (typeof q.active !== "object" || typeof (q.active as Record<string, unknown>).questionId !== "string")) ||
    (q.lastQuizAt !== null && typeof q.lastQuizAt !== "number") ||
    !Array.isArray(q.asked)
  ) {
    return false;
  }
  for (const id of q.asked) if (typeof id !== "string") return false;
  return true;
}

function validateCursor(
  cursor: Cursor,
  changesets: ChangeSet[],
): Cursor | null {
  const cs = changesets.find((c) => c.id === cursor.changesetId);
  if (!cs) return null;
  const file = cs.files.find((f) => f.id === cursor.fileId);
  if (!file) return null;
  const hunk = file.hunks.find((h) => h.id === cursor.hunkId);
  if (!hunk) return null;
  if (cursor.lineIdx < 0 || cursor.lineIdx >= hunk.lines.length) return null;
  return cursor;
}

function defaultCursor(changesets: ChangeSet[]): Cursor | null {
  const cs = changesets[0];
  if (!cs) return null;
  const file = cs.files[0];
  if (!file) return null;
  const hunk = file.hunks[0];
  if (!hunk) return null;
  return {
    changesetId: cs.id,
    fileId: file.id,
    hunkId: hunk.id,
    lineIdx: 0,
  };
}

function collectHunkIds(changesets: ChangeSet[]): Set<string> {
  const out = new Set<string>();
  for (const cs of changesets) {
    for (const f of cs.files) {
      for (const h of f.hunks) out.add(h.id);
    }
  }
  return out;
}

function collectFileIds(changesets: ChangeSet[]): Set<string> {
  const out = new Set<string>();
  for (const cs of changesets) {
    for (const f of cs.files) out.add(f.id);
  }
  return out;
}

function filterDraftsByHunk(
  drafts: Record<string, string>,
  validHunkIds: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, body] of Object.entries(drafts)) {
    if (!body) continue;
    if (replyKeyTargetsValidHunk(key, validHunkIds)) out[key] = body;
  }
  return out;
}

/**
 * Thread-key shapes (see types.ts):
 *   note:hunkId:lineIdx · user:hunkId:lineIdx · block:hunkId:lo-hi
 *   hunkSummary:hunkId  · teammate:hunkId
 * The hunkId can contain `/` and `#`, so we split on the first colon to
 * get the prefix and treat the remainder accordingly.
 */
function replyKeyTargetsValidHunk(
  key: string,
  validHunkIds: Set<string>,
): boolean {
  const colon = key.indexOf(":");
  if (colon < 0) return false;
  const prefix = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  switch (prefix) {
    case "hunkSummary":
    case "teammate":
      return validHunkIds.has(rest);
    case "note":
    case "user": {
      const last = rest.lastIndexOf(":");
      if (last < 0) return false;
      return validHunkIds.has(rest.slice(0, last));
    }
    case "block": {
      const last = rest.lastIndexOf(":");
      if (last < 0) return false;
      return validHunkIds.has(rest.slice(0, last));
    }
    default:
      return false;
  }
}
