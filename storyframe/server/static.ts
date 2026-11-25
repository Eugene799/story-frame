import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serves the Vite build so the app and `/api` share one origin.
 *
 * The browser only ever calls relative `/api` paths, and the API sends no CORS
 * headers, so a deployed frontend on another origin could not reach it. One
 * process serving both removes that whole class of problem.
 *
 * Only files under the build directory are reachable: the request path is
 * resolved against it and refused if it escapes. A route-like path (no
 * extension) falls back to `index.html`, so reloading an app URL boots the
 * client instead of 404ing.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function send(
  response: ServerResponse,
  file: string,
  cacheControl: string,
  headOnly: boolean,
): boolean {
  let byteSize: number;
  try {
    const info = statSync(file);
    if (!info.isFile()) return false;
    byteSize = info.size;
  } catch {
    return false;
  }

  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": String(byteSize),
    "Cache-Control": cacheControl,
  });
  if (headOnly) {
    response.end();
    return true;
  }
  createReadStream(file).pipe(response);
  return true;
}

/** A static handler bound to one build directory. */
export function createStaticHandler(
  distDir: string,
): (request: IncomingMessage, response: ServerResponse, pathname: string) => void {
  const dist = resolve(distDir);
  const index = resolve(dist, "index.html");

  return function serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Use GET or HEAD.");
      return;
    }
    const headOnly = request.method === "HEAD";

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Bad path.");
      return;
    }

    const file = resolve(dist, `.${decoded}`);
    const inside = file === dist || file.startsWith(`${dist}${sep}`);
    const isAssetPath = extname(decoded) !== "";

    if (inside && !isAssetPath && send(response, file, "public, max-age=0, must-revalidate", headOnly)) {
      return;
    }

    if (inside && isAssetPath) {
      // Vite hashes everything under /assets, so those files never change in place.
      const cacheControl = decoded.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate";
      if (send(response, file, cacheControl, headOnly)) return;
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }

    if (send(response, index, "no-store", headOnly)) return;
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("The client build is missing. Run npm run build.");
  };
}

/** The Vite build generated next to the server. */
export const serveStatic = createStaticHandler(fileURLToPath(new URL("../dist", import.meta.url)));
