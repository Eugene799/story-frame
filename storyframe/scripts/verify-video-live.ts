import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "../server/app";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import type { ProjectDocumentV2, ProjectScene } from "../shared/project-contract";

/**
 * Opt-in Phase 9 acceptance check against real JSON2Video, Supabase, and R2.
 *
 * Creates one disposable user and project, uploads one small image, attaches an
 * uploaded 1-second WAV as narration (no Deepgram spend), and renders two
 * three-second scenes. The movie is 6 seconds, so the run costs about 6
 * JSON2Video credits (1 credit per second of output) and nothing else.
 *
 * Without JSON2VIDEO_API_KEY the script prints a clear SKIP and exits 0, so a
 * missing key is never reported as a pass. Pass --require-live to make it exit 1
 * instead. It never prints keys, signed URLs, or provider URLs.
 */
try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const requireLive = process.argv.includes("--require-live");
const videoKey = process.env.JSON2VIDEO_API_KEY?.trim();
if (!videoKey) {
  console.log("SKIP verify:video-live - JSON2VIDEO_API_KEY is not configured, so no paid render was requested.");
  console.log("Set JSON2VIDEO_API_KEY (environment or .env) and run again; --require-live turns this skip into a failure.");
  process.exit(requireLive ? 1 : 0);
}

const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
const r2Ready = Boolean(
  (process.env.R2_ENDPOINT ?? process.env.CLOUDFLARE_S3_ENDPOINT_URL) &&
    (process.env.R2_BUCKET_NAME ?? process.env.CLOUDFLARE_R2_BUCKET_NAME) &&
    (process.env.R2_ACCESS_KEY_ID ?? process.env.CLOUDFLARE_ACCESS_ID) &&
    (process.env.R2_SECRET_ACCESS_KEY ?? process.env.CLOUDFLARE_SECRET_ACCESS_KEY),
);

if (!base || !serviceRoleKey || !publishableKey) {
  console.error("verify:video-live requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}
if (!r2Ready) {
  console.error("verify:video-live requires the R2 endpoint, bucket, access key, and secret.");
  process.exit(1);
}

const adminHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};
const serviceHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createUser(): Promise<{ id: string; token: string }> {
  const email = `storyframe-video-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `R${randomUUID()}a1!`;
  const created = await fetch(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const createdBody = (await created.json().catch(() => ({}))) as { id?: string; user?: { id?: string } };
  const id = createdBody.id ?? createdBody.user?.id;
  if (!created.ok || typeof id !== "string") {
    throw new Error(`could not create a disposable user (HTTP ${created.status})`);
  }
  // The module-level guard exits before this runs, so the key is always present.
  const signInKey = publishableKey ?? "";
  const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: signInKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = (await login.json().catch(() => ({}))) as { access_token?: string };
  if (!login.ok || typeof session.access_token !== "string") {
    throw new Error(`could not sign in the disposable user (HTTP ${login.status})`);
  }
  return { id, token: session.access_token };
}

/** 1x1 PNG: enough for the magic-byte check to see image/png. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 1-second silent 8 kHz mono WAV, the same shape the narration check uploads. */
function wavBytes(seconds = 1): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * seconds * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}

function approvedScene(id: string, heading: string, body: string, assetIds: string[] = []): ProjectScene {
  const scene: ProjectScene = {
    id,
    heading,
    body,
    visualDirection: "A slow push in.",
    assetIds,
    onScreenText: heading.toUpperCase(),
    durationSeconds: 3,
    approved: true,
    approvedFingerprint: "",
    locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
  };
  return { ...scene, approvedFingerprint: sceneFingerprint(scene) };
}

function documentFor(firstAssetIds: string[] = [], secondAssetIds: string[] = []): ProjectDocumentV2 {
  return {
    schemaVersion: 2,
    summary: "A short live video export check.",
    brief: {
      topic: "Live video export check",
      audience: "Internal",
      goal: "Prove the export route",
      mode: "fiction",
      targetDurationSeconds: 6,
      tone: "Neutral",
      preset: "Story short",
      voicePreference: "neutral",
      planningBudgetUsd: 0,
    },
    scenes: [
      approvedScene("s1", "Opening", "The letter waits under a seat as the night train crosses the coast.", firstAssetIds),
      approvedScene("s2", "Close", "The courier lifts the envelope and reads a name that is not theirs.", secondAssetIds),
    ],
  };
}

async function main(): Promise<number> {
  // A short sweep so the check does not wait a full minute per poll. The export
  // still advances only through the server's own timer.
  const env = { ...process.env, VIDEO_SWEEP_INTERVAL_MS: process.env.VIDEO_SWEEP_INTERVAL_MS ?? "3000" };
  const server = createStoryframeServer({ env });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port assigned");
  const appUrl = `http://127.0.0.1:${address.port}`;

  async function api(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${appUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  async function uploadMedia(
    token: string,
    kind: "image" | "audio",
    bytes: Buffer,
    contentType: string,
  ): Promise<{ id: string; status: string; byteSize: number; contentType: string }> {
    const initiated = await api(token, "POST", `/api/projects/${projectId}/media`, {
      kind,
      contentType,
      byteSize: bytes.length,
    });
    if (initiated.status !== 201) {
      throw new Error(`media initiation failed (HTTP ${initiated.status})`);
    }
    const put = await fetch(initiated.body.upload.url, {
      method: "PUT",
      headers: initiated.body.upload.headers,
      body: new Uint8Array(bytes),
    });
    if (!put.ok) throw new Error(`R2 upload failed (HTTP ${put.status})`);
    const completed = await api(
      token,
      "POST",
      `/api/projects/${projectId}/media/${initiated.body.media.id}/complete`,
      {},
    );
    if (completed.status !== 200) {
      throw new Error(`media completion failed (HTTP ${completed.status})`);
    }
    return completed.body.media;
  }

  async function serviceRows(query: string): Promise<any[]> {
    const response = await fetch(`${base}/rest/v1/${query}`, { headers: serviceHeaders });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null);
    return Array.isArray(payload) ? payload : [];
  }

  /** Polls our own detail route; the sweep is what moves the provider status. */
  async function waitForExport(
    token: string,
    projectRef: string,
    exportId: string,
    timeoutMs = 20 * 60 * 1000,
  ): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let last: any = null;
    while (Date.now() < deadline) {
      const current = await api(token, "GET", `/api/projects/${projectRef}/exports/video/${exportId}`);
      last = current.body?.export ?? last;
      if (last?.status === "ready" || last?.status === "failed") return last;
      await sleep(3000);
    }
    return last;
  }

  let user: { id: string; token: string } | null = null;
  let projectId: string | null = null;

  try {
    user = await createUser();

    const created = await api(user.token, "POST", "/api/projects", {
      projectType: "story",
      title: "Video export live check",
      document: documentFor(),
    });
    projectId = created.body?.project?.id ?? null;
    check("a disposable project is created", created.status === 201 && projectId !== null);
    if (!projectId || !user) return 1;

    const before = await api(user.token, "GET", `/api/projects/${projectId}/exports/video`);
    check(
      "the export list starts empty with a zero spend window",
      before.status === 200 &&
        Array.isArray(before.body?.exports) &&
        before.body.exports.length === 0 &&
        before.body?.usage?.creditsUsed === 0,
      `status=${before.status}`,
    );

    const image = await uploadMedia(user.token, "image", PNG, "image/png");
    check(
      "a real image uploads through the private R2 media path",
      image.status === "ready" && image.byteSize === PNG.length && image.contentType === "image/png",
      `type=${image.contentType} bytes=${image.byteSize}`,
    );

    const saved = await api(user.token, "PUT", `/api/projects/${projectId}`, {
      title: "Video export live check",
      document: documentFor([image.id]),
      version: created.body.project.version,
    });
    const savedRevision = saved.body?.project?.version;
    check(
      "the saved revision names the image on the first scene",
      saved.status === 200 && typeof savedRevision === "number" && savedRevision > created.body.project.version,
      `status=${saved.status} revision=${savedRevision}`,
    );

    const narrationMedia = await uploadMedia(user.token, "audio", wavBytes(1), "audio/wav");
    const narration = await api(user.token, "POST", `/api/projects/${projectId}/narration/upload`, {
      mediaId: narrationMedia.id,
    });
    check(
      "uploaded narration is measured and active without Deepgram spend",
      narration.status === 201 &&
        narration.body?.track?.source === "upload" &&
        narration.body?.track?.status === "active" &&
        narration.body?.track?.durationSeconds > 0,
      `status=${narration.status}`,
    );

    const submitted = await api(
      user.token,
      "POST",
      `/api/projects/${projectId}/exports/video`,
      { projectRevision: savedRevision },
      { "Idempotency-Key": `video-live-${randomUUID()}` },
    );
    const exportId = submitted.body?.export?.id ?? null;
    check(
      "the export is accepted as pending at the saved revision",
      submitted.status === 202 &&
        submitted.body?.export?.status === "pending" &&
        submitted.body?.export?.projectRevision === savedRevision &&
        submitted.body?.export?.creditsEstimate === 6,
      `status=${submitted.status} estimate=${submitted.body?.export?.creditsEstimate}`,
    );
    check(
      "the reservation is written before the provider call",
      (await serviceRows(
        `video_usage?select=status,credits_estimate,credits_counted&owner_id=eq.${user.id}&project_id=eq.${projectId}`,
      )).some((row) => row.status === "pending" && row.credits_estimate === 6),
    );

    const jobs = await serviceRows(
      `provider_jobs?select=status,external_id,kind&project_id=eq.${projectId}&kind=eq.video-export`,
    );
    check(
      "the provider job records the accepted 16-character movie id",
      jobs.length === 1 &&
        (jobs[0].status === "running" || jobs[0].status === "succeeded") &&
        typeof jobs[0].external_id === "string" &&
        jobs[0].external_id.length === 16,
      JSON.stringify(jobs.map((row) => [row.status, typeof row.external_id])),
    );

    if (exportId) {
      const second = await api(
        user.token,
        "POST",
        `/api/projects/${projectId}/exports/video`,
        { projectRevision: savedRevision },
        { "Idempotency-Key": `video-live-${randomUUID()}` },
      );
      // The row may already be ready on a fast provider; either answer is honest.
      check(
        "a second export while live is refused without a second render",
        second.status === 429
          ? second.body?.error?.code === "VIDEO_RENDER_IN_FLIGHT"
          : (await serviceRows(`render_snapshots?select=id&project_id=eq.${projectId}&kind=eq.video-export`)).length === 1,
        `status=${second.status}`,
      );

      const finished = await waitForExport(user.token, projectId, exportId);
      check(
        "the render reaches ready with a measured duration, size, and dimensions",
        finished?.status === "ready" &&
          finished?.failureCode === null &&
          finished?.providerStatus === "done" &&
          finished?.durationSeconds > 0 &&
          finished?.byteSize > 0 &&
          finished?.width > 0 &&
          finished?.height > 0,
        `status=${finished?.status} code=${finished?.failureCode} ${finished?.failureMessage ?? ""}`,
      );
      check(
        "the row records the credits the render actually consumed",
        typeof finished?.creditsConsumed === "number" && finished.creditsConsumed > 0 && finished.creditsConsumed <= 6,
        `consumed=${finished?.creditsConsumed}`,
      );

      const mediaRows = await serviceRows(
        `media_metadata?select=id,kind,status,content_type,byte_size&id=eq.${finished?.mediaId}`,
      );
      check(
        "the MP4 is stored as a ready video asset with the detected container",
        mediaRows.length === 1 &&
          mediaRows[0].kind === "video" &&
          mediaRows[0].status === "ready" &&
          String(mediaRows[0].content_type).startsWith("video/") &&
          mediaRows[0].byte_size === finished?.byteSize,
        JSON.stringify(mediaRows.map((row) => [row.kind, row.status, row.content_type])),
      );

      const renderRows = await serviceRows(
        `render_snapshots?select=status,media_id,output_key,credits_consumed&id=eq.${exportId}`,
      );
      check(
        "the hosted render row is ready with its media link and stored key",
        renderRows.length === 1 &&
          renderRows[0].status === "ready" &&
          renderRows[0].media_id === finished?.mediaId &&
          typeof renderRows[0].output_key === "string" &&
          renderRows[0].output_key.length > 0 &&
          renderRows[0].credits_consumed > 0,
        JSON.stringify(renderRows.map((row) => [row.status, Boolean(row.media_id)])),
      );

      const playback = await api(user.token, "GET", `/api/projects/${projectId}/exports/video/${exportId}/url`);
      const playedBytes = playback.body?.url ? Buffer.from(await (await fetch(playback.body.url)).arrayBuffer()) : null;
      check(
        "playback returns our stored MP4 byte-for-byte from private storage",
        playback.status === 200 &&
          playback.body?.contentType?.startsWith("video/") &&
          playedBytes !== null &&
          playedBytes.length === finished?.byteSize &&
          playedBytes.subarray(4, 8).toString() === "ftyp",
        `status=${playback.status} bytes=${playedBytes?.length ?? 0}`,
      );

      const usageRows = await serviceRows(
        `video_usage?select=status,credits_counted,duration_seconds,rate_version&render_id=eq.${exportId}`,
      );
      check(
        "the spend row settles as succeeded with the counted credits and real duration",
        usageRows.length === 1 &&
          usageRows[0].status === "succeeded" &&
          usageRows[0].credits_counted > 0 &&
          usageRows[0].credits_counted <= 6 &&
          usageRows[0].duration_seconds > 0 &&
          usageRows[0].rate_version === "json2video-2026-11-25",
        JSON.stringify(usageRows.map((row) => [row.status, row.credits_counted])),
      );

      const removed = await api(user.token, "DELETE", `/api/projects/${projectId}/exports/video/${exportId}`);
      const remainingRender = await serviceRows(`render_snapshots?select=id&id=eq.${exportId}`);
      const deletedMedia = await serviceRows(`media_metadata?select=deleted_at&id=eq.${finished?.mediaId}`);
      check(
        "deleting the export removes its row and its stored object",
        removed.status === 200 &&
          remainingRender.length === 0 &&
          deletedMedia.length === 1 &&
          deletedMedia[0].deleted_at !== null,
        `status=${removed.status}`,
      );
    }

    const removedProject = await api(user.token, "DELETE", `/api/projects/${projectId}`);
    check("cleanup removes the project", removedProject.status === 200);
    const ledger = await serviceRows(
      `video_usage?select=status,credits_counted,project_id&owner_id=eq.${user.id}`,
    );
    check(
      "project cleanup preserves the credit ledger and clears its project reference",
      ledger.length >= 1 &&
        ledger.every((row) => row.project_id === null) &&
        ledger.some((row) => row.credits_counted > 0),
      JSON.stringify(ledger.map((row) => [row.status, row.credits_counted, row.project_id])),
    );
    projectId = null;
  } finally {
    if (projectId) await api(user?.token ?? null, "DELETE", `/api/projects/${projectId}`).catch(() => undefined);
    if (user) {
      await fetch(`${base}/auth/v1/admin/users/${user.id}`, {
        method: "DELETE",
        headers: adminHeaders,
      }).catch(() => undefined);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
