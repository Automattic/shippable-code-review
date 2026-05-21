// HTTP edge for stats. POST /api/stats/event is the web→server trust boundary —
// only KNOWN_STATS names are accepted; server-side stat names are recorded
// directly at their call sites and must never be reportable from the web.

import type { IncomingMessage, ServerResponse } from "node:http";

import { readJson, writeCorsHeaders, writeJson } from "../http.ts";
import { consentGranted, grantConsent } from "./consent.ts";
import { isKnownStat } from "./known.ts";
import { recordStat, recordStatOnce } from "./record.ts";

function writeNoContent(res: ServerResponse, origin: string | null): void {
  writeCorsHeaders(res, origin);
  res.writeHead(204).end();
}

/** POST /api/stats/event — body { name, dedupKey? }. */
export async function handleStatsEvent(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
): Promise<void> {
  const raw = await readJson(req);
  if (!raw || typeof raw !== "object") {
    writeJson(res, origin, 400, { error: "invalid JSON body" });
    return;
  }
  const b = raw as Record<string, unknown>;
  if (!isKnownStat(b.name)) {
    writeJson(res, origin, 400, { error: "unknown stat name" });
    return;
  }
  if (typeof b.dedupKey === "string" && b.dedupKey !== "") {
    recordStatOnce(b.name, b.dedupKey);
  } else {
    recordStat(b.name);
  }
  writeNoContent(res, origin);
}

/** GET /api/stats/consent → { consent: "granted" | "undecided" }. */
export async function handleStatsConsentGet(
  _req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
): Promise<void> {
  writeJson(res, origin, 200, {
    consent: consentGranted() ? "granted" : "undecided",
  });
}

/** POST /api/stats/consent — body { consent: "granted" }. */
export async function handleStatsConsentSet(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string | null,
): Promise<void> {
  const raw = await readJson(req);
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as Record<string, unknown>).consent !== "granted"
  ) {
    writeJson(res, origin, 400, { error: 'consent must be "granted"' });
    return;
  }
  grantConsent();
  writeNoContent(res, origin);
}
