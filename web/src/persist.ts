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

import { fileContentKey, hunkContentKey } from "./anchor";
import type {
  ChangeSet,
  Cursor,
  DiffFile,
  DiffLine,
  QuizState,
  ReviewState,
} from "./types";

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

// Head schema version is 8. Snapshots whose `v` isn't exactly 8 are rejected
// at load and the store boots empty. The prototype has no users to migrate.
// v3 → v4: interactions and detachedInteractions removed (moved to SQLite).
// v4 → v5: reviewedChangesets added (revision-scoped changeset sign-off,
// see docs/concepts/review-state.md § Review tokens).
// v5 → v6: quiz slice added (comprehension questions + answers + cooldown,
// see docs/plans/comprehension-quiz.md).
// v6 → v7: quiz dice + cooldown removed; `lastQuizAt` gone, `active.mode`
// added. Deterministic surfacing on sign-off events.
// v7 → v8: hunkKeys + fileKeys added — content keys that let read marks and
// reviewed flags survive changeset-id churn (worktree dirty-hash reloads).

/** What we actually serialize — Sets become arrays, ephemeral fields drop. */
interface PersistedSnapshot {
  v: 8;
  cursor: Cursor;
  /** Set<number> → number[] per hunk id. */
  readLines: Record<string, number[]>;
  /** hunkId → content key (anchor.ts hunkContentKey) for every readLines
   *  entry resolvable in the saved changesets. Lets hydration follow
   *  unchanged content to its new ids when the changeset id churns. */
  hunkKeys: Record<string, string>;
  reviewedFiles: string[];
  /** fileId → content key (anchor.ts fileContentKey), same purpose. */
  fileKeys: Record<string, string>;
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
  // Content keys for whatever the snapshot references and the loaded
  // changesets can resolve. Entries pointing at changesets not currently
  // loaded simply get no key — they can't re-key, same as before v8.
  const hunkById = new Map<string, { path: string; lines: DiffLine[] }>();
  const fileById = new Map<string, DiffFile>();
  for (const cs of state.changesets) {
    for (const f of cs.files) {
      fileById.set(f.id, f);
      for (const h of f.hunks) hunkById.set(h.id, { path: f.path, lines: h.lines });
    }
  }

  const readLines: Record<string, number[]> = {};
  const hunkKeys: Record<string, string> = {};
  for (const [hunkId, set] of Object.entries(state.readLines)) {
    if (set.size === 0) continue;
    readLines[hunkId] = Array.from(set).sort((a, b) => a - b);
    const hunk = hunkById.get(hunkId);
    if (hunk) hunkKeys[hunkId] = hunkContentKey(hunk.path, hunk.lines);
  }
  const cursorHunk = hunkById.get(state.cursor.hunkId);
  if (cursorHunk) {
    hunkKeys[state.cursor.hunkId] = hunkContentKey(cursorHunk.path, cursorHunk.lines);
  }

  const reviewedFiles = Array.from(state.reviewedFiles).sort();
  const fileKeys: Record<string, string> = {};
  for (const fileId of reviewedFiles) {
    const file = fileById.get(fileId);
    if (file) fileKeys[fileId] = fileContentKey(file);
  }

  const reviewedChangesets: Record<string, string[]> = {};
  for (const [csId, tokens] of Object.entries(state.reviewedChangesets)) {
    if (tokens.length === 0) continue;
    reviewedChangesets[csId] = [...tokens];
  }
  return {
    v: 8,
    cursor: state.cursor,
    readLines,
    hunkKeys,
    reviewedFiles,
    fileKeys,
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
  // between runs (or the user loaded an entirely different set). When the
  // exact ids are gone (worktree reload churned the changeset id) but the
  // cursor's hunk content survived, follow it to its new id.
  const hunkKeyIndex = indexHunksByContentKey(changesets);
  const cursor =
    validateCursor(snapshot.cursor, changesets) ??
    rekeyCursor(snapshot, hunkKeyIndex);

  // Rehydrate Sets and Maps. Entries whose hunk/file ids don't exist in the
  // current changesets re-key by content when the snapshot carries a content
  // key that matches — ids churn with the changeset id on every worktree
  // reload, and unchanged files shouldn't lose their marks. Anything that
  // neither matches by id nor by content is dropped — stale data from older
  // fixtures shouldn't poison the current session. (We don't drop them on
  // save — user might switch back to the older changeset later.)
  const validHunkIds = collectHunkIds(changesets);
  const validFileIds = collectFileIds(changesets);

  const readLines: Record<string, Set<number>> = {};
  for (const [hunkId, arr] of Object.entries(snapshot.readLines)) {
    const targetId = validHunkIds.has(hunkId)
      ? hunkId
      : rekeyByContent(hunkId, snapshot.hunkKeys, hunkKeyIndex)?.hunkId;
    if (!targetId) continue;
    const set = readLines[targetId] ?? new Set<number>();
    for (const n of arr) if (Number.isFinite(n)) set.add(n);
    readLines[targetId] = set;
  }

  const fileKeyIndex = indexFilesByContentKey(changesets);
  const reviewedFiles = new Set<string>();
  for (const fileId of snapshot.reviewedFiles) {
    if (validFileIds.has(fileId)) {
      reviewedFiles.add(fileId);
      continue;
    }
    const key = snapshot.fileKeys[fileId];
    const rekeyed = key ? fileKeyIndex.get(key) : undefined;
    if (rekeyed) reviewedFiles.add(rekeyed);
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
      reviewedFiles,
      reviewedChangesets,
      dismissedGuides: new Set(snapshot.dismissedGuides),
      quiz: snapshot.quiz,
    },
    drafts: filterDraftsByHunk(snapshot.drafts, validHunkIds),
  };
}

// ─── helpers ────────────────────────────────────────────────────────────

/** Content-key → location of the first hunk with that content in the
 *  loaded changesets. Duplicate content keeps the first hit — a stale
 *  match lands somewhere identical, which is as good as correct. */
interface HunkLocation {
  changesetId: string;
  fileId: string;
  hunkId: string;
  lineCount: number;
}

function indexHunksByContentKey(
  changesets: ChangeSet[],
): Map<string, HunkLocation> {
  const out = new Map<string, HunkLocation>();
  for (const cs of changesets) {
    for (const f of cs.files) {
      for (const h of f.hunks) {
        const key = hunkContentKey(f.path, h.lines);
        if (!out.has(key)) {
          out.set(key, {
            changesetId: cs.id,
            fileId: f.id,
            hunkId: h.id,
            lineCount: h.lines.length,
          });
        }
      }
    }
  }
  return out;
}

function indexFilesByContentKey(changesets: ChangeSet[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const cs of changesets) {
    for (const f of cs.files) {
      const key = fileContentKey(f);
      if (!out.has(key)) out.set(key, f.id);
    }
  }
  return out;
}

function rekeyByContent(
  hunkId: string,
  hunkKeys: Record<string, string>,
  index: Map<string, HunkLocation>,
): HunkLocation | undefined {
  const key = hunkKeys[hunkId];
  return key ? index.get(key) : undefined;
}

/** Follow the persisted cursor's hunk content to its new ids. Same-content
 *  hunks have the same line count, but clamp anyway — the key is a hash. */
function rekeyCursor(
  snapshot: PersistedSnapshot,
  index: Map<string, HunkLocation>,
): Cursor | null {
  const hit = rekeyByContent(snapshot.cursor.hunkId, snapshot.hunkKeys, index);
  if (!hit) return null;
  return {
    changesetId: hit.changesetId,
    fileId: hit.fileId,
    hunkId: hit.hunkId,
    lineIdx: Math.max(0, Math.min(hit.lineCount - 1, snapshot.cursor.lineIdx)),
  };
}

function isPersistedSnapshot(x: unknown): x is PersistedSnapshot {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (
    o.v !== 8 ||
    typeof o.cursor !== "object" ||
    typeof o.readLines !== "object" ||
    !isStringRecord(o.hunkKeys) ||
    !Array.isArray(o.reviewedFiles) ||
    !isStringRecord(o.fileKeys) ||
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
    !Array.isArray(q.asked)
  ) {
    return false;
  }
  if (q.active !== null) {
    if (typeof q.active !== "object") return false;
    const a = q.active as Record<string, unknown>;
    if (typeof a.questionId !== "string") return false;
    if (a.mode !== "single" && a.mode !== "sequence") return false;
  }
  for (const id of q.asked) if (typeof id !== "string") return false;
  return true;
}

function isStringRecord(x: unknown): x is Record<string, string> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  for (const v of Object.values(x)) if (typeof v !== "string") return false;
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
  // Skip hunkless entries (binary adds, pure renames) and anchor on the
  // first reviewable hunk — same rule as the reducer's LOAD_CHANGESET.
  const seatFile = cs.files.find((f) => f.hunks.length > 0);
  const seatHunk = seatFile?.hunks[0];
  if (!seatFile || !seatHunk) return null;
  return {
    changesetId: cs.id,
    fileId: seatFile.id,
    hunkId: seatHunk.id,
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
