import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Push the deploy's non-secret environment onto a Render service.
 *
 * `render.yaml` is the source of truth for the values that are safe to write by
 * hand: `NODE_ENV`, `HOST`, and the three measured caps. Everything marked
 * `sync: false` is a credential (or a per-service value) and is never sent — the
 * three caps keep their defaults, the secrets stay in the dashboard. `APP_ORIGIN`
 * is `sync: false` too because it is per-service, so it is derived from the
 * service's own URL instead of being typed in.
 *
 *   npm run deploy:env -- --service srv-xxxx [--origin https://<host>] [--dry-run]
 *
 * `RENDER_API_KEY` comes from the shell or `.env`; `RENDER_SERVICE_ID` can stand
 * in for `--service`. Each key is written with PUT /env-vars/{key}, which adds or
 * updates that key alone, so a credential already on the service is untouched.
 * Render does not deploy env changes by itself: run a deploy afterwards.
 *
 * Exit codes: 0 every value set, 1 a write failed, 2 usage or configuration.
 */

const RENDER_API = "https://api.render.com/v1";
const DEPLOY_FILE = new URL("../render.yaml", import.meta.url);

export interface DeployEnv {
  /** Keys with a literal `value:` in the deploy file, in file order. */
  values: Record<string, string>;
  /** Keys marked `sync: false`: credentials, plus the per-service `APP_ORIGIN`. */
  dashboardKeys: string[];
}

export interface SyncResult {
  key: string;
  ok: boolean;
  status?: number;
  detail?: string;
}

/** Reads the literal `value:` entries and the `sync: false` keys from render.yaml. */
export function parseDeployEnv(yaml: string): DeployEnv {
  const values: Record<string, string> = {};
  const dashboardKeys: string[] = [];
  let key: string | null = null;
  let literal: string | null = null;
  let fromDashboard = false;

  const flush = (): void => {
    if (key === null) return;
    if (literal !== null) values[key] = literal;
    else if (fromDashboard) dashboardKeys.push(key);
    key = null;
    literal = null;
    fromDashboard = false;
  };

  for (const line of yaml.split(/\r?\n/)) {
    const keyMatch = /^\s*-\s*key:\s*(\S+)\s*$/.exec(line);
    if (keyMatch) {
      flush();
      key = keyMatch[1] ?? "";
      continue;
    }
    if (key === null) continue;
    const valueMatch = /^\s+value:\s*(.+?)\s*$/.exec(line);
    if (valueMatch) {
      const raw = valueMatch[1] ?? "";
      literal = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      continue;
    }
    if (/^\s+sync:\s*false\s*$/.test(line)) fromDashboard = true;
  }
  flush();

  return { values, dashboardKeys };
}

/** An origin only: http(s), a host, no path, no trailing slash. */
export function normalizeOrigin(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`APP_ORIGIN must be http or https, not ${url.protocol}`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`APP_ORIGIN must be an origin without a path: ${url.origin}`);
  }
  return `${url.protocol}//${url.host}`;
}

/** The deploy values plus `APP_ORIGIN` for this service, ready to write. */
export function buildPlan(values: Record<string, string>, appOrigin: string): { key: string; value: string }[] {
  const origin = normalizeOrigin(appOrigin);
  const plan = Object.entries(values).map(([key, value]) => ({ key, value }));
  return [...plan.filter((entry) => entry.key !== "APP_ORIGIN"), { key: "APP_ORIGIN", value: origin }];
}

/** Adds or updates each key on its own, so no existing credential is replaced. */
export async function syncEnvVars(options: {
  serviceId: string;
  apiKey: string;
  entries: { key: string; value: string }[];
  fetchImpl?: typeof fetch;
  apiBase?: string;
}): Promise<SyncResult[]> {
  const { serviceId, apiKey, entries } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? RENDER_API;
  const results: SyncResult[] = [];

  for (const { key, value } of entries) {
    try {
      const response = await fetchImpl(
        `${apiBase}/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(key)}`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ value }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      results.push({
        key,
        ok: response.ok,
        status: response.status,
        detail: response.ok ? undefined : (await response.text()).slice(0, 200),
      });
    } catch (error) {
      results.push({ key, ok: false, detail: error instanceof Error ? error.message : "request failed" });
    }
  }
  return results;
}

/** The service's own URL, which is what `APP_ORIGIN` has to name. */
export async function serviceOrigin(options: {
  serviceId: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? RENDER_API;
  const response = await fetchImpl(`${apiBase}/services/${encodeURIComponent(options.serviceId)}`, {
    headers: { authorization: `Bearer ${options.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `Render returned ${response.status} for ${options.serviceId}; check RENDER_API_KEY and the service id`,
    );
  }
  const body = (await response.json()) as { serviceDetails?: { url?: string | null } };
  const url = body.serviceDetails?.url;
  if (!url) throw new Error(`${options.serviceId} has no service URL yet`);
  return normalizeOrigin(url);
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<void> {
  try {
    loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.warn(`[deploy:env] Could not load .env (${code ?? "unknown error"}).`);
  }

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: npm run deploy:env -- --service <srv-id> [--origin https://<host>] [--dry-run]");
    return;
  }

  const serviceId = arg("service") ?? process.env.RENDER_SERVICE_ID?.trim() ?? "";
  const apiKey = process.env.RENDER_API_KEY?.trim() ?? "";
  const dryRun = process.argv.includes("--dry-run");
  const requestedOrigin = arg("origin");
  // A dry run with an explicit origin needs no key: it prints the plan and writes nothing.
  if (!serviceId || (!apiKey && !(dryRun && requestedOrigin))) {
    console.error(
      "SKIP  Pass --service <srv-id> (or RENDER_SERVICE_ID) and set RENDER_API_KEY; nothing was written.",
    );
    process.exitCode = 2;
    return;
  }

  const yaml = readFileSync(DEPLOY_FILE, "utf8");
  const deploy = parseDeployEnv(yaml);
  let origin: string;
  try {
    origin = requestedOrigin ? normalizeOrigin(requestedOrigin) : await serviceOrigin({ serviceId, apiKey });
  } catch (error) {
    console.error(`SKIP  ${error instanceof Error ? error.message : "could not read the service origin"}; nothing was written.`);
    process.exitCode = 2;
    return;
  }
  const plan = buildPlan(deploy.values, origin);

  console.log(`StoryFrame deploy env for ${serviceId}`);
  console.log(`PASS  ${plan.length} non-secret values from render.yaml; ${deploy.dashboardKeys.length} keys left alone`);
  if (dryRun) {
    for (const { key, value } of plan) console.log(`PLAN  ${key}=${value}`);
    return;
  }

  const results = await syncEnvVars({ serviceId, apiKey, entries: plan });
  for (const result of results) {
    const printed = plan.find((entry) => entry.key === result.key)?.value ?? "";
    console.log(
      result.ok
        ? `SET   ${result.key}=${printed}`
        : `FAIL  ${result.key}  (${result.status ? `status=${result.status} ` : ""}${result.detail ?? "request failed"})`,
    );
  }

  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} values synced`);
  console.log("Render does not deploy env changes on its own: deploy the service to apply them.");
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main().catch((error: unknown) => {
    console.error(`FAIL  ${error instanceof Error ? error.message : "unexpected failure"}`);
    process.exitCode = 2;
  });
}
