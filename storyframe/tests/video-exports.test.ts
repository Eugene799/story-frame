import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildNarrationScript } from "../server/narration";
import type { ProjectDocumentV2, ProjectScene } from "../shared/project-contract";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import { USER_A, USER_B } from "./fake-supabase";
import { documentFixture, sceneFixture } from "./project-fixture";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

/**
 * Phase 9 slice 1 route tests against a fake JSON2Video API and the fake
 * Supabase/R2 servers. No paid call is made: every provider request is answered
 * by `fakeProvider` below.
 */

const API = "https://api.json2video.com/v2/movies";
const PROVIDER_ID = "abcdefghijklmnop";
const PROVIDER_OUTPUT = "https://assets.json2video.com/render/abcdefghijklmnop.mp4";

/** A 64-byte ftyp box: enough for the magic-byte check to see video/mp4. */
function mp4Bytes(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4);
  bytes.write("isom", 8);
  bytes.write("isomiso2mp41", 12);
  return bytes;
}

const MP4 = mp4Bytes();

type ProviderMode = "running" | "done" | "error" | "missing";

interface FakeProvider {
  submits: number;
  polls: number;
  deletes: number;
  submitted: Record<string, unknown>[];
  mode: ProviderMode;
  consumedCredits: unknown;
  /** The output download fails, so the copy cannot start. */
  outputFails: boolean;
  /** Non-200 answers the submit, the way a provider outage does. */
  submitStatus: number;
  /** Where the finished movie claims to live. */
  outputUrl: string;
  /** The bytes that URL serves, when a test needs something other than an MP4. */
  outputBytes?: Buffer;
  /** Every output download the server attempted, so a refusal is visible. */
  outputDownloads: string[];
}

function fakeProvider(initial: Partial<FakeProvider> = {}): {
  provider: FakeProvider;
  fetchImpl: typeof fetch;
} {
  const provider: FakeProvider = {
    submits: 0,
    polls: 0,
    deletes: 0,
    submitted: [],
    mode: "done",
    consumedCredits: [6, 2],
    outputFails: false,
    submitStatus: 200,
    outputUrl: PROVIDER_OUTPUT,
    outputDownloads: [],
    ...initial,
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith("https://assets.json2video.com/") || url === provider.outputUrl) {
      provider.outputDownloads.push(url);
      if (provider.outputFails) {
        return new Response("output unavailable", { status: 500 });
      }
      return new Response(new Uint8Array(provider.outputBytes ?? MP4), {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      });
    }

    if (url === API || url.startsWith(`${API}?`)) {
      if (init?.method === "DELETE") {
        provider.deletes += 1;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url === API) {
      if (init?.method === "POST") {
        provider.submits += 1;
        provider.submitted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (provider.submitStatus !== 200) {
          return new Response(JSON.stringify({ success: false }), {
            status: provider.submitStatus,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ success: true, project: PROVIDER_ID, timestamp: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.startsWith(API) && url.includes("project=")) {
      provider.polls += 1;
      if (provider.mode === "missing") {
        return new Response(JSON.stringify({ success: false }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const movie = {
        project: PROVIDER_ID,
        status: provider.mode,
        success: provider.mode !== "error",
        message: provider.mode === "error" ? "render failed at step 2" : "",
        url: provider.mode === "done" ? provider.outputUrl : null,
        thumbnail: null,
        duration: provider.mode === "done" ? 10 : null,
        size: provider.mode === "done" ? MP4.length : null,
        width: provider.mode === "done" ? 1920 : null,
        height: provider.mode === "done" ? 1080 : null,
        consumed_credits: provider.mode === "done" ? provider.consumedCredits : null,
        created_at: new Date().toISOString(),
      };
      return new Response(JSON.stringify({ success: true, movie }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return fetch(input, init);
  }) as typeof fetch;

  return { provider, fetchImpl };
}

function approvedScene(overrides: Partial<ProjectScene> = {}): ProjectScene {
  const base = sceneFixture({
    approved: true,
    approvedFingerprint: "pending",
    ...overrides,
  });
  return { ...base, approvedFingerprint: sceneFingerprint(base) };
}

function exportDocument(scenes: ProjectScene[]): ProjectDocumentV2 {
  return documentFixture({ scenes });
}

const apps: TestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function startExportApp(
  providerOptions: Partial<FakeProvider> = {},
  env: Record<string, string> = {},
): Promise<{ app: TestApp; provider: FakeProvider }> {
  const { provider, fetchImpl } = fakeProvider(providerOptions);
  const app = await startTestServer({
    fetchImpl,
    env: {
      JSON2VIDEO_API_KEY: "json2video-test-key",
      // Short cadence so the sweep, not the test, advances the row.
      VIDEO_SWEEP_INTERVAL_MS: "25",
      VIDEO_DOWNLOAD_TIMEOUT_MS: "2000",
      ...env,
    },
  });
  apps.push(app);
  return { app, provider };
}

async function createProject(app: TestApp, document: ProjectDocumentV2): Promise<{ id: string; version: number }> {
  const response = await apiRequest(app.url, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ projectType: "story", title: "Video export", document }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { project: { id: string; version: number } };
  return body.project;
}

function exportRequest(
  app: TestApp,
  projectId: string,
  projectRevision: number,
  options: { idempotencyKey?: string | null; token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const key = options.idempotencyKey === undefined ? `export-key-${randomUUID()}` : options.idempotencyKey;
  if (key !== null) headers["Idempotency-Key"] = key;
  return apiRequest(
    app.url,
    `/api/projects/${projectId}/exports/video`,
    { method: "POST", headers, body: JSON.stringify({ projectRevision }) },
    options.token === undefined ? USER_A.token : options.token,
  );
}

interface ExportBody {
  ok: boolean;
  export: {
    id: string;
    status: string;
    providerStatus: string | null;
    mediaId: string | null;
    outputKey: string | null;
    failureCode: string | null;
    creditsEstimate: number;
    creditsConsumed: number | null;
    byteSize: number | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
  };
  media: { id: string; kind: string; status: string; byteSize: number } | null;
  usage: { creditsUsed: number; creditsLimit: number | null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitStatus(
  app: TestApp,
  projectId: string,
  exportId: string,
  wanted: string[],
  timeoutMs = 4000,
): Promise<ExportBody> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await apiRequest(app.url, `/api/projects/${projectId}/exports/video/${exportId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ExportBody;
    if (wanted.includes(body.export.status)) return body;
    await sleep(20);
  }
  throw new Error(`export ${exportId} did not reach ${wanted.join("/")} in time`);
}

describe("video exports", () => {
  it("submits once, copies the finished MP4, and settles the measured credits", async () => {
    const { app, provider } = await startExportApp();
    const project = await createProject(
      app,
      exportDocument([approvedScene({ id: "a", durationSeconds: 5 }), approvedScene({ id: "b", durationSeconds: 5 })]),
    );

    const submitted = await exportRequest(app, project.id, project.version);
    expect(submitted.status).toBe(202);
    const accepted = (await submitted.json()) as ExportBody;
    expect(accepted.export.status).toBe("pending");
    expect(accepted.export.creditsEstimate).toBe(10);
    expect(accepted.usage.creditsUsed).toBe(10);
    expect(provider.submits).toBe(1);

    // Signed input URLs never reach storage: only keys and expiries.
    const job = app.supabase.jobs.at(-1) as Record<string, unknown>;
    expect(JSON.stringify(job.request)).not.toContain("X-Amz-Signature");

    const ready = await awaitStatus(app, project.id, accepted.export.id, ["ready", "failed"]);
    expect(ready.export.failureCode).toBeNull();
    expect(ready.export.status).toBe("ready");
    expect(ready.media).toMatchObject({ kind: "video", status: "ready", byteSize: MP4.length });
    expect(ready.export.creditsConsumed).toBe(8);
    expect(ready.export.durationSeconds).toBe(10);
    expect(ready.export.width).toBe(1920);
    expect(ready.export.height).toBe(1080);
    expect(ready.export.byteSize).toBe(MP4.length);

    // Playback streams the stored bytes, never the provider URL.
    const playbackResponse = await apiRequest(
      app.url,
      `/api/projects/${project.id}/exports/video/${accepted.export.id}/url`,
    );
    expect(playbackResponse.status).toBe(200);
    const playback = (await playbackResponse.json()) as { url: string; contentType: string; byteSize: number };
    expect(playback.contentType).toBe("video/mp4");
    expect(playback.byteSize).toBe(MP4.length);
    expect(playback.url).not.toContain("json2video");

    const downloaded = await fetch(playback.url);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(MP4)).toBe(true);

    // The provider's copy is deleted once ours exists.
    expect(provider.deletes).toBe(1);
    expect(app.supabase.videoUsage.at(-1)).toMatchObject({
      status: "succeeded",
      credits_counted: 8,
      duration_seconds: 10,
    });

    // The generic render contract is untouched by the export-only indexes.
    const generic = await apiRequest(app.url, `/api/projects/${project.id}/renders`, {
      method: "POST",
      body: JSON.stringify({ projectRevision: project.version }),
    });
    expect(generic.status).toBe(201);
    const again = await apiRequest(app.url, `/api/projects/${project.id}/renders`, {
      method: "POST",
      body: JSON.stringify({ projectRevision: project.version }),
    });
    expect(again.status).toBe(201);
    expect(app.supabase.renders.filter((row) => row.kind === undefined || row.kind === "snapshot")).toHaveLength(2);
  });

  it("leaves an export alone while another instance holds its row claim", async () => {
    const { app, provider } = await startExportApp({ mode: "running" });
    const project = await createProject(app, exportDocument([approvedScene()]));

    const submitted = await exportRequest(app, project.id, project.version);
    expect(submitted.status).toBe(202);
    const accepted = (await submitted.json()) as ExportBody;

    // A stored claim stands the sweep down, so no pass may poll this row.
    const claim = `video-row:${accepted.export.id}`;
    app.supabase.jobLeases.push({
      name: claim,
      holder: "another-instance",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    // Let a poll that was already in flight finish, then watch a full cadence.
    await sleep(100);
    const polls = provider.polls;
    await sleep(250);
    expect(provider.polls).toBe(polls);

    const running = (await (
      await apiRequest(app.url, `/api/projects/${project.id}/exports/video/${accepted.export.id}`)
    ).json()) as ExportBody;
    expect(running.export.status).toBe("pending");
    expect(provider.outputDownloads).toHaveLength(0);
    expect(app.supabase.jobLeaseClaims.some((entry) => entry.name === claim && !entry.granted)).toBe(true);
    expect(app.supabase.jobLeases.some((row) => row.name === claim && row.holder === "another-instance")).toBe(
      true,
    );

    // Releasing it lets the next pass poll the same row, and the render is now
    // finished at the provider, so that pass copies and settles it.
    app.supabase.jobLeases.splice(app.supabase.jobLeases.findIndex((row) => row.name === claim), 1);
    provider.mode = "done";
    const ready = await awaitStatus(app, project.id, accepted.export.id, ["ready", "failed"]);
    expect(ready.export.status).toBe("ready");
    expect(ready.media?.byteSize).toBe(MP4.length);
    // The row turns ready inside the pass; the pass deletes its own sweep lease
    // after that, so let the release land instead of requiring it in the same
    // tick as the status write.
    for (let attempt = 0; attempt < 100 && app.supabase.jobLeases.length > 0; attempt += 1) {
      await sleep(20);
    }
    expect(app.supabase.jobLeases).toHaveLength(0);
  });

  it("keeps one live export per project and makes the second refusal free", async () => {
    const { app, provider } = await startExportApp(
      { mode: "running" },
      { VIDEO_SWEEP_INTERVAL_MS: "0" },
    );
    const project = await createProject(app, exportDocument([approvedScene()]));

    const first = await exportRequest(app, project.id, project.version);
    expect(first.status).toBe(202);
    const second = await exportRequest(app, project.id, project.version);
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("VIDEO_RENDER_IN_FLIGHT");
    expect(provider.submits).toBe(1);
  });

  it("returns the same export for a replayed Idempotency-Key without submitting again", async () => {
    const { app, provider } = await startExportApp({ mode: "running" }, { VIDEO_SWEEP_INTERVAL_MS: "0" });
    const project = await createProject(app, exportDocument([approvedScene()]));

    const key = "replay-key-0001";
    const first = await exportRequest(app, project.id, project.version, { idempotencyKey: key });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as ExportBody;

    const replay = await exportRequest(app, project.id, project.version, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as ExportBody;
    expect(replayBody.export.id).toBe(firstBody.export.id);
    expect(provider.submits).toBe(1);
  });

  it("refuses an over-budget render before any provider call", async () => {
    const { app, provider } = await startExportApp({}, { VIDEO_DAILY_CREDITS_PER_USER: "5" });
    const project = await createProject(app, exportDocument([approvedScene({ durationSeconds: 10 })]));

    const response = await exportRequest(app, project.id, project.version);
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("VIDEO_BUDGET_EXCEEDED");
    expect(provider.submits).toBe(0);
    // A refusal leaves no pending row to block the project.
    expect(app.supabase.renders).toHaveLength(0);

    const listed = await apiRequest(app.url, `/api/projects/${project.id}/exports/video`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { exports: unknown[] }).exports).toHaveLength(0);
  });

  it("fails a provider-side render error and settles it at zero", async () => {
    const { app } = await startExportApp({ mode: "error" });
    const project = await createProject(app, exportDocument([approvedScene()]));

    const accepted = (await (await exportRequest(app, project.id, project.version)).json()) as ExportBody;
    const failed = await awaitStatus(app, project.id, accepted.export.id, ["failed", "ready"]);
    expect(failed.export.status).toBe("failed");
    expect(failed.export.failureCode).toBe("VIDEO_PROVIDER_REJECTED");
    // A confirmed rejection is not billed by the provider.
    expect(failed.export.creditsConsumed).toBe(0);

    await sleep(80);
    const settled = app.supabase.videoUsage.at(-1) as Record<string, unknown>;
    expect(settled).toMatchObject({ status: "failed", credits_counted: 0 });
  });

  it("keeps a failed copy pending until the attempt limit, then keeps the provider copy", async () => {
    // A pass every 800 ms, so one attempt is visible before the next begins.
    const { app, provider } = await startExportApp(
      { mode: "done", outputFails: true },
      { VIDEO_SWEEP_INTERVAL_MS: "800" },
    );
    const project = await createProject(app, exportDocument([approvedScene({ durationSeconds: 10 })]));

    const accepted = (await (await exportRequest(app, project.id, project.version)).json()) as ExportBody;
    expect(accepted.export.creditsEstimate).toBe(10);

    // The first copy fails. The render is already paid for, so the row waits for
    // the next pass instead of being thrown away.
    const deadline = Date.now() + 4000;
    while (provider.outputDownloads.length === 0 && Date.now() < deadline) await sleep(10);
    expect(provider.outputDownloads).toHaveLength(1);
    const pending = await awaitStatus(app, project.id, accepted.export.id, ["pending", "failed"]);
    expect(pending.export.status).toBe("pending");
    expect(pending.export.failureCode).toBeNull();
    expect(app.r2.objects.size).toBe(0);

    const failed = await awaitStatus(app, project.id, accepted.export.id, ["failed"], 10_000);
    expect(failed.export.status).toBe("failed");
    expect(failed.export.failureCode).toBe("VIDEO_OUTPUT_COPY_FAILED");
    // The row records what the billed attempt cost, not just the estimate.
    expect(failed.export.creditsConsumed).toBe(10);
    expect(failed.export.mediaId).toBeNull();
    expect(failed.export.outputKey).toBeNull();
    expect(failed.media).toBeNull();
    // Nothing was written, so no object and no media row exist.
    expect(app.r2.objects.size).toBe(0);

    // Three attempts at three passes, and never a second paid render.
    expect(provider.outputDownloads).toHaveLength(3);
    expect(provider.submits).toBe(1);

    // The URL of the finished render survives for a later retry, and the provider
    // copy is kept rather than deleted.
    const job = app.supabase.jobs.at(-1) as Record<string, unknown>;
    expect(job.status).toBe("failed");
    expect(job.result).toMatchObject({
      providerStatus: "done",
      providerCopy: { url: PROVIDER_OUTPUT },
      failureCode: "VIDEO_OUTPUT_COPY_FAILED",
    });
    expect(provider.deletes).toBe(0);

    // The row is settled, so no further copy is attempted.
    await sleep(1_000);
    expect(provider.outputDownloads).toHaveLength(3);

    const listed = await apiRequest(app.url, `/api/projects/${project.id}/exports/video`);
    const body = (await listed.json()) as { exports: { status: string }[] };
    expect(body.exports).toHaveLength(1);
    expect(body.exports[0].status).toBe("failed");

    await sleep(80);
    const settled = app.supabase.videoUsage.at(-1) as Record<string, unknown>;
    expect(settled).toMatchObject({ status: "failed", credits_counted: 10 });
  });

  it("fails a render that can never copy on the first attempt", async () => {
    // Bytes that fail the magic-byte check: another download of the same bytes
    // cannot make them a video, so the first attempt settles the export.
    const garbage = await startExportApp({ mode: "done", outputBytes: Buffer.from("not a video at all") });
    const garbageProject = await createProject(garbage.app, exportDocument([approvedScene()]));
    const garbageAccepted = (
      await (await exportRequest(garbage.app, garbageProject.id, garbageProject.version)).json()
    ) as ExportBody;
    const garbageFailed = await awaitStatus(
      garbage.app,
      garbageProject.id,
      garbageAccepted.export.id,
      ["failed"],
      8000,
    );
    expect(garbageFailed.export.failureCode).toBe("VIDEO_OUTPUT_INVALID");
    // Long enough for several passes at the 25 ms cadence.
    await sleep(200);
    expect(garbage.provider.outputDownloads).toHaveLength(1);

    // A render over VIDEO_MAX_BYTES: the cap will never accept it either.
    const oversized = Buffer.alloc(2 * 1024 * 1024, 1);
    oversized.writeUInt32BE(24, 0);
    oversized.write("ftyp", 4);
    oversized.write("isom", 8);
    oversized.write("isomiso2mp41", 12);
    const capped = await startExportApp(
      { mode: "done", outputBytes: oversized },
      { VIDEO_MAX_BYTES: "1048576" },
    );
    const cappedProject = await createProject(capped.app, exportDocument([approvedScene()]));
    const cappedAccepted = (
      await (await exportRequest(capped.app, cappedProject.id, cappedProject.version)).json()
    ) as ExportBody;
    const cappedFailed = await awaitStatus(
      capped.app,
      cappedProject.id,
      cappedAccepted.export.id,
      ["failed"],
      8000,
    );
    expect(cappedFailed.export.failureCode).toBe("VIDEO_OUTPUT_INVALID");
    await sleep(200);
    expect(capped.provider.outputDownloads).toHaveLength(1);

    // A valid MP4 with no room in the account: the row cannot free space while
    // it is pending, so this is the first and only attempt.
    const tooBig = Buffer.alloc(2048, 1);
    tooBig.writeUInt32BE(24, 0);
    tooBig.write("ftyp", 4);
    tooBig.write("isom", 8);
    tooBig.write("isomiso2mp41", 12);
    const full = await startExportApp(
      { mode: "done", outputBytes: tooBig },
      { MEDIA_OWNER_STORAGE_BYTES: "1024" },
    );
    const fullProject = await createProject(full.app, exportDocument([approvedScene()]));
    const fullAccepted = (
      await (await exportRequest(full.app, fullProject.id, fullProject.version)).json()
    ) as ExportBody;
    const fullFailed = await awaitStatus(full.app, fullProject.id, fullAccepted.export.id, ["failed"], 8000);
    expect(fullFailed.export.failureCode).toBe("VIDEO_OUTPUT_COPY_FAILED");
    await sleep(200);
    expect(full.provider.outputDownloads).toHaveLength(1);
    expect(full.app.r2.objects.size).toBe(0);
  });

  it("copies a deferred render from the stored URL when the provider no longer knows the job", async () => {
    const { app, provider } = await startExportApp(
      { mode: "done", outputFails: true },
      { VIDEO_SWEEP_INTERVAL_MS: "800" },
    );
    const project = await createProject(app, exportDocument([approvedScene({ durationSeconds: 10 })]));

    const accepted = (await (await exportRequest(app, project.id, project.version)).json()) as ExportBody;
    const deadline = Date.now() + 4000;
    while (provider.outputDownloads.length === 0 && Date.now() < deadline) await sleep(10);
    expect(provider.outputDownloads).toHaveLength(1);
    const polls = provider.polls;

    // The provider forgets the job, but its CDN still serves the finished render.
    provider.mode = "missing";
    provider.outputFails = false;

    const ready = await awaitStatus(app, project.id, accepted.export.id, ["ready", "failed"], 8000);
    expect(ready.export.status).toBe("ready");
    expect(ready.export.byteSize).toBe(MP4.length);
    expect(ready.export.failureCode).toBeNull();
    // The retry used the stored URL: no new poll, and no second paid render.
    expect(provider.polls).toBe(polls);
    expect(provider.submits).toBe(1);
    expect(provider.outputDownloads).toEqual([PROVIDER_OUTPUT, PROVIDER_OUTPUT]);
    // The finished render's own credit count survives the deferral.
    expect(ready.export.creditsConsumed).toBe(8);

    await sleep(80);
    const settled = app.supabase.videoUsage.at(-1) as Record<string, unknown>;
    expect(settled).toMatchObject({ status: "succeeded", credits_counted: 8 });
  });

  it("keeps the estimated credits when the submit failure is ambiguous", async () => {
    const { app, provider } = await startExportApp(
      { submitStatus: 500 },
      { VIDEO_SWEEP_INTERVAL_MS: "0" },
    );
    const project = await createProject(app, exportDocument([approvedScene({ durationSeconds: 10 })]));

    const response = await exportRequest(app, project.id, project.version);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "VIDEO_PROVIDER_UNAVAILABLE",
    );
    // A 5xx is retried before it is given up on, and nothing is left pending.
    expect(provider.submits).toBe(3);

    // The provider may have created (and billed) the render, so the window keeps
    // the estimate instead of pretending the attempt was free.
    await sleep(80);
    const settled = app.supabase.videoUsage.at(-1) as Record<string, unknown>;
    expect(settled).toMatchObject({ status: "failed", credits_counted: 10 });

    const listed = await apiRequest(app.url, `/api/projects/${project.id}/exports/video`);
    const body = (await listed.json()) as {
      exports: { status: string; failureCode: string | null; creditsConsumed: number | null }[];
      usage: { creditsUsed: number };
    };
    expect(body.exports).toHaveLength(1);
    expect(body.exports[0]).toMatchObject({ status: "failed", failureCode: "VIDEO_PROVIDER_UNAVAILABLE" });
    // The row and the ledger agree on the ambiguous attempt's cost.
    expect(body.exports[0].creditsConsumed).toBe(10);
    expect(body.usage.creditsUsed).toBe(10);
  });

  it("copies the MP4 from the provider's own CDN bucket", async () => {
    // A live render on 2026-11-25 was delivered from this host, not the
    // documented assets.json2video.com.
    const cdn = "https://json2video-cdn1.s3.amazonaws.com/render/abcdefghijklmnop.mp4";
    const { app, provider } = await startExportApp({ mode: "done", outputUrl: cdn });
    const project = await createProject(app, exportDocument([approvedScene({ durationSeconds: 5 })]));

    const accepted = (await (await exportRequest(app, project.id, project.version)).json()) as ExportBody;
    const ready = await awaitStatus(app, project.id, accepted.export.id, ["ready", "failed"]);
    expect(ready.export.failureCode).toBeNull();
    expect(ready.export.status).toBe("ready");
    expect(ready.export.byteSize).toBe(MP4.length);
    expect(provider.outputDownloads).toEqual([cdn]);
  });

  it("refuses an output URL outside the provider's delivery hosts", async () => {
    const { app, provider } = await startExportApp({
      mode: "done",
      outputUrl: "https://cdn.attacker.example/render/abcdefghijklmnop.mp4",
    });
    const project = await createProject(app, exportDocument([approvedScene({ durationSeconds: 5 })]));

    const accepted = (await (await exportRequest(app, project.id, project.version)).json()) as ExportBody;
    const failed = await awaitStatus(app, project.id, accepted.export.id, ["failed", "ready"]);
    expect(failed.export.failureCode).toBe("VIDEO_OUTPUT_INVALID");
    expect(failed.export.mediaId).toBeNull();
    // Nothing was fetched and nothing was stored.
    expect(provider.outputDownloads).toEqual([]);
    expect(app.r2.objects.size).toBe(0);
  });

  it("stops polling when the provider no longer knows the render", async () => {
    const { app, provider } = await startExportApp({ mode: "missing" });
    const project = await createProject(app, exportDocument([approvedScene()]));

    const accepted = (await (await exportRequest(app, project.id, project.version)).json()) as ExportBody;
    const failed = await awaitStatus(app, project.id, accepted.export.id, ["failed", "ready"]);
    expect(failed.export.failureCode).toBe("VIDEO_JOB_NOT_FOUND");
    const polls = provider.polls;
    await sleep(100);
    expect(provider.polls).toBe(polls);
  });

  it("refuses unapproved scenes and a stale revision with no provider call", async () => {
    const { app, provider } = await startExportApp();
    const project = await createProject(
      app,
      exportDocument([approvedScene({ approved: false, approvedFingerprint: null })]),
    );

    const unapproved = await exportRequest(app, project.id, project.version);
    expect(unapproved.status).toBe(409);
    expect(((await unapproved.json()) as { error: { code: string } }).error.code).toBe(
      "VIDEO_SCRIPT_NOT_APPROVED",
    );

    const stale = await exportRequest(app, project.id, 99);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      "PROJECT_REVISION_NOT_FOUND",
    );
    expect(provider.submits).toBe(0);
    expect(app.supabase.renders).toHaveLength(0);
  });

  it("refuses stale or overflowing narration before the provider call", async () => {
    const { app, provider } = await startExportApp();
    const document = exportDocument([approvedScene({ id: "a", durationSeconds: 5 })]);
    const project = await createProject(app, document);
    const script = buildNarrationScript(document);

    const track = (fingerprint: string, durationSeconds: number) => {
      app.supabase.narrationTracks.push({
        id: randomUUID(),
        owner_id: USER_A.id,
        project_id: project.id,
        kind: "narration",
        source: "upload",
        status: "active",
        media_id: randomUUID(),
        voice_model: null,
        voice_name: null,
        script_fingerprint: fingerprint,
        script_characters: 12,
        duration_seconds: durationSeconds,
        volume: 1,
        muted: false,
        cost_usd: null,
        cost_rate_version: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    };

    track("stale-fingerprint", 2);
    const stale = await exportRequest(app, project.id, project.version);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("VIDEO_NARRATION_STALE");

    app.supabase.narrationTracks.splice(0);
    track(script.fingerprint, 30);
    const overflow = await exportRequest(app, project.id, project.version);
    expect(overflow.status).toBe(409);
    expect(((await overflow.json()) as { error: { code: string } }).error.code).toBe(
      "VIDEO_NARRATION_OVERFLOW",
    );

    expect(provider.submits).toBe(0);
  });

  it("deletes the export, its stored object, and the provider copy", async () => {
    const { app, provider } = await startExportApp();
    const project = await createProject(app, exportDocument([approvedScene()]));

    const accepted = (await (await exportRequest(app, project.id, project.version)).json()) as ExportBody;
    const ready = await awaitStatus(app, project.id, accepted.export.id, ["ready", "failed"]);
    expect(ready.export.status).toBe("ready");
    const objectKey = ready.export.outputKey;
    expect(objectKey).not.toBeNull();
    expect(app.r2.objects.has(objectKey as string)).toBe(true);

    const removed = await apiRequest(
      app.url,
      `/api/projects/${project.id}/exports/video/${accepted.export.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(app.r2.objects.has(objectKey as string)).toBe(false);
    expect(app.supabase.renders).toHaveLength(0);
    expect(provider.deletes).toBeGreaterThanOrEqual(2);

    const again = await apiRequest(
      app.url,
      `/api/projects/${project.id}/exports/video/${accepted.export.id}`,
      { method: "DELETE" },
    );
    expect(again.status).toBe(404);
  });

  it("refuses when the provider key is absent and hides other accounts' exports", async () => {
    const off = await startTestServer({
      env: { JSON2VIDEO_API_KEY: "", VIDEO_SWEEP_INTERVAL_MS: "0" },
    });
    apps.push(off);
    const project = await createProject(off, exportDocument([approvedScene()]));
    const disabled = await exportRequest(off, project.id, project.version);
    expect(disabled.status).toBe(503);
    expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe(
      "VIDEO_PROVIDER_DISABLED",
    );

    const { app } = await startExportApp({ mode: "running" }, { VIDEO_SWEEP_INTERVAL_MS: "0" });
    const own = await createProject(app, exportDocument([approvedScene()]));
    const accepted = (await (await exportRequest(app, own.id, own.version)).json()) as ExportBody;

    const foreign = await apiRequest(
      app.url,
      `/api/projects/${own.id}/exports/video/${accepted.export.id}`,
      {},
      USER_B.token,
    );
    expect(foreign.status).toBe(404);
  });

  it("requires an Idempotency-Key and rejects a non-UUID export id", async () => {
    const { app } = await startExportApp({ mode: "running" }, { VIDEO_SWEEP_INTERVAL_MS: "0" });
    const project = await createProject(app, exportDocument([approvedScene()]));

    const missing = await exportRequest(app, project.id, project.version, { idempotencyKey: null });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );

    const malformed = await apiRequest(app.url, `/api/projects/${project.id}/exports/video/not-a-uuid`);
    expect(malformed.status).toBe(404);
  });
});
