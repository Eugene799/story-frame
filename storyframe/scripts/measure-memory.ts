/**
 * Peak RSS on the two background paths that hold a whole file in memory:
 *
 *   npx tsx scripts/measure-memory.ts lipsync 25
 *   npx tsx scripts/measure-memory.ts lipsync-copy 64
 *   npx tsx scripts/measure-memory.ts video-copy 256
 *
 * `lipsync` runs a real `submit`: both inputs are read from storage and inlined
 * as base64 Data URIs before the provider POST, so the peak is the two inputs
 * plus their base64 copies plus the serialized body. `video-copy` runs a real
 * sweep pass over a finished render: the provider output is streamed with the
 * byte cap, concatenated, checked, and PUT to the bucket. `lipsync-copy` is the
 * same copy on the lip sync side: the finished MP4 is downloaded, measured, and
 * PUT to the bucket.
 *
 * Both use in-memory stores and a fake provider, so this measures this server's
 * own buffering rather than a network or a paid call. Run one scenario per
 * process: the peaks would otherwise add up.
 */

import { createLipsyncService, type LipsyncExportRow, type LipsyncLimits, type LipsyncStore } from "../server/lipsync";
import { JSON2VIDEO_MOVIES_URL } from "../server/json2video";
import {
  createVideoExportService,
  type VideoExportCursor,
  type VideoExportStore,
  type VideoLimits,
} from "../server/video-exports";
import type { MediaLimits, MediaStore } from "../server/media";
import type { R2Client } from "../server/r2";
import type { MediaRecord } from "../shared/media-contract";

const MIB = 1024 * 1024;
const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const AUDIO = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const RENDER_URL = "https://assets.json2video.com/render/measure.mp4";

function toMiB(bytes: number): number {
  return Math.round((bytes / MIB) * 10) / 10;
}

/** Enough of a container header for the server's magic-byte check. */
function mp4Prefix(bytes: Buffer): Buffer {
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4);
  bytes.write("isom", 8);
  bytes.write("isomiso2mp41", 12);
  return bytes;
}

function mediaRecord(overrides: Partial<MediaRecord> = {}): MediaRecord {
  const now = new Date().toISOString();
  return {
    id: SOURCE,
    kind: "video",
    status: "ready",
    sceneKey: null,
    contentType: "video/mp4",
    byteSize: 1024,
    uploadExpiresAt: null,
    readyAt: now,
    deletedAt: null,
    createdAt: now,
    referenceCount: 0,
    provenance: null,
    ...overrides,
  };
}

function peakSampler(): { stop: () => number } {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(peak, process.memoryUsage().rss);
    },
  };
}

async function measureLipsync(sizeMiB: number): Promise<{ baseline: number; peak: number }> {
  const size = sizeMiB * MIB;
  // The two ready assets the route would have stored; `submit` reads them from
  // the bucket into memory before anything is sent.
  const sourceBytes = mp4Prefix(Buffer.alloc(size, 7));
  const audioBytes = Buffer.alloc(size, 9);

  const rows: LipsyncExportRow[] = [];
  const store: LipsyncStore = {
    async findByKey() {
      return null;
    },
    async findLive() {
      return null;
    },
    async create(ownerId, projectId, write) {
      const created: LipsyncExportRow = {
        id: write.id,
        ownerId,
        projectId,
        status: "pending",
        providerStatus: null,
        providerTaskId: null,
        sourceMediaId: write.sourceMediaId,
        audioMediaId: write.audioMediaId,
        outputMediaId: null,
        resolution: write.resolution,
        secondsEstimate: write.secondsEstimate,
        secondsCounted: null,
        usdEstimate: write.usdEstimate,
        byteSize: null,
        failureCode: null,
        failureMessage: null,
        lastPolledAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      rows.unshift(created);
      return created;
    },
    async get(_ownerId, _projectId, exportId) {
      const found = rows.find((entry) => entry.id === exportId);
      if (!found) throw new Error("missing lip sync row");
      return found;
    },
    async list() {
      return rows;
    },
    async update(_ownerId, exportId, patch) {
      const found = rows.find((entry) => entry.id === exportId);
      if (found) Object.assign(found, patch);
    },
    async live() {
      return rows.filter((entry) => entry.status === "pending");
    },
    async remove() {
      return undefined;
    },
    async reserve(_ownerId, _projectId, _exportId, seconds) {
      return { allowed: true, secondsUsed: seconds, oldestAt: new Date().toISOString() };
    },
    async settleUsage() {
      return undefined;
    },
    async usageSince() {
      return { secondsUsed: 0, usdUsed: 0, oldestAt: null };
    },
  };

  const media = {
    async get(_ownerId: string, _projectId: string, mediaId: string) {
      if (mediaId === SOURCE) return { media: mediaRecord({ byteSize: size }), objectKey: "media/source.mp4" };
      if (mediaId === AUDIO) {
        return {
          media: mediaRecord({ id: AUDIO, kind: "audio", contentType: "audio/mpeg", byteSize: size }),
          objectKey: "media/audio.mp3",
        };
      }
      return null;
    },
  } as unknown as MediaStore;

  const objects = {
    get: async (key: string) =>
      key === "media/source.mp4" ? sourceBytes : key === "media/audio.mp3" ? audioBytes : null,
  } as unknown as R2Client;

  let submittedBytes = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.everypixel.com/v1/")) {
      submittedBytes = typeof init?.body === "string" ? init.body.length : 0;
      return new Response(JSON.stringify({ task_id: "task-measure", status: "PENDING" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const limits: LipsyncLimits = {
    timeoutMs: 60_000,
    pollIntervalMs: 5_000,
    sweepIntervalMs: 0,
    abandonAfterMs: 60 * 60 * 1000,
    downloadTimeoutMs: 60_000,
    maxInputBytes: 25 * MIB,
    maxOutputBytes: 256 * MIB,
    redirectLimit: 3,
    outputHosts: [],
    dailySecondsLimit: 600,
    dailyUsdLimit: 5,
    spendWindowMs: 24 * 60 * 60 * 1000,
  };

  const service = createLipsyncService({
    store,
    media,
    objects,
    settings: { clientId: "measure", clientSecret: "measure" },
    limits,
    mediaLimits: { uploadUrlSeconds: 900, downloadUrlSeconds: 300, uploadTtlMs: 900_000, ownerStorageBytes: 4 * 1024 * MIB, listLimit: 50 } as unknown as MediaLimits,
    claimRow: async (_rowId, work) => work(new AbortController().signal),
    fetchImpl,
    logger: { error: () => undefined },
  });

  const baseline = process.memoryUsage().rss;
  const sampler = peakSampler();
  await service.submit(
    OWNER,
    PROJECT,
    { sourceMediaId: SOURCE, audioMediaId: AUDIO, resolution: "720p" },
    "measure-lipsync",
  );
  const peak = sampler.stop();
  if (rows[0]?.providerTaskId !== "task-measure" || submittedBytes === 0) {
    throw new Error("the lip sync submit did not reach the fake provider");
  }
  return { baseline, peak };
}

async function measureVideoCopy(sizeMiB: number): Promise<{ baseline: number; peak: number }> {
  const total = sizeMiB * MIB;
  let sent = 0;
  // One MiB at a time, the way a real download arrives; the server holds every
  // chunk plus the concatenation plus the PUT body.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const length = Math.min(MIB, total - sent);
      const bytes = Buffer.alloc(length, 3);
      if (sent === 0) mp4Prefix(bytes);
      sent += length;
      controller.enqueue(bytes);
    },
  });

  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const cursor: VideoExportCursor = {
    id: "66666666-6666-4666-8666-666666666666",
    ownerId: OWNER,
    projectId: PROJECT,
    createdAt,
    creditsEstimate: 10,
    creditsConsumed: null,
    projectRevision: 1,
    job: {
      id: JOB,
      status: "running",
      externalId: "abcdefghijklmnop",
      createdAt,
      request: null,
      result: null,
    },
  };

  const store = {
    async live() {
      return [cursor];
    },
    async update() {
      return undefined;
    },
    async updateJob() {
      return undefined;
    },
    async settleUsage() {
      return undefined;
    },
  } as unknown as VideoExportStore;

  const media = {
    async usedBytes() {
      return 0;
    },
    async createPending(_ownerId: string, _projectId: string, write: { id: string; kind: "video"; contentType: string; byteSize: number }) {
      return mediaRecord({ id: write.id, kind: write.kind, contentType: write.contentType, status: "pending", byteSize: write.byteSize });
    },
    async markReady() {
      return true;
    },
    async addReference() {
      return undefined;
    },
    async markDeleted() {
      return true;
    },
  } as unknown as MediaStore;

  const objects = {
    presignPut: (key: string) => ({ url: `https://r2.test/put/${key}`, expiresAt: new Date(Date.now() + 900_000).toISOString() }),
    head: async () => ({ byteSize: total, contentType: "video/mp4", etag: "measure", lastModified: null }),
    delete: async () => true,
  } as unknown as R2Client;

  let putBytes = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === RENDER_URL) {
      return new Response(stream, { status: 200, headers: { "Content-Type": "video/mp4" } });
    }
    if (url.startsWith(JSON2VIDEO_MOVIES_URL) && (init?.method ?? "GET") === "GET") {
      return new Response(
        JSON.stringify({
          success: true,
          movie: {
            project: "abcdefghijklmnop",
            status: "done",
            success: true,
            message: "",
            url: RENDER_URL,
            thumbnail: null,
            duration: 10,
            size: total,
            width: 1920,
            height: 1080,
            consumed_credits: [6, 2],
            created_at: createdAt,
          },
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://r2.test/put/") && init?.method === "PUT") {
      putBytes = (init.body as Uint8Array | undefined)?.byteLength ?? 0;
      return new Response("", { status: 200 });
    }
    if (url.startsWith(JSON2VIDEO_MOVIES_URL) && init?.method === "DELETE") {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const limits: VideoLimits = {
    resolution: "hd",
    timeoutMs: 30_000,
    renderTimeoutMs: 20 * 60 * 1000,
    abandonAfterMs: 45 * 60 * 1000,
    inputUrlSeconds: 7_200,
    downloadTimeoutMs: 60_000,
    maxBytes: total + MIB,
    maxSeconds: 600,
    timingToleranceSeconds: 0.5,
    dailyCreditsLimit: 600,
    spendWindowMs: 24 * 60 * 60 * 1000,
  };

  const service = createVideoExportService({
    store,
    media,
    narration: {} as never,
    projects: {} as never,
    objects,
    settings: { apiKey: "measure" },
    limits,
    mediaLimits: { uploadUrlSeconds: 900, downloadUrlSeconds: 300, uploadTtlMs: 900_000, ownerStorageBytes: 8 * 1024 * MIB, listLimit: 50 } as unknown as MediaLimits,
    claimRow: async (_rowId, work) => work(new AbortController().signal),
    fetchImpl,
    logger: { error: () => undefined },
  });

  const baseline = process.memoryUsage().rss;
  const sampler = peakSampler();
  await service.sweep();
  const peak = sampler.stop();
  if (putBytes !== total) throw new Error(`the copy PUT ${putBytes} bytes instead of ${total}`);
  return { baseline, peak };
}

/** The lip sync sweep's output copy, which sizes `LIPSYNC_MAX_OUTPUT_BYTES`. */
async function measureLipsyncCopy(sizeMiB: number): Promise<{ baseline: number; peak: number }> {
  const total = sizeMiB * MIB;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const length = Math.min(MIB, total - sent);
      const bytes = Buffer.alloc(length, 5);
      if (sent === 0) mp4Prefix(bytes);
      sent += length;
      controller.enqueue(bytes);
    },
  });

  const now = new Date().toISOString();
  const row: LipsyncExportRow = {
    id: "77777777-7777-4777-8777-777777777777",
    ownerId: OWNER,
    projectId: PROJECT,
    status: "pending",
    providerStatus: "SUCCESS",
    providerTaskId: "task-measure",
    sourceMediaId: SOURCE,
    audioMediaId: AUDIO,
    outputMediaId: null,
    resolution: "720p",
    secondsEstimate: 20,
    secondsCounted: null,
    usdEstimate: 0.15,
    byteSize: null,
    failureCode: null,
    failureMessage: null,
    lastPolledAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const store = {
    async live() {
      return [row];
    },
    async update(_ownerId: string, _exportId: string, patch: Partial<LipsyncExportRow>) {
      Object.assign(row, patch);
    },
    async settleUsage() {
      return undefined;
    },
    async get() {
      return row;
    },
  } as unknown as LipsyncStore;

  const media = {
    async usedBytes() {
      return 0;
    },
    async createPending(_ownerId: string, _projectId: string, write: { id: string; kind: "video"; contentType: string; byteSize: number }) {
      return mediaRecord({ id: write.id, kind: write.kind, contentType: write.contentType, status: "pending", byteSize: write.byteSize });
    },
    async markReady() {
      return true;
    },
    async markDeleted() {
      return true;
    },
  } as unknown as MediaStore;

  const objects = {
    presignPut: (key: string) => ({ url: `https://r2.test/put/${key}`, expiresAt: new Date(Date.now() + 900_000).toISOString() }),
    head: async () => ({ byteSize: total, contentType: "video/mp4", etag: "measure", lastModified: null }),
    delete: async () => true,
  } as unknown as R2Client;

  let putBytes = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.everypixel.com/v1/status")) {
      return new Response(
        JSON.stringify({ task_id: "task-measure", status: "SUCCESS", result: "https://cdn.everypixel.com/out/measure.mp4" }),
        { status: 200 },
      );
    }
    if (url === "https://cdn.everypixel.com/out/measure.mp4") {
      return new Response(stream, { status: 200, headers: { "Content-Type": "video/mp4" } });
    }
    if (url.startsWith("https://r2.test/put/") && init?.method === "PUT") {
      putBytes = (init.body as Uint8Array | undefined)?.byteLength ?? 0;
      return new Response("", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const limits: LipsyncLimits = {
    timeoutMs: 60_000,
    pollIntervalMs: 0,
    sweepIntervalMs: 0,
    abandonAfterMs: 60 * 60 * 1000,
    downloadTimeoutMs: 60_000,
    maxInputBytes: 25 * MIB,
    maxOutputBytes: total + MIB,
    redirectLimit: 3,
    outputHosts: [],
    dailySecondsLimit: 600,
    dailyUsdLimit: 5,
    spendWindowMs: 24 * 60 * 60 * 1000,
  };

  const service = createLipsyncService({
    store,
    media,
    objects,
    settings: { clientId: "measure", clientSecret: "measure" },
    limits,
    mediaLimits: { uploadUrlSeconds: 900, downloadUrlSeconds: 300, uploadTtlMs: 900_000, ownerStorageBytes: 8 * 1024 * MIB, listLimit: 50 } as unknown as MediaLimits,
    claimRow: async (_rowId, work) => work(new AbortController().signal),
    fetchImpl,
    logger: { error: () => undefined },
  });

  const baseline = process.memoryUsage().rss;
  const sampler = peakSampler();
  await service.sweep();
  const peak = sampler.stop();
  if (row.status !== "ready" || putBytes !== total) {
    throw new Error(`the lip sync copy did not finish (status ${row.status}, PUT ${putBytes} of ${total})`);
  }
  return { baseline, peak };
}

async function main(): Promise<void> {
  const scenario = process.argv[2];
  const sizeMiB = Number(process.argv[3] ?? (scenario === "lipsync" ? 25 : 256));
  if (!Number.isFinite(sizeMiB) || sizeMiB <= 0) throw new Error("size must be a positive number of MiB");

  const result =
    scenario === "lipsync"
      ? await measureLipsync(sizeMiB)
      : scenario === "lipsync-copy"
        ? await measureLipsyncCopy(sizeMiB)
        : scenario === "video-copy"
          ? await measureVideoCopy(sizeMiB)
          : null;
  if (result === null) throw new Error("usage: measure-memory.ts <lipsync|lipsync-copy|video-copy> [MiB]");

  // `maxRSS` is the kernel's own high-water mark for this process, which does
  // not depend on the sampler catching the instant of the peak.
  const maxRssMiB = process.resourceUsage().maxRSS / 1024;
  console.log(
    [
      `${scenario} payload=${sizeMiB} MiB`,
      `baseline=${toMiB(result.baseline)} MiB`,
      `peak=${toMiB(result.peak)} MiB`,
      `maxRSS=${toMiB(maxRssMiB * MIB)} MiB`,
      `overBaseline=${toMiB(result.peak - result.baseline)} MiB`,
    ].join("  "),
  );
}

await main();
