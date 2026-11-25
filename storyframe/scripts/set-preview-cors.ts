import { readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createR2Client } from "../server/r2";
import { preflightUpload } from "./preview-origin";

/**
 * Point the bucket's CORS rule, and `cors.json`, at the origin the browser
 * uploads from.
 *
 * A browser upload is a cross-origin `PUT` to a presigned URL, so the bucket must
 * echo that exact origin. When the preview hostname changes and the rule does
 * not, initiation still succeeds and the `PUT` is refused: the media row stays
 * `pending` and nothing else says why. Run this before a browser check.
 *
 * The methods, headers, exposed headers, and localhost origin in `cors.json` are
 * kept; every other origin becomes the one passed here. The rule is applied
 * through the Cloudflare API, `cors.json` is rewritten to match so the live
 * upload checks preflight the same origin, and a real presigned upload is
 * preflighted from it. No object or other resource is created.
 *
 * Usage: npm run cors:preview -- https://<preview-host>   (or PREVIEW_ORIGIN)
 * Requires CLOUDFLARE_API_TOKEN with R2 edit access, CLOUDFLARE_ACCOUNT_ID, and
 * the bucket name. Exit codes: 0 the bucket echoes the origin, 1 it does not,
 * 2 missing or invalid configuration.
 */

const corsPath = fileURLToPath(new URL("../cors.json", import.meta.url));
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
try {
  loadEnvFile(envPath);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") console.warn(`[cors] Could not load ${envPath} (${code ?? "unknown error"}).`);
}

function value(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

const requested = (process.argv[2] ?? value("PREVIEW_ORIGIN") ?? "").trim();
if (!requested) {
  console.error("SKIP  Pass the preview origin: npm run cors:preview -- https://<preview-host>");
  process.exit(2);
}

let previewOrigin: string;
try {
  const url = new URL(requested);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the origin must start with http:// or https://");
  }
  // A preflight sends one exact string, so a path, query, or fragment is an error.
  previewOrigin = `${url.protocol}//${url.host}`;
  if (previewOrigin !== requested.replace(/\/+$/, "")) {
    throw new Error(`use an origin only, without a path: ${previewOrigin}`);
  }
} catch (error) {
  console.error(`SKIP  ${error instanceof Error ? error.message : "The preview origin is not a URL."}`);
  process.exit(2);
}

const token = value("CLOUDFLARE_API_TOKEN");
const accountId = value("CLOUDFLARE_ACCOUNT_ID");
const r2 = {
  endpoint: value("R2_ENDPOINT") ?? value("CLOUDFLARE_S3_ENDPOINT_URL"),
  bucket: value("R2_BUCKET_NAME") ?? value("CLOUDFLARE_R2_BUCKET_NAME"),
  accessKeyId: value("R2_ACCESS_KEY_ID") ?? value("CLOUDFLARE_ACCESS_ID"),
  secretAccessKey: value("R2_SECRET_ACCESS_KEY") ?? value("CLOUDFLARE_SECRET_ACCESS_KEY"),
};

if (!token || !accountId || !r2.endpoint || !r2.bucket || !r2.accessKeyId || !r2.secretAccessKey) {
  console.error(
    "SKIP  Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and the R2 endpoint, bucket, access key, and secret.",
  );
  process.exit(2);
}

interface CorsRule {
  id?: string;
  allowed: { origins: string[]; methods: string[]; headers?: string[] };
  exposeHeaders?: string[];
  maxAgeSeconds?: number;
}

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}

let rules: CorsRule[];
try {
  rules = (JSON.parse(readFileSync(corsPath, "utf8")) as { rules?: CorsRule[] }).rules ?? [];
} catch (error) {
  console.error(`FAIL  Could not read ${corsPath}: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
if (rules.length === 0) {
  console.error("FAIL  cors.json has no rules to apply.");
  process.exit(1);
}

// The localhost origin stays for local browser checks; every other entry is a
// per-chat preview hostname and becomes the origin passed here.
const staleOrigins = [
  ...new Set(
    rules
      .flatMap((rule) => rule.allowed.origins)
      .filter((origin) => !origin.startsWith("http://localhost") && origin !== previewOrigin),
  ),
];
const policy = {
  rules: rules.map((rule) => ({
    ...rule,
    allowed: {
      ...rule.allowed,
      origins: [...new Set(rule.allowed.origins.map((origin) => (origin.startsWith("http://localhost") ? origin : previewOrigin)))],
    },
  })),
};
console.log(`StoryFrame bucket CORS for ${r2.bucket}`);
console.log(`preview origin ${previewOrigin}`);

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(r2.bucket)}/cors`;
let rejection: string | null = null;
try {
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(policy),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: { code?: number; message?: string }[];
  };
  const errors = (body.errors ?? [])
    .map((error) => `${error.code ?? "?"} ${error.message ?? "unknown error"}`)
    .join("; ");
  if (!response.ok || body.success !== true) rejection = errors || `HTTP ${response.status}`;
} catch (error) {
  rejection = error instanceof Error ? error.message : "unknown error";
}
check("the Cloudflare API accepts the rule", rejection === null, rejection ?? "");
if (rejection !== null) {
  console.error("\nFAIL  The bucket still has its previous CORS rule. cors.json was not changed.");
  process.exit(1);
}

const next = `${JSON.stringify(policy, null, 2)}\n`;
if (next !== readFileSync(corsPath, "utf8")) {
  writeFileSync(corsPath, next);
  console.log("cors.json now names that origin, so the live upload checks preflight the same one");
}

const client = createR2Client({
  endpoint: r2.endpoint,
  bucket: r2.bucket,
  accessKeyId: r2.accessKeyId,
  secretAccessKey: r2.secretAccessKey,
});
const probeUrl = client.presignPut(`media/cors-probe-${Date.now()}.bin`, 120).url;
let cors = await preflightUpload(probeUrl, previewOrigin);
let replaced = await Promise.all(
  staleOrigins.map(async (origin) => ({ origin, verdict: await preflightUpload(probeUrl, origin) })),
);
// R2 can answer the previous rule for a few seconds after the write, which makes
// both verdicts lie; measured, not assumed, so re-probe before reporting either.
for (let attempt = 0; attempt < 6; attempt += 1) {
  if (cors.ok && replaced.every((entry) => !entry.verdict.ok)) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  cors = await preflightUpload(probeUrl, previewOrigin);
  replaced = await Promise.all(
    staleOrigins.map(async (origin) => ({ origin, verdict: await preflightUpload(probeUrl, origin) })),
  );
}
check("a presigned upload preflight is allowed from that origin", cors.ok, cors.detail);

// The origin this rule replaced is the one that stalled a browser upload, so it
// has to be refused now; a foreign origin covers the rule not being a wildcard.
for (const entry of replaced) {
  check(`the replaced origin ${entry.origin} is refused`, !entry.verdict.ok, entry.verdict.detail);
}
if (staleOrigins.length === 0) console.log("SKIP  cors.json named no other preview origin to check");

const foreign = await preflightUpload(probeUrl, "https://example.invalid");
check("a foreign origin is still refused", !foreign.ok, foreign.detail);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
