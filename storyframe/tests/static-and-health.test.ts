import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticHandler } from "../server/static";
import { startTestServer, type TestApp } from "./server-helpers";

// The static handler is tested against a fixture build, not the real `dist`, so
// the suite does not depend on `npm run build` having run first.

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';
const SCRIPT = "console.log('storyframe');";

interface StaticApp {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

async function startStaticServer(distDir: string | null): Promise<StaticApp> {
  const handler = createStaticHandler(distDir ?? join(tmpdir(), "storyframe-missing-dist"));
  const server = createServer((request, response) => {
    // The raw path, so a traversal attempt reaches the handler unnormalized.
    handler(request, response, (request.url ?? "/").split("?")[0]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

let buildDir: string;
let emptyDir: string;
let app: StaticApp;
let missingBuild: StaticApp;

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "storyframe-dist-"));
  emptyDir = await mkdtemp(join(tmpdir(), "storyframe-empty-"));
  await mkdir(join(buildDir, "assets"), { recursive: true });
  await writeFile(join(buildDir, "index.html"), INDEX_HTML);
  await writeFile(join(buildDir, "assets", "app-abc123.js"), SCRIPT);
  await writeFile(join(buildDir, "..", "storyframe-secret.txt"), "SECRET");
  app = await startStaticServer(buildDir);
  missingBuild = await startStaticServer(emptyDir);
});

afterAll(async () => {
  await app?.close();
  await missingBuild?.close();
  await rm(buildDir, { recursive: true, force: true });
  await rm(emptyDir, { recursive: true, force: true });
  await rm(join(buildDir, "..", "storyframe-secret.txt"), { force: true });
});

describe("static build handler", () => {
  it("serves index.html at the root without caching it", async () => {
    const response = await fetch(`${app.url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain('id="root"');
  });

  it("serves a hashed asset as immutable JavaScript", async () => {
    const response = await fetch(`${app.url}/assets/app-abc123.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe(SCRIPT);
  });

  it("falls back to index.html for an app route", async () => {
    const response = await fetch(`${app.url}/projects/abc`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="root"');
  });

  it("does not fall back to index.html for a missing asset", async () => {
    const response = await fetch(`${app.url}/assets/missing.js`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found.");
  });

  it("refuses a path that escapes the build directory", async () => {
    // Encoded so the client does not normalize the traversal away: the handler
    // decodes it, resolves outside the build, and falls back to the client.
    const response = await fetch(`${app.url}/..%2fstoryframe-secret.txt`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('id="root"');
    expect(body).not.toContain("SECRET");
  });

  it("answers HEAD with headers and no body", async () => {
    const response = await fetch(`${app.url}/`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(INDEX_HTML.length));
    expect(await response.text()).toBe("");
  });

  it("rejects other methods", async () => {
    const response = await fetch(`${app.url}/`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("reports a missing build instead of pretending the app loaded", async () => {
    const response = await fetch(`${missingBuild.url}/`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("npm run build");
  });
});

describe("health route and API fallthrough", () => {
  let server: TestApp;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("reports configuration readiness without a provider call", async () => {
    const response = await fetch(`${server.url}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      ready: { auth: true, ledger: true, storage: true },
    });
  });

  it("fails the health check when the ledger or storage is not configured", async () => {
    const unconfigured = await startTestServer({
      env: {
        SUPABASE_SERVICE_ROLE_KEY: "",
        R2_ENDPOINT: "",
        R2_BUCKET_NAME: "",
        R2_ACCESS_KEY_ID: "",
        R2_SECRET_ACCESS_KEY: "",
      },
    });
    try {
      const response = await fetch(`${unconfigured.url}/api/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        ready: { auth: true, ledger: false, storage: false },
      });
    } finally {
      await unconfigured.close();
    }
  });

  it("answers the bare /api prefix with the JSON 404, not the client", async () => {
    const response = await fetch(`${server.url}/api`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Unknown endpoint." },
    });
  });

  it("rejects a non-GET health check", async () => {
    const response = await fetch(`${server.url}/api/health`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});
