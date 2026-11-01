import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Serves the built web app. Unknown paths without a file extension get index.html (client-side routes). */
export function staticFiles(rootDir: string): MiddlewareHandler {
  const root = resolve(rootDir);
  const indexFile = join(root, "index.html");

  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    let requestPath: string;
    try {
      requestPath = decodeURIComponent(c.req.path);
    } catch {
      return c.notFound();
    }
    if (requestPath.startsWith("/api/")) return next();

    let file = resolve(root, `.${requestPath}`);
    if (file !== root && !file.startsWith(root + sep)) return c.notFound();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      if (extname(requestPath)) return c.notFound();
      file = indexFile;
    }

    const body = await readFile(file).catch(() => null);
    if (!body) return c.notFound();
    const immutable = requestPath.startsWith("/assets/");
    return c.body(body, 200, {
      "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
  };
}
