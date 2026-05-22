import { getSetting, setSetting } from "./settings.ts";

// Stats consent. Binary and one-way: the user is `undecided` until they opt
// in, after which they are `granted` forever. Declining stores nothing.

const CONSENT_KEY = "stats_mc_consent";

// Read straight from the settings table. Stats fire at human pace, so a local
// SQLite lookup per record is cheap — a cache would only buy a test-reset hook.
export function consentGranted(): boolean {
  return getSetting(CONSENT_KEY) === "granted";
}

// The only transition — consent never moves back to undecided.
export function grantConsent(): void {
  setSetting(CONSENT_KEY, "granted");
}
