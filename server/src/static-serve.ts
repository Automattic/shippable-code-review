import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".dat": "application/octet-stream",
};

// Serve the built web bundle so `npm start` runs the whole app on one port
// without Vite. Only wired up when SHIPPABLE_WEB_DIST is set, so the Tauri
// sidecar (which serves its own bundle) and the dev server stay untouched.
// Returns true once it has written a response, false to fall through to 404.
export async function serveStatic(
  root: string,
  url: string,
  res: ServerResponse,
): Promise<boolean> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.split("?")[0]);
  } catch {
    return false;
  }
  const rootResolved = resolve(root);
  let filePath = resolve(rootResolved, "." + pathname);
  // Reject traversal outside the bundle (`resolve` collapses `..` segments).
  if (filePath !== rootResolved && !filePath.startsWith(rootResolved + sep)) {
    return false;
  }
  let info = await statOrNull(filePath);
  if (info?.isDirectory()) {
    filePath = join(filePath, "index.html");
    info = await statOrNull(filePath);
  }
  // SPA fallback: an unknown route with no file extension serves index.html so
  // deep links (e.g. `?cs=…`) and client routing resolve to the app shell.
  if (!info && extname(pathname) === "") {
    filePath = join(rootResolved, "index.html");
    info = await statOrNull(filePath);
  }
  if (!info) return false;
  const ext = extname(filePath);
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": cacheControl(filePath, rootResolved, ext),
  });
  createReadStream(filePath).pipe(res);
  return true;
}

// Vite emits content-hashed filenames under assets/ — cache those forever. The
// HTML shell must never be cached, or a rebuild leaves the browser pointing at
// hashed chunks that no longer exist (white screen until a hard refresh).
function cacheControl(filePath: string, root: string, ext: string): string {
  if (ext === ".html") return "no-cache";
  if (relative(root, filePath).startsWith(`assets${sep}`)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
