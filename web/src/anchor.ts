/**
 * anchor.ts — content-anchored comment helpers.
 *
 * A reply is anchored on a 5-line window centered on its line. The hash of
 * that window is what the reload pass matches against; the wider 10-line
 * snippet around it travels alongside as `anchorContext` so a detached
 * reply stays self-explanatory when the matching window is gone.
 *
 * See `docs/plans/worktree-live-reload.md` (slice c).
 */

import { parseReplyKey } from "./types";
import type { ChangeSet, DiffLine, Hunk, Interaction } from "./types";

/** Inner-window radius. ±2 → 5 lines for the matching hash. */
const HASH_RADIUS = 2;
/** Outer-window radius (above). 5 above + anchor + 4 below = 10 lines stored. */
const CONTEXT_ABOVE = 5;
const CONTEXT_BELOW = 4;

/** FNV-1a 32-bit. Cheap, deterministic, no deps; collisions are tolerable
 *  for this — a stale match is the same outcome as no match. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Hash the 5-line window centered on `centerIdx`. Lines outside the array
 * bounds contribute the empty string — windows near the start/end of a hunk
 * still produce stable hashes that survive a reload.
 */
export function hashAnchorWindow(lines: DiffLine[], centerIdx: number): string {
  const parts: string[] = [];
  for (let i = centerIdx - HASH_RADIUS; i <= centerIdx + HASH_RADIUS; i++) {
    if (i < 0 || i >= lines.length) {
      parts.push("");
    } else {
      const l = lines[i];
      parts.push(`${l.kind[0]}|${l.text}`);
    }
  }
  return fnv1a(parts.join("\n"));
}

export interface CapturedAnchor {
  context: DiffLine[];
  hash: string;
}

/**
 * Capture the 10-line context window plus the inner 5-line hash for a
 * reply being anchored at `centerIdx` in `lines`. The slice clips at the
 * edges of the array — no padding lines are inserted.
 */
export function captureAnchorContext(
  lines: DiffLine[],
  centerIdx: number,
): CapturedAnchor {
  const lo = Math.max(0, centerIdx - CONTEXT_ABOVE);
  const hi = Math.min(lines.length, centerIdx + CONTEXT_BELOW + 1);
  return {
    context: lines.slice(lo, hi),
    hash: hashAnchorWindow(lines, centerIdx),
  };
}

export interface AnchorMatch {
  hunkIdx: number;
  lineIdx: number;
}

/**
 * Search a file's hunks for a 5-line window whose hash matches `target`.
 * `prefer` (when given) biases toward the same `(hunkIdx, lineIdx)` if it
 * still hashes correctly, so unrelated edits elsewhere in the file don't
 * pull the anchor out of place. Returns the first match, or null.
 */
export function findAnchorInFile(
  hunks: Pick<Hunk, "lines">[],
  target: string,
  prefer?: { hunkIdx: number; lineIdx: number },
): AnchorMatch | null {
  if (
    prefer &&
    prefer.hunkIdx >= 0 &&
    prefer.hunkIdx < hunks.length &&
    prefer.lineIdx >= 0 &&
    prefer.lineIdx < hunks[prefer.hunkIdx].lines.length &&
    hashAnchorWindow(hunks[prefer.hunkIdx].lines, prefer.lineIdx) === target
  ) {
    return { hunkIdx: prefer.hunkIdx, lineIdx: prefer.lineIdx };
  }
  for (let h = 0; h < hunks.length; h++) {
    const lines = hunks[h].lines;
    for (let i = 0; i < lines.length; i++) {
      if (hashAnchorWindow(lines, i) === target) {
        return { hunkIdx: h, lineIdx: i };
      }
    }
  }
  return null;
}

/** Anchor metadata to merge onto an Interaction at write time. */
export type ReplyAnchorFields = Pick<
  Interaction,
  | "anchorPath"
  | "anchorContext"
  | "anchorHash"
  | "anchorLineNo"
  | "originSha"
  | "originType"
>;

/**
 * Resolve a reply key to its anchor inside `cs`, then produce the anchor
 * fields the reducer needs to keep this comment alive across reloads.
 * Returns an empty object when the key isn't recognized or the hunk it
 * names is missing — the reply is still saved, just without anchor info,
 * which means it falls back to in-place hashing on reload.
 */
export function buildReplyAnchor(
  key: string,
  cs: ChangeSet,
): ReplyAnchorFields {
  // parseReplyKey (types.ts) is the single source of truth for key parsing —
  // it accounts for the trailing per-comment `:id` segment that user/block
  // keys carry. The file-level kinds have no hunk to anchor against.
  const parsed = parseReplyKey(key);
  if (
    parsed === null ||
    parsed.kind === "userFile" ||
    parsed.kind === "blockFile"
  ) {
    return {};
  }
  const { hunkId, lineIdx } = parsed;
  for (const f of cs.files) {
    for (const h of f.hunks) {
      if (h.id !== hunkId) continue;
      const safeIdx = Math.max(0, Math.min(h.lines.length - 1, lineIdx));
      const cap = captureAnchorContext(h.lines, safeIdx);
      const anchorLine = h.lines[safeIdx];
      // A worktree-loaded ChangeSet carries its own sha + dirty flag; for
      // pasted/uploaded loads we fall back to the changeset id so detached
      // entries still have *something* to display in their origin caption.
      const wt = cs.worktreeSource;
      const dirty = wt?.dirty ?? false;
      return {
        anchorPath: f.path,
        anchorContext: cap.context,
        anchorHash: cap.hash,
        anchorLineNo: anchorLine?.newNo ?? anchorLine?.oldNo,
        originSha: wt?.commitSha ?? cs.id,
        originType: dirty ? "dirty" : "committed",
      };
    }
  }
  return {};
}
