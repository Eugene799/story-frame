import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPlan,
  normalizeOrigin,
  parseDeployEnv,
  serviceOrigin,
  syncEnvVars,
} from "../scripts/sync-deploy-env";

// Pure: reads the deploy file, plans a request, and runs a fake fetch.
// No Render request is made and no credential is read.

const deployYaml = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");
const deploy = parseDeployEnv(deployYaml);
const plan = buildPlan(deploy.values, "https://storyframe-nse9.onrender.com/");

function fetchRecorder(
  respond: (url: string, index: number) => Response = () => new Response("{}", { status: 200 }),
): { calls: { url: string; init: RequestInit }[]; fetchImpl: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("deploy env source", () => {
  it("takes only the literal render.yaml values and leaves every sync:false key alone", () => {
    expect(deploy.values).toEqual({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      VIDEO_MAX_BYTES: "67108864",
      LIPSYNC_MAX_INPUT_BYTES: "16777216",
      LIPSYNC_MAX_OUTPUT_BYTES: "67108864",
    });
    // The credentials and the per-service origin are the dashboard's job; the
    // script must have no value for them to send.
    const syncFalseKeys = deployYaml.match(/^\s+sync:\s*false\s*$/gm) ?? [];
    expect(deploy.dashboardKeys).toHaveLength(syncFalseKeys.length);
    for (const key of ["APP_ORIGIN", "SUPABASE_SERVICE_ROLE_KEY", "R2_SECRET_ACCESS_KEY", "OLLAMA_API_KEY"]) {
      expect(deploy.dashboardKeys).toContain(key);
      expect(deploy.values).not.toHaveProperty(key);
    }
  });

  it("plans the six non-secret values, deriving APP_ORIGIN from the service URL", () => {
    expect(plan).toHaveLength(6);
    expect(plan.at(-1)).toEqual({
      key: "APP_ORIGIN",
      value: "https://storyframe-nse9.onrender.com",
    });
    expect(plan.map((entry) => entry.value)).not.toContain("false");
  });

  it("rejects an origin with a path or a non-http scheme", () => {
    expect(() => normalizeOrigin("https://storyframe.test/api")).toThrow(/without a path/);
    expect(() => normalizeOrigin("ftp://storyframe.test")).toThrow(/http or https/);
  });
});

describe("deploy env CLI", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));

  function run(args: string[], env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, ["--import", "tsx", "scripts/sync-deploy-env.ts", ...args], {
      cwd,
      env: { ...process.env, RENDER_API_KEY: "", ...env },
      encoding: "utf8",
    });
  }

  it("exits 2 with a usage message rather than a stack trace", () => {
    // A path in APP_ORIGIN is a configuration mistake, not a crash: the run must
    // stop before any request and say so.
    const badOrigin = run(["--service", "srv-test", "--origin", "https://storyframe.test/api", "--dry-run"]);
    expect(badOrigin.status).toBe(2);
    expect(badOrigin.stderr).toContain("nothing was written");
    expect(badOrigin.stderr).not.toContain("    at ");

    const noService = run(["--origin", "https://storyframe.test", "--dry-run"]);
    expect(noService.status).toBe(2);
    expect(noService.stderr).toContain("Pass --service");
  });

  it("prints the plan and writes nothing on a dry run", () => {
    const dryRun = run([
      "--service",
      "srv-test",
      "--origin",
      "https://storyframe.test",
      "--dry-run",
    ]);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("PLAN  APP_ORIGIN=https://storyframe.test");
    expect(dryRun.stdout).toContain("20 keys left alone");
    expect(dryRun.stdout).not.toContain("SET  ");
  });
});

describe("deploy env sync", () => {
  it("PUTs each key on its own so a stored credential is never replaced", async () => {
    const { calls, fetchImpl } = fetchRecorder();
    const results = await syncEnvVars({
      serviceId: "srv-test",
      apiKey: "render-key",
      entries: plan,
      fetchImpl,
      apiBase: "https://api.test/v1",
    });

    expect(results.every((result) => result.ok)).toBe(true);
    expect(calls).toHaveLength(plan.length);
    expect(calls[0]?.url).toBe("https://api.test/v1/services/srv-test/env-vars/NODE_ENV");
    expect(calls[0]?.init.method).toBe("PUT");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer render-key");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ value: "production" });

    // One key per request: no bulk body that could drop a credential.
    const sentKeys = calls.map((call) => call.url.slice(call.url.lastIndexOf("/") + 1));
    expect(sentKeys).toEqual(plan.map((entry) => entry.key));
    expect(sentKeys).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("reports a failed key and still attempts the rest", async () => {
    const { fetchImpl } = fetchRecorder((_url, index) =>
      index === 0 ? new Response("unauthorized", { status: 401 }) : new Response("{}", { status: 200 }),
    );
    const results = await syncEnvVars({
      serviceId: "srv-test",
      apiKey: "render-key",
      entries: plan,
      fetchImpl,
      apiBase: "https://api.test/v1",
    });

    expect(results[0]).toMatchObject({ key: "NODE_ENV", ok: false, status: 401 });
    expect(results.slice(1).every((result) => result.ok)).toBe(true);
  });

  it("reads APP_ORIGIN from the service's own URL", async () => {
    const { fetchImpl } = fetchRecorder(
      () =>
        new Response(JSON.stringify({ serviceDetails: { url: "https://storyframe-nse9.onrender.com" } }), {
          status: 200,
        }),
    );
    expect(await serviceOrigin({ serviceId: "srv-test", apiKey: "render-key", fetchImpl })).toBe(
      "https://storyframe-nse9.onrender.com",
    );

    const missing = fetchRecorder(() => new Response(JSON.stringify({ serviceDetails: {} }), { status: 200 }));
    await expect(
      serviceOrigin({ serviceId: "srv-test", apiKey: "render-key", fetchImpl: missing.fetchImpl }),
    ).rejects.toThrow(/no service URL/);
  });
});
