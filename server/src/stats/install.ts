import { randomUUID } from "node:crypto";

import { recordStatOnce } from "./record.ts";
import { getSetting, setSetting } from "./settings.ts";

const INSTALL_ID_KEY = "install_id";

// Opaque random token identifying this install. Generated and persisted on the
// first call; returned unchanged afterwards. It never leaves the host — it is
// only ever used as a recordStatOnce dedup key, so MC receives bumps, not the id.
export function installId(): string {
  const existing = getSetting(INSTALL_ID_KEY);
  if (existing) return existing;
  const id = randomUUID();
  setSetting(INSTALL_ID_KEY, id);
  return id;
}

// Install-identity counters, fired once at server startup. The dedup keys make
// the cadence explicit: `install-new` once per install ever, `install-active`
// once per install per UTC day.
export function recordInstallStats(): void {
  const id = installId();
  const utcDay = new Date().toISOString().slice(0, 10);
  recordStatOnce("install-new", id);
  recordStatOnce("install-active", `${id}:${utcDay}`);
}
