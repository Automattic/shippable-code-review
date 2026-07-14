import type { DiffFile } from "../types";

// v1 ships worktree only; other sources are type-level future (§1.3, §18).
export type ChangeSetSource = {
  type: "worktree";
  workdir: string;
  branch: string;
  identifier: string; // commit sha, or a computed id when there are uncommitted changes
  dirty: boolean;
};

export type ChangeSet = {
  id: string;
  parentChangesetId?: string;
  source: ChangeSetSource;
  files: DiffFile[]; // DiffFile/Hunk/DiffLine unchanged — carried from ../types
  ingestedAt: string;
};

export function changeSetId(source: ChangeSetSource): string {
  return `worktree:${source.workdir}@${source.identifier}`;
}
