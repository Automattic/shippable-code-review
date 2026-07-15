// Client-side identity — a random id the server uses to upsert a users row
// and stamp interaction writes (server/src/identity.ts). Persisted under a
// single localStorage key so it survives reloads; best-effort only, so
// private-mode/quota storage failures fall back to an id kept in memory for
// the session rather than throwing.

const STORAGE_KEY = "shippable:userId:v1";

let memoryFallback: string | null = null;

export function getUserId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, minted);
    return minted;
  } catch {
    if (!memoryFallback) memoryFallback = crypto.randomUUID();
    return memoryFallback;
  }
}
