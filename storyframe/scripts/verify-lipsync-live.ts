import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "../server/app";
import { mediaObjectKey } from "../server/media";
import { readMp4DurationSeconds } from "../server/mp4";
import { createR2Client } from "../server/r2";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import { LIPSYNC_RATE_VERSION } from "../shared/lipsync-contract";
import type { ProjectDocumentV2, ProjectScene } from "../shared/project-contract";
import { formatSubmitFailure } from "./lipsync-submit-failure";

/**
 * Opt-in live lip sync check against real Everypixel, Supabase, and R2.
 *
 * Makes exactly one paid provider request: it uploads one short talking clip and
 * one short voice track through the private media path, submits a single 720p
 * lip sync through the route, and lets the server's own sweep copy the finished
 * MP4 into the bucket. It then checks that the ledger settled the measured
 * duration (not the reserved 20-second ceiling) and that playback returns our
 * stored bytes. Cleanup deletes the export, both inputs, its stored objects, the
 * project, and the disposable user.
 *
 * Usage: tsx scripts/verify-lipsync-live.ts --video clip.mp4 --audio voice.mp3
 *
 * Without the Everypixel keys, Supabase/R2 settings, or the two media paths, it
 * prints a clear SKIP and exits 0; --require-live turns that into exit 1.
 */
try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const requireLive = process.argv.includes("--require-live");
const argValue = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
};
const videoPath = argValue("video");
const audioPath = argValue("audio");

const configured = Boolean(process.env.EVERYPIXEL_CLIENT_ID?.trim() && process.env.EVERYPIXEL_SECRET_ID?.trim());
const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
const r2Config = {
  endpoint: (process.env.R2_ENDPOINT ?? process.env.CLOUDFLARE_S3_ENDPOINT_URL ?? "").replace(/\/+$/, ""),
  bucket: process.env.R2_BUCKET_NAME ?? process.env.CLOUDFLARE_R2_BUCKET_NAME ?? "",
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? process.env.CLOUDFLARE_ACCESS_ID ?? "",
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? process.env.CLOUDFLARE_SECRET_ACCESS_KEY ?? "",
};
const r2Ready = Object.values(r2Config).every((value) => value.length > 0);

if (!configured) {
  console.log("SKIP verify:lipsync-live - EVERYPIXEL_CLIENT_ID/EVERYPIXEL_SECRET_ID are not configured, so no paid request was made.");
  process.exit(requireLive ? 1 : 0);
}
if (!base || !serviceRoleKey || !publishableKey) {
  console.error("verify:lipsync-live requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}
if (!r2Ready) {
  console.error("verify:lipsync-live requires the R2 endpoint, bucket, access key, and secret.");
  process.exit(1);
}
if (!videoPath || !audioPath) {
  console.log("SKIP verify:lipsync-live - pass --video <clip.mp4> and --audio <voice.mp3>; a face and speech are required.");
  process.exit(requireLive ? 1 : 0);
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
  const email = `storyframe-lipsync-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
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
  const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = (await login.json().catch(() => ({}))) as { access_token?: string };
  if (!login.ok || typeof session.access_token !== "string") {
    throw new Error(`could not sign in the disposable user (HTTP ${login.status})`);
  }
  return { id, token: session.access_token };
}

function approvedScene(id: string, heading: string, body: string): ProjectScene {
  const scene: ProjectScene = {
    id,
    heading,
    body,
    visualDirection: "A slow push in.",
    assetIds: [],
    onScreenText: heading.toUpperCase(),
    durationSeconds: 5,
    approved: true,
    approvedFingerprint: "",
    locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
  };
  return { ...scene, approvedFingerprint: sceneFingerprint(scene) };
}

function documentFor(): ProjectDocumentV2 {
  return {
    schemaVersion: 2,
    summary: "A short live lip sync check.",
    brief: {
      topic: "Live lip sync check",
      audience: "Internal",
      goal: "Prove the lip sync route, copy path, and ledger",
      mode: "fiction",
      targetDurationSeconds: 5,
      tone: "Neutral",
      preset: "Story short",
      voicePreference: "neutral",
      planningBudgetUsd: 0,
    },
    scenes: [approvedScene("s1", "Opening", "The courier checks the envelope once more before the doors close.")],
  };
}

async function main(): Promise<number> {
  const videoBytes = readFileSync(videoPath ?? "");
  const audioBytes = readFileSync(audioPath ?? "");
  console.log(`Inputs: ${(videoBytes.length / 1024 / 1024).toFixed(2)} MB clip, ${audioBytes.length} bytes of audio.`);

  // The sweep is the only clock, so a short cadence keeps the check prompt
  // without changing how any row advances.
  const env = {
    ...process.env,
    LIPSYNC_SWEEP_INTERVAL_MS: process.env.LIPSYNC_SWEEP_INTERVAL_MS ?? "3000",
    LIPSYNC_POLL_INTERVAL_MS: process.env.LIPSYNC_POLL_INTERVAL_MS ?? "1000",
  };
  const server = createStoryframeServer({ env });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port assigned");
  const appUrl = `http://127.0.0.1:${address.port}`;

  const objects = createR2Client(r2Config);

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
    kind: "audio" | "video",
    bytes: Buffer,
    contentType: string,
  ): Promise<any> {
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
    const completed = await api(token, "POST", `/api/projects/${projectId}/media/${initiated.body.media.id}/complete`, {});
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

  /** Polls our own detail route; only the server's sweep moves the provider status. */
  async function waitForExport(token: string, exportId: string, timeoutMs = 25 * 60 * 1000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let last: any = null;
    while (Date.now() < deadline) {
      const current = await api(token, "GET", `/api/projects/${projectId}/exports/lipsync/${exportId}`);
      last = current.body?.export ?? last;
      if (last?.status === "ready" || last?.status === "failed") return last;
      await sleep(3000);
    }
    return last;
  }

  let user: { id: string; token: string } | null = null;
  let projectId: string | null = null;
  let exportId: string | null = null;

  try {
    user = await createUser();

    const created = await api(user.token, "POST", "/api/projects", {
      projectType: "story",
      title: "Lip sync live check",
      document: documentFor(),
    });
    projectId = created.body?.project?.id ?? null;
    check("a disposable project is created", created.status === 201 && projectId !== null, `status=${created.status}`);
    if (!projectId || !user) return 1;

    const before = await api(user.token, "GET", `/api/projects/${projectId}/exports/lipsync`);
    check(
      "the export list starts empty with a zero spend window",
      before.status === 200 &&
        Array.isArray(before.body?.exports) &&
        before.body.exports.length === 0 &&
        before.body?.usage?.secondsUsed === 0,
      `status=${before.status} used=${before.body?.usage?.secondsUsed}`,
    );

    const source = await uploadMedia(user.token, "video", videoBytes, "video/mp4");
    check(
      "the talking clip uploads as a ready video through private R2",
      source?.status === "ready" && source?.kind === "video" && String(source?.contentType).startsWith("video/"),
      `status=${source?.status} type=${source?.contentType}`,
    );
    const audio = await uploadMedia(user.token, "audio", audioBytes, "audio/mpeg");
    check(
      "the voice track uploads as ready audio",
      audio?.status === "ready" && audio?.kind === "audio" && String(audio?.contentType).startsWith("audio/"),
      `status=${audio?.status} type=${audio?.contentType}`,
    );

    // The one paid request. Every later check reads state this call produced.
    const idempotencyKey = `lipsync-live-${randomUUID()}`;
    const submitted = await api(
      user.token,
      "POST",
      `/api/projects/${projectId}/exports/lipsync`,
      { sourceMediaId: source.id, audioMediaId: audio.id, resolution: "720p" },
      { "Idempotency-Key": idempotencyKey },
    );
    exportId = submitted.body?.export?.id ?? null;
    if (submitted.status !== 202) {
      console.error(`Lip sync submission failed: ${formatSubmitFailure(submitted.status, submitted.body)}`);
    }
    check(
      "the lip sync is accepted as pending at the reserved 20-second ceiling",
      submitted.status === 202 &&
        submitted.body?.export?.status === "pending" &&
        submitted.body?.export?.secondsEstimate === 20 &&
        submitted.body?.export?.secondsCounted === null,
      `status=${submitted.status} estimate=${submitted.body?.export?.secondsEstimate}`,
    );

    const reservation = await serviceRows(
      `lipsync_usage?select=status,seconds_estimate,seconds_counted,usd_estimate&owner_id=eq.${user.id}&project_id=eq.${projectId}`,
    );
    check(
      // A pending reservation counts the ceiling it blocked, until settlement
      // replaces it with the measured length.
      "the reservation holds the full 20-second ceiling before the provider bills",
      reservation.length === 1 &&
        reservation[0].status === "pending" &&
        Number(reservation[0].seconds_estimate) === 20 &&
        Number(reservation[0].seconds_counted) === 20,
      JSON.stringify(reservation.map((row) => [row.status, row.seconds_estimate, row.seconds_counted])),
    );

    const taskRows = await serviceRows(
      `lipsync_exports?select=status,provider_status,provider_task_id&id=eq.${exportId}`,
    );
    check(
      "the hosted row records the provider task id it is following",
      taskRows.length === 1 && typeof taskRows[0].provider_task_id === "string" && taskRows[0].provider_task_id.length > 0,
      JSON.stringify(taskRows.map((row) => [row.status, Boolean(row.provider_task_id)])),
    );

    if (exportId) {
      // Replaying the same Idempotency-Key must resolve to the first row: no second paid request.
      const replay = await api(
        user.token,
        "POST",
        `/api/projects/${projectId}/exports/lipsync`,
        { sourceMediaId: source.id, audioMediaId: audio.id, resolution: "720p" },
        { "Idempotency-Key": idempotencyKey },
      );
      check(
        "replaying the idempotency key returns the same export without a second request",
        replay.body?.export?.id === exportId &&
          (await serviceRows(`lipsync_exports?select=id&project_id=eq.${projectId}`)).length === 1,
        `status=${replay.status} id=${replay.body?.export?.id}`,
      );

      const startedAt = Date.now();
      const finished = await waitForExport(user.token, exportId);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      check(
        "the sweep advances the export to ready with a finished provider status",
        finished?.status === "ready" && finished?.failureCode === null && finished?.providerStatus === "SUCCESS",
        `status=${finished?.status} code=${finished?.failureCode} ${finished?.failureMessage ?? ""} (${elapsed}s)`,
      );
      check(
        "the settled seconds are the measured length, not the 20-second ceiling",
        typeof finished?.secondsCounted === "number" && finished.secondsCounted > 0 && finished.secondsCounted < 20,
        `counted=${finished?.secondsCounted}`,
      );
      check("the finished MP4 has a recorded size", typeof finished?.byteSize === "number" && finished.byteSize > 0, `bytes=${finished?.byteSize}`);

      const outputRows = await serviceRows(
        `media_metadata?select=id,kind,status,content_type,byte_size&id=eq.${finished?.outputMediaId}`,
      );
      check(
        "the copy is stored as a ready video asset in private storage",
        finished?.outputMediaId !== null &&
          outputRows.length === 1 &&
          outputRows[0].kind === "video" &&
          outputRows[0].status === "ready" &&
          String(outputRows[0].content_type).startsWith("video/") &&
          Number(outputRows[0].byte_size) === finished?.byteSize,
        JSON.stringify(outputRows.map((row) => [row.kind, row.status, row.content_type])),
      );

      const playback = await api(
        user.token,
        "GET",
        `/api/projects/${projectId}/exports/lipsync/${exportId}/url`,
      );
      const playedBytes = playback.body?.url
        ? Buffer.from(await (await fetch(playback.body.url)).arrayBuffer())
        : null;
      const playedDuration = playedBytes ? readMp4DurationSeconds(playedBytes) : null;
      check(
        "playback returns our stored bytes, and they measure the settled seconds",
        playback.status === 200 &&
          playedBytes !== null &&
          playedBytes.length === finished?.byteSize &&
          playedBytes.subarray(4, 8).toString() === "ftyp" &&
          playedDuration !== null &&
          Math.abs(playedDuration - Number(finished?.secondsCounted)) < 0.001,
        `status=${playback.status} bytes=${playedBytes?.length ?? 0} measured=${playedDuration} counted=${finished?.secondsCounted}`,
      );

      const usageRows = await serviceRows(
        `lipsync_usage?select=status,seconds_estimate,seconds_counted,usd_estimate,rate_version,export_id&export_id=eq.${exportId}`,
      );
      check(
        "the spend row settles as succeeded at the measured seconds",
        usageRows.length === 1 &&
          usageRows[0].status === "succeeded" &&
          Number(usageRows[0].seconds_counted) === Number(finished?.secondsCounted) &&
          usageRows[0].rate_version === LIPSYNC_RATE_VERSION,
        JSON.stringify(usageRows.map((row) => [row.status, row.seconds_counted, row.rate_version])),
      );

      console.log(
        `Live result: ${finished?.secondsCounted}s measured, ${finished?.byteSize} bytes, ` +
          `playback measured ${playedDuration}s, ledger ${usageRows[0]?.seconds_counted}s ` +
          `against a ${finished?.secondsEstimate}s reservation.`,
      );

      const listed = await api(user.token, "GET", `/api/projects/${projectId}/exports/lipsync`);
      check(
        "the usage line now reports the settled seconds instead of the reservation",
        listed.status === 200 &&
          Number(listed.body?.usage?.secondsUsed) === Number(finished?.secondsCounted) &&
          Number(listed.body?.usage?.usdUsed) > 0,
        `used=${listed.body?.usage?.secondsUsed} usd=${listed.body?.usage?.usdUsed}`,
      );

      const outputKey = mediaObjectKey(user.id, String(finished?.outputMediaId));
      const removed = await api(user.token, "DELETE", `/api/projects/${projectId}/exports/lipsync/${exportId}`);
      const remainingExport = await serviceRows(`lipsync_exports?select=id&id=eq.${exportId}`);
      const deletedOutput = await serviceRows(`media_metadata?select=deleted_at&id=eq.${finished?.outputMediaId}`);
      const outputObject = await objects.head(outputKey).catch(() => null);
      check(
        "deleting the export removes its row, its media row, and the stored object",
        removed.status === 200 &&
          remainingExport.length === 0 &&
          deletedOutput.length === 1 &&
          deletedOutput[0].deleted_at !== null &&
          outputObject === null,
        `status=${removed.status} object=${outputObject === null ? "absent" : "present"}`,
      );
      exportId = null;
    }

    const sourceKey = mediaObjectKey(user.id, String(source.id));
    const audioKey = mediaObjectKey(user.id, String(audio.id));
    const removedSource = await api(user.token, "DELETE", `/api/projects/${projectId}/media/${source.id}`);
    const removedAudio = await api(user.token, "DELETE", `/api/projects/${projectId}/media/${audio.id}`);
    const inputObjects = await Promise.all([
      objects.head(sourceKey).catch(() => null),
      objects.head(audioKey).catch(() => null),
    ]);
    check(
      "deleting the inputs removes their objects too",
      removedSource.status === 200 && removedAudio.status === 200 && inputObjects.every((value) => value === null),
      `source=${removedSource.status} audio=${removedAudio.status}`,
    );

    const removedProject = await api(user.token, "DELETE", `/api/projects/${projectId}`);
    check("cleanup removes the project", removedProject.status === 200, `status=${removedProject.status}`);
    const ledger = await serviceRows(
      `lipsync_usage?select=status,seconds_counted,project_id,export_id&owner_id=eq.${user.id}`,
    );
    check(
      "project cleanup keeps the seconds ledger and clears its project reference",
      ledger.length === 1 &&
        ledger[0].project_id === null &&
        ledger[0].export_id === null &&
        Number(ledger[0].seconds_counted) > 0,
      JSON.stringify(ledger.map((row) => [row.status, row.seconds_counted, row.project_id])),
    );
    projectId = null;
  } finally {
    if (projectId) await api(user?.token ?? null, "DELETE", `/api/projects/${projectId}`).catch(() => undefined);
    if (user) {
      await fetch(`${base}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: adminHeaders }).catch(
        () => undefined,
      );
      const leftovers = await serviceRows(`lipsync_usage?select=id&owner_id=eq.${user.id}`);
      check("deleting the account clears its remaining ledger rows", leftovers.length === 0, `rows=${leftovers.length}`);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
