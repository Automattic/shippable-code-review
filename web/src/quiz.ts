import type { ChangeSet, Question } from "./types";

export function eligibleQuestionsForFile(
  all: Question[],
  cs: ChangeSet,
  fileId: string,
  asked: string[],
): Question[] {
  const askedSet = new Set(asked);
  const file = cs.files.find((f) => f.id === fileId);
  if (!file) return [];
  const hunkIds = new Set(file.hunks.map((h) => h.id));
  return all.filter((q) => {
    if (askedSet.has(q.id)) return false;
    const t = q.target;
    switch (t.kind) {
      case "changeset":
        return false;
      case "file":
        return t.path === file.path;
      case "hunk":
        return hunkIds.has(t.hunkId);
      case "symbol":
        return t.definedIn === file.path;
    }
  });
}

/** Head of the eligible queue for a file mark. Order follows the server's
 *  emission order — we don't re-sort. */
export function pickNextForFile(
  all: Question[],
  cs: ChangeSet,
  fileId: string,
  asked: string[],
): Question | null {
  const eligible = eligibleQuestionsForFile(all, cs, fileId, asked);
  return eligible[0] ?? null;
}

/** Next question for the Shift+S sequence. Picks the first unanswered
 *  question, preferring changeset-level targets, then anything else.
 *  `asked` already filters surfaced questions. */
export function pickNextForChangeset(
  all: Question[],
  asked: string[],
): Question | null {
  const askedSet = new Set(asked);
  const unanswered = all.filter((q) => !askedSet.has(q.id));
  return (
    unanswered.find((q) => q.target.kind === "changeset") ??
    unanswered[0] ??
    null
  );
}
