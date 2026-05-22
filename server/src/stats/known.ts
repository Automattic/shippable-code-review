// The catalog of stat names. KNOWN_STATS doubles as the web→server trust
// boundary: POST /api/stats/event accepts only these. Server-side names are
// recorded directly at their call sites and must never be web-reportable —
// they live in SERVER_STATS and must stay out of KNOWN_STATS.

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

// Server-side stat names, recorded directly at their call sites. A union (not
// a runtime allowlist) so a typo at a call site fails to compile — there is no
// registration step that would otherwise catch it.
export type ServerStat =
  | "ai-review-request"
  | "comment-posted-ai"
  | "comment-posted-agent"
  | "comment-posted-user"
  | "install-new"
  | "install-active";

/** Every name recordStat accepts — web-reportable or server-side. */
export type Stat = KnownStat | ServerStat;
