import { getDb } from "../db/index.ts";
import { consentGranted } from "./consent.ts";
import type { Stat } from "./known.ts";
import { LogSink, McSink, type StatSink } from "./sink.ts";

// The one recording entry point. Fire-and-forget, never throws — a failed stat
// must never disturb the review flow. The sink is chosen per call from the
// live consent state, so granting consent mid-session takes effect at once.

const logSink: StatSink = new LogSink();
const mcSink: StatSink = new McSink();

function activeSink(): StatSink {
  return consentGranted() ? mcSink : logSink;
}

export function recordStat(name: Stat, count = 1): void {
  try {
    activeSink().record(name, count);
  } catch {
    // Best-effort: stats never propagate errors to callers.
  }
}

/** Records `name` once per `dedupKey`. A repeat key is a no-op. */
export function recordStatOnce(name: Stat, dedupKey: string): void {
  let inserted = false;
  try {
    const result = getDb()
      .prepare(
        "INSERT OR IGNORE INTO stat_dedup (name, dedup_key, recorded_at) VALUES (?, ?, ?)",
      )
      .run(name, dedupKey, new Date().toISOString());
    inserted = result.changes === 1;
  } catch {
    return;
  }
  if (inserted) recordStat(name);
}
