import { getSetting, setSetting } from "./settings.ts";

// MC stats consent. Binary and one-way: the user is `undecided` until they opt
// in, after which they are `granted` forever. Declining stores nothing.

const CONSENT_KEY = "stats_mc_consent";

// Cached so the stats hot path never does a DB round-trip. Seeded lazily from
// the settings table on first read.
let cache: boolean | undefined;

export function consentGranted(): boolean {
  if (cache === undefined) {
    cache = getSetting(CONSENT_KEY) === "granted";
  }
  return cache;
}

// The only transition — consent never moves back to undecided.
export function grantConsent(): void {
  setSetting(CONSENT_KEY, "granted");
  cache = true;
}

/** Test-only: drop the cached value so the next read re-loads from the DB. */
export function resetConsentForTests(): void {
  cache = undefined;
}
