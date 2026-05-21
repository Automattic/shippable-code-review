import { apiUrl } from "./apiUrl";

// Fire-and-forget usage-stat report. Every error is swallowed — a stat must
// never disturb the review flow. The server decides per consent whether the
// event reaches MC; the web app does not gate on consent.
//
// Pass `dedupKey` for stats that should count once per subject (e.g.
// review-started, once per changeset) — the server dedups on it.
export function reportStat(name: string, dedupKey?: string): void {
  void (async () => {
    try {
      await fetch(await apiUrl("/api/stats/event"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dedupKey ? { name, dedupKey } : { name }),
      });
    } catch {
      // Best-effort.
    }
  })();
}
