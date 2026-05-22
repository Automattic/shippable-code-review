// A StatSink receives a stat bump. Two implementations: LogSink (no network,
// the default) and McSink (a wp.com pixel). recordStat resolves the stat and
// picks a sink per call from the live consent state — sinks are pure transport
// and never touch the catalog.

import type { ResolvedStat } from "./known.ts";

export interface StatSink {
  record(stat: ResolvedStat, count: number): void;
}

/**
 * Writes the bump to the console — the logical id plus the `group/name` it
 * would land on. No network; used until the user consents.
 */
export class LogSink implements StatSink {
  record({ id, group, name }: ResolvedStat, count: number): void {
    console.log(`[stat] ${id} → ${group}/${name} +${count}`);
  }
}

/**
 * Bumps a wp.com stat with a fire-and-forget pixel GET. The
 * `x_<group>/<name>=<count>` multiplier form bumps the stat by `count` in a
 * single request. No cache-buster is needed — a server-side fetch has no image
 * cache. All network errors are swallowed.
 */
export class McSink implements StatSink {
  record({ group, name }: ResolvedStat, count: number): void {
    const url = `https://pixel.wp.com/g.gif?v=wpcom-no-pv&x_${group}/${name}=${count}`;
    void fetch(url).catch(() => {});
  }
}
