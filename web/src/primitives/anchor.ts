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

export function resolveRootAnchor(
  anchor: Anchor,
  lookup: (interactionId: string) => Anchor | undefined,
): Anchor {
  const visited = new Set<string>();
  let current = anchor;
  while (current.type === "interaction") {
    if (visited.has(current.interactionId)) {
      throw new Error(`resolveRootAnchor: cycle at ${current.interactionId}`);
    }
    visited.add(current.interactionId);
    const parent = lookup(current.interactionId);
    if (!parent) {
      throw new Error(`resolveRootAnchor: missing parent ${current.interactionId}`);
    }
    current = parent;
  }
  return current;
}
