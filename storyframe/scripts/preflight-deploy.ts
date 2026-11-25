import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

/**
 * One-command check of a deployed StoryFrame instance.
 *
 * It answers two questions that a deploy can get wrong independently:
 * 1. Is the production environment complete? Run from the machine or dashboard
 *    shell that holds the deploy values, it checks the Supabase trio, the R2
 *    quartet, and `APP_ORIGIN`, and warns about provider keys (a missing one
 *    disables that feature rather than breaking the instance).
 * 2. Does the target origin actually serve the app? It fetches the client shell
 *    and the asset it references, `/api/health` (which answers 503 when auth,
 *    ledger, or storage is unconfigured), and an unknown `/api` path, which must
 *    be the JSON 404 rather than the client.
 *
 * Usage: npm run preflight:deploy -- https://<origin>   (or PREFLIGHT_ORIGIN)
 * Exit codes: 0 every check passed, 1 something failed, 2 no usable origin.
 * It prints no secret and never mutates the deployment.
 */

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
try {
  loadEnvFile(envPath);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") console.warn(`[preflight] Could not load ${envPath} (${code ?? "unknown error"}).`);
}

function value(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

const requested = (process.argv[2] ?? value("PREFLIGHT_ORIGIN") ?? "").trim();
if (!requested) {
  console.error("SKIP  Pass the deployment origin: npm run preflight:deploy -- https://<origin>");
  process.exit(2);
}

let origin: string;
try {
  const url = new URL(requested);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the origin must start with http:// or https://");
  }
  origin = `${url.protocol}//${url.host}`;
  if (origin !== requested.replace(/\/+$/, "")) {
    throw new Error(`use an origin only, without a path: ${origin}`);
  }
} catch (error) {
  console.error(`SKIP  ${error instanceof Error ? error.message : "The origin is not a URL."}`);
  process.exit(2);
}

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}
function skip(name: string, detail = ""): void {
  console.log(`SKIP  ${name}${detail ? `  (${detail})` : ""}`);
}
function warn(name: string, detail = ""): void {
  console.log(`WARN  ${name}${detail ? `  (${detail})` : ""}`);
}

// The values the instance cannot work without: identity, the durable ledger,
// private media, and the one origin allowed to call the API.
const required: [string, string | null][] = [
  ["SUPABASE_URL", value("SUPABASE_URL")],
  ["SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY)", value("SUPABASE_PUBLISHABLE_KEY") ?? value("SUPABASE_ANON_KEY")],
  ["SUPABASE_SERVICE_ROLE_KEY", value("SUPABASE_SERVICE_ROLE_KEY")],
  ["R2_ENDPOINT (or CLOUDFLARE_S3_ENDPOINT_URL)", value("R2_ENDPOINT") ?? value("CLOUDFLARE_S3_ENDPOINT_URL")],
  ["R2_BUCKET_NAME (or CLOUDFLARE_R2_BUCKET_NAME)", value("R2_BUCKET_NAME") ?? value("CLOUDFLARE_R2_BUCKET_NAME")],
  ["R2_ACCESS_KEY_ID (or CLOUDFLARE_ACCESS_ID)", value("R2_ACCESS_KEY_ID") ?? value("CLOUDFLARE_ACCESS_ID")],
  ["R2_SECRET_ACCESS_KEY (or CLOUDFLARE_SECRET_ACCESS_KEY)", value("R2_SECRET_ACCESS_KEY") ?? value("CLOUDFLARE_SECRET_ACCESS_KEY")],
  ["APP_ORIGIN", value("APP_ORIGIN")],
];
const optional: [string, string | null][] = [
  ["OLLAMA_API_KEY", value("OLLAMA_API_KEY")],
  ["DEEPGRAM_API_KEY", value("DEEPGRAM_API_KEY")],
  ["JSON2VIDEO_API_KEY", value("JSON2VIDEO_API_KEY")],
  ["EVERYPIXEL_CLIENT_ID", value("EVERYPIXEL_CLIENT_ID")],
  ["EVERYPIXEL_SECRET_ID", value("EVERYPIXEL_SECRET_ID")],
  ["PEXELS_API_KEY", value("PEXELS_API_KEY")],
  ["PIXABAY_API_KEY", value("PIXABAY_API_KEY")],
  ["CLOUDFLARE_ACCOUNT_ID", value("CLOUDFLARE_ACCOUNT_ID")],
  ["CLOUDFLARE_AI_API_TOKEN (or CF_API_TOKEN)", value("CLOUDFLARE_AI_API_TOKEN") ?? value("CF_API_TOKEN")],
  ["LEONARDO_API_KEY", value("LEONARDO_API_KEY")],
];

console.log(`StoryFrame deploy preflight for ${origin}`);
const provided = required.filter(([, configured]) => configured !== null).length;
if (provided === 0) {
  // The origin probe below still validates the deployed instance's own readiness.
  skip("production env", "none of the deploy values are set in this shell");
} else {
  for (const [name, configured] of required) {
    check(name, configured !== null, "missing");
  }
  const appOrigin = value("APP_ORIGIN")?.replace(/\/+$/, "");
  if (appOrigin) {
    check("APP_ORIGIN names the probed origin", appOrigin === origin, `APP_ORIGIN=${appOrigin}`);
  }
  for (const [name, configured] of optional) {
    if (configured === null) warn(`${name} is not set`, "that feature stays disabled on this deployment");
  }
}

async function probe(path: string): Promise<Response | null> {
  try {
    return await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15_000) });
  } catch {
    return null;
  }
}

const root = await probe("/");
if (root === null) {
  check(`${origin} is reachable`, false, "the request failed");
} else {
  const contentType = root.headers.get("content-type") ?? "none";
  const html = root.ok ? await root.text() : "";
  // The shell must reference the built bundle; a bare HTML error page would not.
  const asset = /assets\/[^"']+\.(?:js|css)/.exec(html)?.[0] ?? null;
  check(
    "the origin serves the built client",
    root.status === 200 && contentType.includes("text/html") && asset !== null,
    `status=${root.status} type=${contentType} asset=${asset ?? "none"}`,
  );

  if (asset !== null) {
    const bundle = await probe(`/${asset}`);
    check("the asset it references is served", bundle?.status === 200, `path=/${asset}`);
  }

  const health = await probe("/api/health");
  const healthBody = (await health?.json().catch(() => null)) as {
    ok?: boolean;
    ready?: Record<string, boolean>;
  } | null;
  const notReady = Object.entries(healthBody?.ready ?? {})
    .filter(([, ready]) => !ready)
    .map(([name]) => name);
  check(
    "/api/health reports a configured instance",
    health?.status === 200 && healthBody?.ok === true && notReady.length === 0,
    health === null
      ? "the request failed"
      : `status=${health.status} ready=${JSON.stringify(healthBody?.ready ?? null)}`,
  );

  const unknownPath = `/api/preflight-${Math.random().toString(16).slice(2, 10)}`;
  const unknown = await probe(unknownPath);
  const unknownBody = (await unknown?.json().catch(() => null)) as { error?: { code?: string } } | null;
  const unknownType = unknown?.headers.get("content-type") ?? "none";
  check(
    "an unknown /api path is a JSON 404",
    unknown?.status === 404 && unknownType.includes("application/json") && unknownBody?.error?.code === "NOT_FOUND",
    `status=${unknown?.status ?? "none"} type=${unknownType} code=${unknownBody?.error?.code ?? "none"}`,
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
