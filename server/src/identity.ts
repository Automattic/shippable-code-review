import type { IncomingMessage } from "node:http";

// Per-request caller identity, derived from headers a proxy/client sets on
// every /api/* call. Best-effort: a missing or malformed id header just
// means "no identity for this request", not an error.

export type RequestIdentity = { userId: string; role: "human" | "ai" };

const MAX_USER_ID_LENGTH = 128;

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads X-Shippable-User-Id / X-Shippable-User-Role off a headers object.
 * Returns null when the id header is absent, empty/whitespace, or longer
 * than 128 chars — those are the only rejection conditions; the id itself
 * is otherwise opaque. Role is "ai" only when the role header is exactly
 * "ai" case-insensitively; anything else (including absent) is "human".
 */
export function identityFrom(
  headers: Record<string, string | string[] | undefined>,
): RequestIdentity | null {
  const userId = firstHeaderValue(headers["x-shippable-user-id"]);
  if (
    !userId ||
    userId.trim().length === 0 ||
    userId.length > MAX_USER_ID_LENGTH
  ) {
    return null;
  }
  const roleHeader = firstHeaderValue(headers["x-shippable-user-role"]);
  const role = roleHeader?.toLowerCase() === "ai" ? "ai" : "human";
  return { userId, role };
}

// Resolved once per request in index.ts, before route dispatch, and stashed
// here keyed by the request object — so handlers can read it (Task 3) without
// threading an extra parameter through every handler signature.
const identityByRequest = new WeakMap<IncomingMessage, RequestIdentity>();

export function attachRequestIdentity(
  req: IncomingMessage,
  identity: RequestIdentity,
): void {
  identityByRequest.set(req, identity);
}

export function getRequestIdentity(
  req: IncomingMessage,
): RequestIdentity | null {
  return identityByRequest.get(req) ?? null;
}
