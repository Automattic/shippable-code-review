// The stat names the web may report via POST /api/stats/event. This allowlist
// is the single source of truth for that trust boundary. Server-side stat
// names are string literals at their call sites and must never be web-
// reportable — keep them out of this list.

export const KNOWN_STATS = [
  "review-started",
  "review-completed",
  "file-marked-okay",
] as const;

export type KnownStat = (typeof KNOWN_STATS)[number];

export function isKnownStat(v: unknown): v is KnownStat {
  return (
    typeof v === "string" && (KNOWN_STATS as readonly string[]).includes(v)
  );
}
