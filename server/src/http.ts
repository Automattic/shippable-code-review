// Shared HTTP boundary helpers (body reader, CORS writer, JSON helpers) so
// multiple route modules can speak the same wire dialect as `index.ts` without
// duplicating the body-size guard or the JSON write/read pattern.

import type { IncomingMessage, ServerResponse } from "node:http";

// Cap the bytes any single request body can grow to. Local server, but we
// share the box with anything else on 127.0.0.1, and an agent / browser tab
// spamming multi-MB POSTs would trivially OOM us otherwise. 2 MiB fits the
// largest endpoint (the /api/plan changeset body for real-world PRs after
// lockfile elision), with headroom; review-comment / reply prose lives well
// under this.
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on("data", (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        // Stop accumulating but let the body finish streaming so the
        // request/response lifecycle stays in lockstep — fetch clients
        // may not read our response until they've finished writing the
        // body. Rejecting here would also work but sometimes lets the
        // outer catch write 413 before the socket is ready, which some
        // clients see as a connection reset.
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) {
        reject(new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

export function writeCorsHeaders(res: ServerResponse, origin: string | null) {
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Shippable-User-Id, X-Shippable-User-Role",
  );
  // The identity headers make every cross-origin call preflighted (the
  // packaged Tauri shape is tauri://localhost -> 127.0.0.1). Without Max-Age,
  // Chromium caches preflights for ~5s, so polling paths pay a second OPTIONS
  // round trip per poll. 7200s is Chromium's cap; Firefox allows more.
  res.setHeader("Access-Control-Max-Age", "7200");
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
}

export function writeJson(
  res: ServerResponse,
  origin: string | null,
  status: number,
  body: unknown,
): void {
  writeCorsHeaders(res, origin);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
