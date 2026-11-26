import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "../server/app";
import { EVERYPIXEL_STATUS_URL } from "../server/everypixel";
import { createR2Client, type R2Config } from "../server/r2";
import { LIPSYNC_MAX_SOURCE_SECONDS, LIPSYNC_RATE_VERSION, lipsyncEstimateUsd } from "../shared/lipsync-contract";

/**
 * Opt-in live check for the per-row claims that guard paid work.
 *
 * Image settlement: one server sweeps a pending Leonardo job, the other serves
 * a `…/refresh` for the same job.
 *
 * Runs two servers against the same hosted Supabase and R2: one sweeps pending
 * image jobs, the other serves a `…/refresh` for the same job. The Leonardo
 * poll and the image bytes are answered locally, so no provider credit is
 * spent, while the generation row, the lease row, and the stored object are
 * real.
 *
 * The sweep is held inside its claim (blocked in the image download) while the
 * refresh races it. That proves: both instances polled the same job, exactly
 * one `image-settle:<id>` claim exists while the settlement runs, the refresh
 * is refused with `202` without touching the bucket, and the job ends with one
 * media row and one readable stored object.
 *
 * The fixed `image-sweep` lease is waited for and then released, so a crashed
 * run or a deployed instance cannot make the check fail and the check can run
 * again immediately.
 *
 * Lip sync: the first instance sweeps a pending lip sync and is held inside the
 * finished-MP4 download; the second instance starts then, takes the pass over
 * once the first instance's lease is lapsed mid-pass (a paused or partitioned
 * process), and must stand down on the row claim instead of polling and storing
 * a second copy. The row ends ready with one media row, one usage row, and one
 * stored object.
 *
 * Neither race spends provider credit: Leonardo, Everypixel, and the media
 * bytes are answered locally, while Supabase, the lease table, and R2 are real.
 *
 * It never prints keys, tokens, signed URLs, prompts, or provider responses.
 */
try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const JOB_ID = "job-claim-race";
const IMAGE_URL = "https://cdn.leonardo.ai/verify/claim-race.png";
const LIPSYNC_TASK_ID = "verify-claim-task";
const LIPSYNC_OUTPUT_URL = "https://cdn.everypixel.com/verify/claim-race.mp4";
/** The length the finished clip carries, and the seconds that must be counted. */
const LIPSYNC_SECONDS = 6;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, payload]);
}

/** A real MP4 skeleton: an ftyp box and a movie header with a six-second length. */
const LIPSYNC_MP4 = (() => {
  const payload = Buffer.alloc(100);
  payload.writeUInt8(0, 0);
  payload.writeUInt32BE(1000, 12);
  payload.writeUInt32BE(LIPSYNC_SECONDS * 1000, 16);
  return Buffer.concat([box("ftyp", Buffer.from("isomisomiso2", "ascii")), box("moov", box("mvhd", payload))]);
})();

function required(label: string, value: string | undefined): string {
  if (!value) {
    console.error(`verify:claim-live requires ${label}.`);
    process.exit(1);
  }
  return value;
}

const base = required("SUPABASE_URL", process.env.SUPABASE_URL?.replace(/\/+$/, ""));
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
const publishableKey = required(
  "SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY",
  process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY,
);
const r2: R2Config = {
  endpoint: required(
    "R2_ENDPOINT or CLOUDFLARE_S3_ENDPOINT_URL",
    process.env.R2_ENDPOINT ?? process.env.CLOUDFLARE_S3_ENDPOINT_URL,
  ),
  bucket: required(
    "R2_BUCKET_NAME or CLOUDFLARE_R2_BUCKET_NAME",
    process.env.R2_BUCKET_NAME ?? process.env.CLOUDFLARE_R2_BUCKET_NAME,
  ),
  accessKeyId: required(
    "R2_ACCESS_KEY_ID or CLOUDFLARE_ACCESS_ID",
    process.env.R2_ACCESS_KEY_ID ?? process.env.CLOUDFLARE_ACCESS_ID,
  ),
  secretAccessKey: required(
    "R2_SECRET_ACCESS_KEY or CLOUDFLARE_SECRET_ACCESS_KEY",
    process.env.R2_SECRET_ACCESS_KEY ?? process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  ),
};

const adminHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};
const serviceHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
};
const authHeaders = {
  apikey: publishableKey,
  "Content-Type": "application/json",
};

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

interface ProviderCall {
  instance: "sweep" | "refresh" | "lipsync-sweep" | "lipsync-takeover";
  kind: "poll" | "download";
  at: number;
}

/**
 * Answers the Leonardo poll and the image bytes for one instance, and records
 * which instance asked. Everything else — Supabase, the bucket — stays real.
 */
function instrumentedFetch(
  instance: ProviderCall["instance"],
  calls: ProviderCall[],
  downloadGate: Promise<void>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cloud.leonardo.ai/api/rest/v1/generations/")) {
      calls.push({ instance, kind: "poll", at: Date.now() });
      return new Response(
        JSON.stringify({
          generations_by_pk: {
            status: "COMPLETE",
            generated_images: [{ url: IMAGE_URL }],
            apiCreditCost: 3,
            cost: { amount: 0.02, unit: "USD" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === IMAGE_URL) {
      calls.push({ instance, kind: "download", at: Date.now() });
      await downloadGate;
      return new Response(new Uint8Array(PNG), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }
    return fetch(input as RequestInfo, init);
  }) as typeof fetch;
}

/**
 * Answers the Everypixel status read and the finished MP4 for one instance.
 * The download is held open until the gate opens, which is the window the
 * second instance takes over in. Supabase and the bucket are passed through.
 */
function lipsyncFetch(
  instance: ProviderCall["instance"],
  calls: ProviderCall[],
  downloadGate: Promise<void>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(EVERYPIXEL_STATUS_URL)) {
      calls.push({ instance, kind: "poll", at: Date.now() });
      return new Response(
        JSON.stringify({
          task_id: LIPSYNC_TASK_ID,
          status: "SUCCESS",
          result: LIPSYNC_OUTPUT_URL,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === LIPSYNC_OUTPUT_URL) {
      calls.push({ instance, kind: "download", at: Date.now() });
      await downloadGate;
      return new Response(new Uint8Array(LIPSYNC_MP4), {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      });
    }
    return fetch(input as RequestInfo, init);
  }) as typeof fetch;
}

async function waitFor(label: string, ready: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createUser(): Promise<{ id: string; token: string }> {
  const email = `storyframe-claim-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `R${randomUUID()}a1!`;
  const created = await fetch(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const createdBody = (await created.json().catch(() => ({}))) as {
    id?: string;
    user?: { id?: string };
  };
  const id = createdBody.id ?? createdBody.user?.id;
  if (!created.ok || typeof id !== "string") {
    throw new Error(`could not create a disposable user (HTTP ${created.status})`);
  }
  const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ email, password }),
  });
  const session = (await login.json().catch(() => ({}))) as {
    access_token?: string;
  };
  if (!login.ok || typeof session.access_token !== "string") {
    throw new Error(`could not sign in the disposable user (HTTP ${login.status})`);
  }
  return { id, token: session.access_token };
}

const document = {
  schemaVersion: 2,
  summary: "",
  brief: {
    topic: "Live claim check",
    audience: "Internal",
    goal: "Prove the per-row settlement claim",
    mode: "fiction",
    targetDurationSeconds: 30,
    tone: "Neutral",
    preset: "Story short",
    voicePreference: "neutral",
    planningBudgetUsd: 0,
  },
  scenes: [
    {
      id: "s1",
      heading: "Opening",
      body: "Hello",
      visualDirection: "",
      assetIds: [],
      onScreenText: "",
      durationSeconds: 10,
      approved: false,
      approvedFingerprint: null,
      locks: {
        narration: false,
        visualDirection: false,
        onScreenText: false,
        duration: false,
      },
    },
  ],
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port assigned");
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function main(): Promise<number> {
  const calls: ProviderCall[] = [];
  const logs: string[] = [];
  const ownLeases: { name: string; holder: string }[] = [];
  const logger = { error: (message: string) => logs.push(message) };
  let releaseDownload: () => void = () => undefined;
  const downloadGate = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });

  const providerEnv = {
    ...process.env,
    // A placeholder keeps the Leonardo adapter configured; the fake answers it.
    LEONARDO_API_KEY: "verify-claim-placeholder",
    IMAGE_POLL_INTERVAL_MS: "50",
    IMAGE_GENERATION_TIMEOUT_MS: "60000",
    IMAGE_PENDING_ABANDON_AFTER_MS: "900000",
  };
  const sweepServer = createStoryframeServer({
    env: { ...providerEnv, IMAGE_PENDING_SWEEP_INTERVAL_MS: "50" },
    fetchImpl: instrumentedFetch("sweep", calls, downloadGate),
    logger,
  });
  const refreshServer = createStoryframeServer({
    env: { ...providerEnv, IMAGE_PENDING_SWEEP_INTERVAL_MS: "0" },
    fetchImpl: instrumentedFetch("refresh", calls, downloadGate),
    logger,
  });

  async function api(
    appUrl: string,
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${appUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }

  async function serviceRows(query: string): Promise<any[]> {
    const response = await fetch(`${base}/rest/v1/${query}`, {
      headers: serviceHeaders,
    });
    if (!response.ok) throw new Error(`service read failed (HTTP ${response.status})`);
    const payload = await response.json().catch(() => null);
    return Array.isArray(payload) ? payload : [];
  }

  /**
   * Races the lip sync sweep against a second instance that takes the pass over.
   *
   * A pass renews its own lease while it runs, so a live holder never lapses on
   * its own. This check lapses the sweeper's lease while its pass is still
   * inside the provider download, which is what a paused or partitioned
   * instance looks like: the renewal stops and the pass continues without the
   * lease. The second instance then claims the free pass lease, lists the same
   * pending row, and must stand down on the per-row claim instead of polling
   * the provider and storing a second copy.
   */
  async function lipsyncRace(account: { id: string; token: string }): Promise<void> {
    const calls: ProviderCall[] = [];
    /**
     * Every lease claim as it reaches the real store. The lease client uses the
     * global fetch rather than an injected one, so watching that call is the
     * only way to tell a refused claim from a pass that never got to the row:
     * a refusal changes no row. Restored in the teardown below.
     */
    const leaseClaims: { name: string; holder: string; granted: boolean }[] = [];
    const globalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/rest/v1/rpc/claim_job_lease") || init?.method !== "POST") {
        return globalFetch(input as RequestInfo, init);
      }
      const body = JSON.parse(String(init.body ?? "{}")) as { p_name?: unknown; p_holder?: unknown };
      const response = await globalFetch(input as RequestInfo, init);
      const granted =
        (await response
          .clone()
          .json()
          .catch(() => null)) === true;
      leaseClaims.push({ name: String(body.p_name ?? ""), holder: String(body.p_holder ?? ""), granted });
      return response;
    }) as typeof fetch;
    const sweepLogs: string[] = [];
    const takeoverLogs: string[] = [];
    const leases: { name: string; holder: string }[] = [];
    let releaseDownload: () => void = () => undefined;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const env = {
      ...process.env,
      // Placeholders keep the Everypixel adapter configured; the fake answers it.
      EVERYPIXEL_CLIENT_ID: "verify-claim-placeholder",
      EVERYPIXEL_SECRET_ID: "verify-claim-placeholder",
      LIPSYNC_POLL_INTERVAL_MS: "0",
      LIPSYNC_TIMEOUT_MS: "15000",
      LIPSYNC_DOWNLOAD_TIMEOUT_MS: "120000",
      LIPSYNC_ABANDON_AFTER_MS: "3600000",
      LIPSYNC_SWEEP_INTERVAL_MS: "50",
      IMAGE_PENDING_SWEEP_INTERVAL_MS: "0",
      MEDIA_SWEEP_INTERVAL_MS: "0",
      VIDEO_SWEEP_INTERVAL_MS: "0",
    };

    const sweepServer = createStoryframeServer({
      env,
      fetchImpl: lipsyncFetch("lipsync-sweep", calls, downloadGate),
      logger: { error: (message: string) => sweepLogs.push(message) },
    });
    let takeoverServer: Server | null = null;

    const exportId = randomUUID();
    const rowClaim = `lipsync-row:${exportId}`;
    const remember = (rows: any[]): void => {
      for (const name of ["lipsync-sweep", rowClaim]) {
        const holder = rows.find((row) => row.name === name)?.holder;
        if (typeof holder === "string") {
          if (!leases.some((lease) => lease.name === name && lease.holder === holder)) {
            leases.push({ name, holder });
          }
        }
      }
    };

    const r2Client = createR2Client(r2);
    let projectId: string | null = null;
    let sweepUrl: string | null = null;
    let objectKey: string | null = null;

    try {
      sweepUrl = await listen(sweepServer);
      const createdProject = await api(sweepUrl, account.token, "POST", "/api/projects", {
        projectType: "story",
        title: "Lip sync claim check",
        document,
      });
      projectId = createdProject.body?.project?.id ?? null;
      check(
        "a disposable lip sync project exists on the hosted store",
        createdProject.status === 201 && projectId !== null,
      );
      if (!projectId) return;

      // A crashed run or a deployed instance can hold the pass lease for one TTL.
      await waitFor(
        "the lipsync-sweep lease to be free",
        async () => {
          const rows = await serviceRows(`job_leases?select=expires_at&name=eq.lipsync-sweep`);
          return rows.length === 0 || Date.parse(String(rows[0].expires_at)) <= Date.now();
        },
        150_000,
      );

      const seeded = await fetch(`${base}/rest/v1/lipsync_exports`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          id: exportId,
          owner_id: account.id,
          project_id: projectId,
          status: "pending",
          provider_status: "IN_PROGRESS",
          provider_task_id: LIPSYNC_TASK_ID,
          resolution: "720p",
          seconds_estimate: LIPSYNC_MAX_SOURCE_SECONDS,
          usd_estimate: lipsyncEstimateUsd(LIPSYNC_MAX_SOURCE_SECONDS),
        }),
      });
      check("a pending lip sync row is seeded in the hosted store", seeded.ok, `HTTP ${seeded.status}`);
      if (!seeded.ok) return;

      // The reservation a real submit makes first, so the settle has a row to count.
      const reservation = await fetch(`${base}/rest/v1/rpc/reserve_lipsync_usage`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          p_owner_id: account.id,
          p_project_id: projectId,
          p_export_id: exportId,
          p_seconds_estimate: LIPSYNC_MAX_SOURCE_SECONDS,
          p_usd_estimate: lipsyncEstimateUsd(LIPSYNC_MAX_SOURCE_SECONDS),
          p_rate_version: LIPSYNC_RATE_VERSION,
          p_second_limit: 600,
          p_window_seconds: 86_400,
        }),
      });
      const reservationRows = (await reservation.json().catch(() => null)) as { allowed?: unknown }[] | null;
      check("the account's seconds are reserved for the export", reservationRows?.[0]?.allowed === true);

      // The sweeping instance picks the row up and blocks inside its claim.
      await waitFor(
        "the sweeping instance to reach the lip sync download",
        () => calls.some((call) => call.kind === "download"),
        30_000,
      );
      check(
        "the sweeping instance claimed the export and started its download",
        calls.filter((call) => call.kind === "download").length === 1 &&
          calls.find((call) => call.kind === "download")?.instance === "lipsync-sweep",
      );

      const held = await serviceRows(`job_leases?select=name,holder,expires_at`);
      remember(held);
      const passHolder = held.find((row) => row.name === "lipsync-sweep")?.holder;
      const initialClaim = held.find((row) => row.name === rowClaim);
      check(
        "the pass and the row are both claimed in the hosted lease table",
        held.filter((row) => row.name === rowClaim).length === 1 && held.some((row) => row.name === "lipsync-sweep"),
        `names=${held.map((row) => row.name).join(",") || "none"}`,
      );
      check(
        "nothing is stored while the claim is held",
        (await serviceRows(`media_metadata?select=id&project_id=eq.${projectId}`)).length === 0 &&
          (await serviceRows(`lipsync_exports?select=status&id=eq.${exportId}`))[0]?.status === "pending",
      );

      // The second instance starts now, so it can only ever see this row while
      // the first one is inside its pass.
      takeoverServer = createStoryframeServer({
        env,
        fetchImpl: lipsyncFetch("lipsync-takeover", calls, downloadGate),
        logger: { error: (message: string) => takeoverLogs.push(message) },
      });
      await listen(takeoverServer);
      // Its first passes run while the sweeper's lease is still live.
      await waitFor(
        "the second instance to be refused the live pass lease",
        () => leaseClaims.some((claim) => claim.name === "lipsync-sweep" && !claim.granted),
        15_000,
      );
      check(
        "the live pass stayed with the first instance",
        (await serviceRows(`job_leases?select=holder&name=eq.lipsync-sweep`))[0]?.holder === passHolder,
      );

      // A paused or partitioned instance stops renewing; its pass keeps running.
      const lapsed = await fetch(
        `${base}/rest/v1/job_leases?name=eq.lipsync-sweep&holder=eq.${encodeURIComponent(String(passHolder))}`,
        { method: "DELETE", headers: serviceHeaders },
      );
      check("the sweeper's lease was lapsed while its pass continued", lapsed.ok, `HTTP ${lapsed.status}`);

      let tookOver = false;
      let refusedAfterTakeover = false;
      try {
        await waitFor(
          "the second instance to claim the lapsed pass lease",
          () => {
            // The sweeper's own client keeps its holder, so a granted claim by
            // another holder is the taken-over pass.
            tookOver = leaseClaims.some(
              (claim) => claim.name === "lipsync-sweep" && claim.granted && claim.holder !== passHolder,
            );
            return tookOver;
          },
          30_000,
        );
        // From here on only the second instance can claim a row: the first one
        // still owns this row's claim and never asks for it again.
        const mark = leaseClaims.length;
        await waitFor(
          "the second instance's pass to reach the row and be refused the claim",
          () => {
            refusedAfterTakeover = leaseClaims.slice(mark).some((claim) => claim.name === rowClaim && !claim.granted);
            return refusedAfterTakeover;
          },
          30_000,
        );
        remember(await serviceRows(`job_leases?select=name,holder`));
      } catch (error) {
        // A live check should say why it stalled, not only that it did.
        const state = await serviceRows(`job_leases?select=name,holder,expires_at`).catch(() => []);
        console.error(`lease rows: ${JSON.stringify(state)}`);
        console.error(`first instance holders: pass=${String(passHolder)} row=${String(initialClaim?.holder)}`);
        console.error(
          `lease claims: ${leaseClaims.map((claim) => `${claim.name}:${claim.granted}`).join(",") || "none"}`,
        );
        console.error(`provider calls: ${calls.map((call) => `${call.instance}:${call.kind}`).join(",") || "none"}`);
        throw error;
      }
      check("the second instance claimed the lapsed pass lease", tookOver);
      check("the second instance's pass reached the row and was refused it", refusedAfterTakeover);
      // A pass that reached the row without claiming it can only have been
      // refused it: a granted claim rewrites the holder and the expiry.
      const claimNow = (
        await serviceRows(`job_leases?select=holder,expires_at&name=eq.${encodeURIComponent(rowClaim)}`)
      )[0];
      check(
        "the row claim stayed with the first instance through the takeover",
        claimNow?.holder === initialClaim?.holder && claimNow?.expires_at === initialClaim?.expires_at,
        `holder=${String(claimNow?.holder)} expires=${String(claimNow?.expires_at)}`,
      );
      check(
        "the second instance never polled the provider",
        calls.every((call) => call.instance !== "lipsync-takeover" || call.kind !== "poll"),
      );
      check(
        "nothing was stored while the row claim was held",
        (await serviceRows(`media_metadata?select=id&project_id=eq.${projectId}`)).length === 0 &&
          (await serviceRows(`lipsync_exports?select=status&id=eq.${exportId}`))[0]?.status === "pending",
      );

      releaseDownload();
      await waitFor(
        "the export to settle",
        async () => (await serviceRows(`lipsync_exports?select=status&id=eq.${exportId}`))[0]?.status === "ready",
        60_000,
      );

      const exportRows = await serviceRows(
        `lipsync_exports?select=status,seconds_counted,byte_size,output_media_id,failure_code&id=eq.${exportId}`,
      );
      const mediaRows = await serviceRows(
        `media_metadata?select=id,kind,status,object_key,byte_size&project_id=eq.${projectId}`,
      );
      const usageRows = await serviceRows(`lipsync_usage?select=status,seconds_counted&export_id=eq.${exportId}`);
      const settled = exportRows[0];
      objectKey = typeof mediaRows[0]?.object_key === "string" ? mediaRows[0].object_key : null;

      check(
        "the export settles ready at the measured length",
        settled?.status === "ready" &&
          Number(settled?.seconds_counted) === LIPSYNC_SECONDS &&
          settled?.failure_code === null,
        `status=${settled?.status} seconds=${settled?.seconds_counted} code=${settled?.failure_code ?? "none"}`,
      );
      check(
        "exactly one media row exists for the project",
        mediaRows.length === 1 && mediaRows[0].status === "ready" && mediaRows[0].kind === "video",
        `rows=${mediaRows.length}`,
      );
      check("the export points at that media row", settled?.output_media_id === mediaRows[0]?.id);
      check(
        "exactly one usage row settled the measured seconds",
        usageRows.length === 1 &&
          usageRows[0].status === "succeeded" &&
          Number(usageRows[0].seconds_counted) === LIPSYNC_SECONDS,
        `rows=${usageRows.length}`,
      );

      const head = objectKey ? await r2Client.head(objectKey) : null;
      check(
        "the stored object exists in the real bucket",
        head !== null && head.byteSize === LIPSYNC_MP4.length,
        `bytes=${head?.byteSize ?? "missing"}`,
      );
      const storedBytes = objectKey ? await r2Client.get(objectKey) : null;
      check("the stored object is the generated MP4", storedBytes !== null && storedBytes.equals(LIPSYNC_MP4));
      check(
        "only one download ever reached the provider",
        calls.filter((call) => call.kind === "download").length === 1,
      );
      check(
        "the row claim was released",
        !(await serviceRows(`job_leases?select=name`)).some((row) => row.name === rowClaim),
      );

      await new Promise((resolve) => setTimeout(resolve, 800));
      check(
        "later lip sync ticks store nothing more",
        (await serviceRows(`media_metadata?select=id&project_id=eq.${projectId}`)).length === 1 &&
          (await serviceRows(`lipsync_usage?select=id&export_id=eq.${exportId}`)).length === 1,
      );
    } finally {
      globalThis.fetch = globalFetch;
      releaseDownload();
      if (projectId && sweepUrl) {
        const deleted = await api(sweepUrl, account.token, "DELETE", `/api/projects/${projectId}`);
        console.log(`cleanup lip sync project delete -> ${deleted.status}`);
        check("cleanup removes the lip sync project", deleted.status === 200);
        check(
          "cleanup leaves no lip sync media",
          (await serviceRows(`media_metadata?select=id&project_id=eq.${projectId}`).catch(() => [])).length === 0,
        );
      }
      await stop(sweepServer);
      if (takeoverServer) await stop(takeoverServer);
      if (projectId) {
        await fetch(`${base}/rest/v1/lipsync_usage?owner_id=eq.${account.id}`, {
          method: "DELETE",
          headers: serviceHeaders,
        }).catch(() => undefined);
        check(
          "cleanup leaves no lip sync rows",
          (await serviceRows(`lipsync_exports?select=id&owner_id=eq.${account.id}`).catch(() => [])).length === 0 &&
            (await serviceRows(`lipsync_usage?select=id&owner_id=eq.${account.id}`).catch(() => [])).length === 0,
        );
      }
      // Release only the leases this run captured, so the next run starts clean.
      for (const lease of leases) {
        await fetch(`${base}/rest/v1/job_leases?name=eq.${encodeURIComponent(lease.name)}&holder=eq.${lease.holder}`, {
          method: "DELETE",
          headers: serviceHeaders,
        }).catch(() => undefined);
      }
      if (sweepLogs.length > 0) console.log(`lip sync sweep log lines: ${sweepLogs.join(", ")}`);
      if (takeoverLogs.length > 0) console.log(`lip sync takeover log lines: ${takeoverLogs.join(", ")}`);
    }
  }

  let user: { id: string; token: string } | null = null;
  let projectId: string | null = null;
  let objectKey: string | null = null;
  let refreshUrl: string | null = null;

  try {
    user = await createUser();
    refreshUrl = await listen(refreshServer);
    await listen(sweepServer);

    const createdProject = await api(refreshUrl, user.token, "POST", "/api/projects", {
      projectType: "story",
      title: "Image claim check",
      document,
    });
    projectId = createdProject.body?.project?.id ?? null;
    check("a disposable project exists on the hosted store", createdProject.status === 201 && projectId !== null);
    if (!projectId) return 1;

    // A crashed run or a deployed instance can hold the sweep lease for one TTL.
    await waitFor(
      "the image-sweep lease to be free",
      async () => {
        const rows = await serviceRows(`job_leases?select=expires_at&name=eq.image-sweep`);
        return rows.length === 0 || Date.parse(String(rows[0].expires_at)) <= Date.now();
      },
      150_000,
    );

    // A job two minutes old: past the request poll window, well inside abandon.
    const generationId = randomUUID();
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    const seeded = await fetch(`${base}/rest/v1/image_generations`, {
      method: "POST",
      headers: { ...adminHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        id: generationId,
        owner_id: user.id,
        project_id: projectId,
        provider: "leonardo",
        model_key: "leonardo:phoenix-1.0",
        prompt: "a lighthouse on a stormy coast",
        settings: { width: 1024, height: 1024, steps: null },
        status: "pending",
        job_id: JOB_ID,
        estimated_usd: null,
        estimated_neurons: null,
        rate_version: "v1",
        created_at: createdAt,
        updated_at: createdAt,
      }),
    });
    check("a pending Leonardo job is seeded in the hosted store", seeded.ok, `HTTP ${seeded.status}`);
    if (!seeded.ok) return 1;

    // The sweeping instance picks the row up and blocks inside its claim.
    await waitFor("the sweep to reach the image download", () => calls.some((call) => call.kind === "download"));
    check(
      "the sweeping instance claimed the job and started its download",
      calls.filter((call) => call.kind === "download").length === 1 &&
        calls.find((call) => call.kind === "download")?.instance === "sweep",
    );

    const claims = await serviceRows(`job_leases?select=name,holder,expires_at`);
    check(
      "exactly one row claim exists in the hosted lease table",
      claims.filter((row) => row.name === `image-settle:${generationId}`).length === 1,
      `names=${claims.map((row) => row.name).join(",") || "none"}`,
    );
    for (const name of ["image-sweep", `image-settle:${generationId}`]) {
      const holder = claims.find((row) => row.name === name)?.holder;
      if (typeof holder === "string") ownLeases.push({ name, holder });
    }
    check(
      "nothing is stored while the claim is held",
      (await serviceRows(`media_metadata?select=id&project_id=eq.${projectId}`)).length === 0,
    );

    // The refresh races that claim on the second instance.
    const refreshed = await api(
      refreshUrl,
      user.token,
      "POST",
      `/api/projects/${projectId}/image-generations/${generationId}/refresh`,
    );
    check(
      "the racing refresh polled a completed job and still answered 202",
      refreshed.status === 202 && refreshed.body?.generation?.status === "pending",
      `status=${refreshed.status} code=${refreshed.body?.error?.code ?? "none"}`,
    );
    check(
      "the racing instance polled the same job",
      calls.some((call) => call.instance === "refresh" && call.kind === "poll"),
    );
    check(
      "the racing instance downloaded nothing",
      calls.every((call) => call.instance !== "refresh" || call.kind !== "download"),
    );
    check(
      "the refused refresh stored nothing",
      (await serviceRows(`media_metadata?select=id&project_id=eq.${projectId}`)).length === 0,
    );

    releaseDownload();
    await waitFor(
      "the sweep to settle the job",
      async () => {
        const rows = await serviceRows(`image_generations?select=status&id=eq.${generationId}`);
        return rows[0]?.status === "succeeded";
      },
      30_000,
    );

    const generationRows = await serviceRows(
      `image_generations?select=status,media_id,error_code,actual_usd,cost_source&id=eq.${generationId}`,
    );
    const mediaRows = await serviceRows(
      `media_metadata?select=id,kind,status,object_key,byte_size&project_id=eq.${projectId}`,
    );
    const generation = generationRows[0];
    objectKey = typeof mediaRows[0]?.object_key === "string" ? mediaRows[0].object_key : null;

    check(
      "the job settles succeeded with no error",
      generation?.status === "succeeded" && generation?.error_code === null,
      `status=${generation?.status} code=${generation?.error_code ?? "none"}`,
    );
    check(
      "exactly one media row exists for the project",
      mediaRows.length === 1 && mediaRows[0].status === "ready" && mediaRows[0].kind === "image",
      `rows=${mediaRows.length}`,
    );
    check("the generation points at that media row", generation?.media_id === mediaRows[0]?.id);
    check(
      "the provider cost is stored once",
      generation?.actual_usd === 0.02 && generation?.cost_source === "provider",
      `usd=${generation?.actual_usd} source=${generation?.cost_source}`,
    );

    const objects = createR2Client(r2);
    const head = objectKey ? await objects.head(objectKey) : null;
    check(
      "the stored object exists in the real bucket",
      head !== null && head.byteSize === PNG.length,
      `bytes=${head?.byteSize ?? "missing"}`,
    );
    const storedBytes = objectKey ? await objects.get(objectKey) : null;
    check(
      "the stored object is the generated PNG",
      storedBytes !== null && storedBytes.subarray(1, 4).toString() === "PNG",
    );

    check("only one download ever reached the provider", calls.filter((call) => call.kind === "download").length === 1);
    check(
      "the row claim was released",
      !(await serviceRows(`job_leases?select=name`)).some((row) => row.name === `image-settle:${generationId}`),
    );

    // Several more sweep ticks must not add a late duplicate.
    await new Promise((resolve) => setTimeout(resolve, 800));
    check(
      "later sweep ticks store nothing more",
      (await serviceRows(`media_metadata?select=id&project_id=eq.${projectId}`)).length === 1,
    );

    if (!user) return 1;
    await lipsyncRace(user);
  } finally {
    // Stop the sweeper first: its last pass releases the sweep lease in its own
    // `finally` while the project cleanup below runs, so nothing can re-claim it.
    await stop(sweepServer);
    if (projectId && user && refreshUrl) {
      const deleted = await api(refreshUrl, user.token, "DELETE", `/api/projects/${projectId}`);
      console.log(`cleanup project delete -> ${deleted.status}`);
      check("cleanup removes the project", deleted.status === 200);
      const remaining = await serviceRows(`image_generations?select=id&owner_id=eq.${user.id}`).catch(() => []);
      check("cleanup leaves no generation rows", remaining.length === 0);
    }
    if (user) {
      const deletedUser = await fetch(`${base}/auth/v1/admin/users/${user.id}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
      console.log(`cleanup user delete -> ${deletedUser.status}`);
      check("cleanup removes the disposable user", deletedUser.ok);
    }
    if (objectKey) {
      check("cleanup leaves no stored object", (await createR2Client(r2).head(objectKey)) === null);
    }
    await stop(refreshServer);
    // Release only the leases this run captured, so the next run starts clean
    // without touching a holder that belongs to another instance.
    for (const lease of ownLeases) {
      await fetch(`${base}/rest/v1/job_leases?name=eq.${encodeURIComponent(lease.name)}&holder=eq.${lease.holder}`, {
        method: "DELETE",
        headers: adminHeaders,
      }).catch(() => undefined);
    }
    const leasesLeft = await serviceRows(`job_leases?select=name,holder`).catch(() => []);
    check(
      "cleanup releases this run's leases",
      !leasesLeft.some((row) => ownLeases.some((lease) => lease.name === row.name && lease.holder === row.holder)),
    );
    if (logs.length > 0) console.log(`server log lines: ${logs.join(", ")}`);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`verify:claim-live failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exit(1);
  });
