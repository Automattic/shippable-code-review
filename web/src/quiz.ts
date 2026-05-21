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

export function pickRandomQuestion(
  questions: Question[],
  rng: () => number,
): Question | null {
  if (questions.length === 0) return null;
  const idx = Math.min(questions.length - 1, Math.floor(rng() * questions.length));
  return questions[idx];
}
