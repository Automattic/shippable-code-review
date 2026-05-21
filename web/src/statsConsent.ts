import { apiUrl } from "./apiUrl";

// Client for the MC-stats consent endpoints. Consent is binary and one-way:
// the welcome banner asks once, and granting it is permanent.

export type Consent = "granted" | "undecided";

/** Reads the current consent state. Throws on network/HTTP failure so the
 *  caller can fail closed — no banner, MC stays off. */
export async function fetchConsent(): Promise<Consent> {
  const res = await fetch(await apiUrl("/api/stats/consent"));
  if (!res.ok) throw new Error(`consent fetch failed: ${res.status}`);
  const json = (await res.json()) as { consent?: string };
  return json.consent === "granted" ? "granted" : "undecided";
}

/** Records the user's opt-in. */
export async function grantConsent(): Promise<void> {
  const res = await fetch(await apiUrl("/api/stats/consent"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consent: "granted" }),
  });
  if (!res.ok) throw new Error(`consent post failed: ${res.status}`);
}
