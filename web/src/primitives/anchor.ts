import type { DiffLine } from "../types";

export type BlockOrigin =
  | { type: "committed"; sha: string }            // git re-derives the window from sha on demand
  | { type: "dirty"; hash: string; context: DiffLine[] }; // no sha → welded snapshot in our store

export type Anchor =
  | { type: "block"; file: string; lo: number; hi: number; origin: BlockOrigin }
  | { type: "symbol"; file: string; symbol: string }
  | { type: "file"; file: string }
  | { type: "changeset" }
  | { type: "interaction"; interactionId: string };

export function isInteractionAnchor(
  a: Anchor,
): a is Extract<Anchor, { type: "interaction" }> {
  return a.type === "interaction";
}
