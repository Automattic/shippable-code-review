import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { serveStatic } from "./static-serve.ts";

// Minimal ServerResponse stand-in: captures the status + headers serveStatic
// sets synchronously before it pipes the file, and absorbs the streamed body.
class ResStub extends Writable {
  statusCode = 0;
  headers: Record<string, string> = {};
  writeHead(code: number, headers: Record<string, string>) {
    this.statusCode = code;
    this.headers = headers;
    return this;
  }
  _write(_chunk: unknown, _enc: unknown, cb: () => void) {
    cb();
  }
}

let dist: string;

beforeAll(async () => {
  dist = await fs.mkdtemp(path.join(os.tmpdir(), "shippable-static-"));
  await fs.writeFile(path.join(dist, "index.html"), "<!doctype html><title>app</title>");
  await fs.mkdir(path.join(dist, "assets"));
  await fs.writeFile(path.join(dist, "assets", "main-DEADBEEF.js"), "console.log(1)");
});

afterAll(async () => {
  await fs.rm(dist, { recursive: true, force: true });
});

const serve = (url: string) => {
  const res = new ResStub();
  return serveStatic(dist, url, res as never).then((handled) => ({ handled, res }));
};

describe("serveStatic path-traversal guard", () => {
  it.each([
    "/../../etc/passwd",
    "/..%2f..%2f..%2fetc%2fpasswd",
    "/%2e%2e/%2e%2e/etc/passwd",
  ])("declines traversal that escapes the root: %s", async (url) => {
    const { handled } = await serve(url);
    expect(handled).toBe(false);
  });

  it("declines a malformed percent-encoding without throwing", async () => {
    const { handled } = await serve("/%E0%A4%A");
    expect(handled).toBe(false);
  });

  it("declines a path with a null byte", async () => {
    // `stat` rejects null bytes; statOrNull swallows that, and the ".png"
    // extension skips the SPA fallback, so nothing is served.
    const { handled } = await serve("/etc/passwd%00.png");
    expect(handled).toBe(false);
  });
});

describe("serveStatic serving + cache headers", () => {
  it("serves the shell with no-cache for the root", async () => {
    const { handled, res } = await serve("/");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/html");
    expect(res.headers["Cache-Control"]).toBe("no-cache");
  });

  it("serves hashed assets as immutable", async () => {
    const { handled, res } = await serve("/assets/main-DEADBEEF.js");
    expect(handled).toBe(true);
    expect(res.headers["Content-Type"]).toContain("text/javascript");
    expect(res.headers["Cache-Control"]).toContain("immutable");
  });

  it("falls back to the shell for an extensionless route", async () => {
    const { handled, res } = await serve("/some/deep/route");
    expect(handled).toBe(true);
    expect(res.headers["Content-Type"]).toContain("text/html");
  });

  it("declines a missing asset with an extension (no false 200)", async () => {
    const { handled } = await serve("/assets/missing-CAFE.js");
    expect(handled).toBe(false);
  });
});
