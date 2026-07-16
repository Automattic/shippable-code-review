// Client-side identity — a random id the server uses to upsert a users row
// and stamp interaction writes (server/src/identity.ts). Persisted under a
// single localStorage key so it survives reloads; best-effort only — when
// storage fails (private mode, quota) the id lives in memory instead. Cached
// at module scope so one session always reports one id, even when storage
// flips between failing and working between calls.

const STORAGE_KEY = "shippable:userId:v1";

let sessionId: string | null = null;

export function getUserId(): string {
  if (sessionId) return sessionId;
  try {
    sessionId = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage unreadable — treat as absent and mint below.
  }
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    try {
      localStorage.setItem(STORAGE_KEY, sessionId);
    } catch {
      // Best-effort persist; the minted id stays session-stable in memory.
    }
  }
  return sessionId;
}

export function resetForTests(): void {
  sessionId = null;
}
