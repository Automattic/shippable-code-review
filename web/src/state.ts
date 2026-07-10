import type {
  CharRange,
  Confidence,
  Cursor,
  ChangeSet,
  DetachedInteraction,
  DiffFile,
  DiffLine,
  Hunk,
  Interaction,
  InteractionTarget,
  LineSelection,
  ParsedReplyKey,
  Question,
  ReviewState,
  QuizState,
  QuizSelfEval,
} from "./types";
import {
  blockCommentKey,
  hunkSummaryReplyKey,
  isValidInteractionPair,
  lineNoteReplyKey,
  mintCommentId,
  parseReplyKey,
  teammateReplyKey,
  userCommentKey,
  userFileCommentKey,
} from "./types";
import { captureAnchorContext, findAnchorInFile, hashAnchorWindow } from "./anchor";
import { enrichWithFileContent } from "./expandContext";
import { newReviewerInteractionId } from "./interactions";
import { pickNextForFile, pickNextForChangeset } from "./quiz";

/**
 * Wire shape returned by `GET /api/agent/replies` — one envelope serves
 * both shapes the agent posts:
 *   - reply-shaped (`parentId` set) — a response to a delivered reviewer
 *     interaction. `parentId` is the client-authoritative interaction id
 *     the agent saw; the reducer resolves it → threadKey by matching
 *     `state.interactions[*].id` and merges the entry into that thread.
 *   - Top-level-shaped (`file` + `lines` set) — a fresh thread the agent
 *     started, anchored at (file, lines). The reducer resolves (file,
 *     lines) → hunkId by walking the active changeset, then builds the
 *     matching user:/block: thread key. Unresolvable entries (file not
 *     in the diff, or lines outside any hunk) land in
 *     `state.detachedInteractions`.
 */
export type PolledAgentReply =
  | {
      id: string;
      parentId: string;
      body: string;
      intent: "ack" | "accept" | "reject";
      author: string;
      authorRole: "agent";
      target: InteractionTarget;
      postedAt: string;
    }
  | {
      id: string;
      /** Repo-relative file path. */
      file: string;
      /** Line number or range — `"118"` or `"72-79"`. */
      lines: string;
      body: string;
      intent: "comment" | "question" | "request" | "blocker";
      author: string;
      authorRole: "agent";
      target: "line" | "block";
      postedAt: string;
      /** Structured fields, present only when the agent supplied them. */
      rationale?: string;
      suggestedFix?: string;
      confidence?: Confidence;
    };

/**
 * Sentinel cursor used while no changeset is loaded (welcome screen).
 * Reading any field on it before LOAD_CHANGESET is a bug — render code
 * must check `state.changesets.length === 0` first.
 */
export const EMPTY_CURSOR: Cursor = {
  changesetId: "",
  fileId: "",
  hunkId: "",
  lineIdx: 0,
};

/** Comprehension-quiz constants — see docs/plans/comprehension-quiz.md.
 *  Surfacing is deterministic now; no dice, no cooldown. */

export const EMPTY_QUIZ: QuizState = {
  questions: {},
  answers: {},
  active: null,
  asked: [],
};

export function initialState(
  seed: ChangeSet[],
  seedInteractions: Record<string, Interaction[]> = {},
): ReviewState {
  // Same anchoring rule as LOAD_CHANGESET: skip hunkless entries (binary
  // adds, pure renames) and seat the cursor on the first reviewable hunk.
  // A persisted recent pointing at a changeset with a hunkless files[0]
  // used to crash here at boot.
  const cs = seed[0];
  const seatFile = cs?.files.find((f) => f.hunks.length > 0);
  const seatHunk = seatFile?.hunks[0];
  if (!cs || !seatFile || !seatHunk) {
    return {
      cursor: EMPTY_CURSOR,
      changesets: [],
      readLines: {},
      reviewedFiles: new Set(),
      reviewedChangesets: {},
      dismissedGuides: new Set(),
      interactions: { ...seedInteractions },
      expandLevelAbove: {},
      expandLevelBelow: {},
      fullExpandedFiles: new Set(),
      previewedFiles: new Set(),
      selection: null,
      detachedInteractions: [],
      quiz: EMPTY_QUIZ,
    };
  }
  return {
    cursor: { changesetId: cs.id, fileId: seatFile.id, hunkId: seatHunk.id, lineIdx: 0 },
    changesets: seed,
    readLines: addLine({}, seatHunk.id, 0),
    reviewedFiles: new Set(),
    reviewedChangesets: {},
    dismissedGuides: new Set(),
    interactions: { ...seedInteractions },
    expandLevelAbove: {},
    expandLevelBelow: {},
    fullExpandedFiles: new Set(),
    previewedFiles: new Set(),
    selection: null,
    detachedInteractions: [],
    quiz: EMPTY_QUIZ,
  };
}

function addLine(
  existing: Record<string, Set<number>>,
  hunkId: string,
  lineIdx: number,
): Record<string, Set<number>> {
  const set = new Set(existing[hunkId] ?? []);
  set.add(lineIdx);
  return { ...existing, [hunkId]: set };
}

export type Action =
  | {
      type: "MOVE_LINE";
      delta: number;
      extend?: boolean;
      /**
       * When true, a same-hunk move preserves the existing selection
       * instead of collapsing it. Used while a block-comment draft is
       * open so the reviewer can scroll back through the range they're
       * commenting on without losing the visual cue.
       */
      preserveSelection?: boolean;
    }
  | { type: "MOVE_HUNK"; delta: number }
  | { type: "MOVE_FILE"; delta: number }
  | { type: "MOVE_TO_COMMENT"; delta: number }
  | { type: "SET_CURSOR"; cursor: Cursor; selection?: LineSelection | null }
  | { type: "COLLAPSE_SELECTION" }
  | { type: "SWITCH_CHANGESET"; changesetId: string }
  | {
      type: "LOAD_CHANGESET";
      changeset: ChangeSet;
      interactions?: Record<string, Interaction[]>;
    }
  | {
      // Reload a changeset that's already in state with a fresh snapshot,
      // preserving comments via the content-anchor pass. The new ChangeSet
      // typically carries a different id (sha changed); `prevChangesetId`
      // tells the reducer which entry to replace.
      type: "RELOAD_CHANGESET";
      prevChangesetId: string;
      changeset: ChangeSet;
    }
  | { type: "DISMISS_GUIDE"; guideId: string }
  | {
      // Toggle the local user's ack on the AI note at (hunkId, lineIdx).
      // Appends an Interaction { intent: "ack" } or { intent: "unack" }
      // depending on the user's most recent response on that thread. The
      // append-only log preserves history; the seam derives current state.
      type: "TOGGLE_ACK";
      hunkId: string;
      lineIdx: number;
      /** Local-user display name. Defaults to "you" if omitted. */
      author?: string;
    }
  | { type: "ADD_INTERACTION"; targetKey: string; interaction: Interaction }
  | { type: "DELETE_INTERACTION"; targetKey: string; interactionId: string }
  | {
      // Mark an Interaction's enqueue attempt as errored / cleared. Drives
      // the ⚠ retry pip in ReplyThread; set by the catch path of an
      // enqueue/sync request and cleared before retry. A delivered or
      // pending `agentQueueStatus` wins over a stale error flag.
      type: "SET_INTERACTION_ENQUEUE_ERROR";
      targetKey: string;
      interactionId: string;
      error: boolean;
    }
  | {
      // Merge a polled batch of agent responses into state.interactions,
      // resolving each reply-shaped entry against the user Interaction
      // whose `id` matches `parentId`. Idempotent: existing ids update in
      // place, new ids append on the same thread, sorted by createdAt.
      type: "MERGE_AGENT_REPLIES";
      polled: PolledAgentReply[];
    }
  | { type: "SET_EXPAND_LEVEL"; hunkId: string; dir: "above" | "below"; level: number }
  | { type: "TOGGLE_EXPAND_FILE"; fileId: string }
  | {
      // Replace a file in the active changeset with one enriched from
      // post-change source. Lazy-fetched on first expand-bar / Source-tab
      // click for files the worktree-changeset endpoint didn't ship content
      // for (everything but `.md` today). No-op if the file is already
      // hydrated or not found — safe to dispatch from a racing fetch.
      type: "HYDRATE_FILE";
      changesetId: string;
      fileId: string;
      postChangeText: string;
    }
  | { type: "TOGGLE_PREVIEW_FILE"; fileId: string }
  | { type: "TOGGLE_FILE_REVIEWED"; fileId: string }
  | {
      // Toggle the current changeset's sign-off at its current review token
      // (`getChangesetReviewToken`). On: append the token to
      // `reviewedChangesets[changesetId]` (no-op if already present). Off:
      // remove only that token's entry — every other entry on the list
      // (prior revisions) is preserved (W6, D4). No-op when the token is null
      // (paste / upload / stub / fixture — D6).
      type: "TOGGLE_CHANGESET_REVIEWED";
      changesetId: string;
    }
  | {
      // Set the line-range selection directly without moving the cursor.
      // Used by the DiffView drag pipeline once per pointermove tick. Drops
      // any prior charRange when anchor !== head; ignored if hunkId differs
      // from the cursor's current hunk.
      type: "SET_SELECTION_RANGE";
      hunkId: string;
      anchor: number;
      head: number;
      charRange?: CharRange;
    }
  | {
      // Set a single-line char-range selection from native text-selection
      // mouseup. No-op when fromCol >= toCol.
      type: "SET_LINE_CHAR_RANGE";
      hunkId: string;
      lineIdx: number;
      fromCol: number;
      toCol: number;
    }
  | {
      // Mark every lineIdx in [loLineIdx, hiLineIdx] as read for `hunkId`.
      // Leaves cursor + selection untouched. Driven by the right-click
      // "Mark as read" menu item.
      type: "MARK_LINES_READ";
      hunkId: string;
      loLineIdx: number;
      hiLineIdx: number;
    }
  | {
      type: "MARK_LINES_UNREAD";
      hunkId: string;
      loLineIdx: number;
      hiLineIdx: number;
    }
  | {
      /**
       * Overlay PR metadata onto an existing worktree-loaded ChangeSet. The
       * diff structure (files/hunks) is untouched; only `prSource` and
       * `prConversation` are set. `worktreeSource` is preserved. PR review
       * comments arrive separately via MERGE_PR_INTERACTIONS.
       */
      type: "MERGE_PR_OVERLAY";
      changesetId: string;
      prSource: import("./types").PrSource;
      prConversation: import("./types").PrConversationItem[];
    }
  | {
      /**
       * Install PR-sourced interactions and detached entries. Idempotent
       * across refresh: every existing entry tagged
       * `external.source === "pr"` is removed before the new entries are
       * merged in, so re-fetching the same PR doesn't accumulate
       * duplicates.
       */
      type: "MERGE_PR_INTERACTIONS";
      changesetId: string;
      prInteractions: Record<string, Interaction[]>;
      prDetached: DetachedInteraction[];
    }
  | { type: "STORE_QUESTIONS"; changesetId: string; questions: Question[] }
  | { type: "TRIGGER_QUIZ_FOR_FILE"; changesetId: string; fileId: string }
  | { type: "TRIGGER_QUIZ_FOR_CHANGESET"; changesetId: string }
  | { type: "DISMISS_QUIZ" }
  | { type: "SUBMIT_QUIZ_ANSWER"; questionId: string; answer: string; now: number }
  | { type: "SET_QUIZ_SELF_EVAL"; questionId: string; selfEval: QuizSelfEval }
  | { type: "CLEAR_QUIZ_ACTIVE" };

export function reducer(state: ReviewState, action: Action): ReviewState {
  // Welcome mode (no changesets) — only LOAD_CHANGESET is meaningful.
  // Everything else assumes a current changeset/file/hunk and would
  // crash on the sentinel cursor. The UI also blocks these dispatches,
  // so this is a defensive belt to the suspenders above.
  // STORE_QUESTIONS is keyed by changesetId only — no cursor dependency.
  if (
    state.changesets.length === 0 &&
    action.type !== "LOAD_CHANGESET" &&
    action.type !== "STORE_QUESTIONS"
  ) {
    return state;
  }
  switch (action.type) {
    case "MOVE_LINE":
      return moveLine(
        state,
        action.delta,
        action.extend ?? false,
        action.preserveSelection ?? false,
      );
    case "COLLAPSE_SELECTION":
      return state.selection === null ? state : { ...state, selection: null };
    case "MOVE_HUNK":
      return moveHunk(state, action.delta);
    case "MOVE_FILE":
      return moveFile(state, action.delta);
    case "MOVE_TO_COMMENT":
      return moveToComment(state, action.delta);
    case "SET_CURSOR": {
      const applied = applyCursor(state, action.cursor, false);
      if (action.selection === undefined) return applied;
      return { ...applied, selection: action.selection };
    }
    case "SWITCH_CHANGESET": {
      const cs = state.changesets.find((c) => c.id === action.changesetId);
      if (!cs) return state;
      const file = cs.files[0];
      const hunk = file.hunks[0];
      const cursor = {
        changesetId: cs.id,
        fileId: file.id,
        hunkId: hunk.id,
        lineIdx: 0,
      };
      return {
        ...state,
        cursor,
        selection: null,
        readLines: addLine(state.readLines, hunk.id, 0),
      };
    }
    case "LOAD_CHANGESET": {
      const cs = action.changeset;
      // Seat the cursor on the first file that actually has hunks. Binary
      // adds, pure renames, etc. produce hunkless entries that are kept in
      // the file list but can't anchor a cursor — `cs.files[0]` is the
      // wrong default when one of those happens to come first.
      const seatFile = cs.files.find((f) => f.hunks.length > 0);
      const seatHunk = seatFile?.hunks[0];
      if (!seatFile || !seatHunk) return state;
      const existingIdx = state.changesets.findIndex((c) => c.id === cs.id);
      const nextList =
        existingIdx >= 0
          ? state.changesets.map((c, i) => (i === existingIdx ? cs : c))
          : [...state.changesets, cs];

      // When reloading a changeset that the cursor is already on, preserve
      // the cursor position if the target file and hunk still exist in the
      // new diff. Falls back to the first hunk-bearing file if the file or
      // hunk has disappeared (e.g., file removed in a PR update).
      let nextCursor: Cursor;
      if (existingIdx >= 0 && state.cursor.changesetId === cs.id) {
        const curFile = cs.files.find((f) => f.id === state.cursor.fileId);
        const curHunk = curFile?.hunks.find((h) => h.id === state.cursor.hunkId);
        if (curFile && curHunk) {
          const maxLine = curHunk.lines.length - 1;
          nextCursor = {
            changesetId: cs.id,
            fileId: curFile.id,
            hunkId: curHunk.id,
            lineIdx: Math.min(state.cursor.lineIdx, Math.max(0, maxLine)),
          };
        } else {
          nextCursor = { changesetId: cs.id, fileId: seatFile.id, hunkId: seatHunk.id, lineIdx: 0 };
        }
      } else {
        nextCursor = { changesetId: cs.id, fileId: seatFile.id, hunkId: seatHunk.id, lineIdx: 0 };
      }

      return {
        ...state,
        changesets: nextList,
        cursor: nextCursor,
        selection: null,
        readLines: addLine(state.readLines, nextCursor.hunkId, nextCursor.lineIdx),
        // Merge incoming interactions per thread: start from current state
        // (user-authored + stub AI notes), then append any entries from the
        // incoming map that aren't already present by id. This lets a DB
        // fetch re-hydrate user interactions on a stub-seeded thread without
        // losing the AI note, while also preserving any locally-authored
        // entries that appeared mid-session.
        interactions: action.interactions
          ? mergeInteractionMaps(state.interactions, action.interactions)
          : state.interactions,
      };
    }
    case "RELOAD_CHANGESET":
      return reloadChangeset(state, action.prevChangesetId, action.changeset);
    case "DISMISS_GUIDE": {
      const next = new Set(state.dismissedGuides);
      next.add(action.guideId);
      return { ...state, dismissedGuides: next };
    }
    case "TOGGLE_ACK": {
      const threadKey = lineNoteReplyKey(action.hunkId, action.lineIdx);
      const author = action.author ?? "you";
      const existing = state.interactions[threadKey] ?? [];
      // Find the author's most recent response on the thread.
      let lastResponse: Interaction | undefined;
      for (let i = existing.length - 1; i >= 0; i--) {
        const ix = existing[i];
        if (ix.author !== author) continue;
        if (ix.intent === "ack" || ix.intent === "unack") {
          lastResponse = ix;
          break;
        }
      }
      const nextIntent: "ack" | "unack" =
        lastResponse?.intent === "ack" ? "unack" : "ack";
      const interaction: Interaction = {
        id: newReviewerInteractionId(),
        threadKey,
        target: "reply",
        intent: nextIntent,
        author,
        authorRole: "user",
        body: "",
        createdAt: new Date().toISOString(),
      };
      return {
        ...state,
        interactions: {
          ...state.interactions,
          [threadKey]: [...existing, interaction],
        },
      };
    }
    case "ADD_INTERACTION": {
      if (!isValidInteractionPair(action.interaction.target, action.interaction.intent)) {
        return state;
      }
      const existing = state.interactions[action.targetKey] ?? [];
      return {
        ...state,
        interactions: {
          ...state.interactions,
          [action.targetKey]: [...existing, action.interaction],
        },
      };
    }
    case "DELETE_INTERACTION": {
      const existing = state.interactions[action.targetKey];
      if (!existing) return state;
      const filtered = existing.filter((ix) => ix.id !== action.interactionId);
      if (filtered.length === existing.length) return state;
      const next = { ...state.interactions };
      // Drop the key entirely when the last interaction is removed —
      // keeps the persisted snapshot tidy and lets the inspector's
      // "no comments yet" empty state appear naturally.
      if (filtered.length === 0) delete next[action.targetKey];
      else next[action.targetKey] = filtered;
      return { ...state, interactions: next };
    }
    case "SET_INTERACTION_ENQUEUE_ERROR": {
      const existing = state.interactions[action.targetKey];
      if (!existing) return state;
      const idx = existing.findIndex((ix) => ix.id === action.interactionId);
      if (idx < 0) return state;
      const current = !!existing[idx].enqueueError;
      if (current === action.error) return state;
      const patched = existing.map((ix, i) =>
        i === idx ? { ...ix, enqueueError: action.error } : ix,
      );
      return {
        ...state,
        interactions: { ...state.interactions, [action.targetKey]: patched },
      };
    }
    case "MERGE_AGENT_REPLIES":
      return mergeAgentInteractions(state, action.polled);
    case "SET_EXPAND_LEVEL": {
      const field = action.dir === "above" ? "expandLevelAbove" : "expandLevelBelow";
      return {
        ...state,
        [field]: { ...state[field], [action.hunkId]: Math.max(0, action.level) },
      };
    }
    case "TOGGLE_EXPAND_FILE": {
      const next = togglein(state.fullExpandedFiles, action.fileId);
      const turningOn = next.has(action.fileId);
      return {
        ...state,
        fullExpandedFiles: next,
        previewedFiles: turningOn ? removeFrom(state.previewedFiles, action.fileId) : state.previewedFiles,
      };
    }
    case "TOGGLE_PREVIEW_FILE": {
      const next = togglein(state.previewedFiles, action.fileId);
      const turningOn = next.has(action.fileId);
      return {
        ...state,
        previewedFiles: next,
        fullExpandedFiles: turningOn ? removeFrom(state.fullExpandedFiles, action.fileId) : state.fullExpandedFiles,
      };
    }
    case "TOGGLE_FILE_REVIEWED":
      return { ...state, reviewedFiles: togglein(state.reviewedFiles, action.fileId) };
    case "TOGGLE_CHANGESET_REVIEWED": {
      const cs = state.changesets.find((c) => c.id === action.changesetId);
      if (!cs) return state;
      const token = getChangesetReviewToken(cs);
      if (token === null) return state;
      const current = state.reviewedChangesets[cs.id] ?? [];
      const idx = current.indexOf(token);
      let nextList: string[];
      if (idx >= 0) {
        nextList = current.filter((t) => t !== token);
      } else {
        nextList = [...current, token];
      }
      const nextMap = { ...state.reviewedChangesets };
      if (nextList.length === 0) delete nextMap[cs.id];
      else nextMap[cs.id] = nextList;
      return { ...state, reviewedChangesets: nextMap };
    }
    case "HYDRATE_FILE": {
      const csIdx = state.changesets.findIndex((c) => c.id === action.changesetId);
      if (csIdx < 0) return state;
      const cs = state.changesets[csIdx];
      const fIdx = cs.files.findIndex((f) => f.id === action.fileId);
      if (fIdx < 0) return state;
      const file = cs.files[fIdx];
      if (file.fullContent) return state;
      const enriched = enrichWithFileContent(
        { ...file, postChangeText: action.postChangeText },
        action.postChangeText,
      );
      const newFiles = [...cs.files];
      newFiles[fIdx] = enriched;
      const newChangesets = [...state.changesets];
      newChangesets[csIdx] = { ...cs, files: newFiles };
      return { ...state, changesets: newChangesets };
    }
    case "SET_SELECTION_RANGE": {
      // Drag is per-hunk; ignore moves that drift to a different hunk.
      if (action.hunkId !== state.cursor.hunkId) return state;
      const charRange = action.anchor === action.head ? action.charRange : undefined;
      const next: LineSelection = charRange
        ? { hunkId: action.hunkId, anchor: action.anchor, head: action.head, charRange }
        : { hunkId: action.hunkId, anchor: action.anchor, head: action.head };
      return { ...state, selection: next };
    }
    case "SET_LINE_CHAR_RANGE": {
      if (action.fromCol >= action.toCol) return state;
      if (action.hunkId !== state.cursor.hunkId) return state;
      return {
        ...state,
        selection: {
          hunkId: action.hunkId,
          anchor: action.lineIdx,
          head: action.lineIdx,
          charRange: {
            lineIdx: action.lineIdx,
            fromCol: action.fromCol,
            toCol: action.toCol,
          },
        },
      };
    }
    case "MARK_LINES_READ": {
      const lo = Math.min(action.loLineIdx, action.hiLineIdx);
      const hi = Math.max(action.loLineIdx, action.hiLineIdx);
      const set = new Set(state.readLines[action.hunkId] ?? []);
      const before = set.size;
      for (let i = lo; i <= hi; i++) set.add(i);
      if (set.size === before) return state;
      return { ...state, readLines: { ...state.readLines, [action.hunkId]: set } };
    }
    case "MARK_LINES_UNREAD": {
      const existing = state.readLines[action.hunkId];
      if (!existing || existing.size === 0) return state;
      const lo = Math.min(action.loLineIdx, action.hiLineIdx);
      const hi = Math.max(action.loLineIdx, action.hiLineIdx);
      const set = new Set(existing);
      let changed = false;
      for (let i = lo; i <= hi; i++) {
        if (set.delete(i)) changed = true;
      }
      if (!changed) return state;
      const next = { ...state.readLines };
      if (set.size === 0) delete next[action.hunkId];
      else next[action.hunkId] = set;
      return { ...state, readLines: next };
    }
    case "MERGE_PR_OVERLAY": {
      const csIdx = state.changesets.findIndex((c) => c.id === action.changesetId);
      if (csIdx < 0) return state;
      const cs = state.changesets[csIdx];
      const nextCs: ChangeSet = {
        ...cs,
        prSource: action.prSource,
        prConversation: action.prConversation,
      };
      const nextChangesets = state.changesets.map((c, i) =>
        i === csIdx ? nextCs : c,
      );
      return { ...state, changesets: nextChangesets };
    }
    case "MERGE_PR_INTERACTIONS": {
      // Strip prior PR-sourced entries first so refresh doesn't duplicate.
      // Other interactions (user, AI, teammate, agent) are preserved
      // untouched.
      const cleaned: Record<string, Interaction[]> = {};
      for (const [key, list] of Object.entries(state.interactions)) {
        const filtered = list.filter((ix) => ix.external?.source !== "pr");
        if (filtered.length > 0) cleaned[key] = filtered;
      }
      const cleanedDetached = state.detachedInteractions.filter(
        (d) => d.interaction.external?.source !== "pr",
      );

      // Merge in the new PR-sourced entries.
      const next: Record<string, Interaction[]> = { ...cleaned };
      for (const [key, list] of Object.entries(action.prInteractions)) {
        if (list.length === 0) continue;
        next[key] = next[key] ? [...next[key], ...list] : [...list];
      }
      const nextDetached = [...cleanedDetached, ...action.prDetached];

      return {
        ...state,
        interactions: next,
        detachedInteractions: nextDetached,
      };
    }
    case "STORE_QUESTIONS": {
      return {
        ...state,
        quiz: {
          ...state.quiz,
          questions: {
            ...state.quiz.questions,
            [action.changesetId]: action.questions,
          },
        },
      };
    }
    case "TRIGGER_QUIZ_FOR_FILE": {
      if (state.quiz.active) return state; // one at a time
      const questions = state.quiz.questions[action.changesetId];
      if (!questions || questions.length === 0) return state;
      const cs = state.changesets.find((c) => c.id === action.changesetId);
      if (!cs) return state;
      const next = pickNextForFile(questions, cs, action.fileId, state.quiz.asked);
      if (!next) return state;
      return {
        ...state,
        quiz: { ...state.quiz, active: { questionId: next.id, mode: "single" } },
      };
    }
    case "TRIGGER_QUIZ_FOR_CHANGESET": {
      if (state.quiz.active) return state;
      const questions = state.quiz.questions[action.changesetId];
      if (!questions || questions.length === 0) return state;
      const next = pickNextForChangeset(questions, state.quiz.asked);
      if (!next) return state;
      return {
        ...state,
        quiz: { ...state.quiz, active: { questionId: next.id, mode: "sequence" } },
      };
    }
    case "DISMISS_QUIZ": {
      if (!state.quiz.active) return state;
      const active = state.quiz.active;
      const askedNext = state.quiz.asked.includes(active.questionId)
        ? state.quiz.asked
        : [...state.quiz.asked, active.questionId];
      if (active.mode === "sequence") {
        const csId = state.cursor.changesetId;
        const questions = state.quiz.questions[csId] ?? [];
        const next = pickNextForChangeset(questions, askedNext);
        return {
          ...state,
          quiz: {
            ...state.quiz,
            asked: askedNext,
            active: next ? { questionId: next.id, mode: "sequence" } : null,
          },
        };
      }
      return {
        ...state,
        quiz: { ...state.quiz, active: null, asked: askedNext },
      };
    }
    case "SUBMIT_QUIZ_ANSWER": {
      const askedNext = state.quiz.asked.includes(action.questionId)
        ? state.quiz.asked
        : [...state.quiz.asked, action.questionId];
      return {
        ...state,
        quiz: {
          ...state.quiz,
          answers: {
            ...state.quiz.answers,
            [action.questionId]: {
              answer: action.answer,
              submittedAt: action.now,
              selfEval: null,
            },
          },
          asked: askedNext,
        },
      };
    }
    case "SET_QUIZ_SELF_EVAL": {
      const prev = state.quiz.answers[action.questionId];
      if (!prev) return state;
      return {
        ...state,
        quiz: {
          ...state.quiz,
          answers: {
            ...state.quiz.answers,
            [action.questionId]: { ...prev, selfEval: action.selfEval },
          },
        },
      };
    }
    case "CLEAR_QUIZ_ACTIVE": {
      if (!state.quiz.active) return state;
      return { ...state, quiz: { ...state.quiz, active: null } };
    }
  }
}

/**
 * Replace the changeset with id `prevId` with `cs`, then re-route every
 * interaction targeting the old changeset's hunks via the content-anchor
 * pass:
 *   strict match → keep inline at the same logical position (with new id)
 *   re-anchor    → rewrite the key to point at where the content ended up
 *   no match     → push to detachedInteractions
 *
 * Interactions on other changesets are untouched. The cursor is best-effort:
 * same file if it still exists in the new diff, else file 0.
 */
function reloadChangeset(
  state: ReviewState,
  prevId: string,
  cs: ChangeSet,
): ReviewState {
  const oldIdx = state.changesets.findIndex((c) => c.id === prevId);
  if (oldIdx < 0) return state;
  const oldCs = state.changesets[oldIdx];
  const firstFile = cs.files[0];
  const firstHunk = firstFile?.hunks[0];
  if (!firstFile || !firstHunk) return state;

  const nextChangesets = state.changesets.map((c, i) =>
    i === oldIdx ? cs : c,
  );

  // Pre-index old hunks so we can pull anchorPath / hunkIdx out of any reply
  // key whose hunkId belongs to this changeset.
  const oldHunkInfo = new Map<
    string,
    { file: DiffFile; fileIdx: number; hunkIdx: number; hunk: Hunk }
  >();
  for (let fi = 0; fi < oldCs.files.length; fi++) {
    const f = oldCs.files[fi];
    for (let hi = 0; hi < f.hunks.length; hi++) {
      const h = f.hunks[hi];
      oldHunkInfo.set(h.id, { file: f, fileIdx: fi, hunkIdx: hi, hunk: h });
    }
  }

  // New file lookup by path, and a parallel hunk-id-by-path-and-index map so
  // we can re-emit thread keys against the new hunk ids.
  const newFileByPath = new Map<string, DiffFile>();
  for (const f of cs.files) newFileByPath.set(f.path, f);

  const nextInteractions: Record<string, Interaction[]> = {};
  const nextDetached: DetachedInteraction[] = [...state.detachedInteractions];

  for (const [key, list] of Object.entries(state.interactions)) {
    const parsed = parseReplyKey(key);
    if (!parsed) {
      // Not a key we understand — leave it untouched.
      nextInteractions[key] = list;
      continue;
    }
    if (parsed.kind === "userFile" || parsed.kind === "blockFile") {
      // File-anchored threads carry no hunk id; re-anchoring happens via
      // snippet match in a separate path (docs/plans/comment-on-unchanged-lines.md).
      nextInteractions[key] = list;
      continue;
    }
    const oldRef = oldHunkInfo.get(parsed.hunkId);
    if (!oldRef) {
      // This interaction belongs to a different changeset; pass through.
      nextInteractions[key] = list;
      continue;
    }

    // For block keys we anchor on the lo line; the original span size is
    // preserved when we know the new lineIdx.
    const anchorLineIdx =
      parsed.kind === "block" ? parsed.lo : parsed.lineIdx;
    const oldLineCount = oldRef.hunk.lines.length;
    const safeOldIdx = Math.max(0, Math.min(oldLineCount - 1, anchorLineIdx));

    // Each interaction may carry its own anchorHash. Entries authored before
    // anchoring shipped won't have one — fall back to hashing the old hunk
    // in place so we still get a best-effort match.
    const fallbackPath = oldRef.file.path;
    const fallbackHash = hashAnchorWindow(oldRef.hunk.lines, safeOldIdx);

    // Resolve the *thread's* destination from the first interaction that
    // has a hash; if every entry lacks one we use the in-place fallback.
    // Keeps a thread together rather than scattering entries one-by-one.
    const threadHash =
      list.find((ix) => ix.anchorHash)?.anchorHash ?? fallbackHash;
    const threadPath =
      list.find((ix) => ix.anchorPath)?.anchorPath ?? fallbackPath;

    const targetFile = newFileByPath.get(threadPath);
    const match = targetFile
      ? findAnchorInFile(targetFile.hunks, threadHash, {
          hunkIdx: oldRef.hunkIdx,
          lineIdx: safeOldIdx,
        })
      : null;

    if (targetFile && match) {
      const matchedHunk = targetFile.hunks[match.hunkIdx];
      const newKey = rekey(parsed, matchedHunk.id, match.lineIdx, matchedHunk.lines.length);
      const merged = nextInteractions[newKey] ?? [];
      nextInteractions[newKey] = [...merged, ...list];
      continue;
    }

    for (const ix of list) {
      nextDetached.push({ interaction: ix, threadKey: key });
    }
  }

  // Cursor: same file if it still exists in the new cs, else file 0.
  const wasOnReloadedCs = state.cursor.changesetId === prevId;
  let nextCursor: Cursor;
  if (wasOnReloadedCs) {
    const oldCursorFile = oldCs.files.find((f) => f.id === state.cursor.fileId);
    const cursorFile =
      (oldCursorFile && cs.files.find((f) => f.path === oldCursorFile.path)) ??
      firstFile;
    const cursorHunk = cursorFile.hunks[0];
    nextCursor = {
      changesetId: cs.id,
      fileId: cursorFile.id,
      hunkId: cursorHunk.id,
      lineIdx: 0,
    };
  } else {
    nextCursor = state.cursor;
  }

  return {
    ...state,
    changesets: nextChangesets,
    cursor: nextCursor,
    selection: null,
    readLines: addLine(state.readLines, nextCursor.hunkId, nextCursor.lineIdx),
    interactions: nextInteractions,
    detachedInteractions: nextDetached,
  };
}

/** Re-emit a reply key against `newHunkId` at `newLineIdx`. Block ranges
 *  preserve their original size, clamped to the new hunk's line count.
 *  File-anchored variants (`userFile`, `blockFile`) are filtered out by
 *  the caller — they don't migrate via hunk id. */
function rekey(
  parsed: Exclude<ParsedReplyKey, { kind: "userFile" | "blockFile" }>,
  newHunkId: string,
  newLineIdx: number,
  newHunkLineCount: number,
): string {
  switch (parsed.kind) {
    case "note":
      return lineNoteReplyKey(newHunkId, newLineIdx);
    case "user":
      return userCommentKey(newHunkId, newLineIdx, parsed.id);
    case "block": {
      const span = parsed.hi - parsed.lo;
      const newHi = Math.min(newHunkLineCount - 1, newLineIdx + span);
      return blockCommentKey(newHunkId, newLineIdx, newHi, parsed.id);
    }
    case "hunkSummary":
      return hunkSummaryReplyKey(newHunkId);
    case "teammate":
      return teammateReplyKey(newHunkId);
  }
}

function togglein(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function removeFrom(set: Set<string>, key: string): Set<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

function moveLine(
  state: ReviewState,
  delta: number,
  extend: boolean,
  preserveSelection: boolean,
): ReviewState {
  const cs = state.changesets.find((c) => c.id === state.cursor.changesetId)!;
  const file = cs.files.find((f) => f.id === state.cursor.fileId)!;
  const hunkIdx = file.hunks.findIndex((h) => h.id === state.cursor.hunkId);
  const hunk = file.hunks[hunkIdx];
  const nextLineIdx = state.cursor.lineIdx + delta;

  if (nextLineIdx < 0) {
    if (hunkIdx === 0)
      return applyCursor(state, state.cursor, extend, preserveSelection);
    const prev = file.hunks[hunkIdx - 1];
    // Crossing a hunk boundary always collapses selection — the range no
    // longer applies once the cursor is in a different hunk.
    return applyCursor(
      state,
      { ...state.cursor, hunkId: prev.id, lineIdx: prev.lines.length - 1 },
      false,
      false,
    );
  }
  if (nextLineIdx >= hunk.lines.length) {
    if (hunkIdx === file.hunks.length - 1)
      return applyCursor(state, state.cursor, extend, preserveSelection);
    const next = file.hunks[hunkIdx + 1];
    return applyCursor(
      state,
      { ...state.cursor, hunkId: next.id, lineIdx: 0 },
      false,
      false,
    );
  }
  return applyCursor(
    state,
    { ...state.cursor, lineIdx: nextLineIdx },
    extend,
    preserveSelection,
  );
}

function moveHunk(state: ReviewState, delta: number): ReviewState {
  const cs = state.changesets.find((c) => c.id === state.cursor.changesetId)!;
  const file = cs.files.find((f) => f.id === state.cursor.fileId)!;
  const hunkIdx = file.hunks.findIndex((h) => h.id === state.cursor.hunkId);
  const next = Math.max(0, Math.min(file.hunks.length - 1, hunkIdx + delta));
  if (next === hunkIdx) return state;
  return applyCursor(
    state,
    { ...state.cursor, hunkId: file.hunks[next].id, lineIdx: 0 },
    false,
  );
}

function moveFile(state: ReviewState, delta: number): ReviewState {
  const cs = state.changesets.find((c) => c.id === state.cursor.changesetId)!;
  const fileIdx = cs.files.findIndex((f) => f.id === state.cursor.fileId);
  const next = Math.max(0, Math.min(cs.files.length - 1, fileIdx + delta));
  if (next === fileIdx) return state;
  const nextFile = cs.files[next];
  return applyCursor(
    state,
    {
      ...state.cursor,
      fileId: nextFile.id,
      hunkId: nextFile.hunks[0].id,
      lineIdx: 0,
    },
    false,
  );
}

/** A line in the changeset that something is anchored to: an AI note, a
 *  user line comment, or the start of a user block comment. The badge
 *  click and the n / N navigation walk this list. */
export interface CommentStop {
  fileId: string;
  hunkId: string;
  lineIdx: number;
}

/**
 * Order: changeset file order → hunk order → line index. Stops come from
 * `user:` and `block:` interaction keys; `parseReplyKey` handles the
 * colon-bearing hunk ids that PR csIds introduce.
 *
 * Detached threads (ones that failed to re-anchor on the last reload) have no
 * live line, so a file carrying any is given a single stop on its first hunk.
 * Landing the cursor there surfaces the Inspector's "Detached" section, which
 * is file-scoped. Detached threads that are anchorless or whose file is no
 * longer in the diff can't seat a cursor and are skipped.
 */
export function buildCommentStops(
  cs: ChangeSet,
  interactions: Record<string, Interaction[]>,
  detached: DetachedInteraction[] = [],
): CommentStop[] {
  const userIdxByHunk = new Map<string, Set<number>>();
  const addIdx = (hunkId: string, idx: number) => {
    let s = userIdxByHunk.get(hunkId);
    if (!s) userIdxByHunk.set(hunkId, (s = new Set()));
    s.add(idx);
  };
  // Files carrying a file-line thread (`userFile:`/`blockFile:`) — anchored to
  // a line outside every hunk, so like detached threads they get one file-level
  // stop rather than a per-line one.
  const fileLineFileIds = new Set<string>();
  for (const [key, list] of Object.entries(interactions)) {
    if (list.length === 0) continue;
    const parsed = parseReplyKey(key);
    if (!parsed) continue;
    if (parsed.kind === "user") {
      addIdx(parsed.hunkId, parsed.lineIdx);
    } else if (parsed.kind === "block") {
      addIdx(parsed.hunkId, parsed.lo);
    } else if (parsed.kind === "userFile" || parsed.kind === "blockFile") {
      fileLineFileIds.add(parsed.fileId);
    }
  }

  // AI note stops come from the interactions store too — every
  // `note:hunkId:lineIdx` thread is an AI annotation (or its replies). Same
  // key shape as user comments, just a different prefix.
  for (const key of Object.keys(interactions)) {
    if (!key.startsWith("note:")) continue;
    const tail = key.slice("note:".length);
    const cut = tail.lastIndexOf(":");
    if (cut < 0) continue;
    const idx = Number(tail.slice(cut + 1));
    if (Number.isNaN(idx)) continue;
    addIdx(tail.slice(0, cut), idx);
  }

  const detachedPaths = new Set<string>();
  for (const d of detached) {
    const p = d.interaction.anchorPath;
    if (p) detachedPaths.add(p);
  }

  const stops: CommentStop[] = [];
  for (const f of cs.files) {
    const perFile: Array<{ hunkIdx: number; hunkId: string; lineIdx: number }> = [];
    for (let hi = 0; hi < f.hunks.length; hi++) {
      const idxs = userIdxByHunk.get(f.hunks[hi].id);
      if (!idxs) continue;
      for (const idx of idxs) perFile.push({ hunkIdx: hi, hunkId: f.hunks[hi].id, lineIdx: idx });
    }
    if ((detachedPaths.has(f.path) || fileLineFileIds.has(f.id)) && f.hunks.length > 0) {
      perFile.push({ hunkIdx: 0, hunkId: f.hunks[0].id, lineIdx: 0 });
    }
    perFile.sort((a, b) => a.hunkIdx - b.hunkIdx || a.lineIdx - b.lineIdx);
    const seen = new Set<string>();
    for (const p of perFile) {
      const k = `${p.hunkId}:${p.lineIdx}`;
      if (seen.has(k)) continue;
      seen.add(k);
      stops.push({ fileId: f.id, hunkId: p.hunkId, lineIdx: p.lineIdx });
    }
  }
  return stops;
}

function moveToComment(state: ReviewState, delta: number): ReviewState {
  const cs = state.changesets.find((c) => c.id === state.cursor.changesetId)!;
  const stops = buildCommentStops(cs, state.interactions, state.detachedInteractions);
  if (stops.length === 0) return state;

  const cur = state.cursor;
  const fileOrder = new Map(cs.files.map((f, i) => [f.id, i]));
  const hunkOrder = new Map<string, Map<string, number>>();
  for (const f of cs.files) {
    hunkOrder.set(f.id, new Map(f.hunks.map((h, i) => [h.id, i])));
  }
  const cmpToCursor = (s: CommentStop): number => {
    const fi = fileOrder.get(s.fileId)!;
    const fc = fileOrder.get(cur.fileId)!;
    if (fi !== fc) return fi - fc;
    const hi = hunkOrder.get(s.fileId)!.get(s.hunkId)!;
    const hc = hunkOrder.get(cur.fileId)!.get(cur.hunkId) ?? -1;
    if (hi !== hc) return hi - hc;
    return s.lineIdx - cur.lineIdx;
  };

  // Wrap around the ends: n from the last comment lands on the first, N from
  // the first lands on the last. Nothing is ever unreachable.
  let target: CommentStop | undefined;
  if (delta > 0) {
    target = stops.find((s) => cmpToCursor(s) > 0) ?? stops[0];
  } else {
    for (let i = stops.length - 1; i >= 0; i--) {
      if (cmpToCursor(stops[i]) < 0) {
        target = stops[i];
        break;
      }
    }
    target ??= stops[stops.length - 1];
  }

  return applyCursor(
    state,
    {
      changesetId: cur.changesetId,
      fileId: target.fileId,
      hunkId: target.hunkId,
      lineIdx: target.lineIdx,
    },
    false,
  );
}

/**
 * Apply a new cursor. Always extends the read track. Selection lifetime:
 *   - extend (Shift+arrow): grows the head within the same hunk
 *   - preserveSelection: keeps the existing selection unchanged within
 *     the same hunk; used while drafting a block comment
 *   - otherwise: collapses
 *   - crossing a hunk boundary: always collapses
 */
function applyCursor(
  state: ReviewState,
  cursor: Cursor,
  extend: boolean,
  preserveSelection: boolean = false,
): ReviewState {
  const sameHunk = cursor.hunkId === state.cursor.hunkId;
  let selection = state.selection;
  if (extend && sameHunk) {
    const anchor =
      selection && selection.hunkId === cursor.hunkId
        ? selection.anchor
        : state.cursor.lineIdx;
    selection = { hunkId: cursor.hunkId, anchor, head: cursor.lineIdx };
  } else if (preserveSelection && sameHunk && selection) {
    // keep selection unchanged
  } else {
    selection = null;
  }
  return {
    ...state,
    cursor,
    selection,
    readLines: addLine(state.readLines, cursor.hunkId, cursor.lineIdx),
  };
}

/**
 * Translate polled agent responses into top-level Interactions with
 * `authorRole: "agent"`. Reply-shaped entries key against the user
 * Interaction whose `id` matches `parentId` (the client-authoritative id
 * the agent saw). Idempotent: existing agent Interactions update in place;
 * new ids append on the same thread.
 */
function mergeAgentInteractions(
  state: ReviewState,
  polled: PolledAgentReply[],
): ReviewState {
  if (polled.length === 0) return state;

  // Active changeset is the only one we can resolve top-level entries
  // against. reply-shaped polled entries don't need it — they ride
  // parentId → interaction id, which already encodes the thread location.
  const activeCs = state.changesets.find(
    (c) => c.id === state.cursor.changesetId,
  );

  // One walk of state.interactions serving two lookups:
  //  - threadKeyByParentId: reply-shaped entries ride parentId → the
  //    interaction whose own `id` matches, carrying its thread key.
  //  - threadKeyById: every existing interaction's id → its thread key, so a
  //    re-polled top-level agent comment can reuse its prior key instead of
  //    minting a new one each poll.
  const threadKeyByParentId = new Map<string, string>();
  const threadKeyById = new Map<string, string>();
  let anyReplyShaped = false;
  let anyTopLevel = false;
  for (const p of polled) {
    if ("parentId" in p) {
      anyReplyShaped = true;
      threadKeyByParentId.set(p.parentId, "");
    } else {
      anyTopLevel = true;
    }
  }
  if (anyReplyShaped || anyTopLevel) {
    for (const [key, list] of Object.entries(state.interactions)) {
      for (const ix of list) {
        threadKeyById.set(ix.id, key);
        if (threadKeyByParentId.has(ix.id)) {
          threadKeyByParentId.set(ix.id, key);
        }
      }
    }
  }

  // Bucket polled entries by destination — a thread key when resolvable,
  // otherwise null (top-level entries that can't be anchored land in
  // `detachedInteractions`).
  type Resolved = { threadKey: string; interaction: Interaction };
  const resolved: Resolved[] = [];
  const detachedAdditions: DetachedInteraction[] = [];

  for (const p of polled) {
    if ("parentId" in p) {
      const threadKey = threadKeyByParentId.get(p.parentId);
      if (!threadKey) continue;
      resolved.push({
        threadKey,
        interaction: {
          id: p.id,
          threadKey,
          target: p.target,
          intent: p.intent,
          author: p.author,
          authorRole: "agent",
          body: p.body,
          createdAt: p.postedAt,
        },
      });
      continue;
    }

    // Structured fields ride only top-level agent posts; carried through
    // whether the entry resolves to a thread or lands in detached.
    const structured: Pick<
      Interaction,
      "rationale" | "suggestedFix" | "confidence"
    > = {};
    if (p.rationale !== undefined) structured.rationale = p.rationale;
    if (p.suggestedFix !== undefined) structured.suggestedFix = p.suggestedFix;
    if (p.confidence !== undefined) structured.confidence = p.confidence;

    // Top-level: resolve (file, lines) against the active changeset.
    const located = activeCs
      ? resolveAgentTopLevelAnchor(activeCs, p.file, p.lines)
      : null;
    const fileLine =
      !located && activeCs
        ? resolveAgentFileLineAnchor(activeCs, p.file, p.lines)
        : null;
    if (located) {
      // Re-poll: reuse the thread key this comment already lives under so it
      // updates in place. Only a genuinely new comment mints a fresh key.
      const existingKey = threadKeyById.get(p.id);
      const threadKey =
        existingKey ??
        (located.lo === located.hi
          ? userCommentKey(located.hunkId, located.lo, mintCommentId())
          : blockCommentKey(located.hunkId, located.lo, located.hi, mintCommentId()));
      const target: InteractionTarget = located.lo === located.hi ? "line" : "block";
      resolved.push({
        threadKey,
        interaction: {
          id: p.id,
          threadKey,
          target,
          intent: p.intent,
          author: p.author,
          authorRole: "agent",
          body: p.body,
          createdAt: p.postedAt,
          ...structured,
        },
      });
    } else if (fileLine) {
      // Line is outside every hunk but present in the file — anchor to the
      // file line so it renders inline (full-file view) instead of detaching.
      const existingKey = threadKeyById.get(p.id);
      const threadKey = existingKey ?? userFileCommentKey(fileLine.fileId, fileLine.newNo);
      resolved.push({
        threadKey,
        interaction: {
          id: p.id,
          threadKey,
          target: "line",
          intent: p.intent,
          author: p.author,
          authorRole: "agent",
          body: p.body,
          createdAt: p.postedAt,
          anchorPath: p.file,
          anchorLineNo: fileLine.newNo,
          anchorContext: fileLine.anchorContext,
          anchorHash: fileLine.anchorHash,
          ...structured,
        },
      });
    } else {
      // No active changeset, file not in the diff, or the line isn't in the
      // file's content. Park in detached with a synthetic threadKey so the
      // Sidebar's Detached group surfaces it.
      const detachedKey = `agent-detached:${p.id}`;
      const interaction: Interaction = {
        id: p.id,
        threadKey: detachedKey,
        target: p.target,
        intent: p.intent,
        author: p.author,
        authorRole: "agent",
        body: p.body,
        createdAt: p.postedAt,
        anchorPath: p.file,
        ...structured,
      };
      detachedAdditions.push({ interaction, threadKey: detachedKey });
    }
  }

  if (resolved.length === 0 && detachedAdditions.length === 0) return state;

  // Apply resolved entries thread-by-thread.
  let touched = false;
  const nextInteractions: Record<string, Interaction[]> = { ...state.interactions };
  const byThread = new Map<string, Interaction[]>();
  for (const r of resolved) {
    let bucket = byThread.get(r.threadKey);
    if (!bucket) {
      bucket = [];
      byThread.set(r.threadKey, bucket);
    }
    bucket.push(r.interaction);
  }
  for (const [threadKey, incomingInteractions] of byThread) {
    const existing = nextInteractions[threadKey] ?? [];
    const merged = reconcileAgentInteractions(existing, incomingInteractions);
    if (merged !== existing) {
      nextInteractions[threadKey] = merged;
      touched = true;
    }
  }

  // Append detached entries, de-duping against existing ids so re-polls
  // don't pile up.
  let nextDetached = state.detachedInteractions;
  if (detachedAdditions.length > 0) {
    const existingIds = new Set(
      nextDetached.map((d) => d.interaction.id),
    );
    const fresh = detachedAdditions.filter(
      (d) => !existingIds.has(d.interaction.id),
    );
    if (fresh.length > 0) {
      nextDetached = [...nextDetached, ...fresh];
      touched = true;
    }
  }

  if (!touched) return state;
  return {
    ...state,
    interactions: nextInteractions,
    detachedInteractions: nextDetached,
  };
}

/**
 * Resolve an agent's wire-shaped (file, lines) to a hunk + clamped
 * line-index range inside the active changeset. Walks the changeset's
 * files for a path match, then matches the hunk whose old or new line
 * range contains the cited lines (an agent may cite a deleted-line
 * number or an added-line number). Returns null when no hunk covers it.
 */
function resolveAgentTopLevelAnchor(
  cs: ChangeSet,
  file: string,
  lines: string,
): { hunkId: string; lo: number; hi: number } | null {
  const match = lines.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return null;
  const loNo = Number(match[1]);
  const hiNo = match[2] !== undefined ? Number(match[2]) : loNo;
  if (!Number.isFinite(loNo) || !Number.isFinite(hiNo) || loNo > hiNo) {
    return null;
  }

  const targetFile = cs.files.find((f) => f.path === file);
  if (!targetFile) return null;

  for (const hunk of targetFile.hunks) {
    // Try the new-line side first (agent typically cites the post-change
    // line number); fall back to the old-line side for deleted lines.
    const loIdxNew = findLineIdxForLineNo(hunk, loNo, "new");
    const hiIdxNew = findLineIdxForLineNo(hunk, hiNo, "new");
    if (loIdxNew !== null && hiIdxNew !== null) {
      return { hunkId: hunk.id, lo: loIdxNew, hi: hiIdxNew };
    }
    const loIdxOld = findLineIdxForLineNo(hunk, loNo, "old");
    const hiIdxOld = findLineIdxForLineNo(hunk, hiNo, "old");
    if (loIdxOld !== null && hiIdxOld !== null) {
      return { hunkId: hunk.id, lo: loIdxOld, hi: hiIdxOld };
    }
  }
  return null;
}

/**
 * Fallback for an agent comment whose line isn't inside any hunk: anchor it to
 * the file line if that line exists in the file's full content. This is how AI
 * findings on unchanged lines (e.g. an issue on context the change depends on)
 * become first-class file-line threads instead of detached "outdated" cards.
 * Needs `file.fullContent`; returns null without it, so the caller falls back
 * to detached.
 */
function resolveAgentFileLineAnchor(
  cs: ChangeSet,
  file: string,
  lines: string,
): { fileId: string; newNo: number; anchorContext: DiffLine[]; anchorHash: string } | null {
  const match = lines.match(/^(\d+)(?:-\d+)?$/);
  if (!match) return null;
  const newNo = Number(match[1]);
  if (!Number.isFinite(newNo)) return null;

  const targetFile = cs.files.find((f) => f.path === file);
  if (!targetFile?.fullContent) return null;

  const idx = targetFile.fullContent.findIndex((l) => l.newNo === newNo);
  if (idx < 0) return null;

  const { context, hash } = captureAnchorContext(targetFile.fullContent, idx);
  return { fileId: targetFile.id, newNo, anchorContext: context, anchorHash: hash };
}

function findLineIdxForLineNo(
  hunk: Hunk,
  lineNo: number,
  side: "new" | "old",
): number | null {
  for (let i = 0; i < hunk.lines.length; i++) {
    const l = hunk.lines[i];
    const no = side === "new" ? l.newNo : l.oldNo;
    if (no === lineNo) return i;
  }
  return null;
}

/**
 * Target for any reply (i.e. an interaction added after the thread head).
 * Parent provenance is recoverable from the `threadKey` prefix, so the
 * target itself is just `"reply"`.
 */
export function replyTarget(): InteractionTarget {
  return "reply";
}

/**
 * Target for the *head* of a thread (the first user-authored
 * Interaction on a `user:`/`block:` key). For `note:`/`hunkSummary:`/
 * `teammate:` keys the head is supplied by ingest carriers, so any
 * user-stored entry is by definition a reply — those routes return
 * `replyTarget` semantics.
 */
export function firstTargetForKey(threadKey: string): InteractionTarget {
  if (threadKey.startsWith("user:")) return "line";
  if (threadKey.startsWith("userFile:")) return "line";
  if (threadKey.startsWith("block:")) return "block";
  if (threadKey.startsWith("blockFile:")) return "block";
  return replyTarget();
}

function reconcileAgentInteractions(
  existing: Interaction[],
  incoming: Interaction[],
): Interaction[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, Interaction>();
  for (const e of existing) byId.set(e.id, e);
  let changed = false;
  for (const inc of incoming) {
    const prev = byId.get(inc.id);
    if (!prev) {
      byId.set(inc.id, inc);
      changed = true;
      continue;
    }
    if (!shallowEqualAgentInteraction(prev, inc)) {
      byId.set(inc.id, inc);
      changed = true;
    }
  }
  if (!changed) return existing;
  // Preserve non-agent interactions in original order; sort agent entries
  // by createdAt to keep the polled batch deterministic.
  const agents = Array.from(byId.values())
    .filter((ix) => ix.authorRole === "agent")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const nonAgents = existing.filter((ix) => ix.authorRole !== "agent");
  return [...nonAgents, ...agents];
}

function shallowEqualAgentInteraction(a: Interaction, b: Interaction): boolean {
  return (
    a.id === b.id &&
    a.body === b.body &&
    a.intent === b.intent &&
    a.createdAt === b.createdAt &&
    a.author === b.author
  );
}

export function hunkCoverage(
  hunk: { id: string; lines: unknown[] },
  lines: Record<string, Set<number>>,
): number {
  const total = hunk.lines.length;
  const seen = lines[hunk.id]?.size ?? 0;
  return total === 0 ? 0 : seen / total;
}

export function fileCoverage(
  file: { hunks: { id: string; lines: unknown[] }[] },
  lines: Record<string, Set<number>>,
): number {
  let total = 0;
  let seen = 0;
  for (const h of file.hunks) {
    total += h.lines.length;
    seen += lines[h.id]?.size ?? 0;
  }
  return total === 0 ? 0 : seen / total;
}

export function changesetCoverage(
  cs: ChangeSet,
  lines: Record<string, Set<number>>,
): number {
  let total = 0;
  let seen = 0;
  for (const f of cs.files) {
    for (const h of f.hunks) {
      total += h.lines.length;
      seen += lines[h.id]?.size ?? 0;
    }
  }
  return total === 0 ? 0 : seen / total;
}

/** Returns the count of reviewed files within the given changeset. */
export function reviewedFilesCount(
  cs: ChangeSet,
  reviewedFiles: Set<string>,
): number {
  let n = 0;
  for (const f of cs.files) if (reviewedFiles.has(f.id)) n++;
  return n;
}

/**
 * Canonical review token for the loaded `ChangeSet`. Sign-off keys against
 * this token, not the changeset id, so a refresh that swaps content while
 * keeping the id (worktree live-reload, PR fetch) recomputes the token and
 * only restores sign-off if the new revision matches a previously stored
 * entry. Rules (see `docs/concepts/review-state.md`):
 *   - worktree-backed: `wt:<sha>:<dirtyHash | ->` from `worktreeSource.state`
 *   - PR-only:         `pr:<baseSha>:<headSha>` from `prSource`
 *   - overlay:         worktree wins; the displayed diff is the worktree's
 *   - paste/upload/stub/fixture/legacy-worktree-without-state: `null`
 */
export function getChangesetReviewToken(cs: ChangeSet): string | null {
  const wt = cs.worktreeSource;
  if (wt) {
    const state = wt.state;
    if (!state) return null;
    return `wt:${state.sha}:${state.dirtyHash ?? "-"}`;
  }
  const pr = cs.prSource;
  if (pr) return `pr:${pr.baseSha}:${pr.headSha}`;
  return null;
}

/**
 * True iff the changeset's current review token is in its `reviewedChangesets`
 * entry. Returns `false` when the token is null (no top-level sign-off shape
 * for paste/upload/etc — the UI should hide the affordance via
 * `getChangesetReviewToken(cs) !== null`).
 */
export function isChangesetSignedOff(
  cs: ChangeSet,
  reviewedChangesets: Record<string, string[]>,
): boolean {
  const token = getChangesetReviewToken(cs);
  if (token === null) return false;
  const list = reviewedChangesets[cs.id];
  return list ? list.includes(token) : false;
}

// ── Ack helpers ──────────────────────────────────────────────────────────
// Derived Set<string> / boolean views over state.interactions, for
// components and seeds that still take the AI-note ack as a Set.

/**
 * True when the local user's latest response on the AI-note thread at
 * (hunkId, lineIdx) is `ack`.
 */
export function isAckedByMe(
  state: ReviewState,
  hunkId: string,
  lineIdx: number,
  user: string = "you",
): boolean {
  const threadKey = lineNoteReplyKey(hunkId, lineIdx);
  const list = state.interactions[threadKey];
  if (!list) return false;
  for (let i = list.length - 1; i >= 0; i--) {
    const ix = list[i];
    if (ix.author !== user) continue;
    if (ix.intent === "ack") return true;
    if (ix.intent === "unack") return false;
  }
  return false;
}

/**
 * Returns the set of `${hunkId}:${lineIdx}` keys where the local user's
 * latest response on the AI-note thread is `ack`. Use this when handing
 * off to view-model builders that still take `acked: Set<string>`.
 */
export function selectAckedNotes(
  state: ReviewState,
  user: string = "you",
): Set<string> {
  const out = new Set<string>();
  for (const [threadKey, list] of Object.entries(state.interactions)) {
    if (!threadKey.startsWith("note:")) continue;
    let latest: "ack" | "unack" | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const ix = list[i];
      if (ix.author !== user) continue;
      if (ix.intent === "ack" || ix.intent === "unack") {
        latest = ix.intent;
        break;
      }
    }
    if (latest === "ack") out.add(threadKey.slice("note:".length));
  }
  return out;
}

/**
 * Concatenate Interaction maps, preserving per-thread arrays. `a` entries
 * come first; `b` entries append. Used at boot/load when ingest-derived
 * Interactions (AI / teammate) need to be merged with user-authored ones.
 */
export function mergeInteractionMaps(
  a: Record<string, Interaction[]>,
  b: Record<string, Interaction[]>,
): Record<string, Interaction[]> {
  const out: Record<string, Interaction[]> = { ...a };
  for (const [key, list] of Object.entries(b)) {
    if (list.length === 0) continue;
    const existing = out[key];
    if (!existing) {
      out[key] = [...list];
      continue;
    }
    // Append only entries the thread doesn't already hold by id — a DB
    // re-fetch must not double a stub-seeded note or a locally-authored reply.
    const seen = new Set(existing.map((ix) => ix.id));
    const added = list.filter((ix) => !seen.has(ix.id));
    out[key] = added.length > 0 ? [...existing, ...added] : existing;
  }
  return out;
}

/**
 * Append local-user ack Interactions for the given `${hunkId}:${lineIdx}`
 * note keys, merged into the given map. Used by gallery fixtures and
 * Demo seeds to flip specific notes into the acked state without
 * round-tripping through the reducer.
 */
export function ackedNotesToInteractions(
  acked: ReadonlySet<string>,
  existing: Record<string, Interaction[]>,
  user: string = "you",
): Record<string, Interaction[]> {
  if (acked.size === 0) return existing;
  const out: Record<string, Interaction[]> = { ...existing };
  for (const noteKey of acked) {
    const colon = noteKey.lastIndexOf(":");
    if (colon < 0) continue;
    const hunkId = noteKey.slice(0, colon);
    const lineIdx = Number(noteKey.slice(colon + 1));
    if (!Number.isFinite(lineIdx)) continue;
    const threadKey = lineNoteReplyKey(hunkId, lineIdx);
    const ack: Interaction = {
      id: `acked:${threadKey}:${user}`,
      threadKey,
      target: "reply",
      intent: "ack",
      author: user,
      authorRole: "user",
      body: "",
      // Slightly after the seam's INGEST_TIMESTAMP so the ack sorts after
      // the AI note it responds to, but before any real user activity.
      createdAt: "0001-01-02T00:00:00.000Z",
    };
    out[threadKey] = out[threadKey] ? [...out[threadKey], ack] : [ack];
  }
  return out;
}
