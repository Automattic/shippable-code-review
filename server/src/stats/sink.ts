// A StatSink receives a stat bump. Two implementations: LogSink (no network,
// the default) and McSink (a wp.com pixel). recordStat picks one per call from
// the live consent state.

export interface StatSink {
  record(name: string, count: number): void;
}

// MC buckets by exact stat name, so a name must be a short static slug — a
// stray dynamic value would spawn a junk MC stat. Cap it defensively.
const MAX_SLUG = 32;
const slug = (s: string): string => s.slice(0, MAX_SLUG);

// Fixed MC stats group for this product.
const STATS_GROUP = "shippable";

/** Writes the bump to the console. No network — used until the user consents. */
export class LogSink implements StatSink {
  record(name: string, count: number): void {
    console.log(`[stat] ${name} +${count}`);
  }
}

/**
 * Bumps a wp.com MC stat with a fire-and-forget pixel GET. The
 * `x_<group>/<name>=<count>` multiplier form bumps the stat by `count` in a
 * single request. No cache-buster is needed — a server-side fetch has no image
 * cache. All network errors are swallowed.
 */
export class McSink implements StatSink {
  record(name: string, count: number): void {
    const url = `https://pixel.wp.com/g.gif?v=wpcom-no-pv&x_${STATS_GROUP}/${slug(name)}=${count}`;
    void fetch(url).catch(() => {});
  }
}
