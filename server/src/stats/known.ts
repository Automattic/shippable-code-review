// The catalog of stats and their reporting destinations.
//
// Every stat has a logical id — the key below, used throughout this codebase
// (the web→server event payload, the stat_dedup table, the log sink) — and a
// group/name it reports under. Groups bin stats by lifecycle area so each
// group's rolled-up total stays meaningful.

// Stat groups, one per lifecycle area. A closed set so the catalog below
// cannot drift onto a mistyped group.
export const STAT_GROUPS = [
  "shippable-reviews",
  "shippable-comments",
  "shippable-installs",
] as const;
export type StatGroup = (typeof STAT_GROUPS)[number];

interface StatTarget {
  group: StatGroup;
  name: string;
}

// KNOWN_STATS doubles as the web→server trust boundary: POST /api/stats/event
// accepts only these ids. Server-side stats live in SERVER_STATS and must
// never be web-reportable — keep them out of here.
export const KNOWN_STATS = {
  "review-started": { group: "shippable-reviews", name: "started" },
  "review-completed": { group: "shippable-reviews", name: "completed" },
  "file-reviewed": { group: "shippable-reviews", name: "file-reviewed" },
} as const satisfies Record<string, StatTarget>;

export type KnownStat = keyof typeof KNOWN_STATS;

export function isKnownStat(v: unknown): v is KnownStat {
  return typeof v === "string" && Object.hasOwn(KNOWN_STATS, v);
}

// Server-side stats, recorded directly at their call sites — never
// web-reportable.
export const SERVER_STATS = {
  "ai-review-request": { group: "shippable-reviews", name: "ai-request" },
  "comment-posted-ai": { group: "shippable-comments", name: "ai" },
  "comment-posted-agent": { group: "shippable-comments", name: "agent" },
  "comment-posted-user": { group: "shippable-comments", name: "user" },
  "install-new": { group: "shippable-installs", name: "new" },
  "install-active": { group: "shippable-installs", name: "active" },
} as const satisfies Record<string, StatTarget>;

export type ServerStat = keyof typeof SERVER_STATS;

/** Every stat recordStat accepts — web-reportable or server-side. */
export type Stat = KnownStat | ServerStat;

/** A stat resolved to everything a sink needs: the id plus its target. */
export interface ResolvedStat extends StatTarget {
  id: Stat;
}

const STAT_TARGETS: Record<Stat, StatTarget> = {
  ...KNOWN_STATS,
  ...SERVER_STATS,
};

/** Resolves a stat id to the id + group/name a sink records. */
export function resolveStat(id: Stat): ResolvedStat {
  return { id, ...STAT_TARGETS[id] };
}
