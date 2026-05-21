import { getDb } from "../db/index.ts";
import { consentGranted } from "./consent.ts";
import { LogSink, McSink, type StatSink } from "./sink.ts";

// The one recording entry point. Fire-and-forget, never throws — a failed stat
// must never disturb the review flow. The sink is chosen per call from the
// live consent state, so granting consent mid-session takes effect at once.

let logSink: StatSink = new LogSink();
let mcSink: StatSink = new McSink();

function activeSink(): StatSink {
  return consentGranted() ? mcSink : logSink;
}

export function recordStat(name: string, count = 1): void {
  try {
    activeSink().record(name, count);
  } catch {
    // Best-effort: stats never propagate errors to callers.
  }
}

/** Records `name` once per `dedupKey`. A repeat key is a no-op. */
export function recordStatOnce(name: string, dedupKey: string): void {
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

/** Test-only: swap in recording sinks to observe routing without the network. */
export function setStatSinksForTests(log: StatSink, mc: StatSink): void {
  logSink = log;
  mcSink = mc;
}

/** Test-only: restore the real sinks. */
export function resetStatSinksForTests(): void {
  logSink = new LogSink();
  mcSink = new McSink();
}
