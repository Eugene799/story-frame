import { describe, expect, it } from "vitest";
import {
  createLipsyncService,
  isLipsyncOutputHost,
  type LipsyncExportRow,
  type LipsyncLimits,
  type LipsyncStore,
} from "../server/lipsync";
import type { MediaLimits, MediaStore } from "../server/media";
import type { R2Client } from "../server/r2";
import type { MediaRecord } from "../shared/media-contract";

/**
 * Lip sync service, offline: an in-memory store, a fake bucket, and a fake
 * Everypixel. No provider call and no paid second anywhere in this file.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const AUDIO = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-11-26T12:00:00.000Z");

const MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
]);

const LIMITS: LipsyncLimits = {
  timeoutMs: 5_000,
  pollIntervalMs: 0,
  sweepIntervalMs: 0,
  abandonAfterMs: 60 * 60 * 1000,
  downloadTimeoutMs: 5_000,
  maxInputBytes: 25 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  redirectLimit: 3,
  outputHosts: [],
  dailySecondsLimit: 600,
  dailyUsdLimit: 5,
  spendWindowMs: 24 * 60 * 60 * 1000,
};

function mediaRecord(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    id: SOURCE,
    kind: "video",
    status: "ready",
    sceneKey: null,
    contentType: "video/mp4",
    byteSize: 1024,
    uploadExpiresAt: null,
    readyAt: new Date(NOW).toISOString(),
    deletedAt: null,
    createdAt: new Date(NOW).toISOString(),
    referenceCount: 0,
    provenance: null,
    ...overrides,
  };
}

function row(overrides: Partial<LipsyncExportRow> = {}): LipsyncExportRow {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    ownerId: OWNER,
    projectId: PROJECT,
    status: "pending",
    providerStatus: "PENDING",
    providerTaskId: "task-1",
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
    createdAt: new Date(NOW - 5_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function memoryStore(seed: LipsyncExportRow[] = []) {
  const rows = [...seed];
  const settled: Array<{ exportId: string; status: string; seconds: number }> = [];
  const reservations: number[] = [];
  let allow = true;

  const store: LipsyncStore = {
    async findByKey() {
      return null;
    },
    async findLive(projectId) {
      return rows.find((entry) => entry.projectId === projectId && entry.status === "pending") ?? null;
    },
    async create(ownerId, projectId, write) {
      const created = row({
        ...write,
        id: write.id,
        ownerId,
        projectId,
        status: "pending",
        providerTaskId: null,
        providerStatus: null,
      });
      rows.unshift(created);
      return created;
    },
    async get(_ownerId, _projectId, exportId) {
      const found = rows.find((entry) => entry.id === exportId);
      if (!found) throw new Error("missing row");
      return found;
    },
    async list(_ownerId, projectId) {
      return rows.filter((entry) => entry.projectId === projectId);
    },
    async update(_ownerId, exportId, patch) {
      const found = rows.find((entry) => entry.id === exportId);
      if (found) Object.assign(found, patch);
    },
    async live() {
      return rows.filter((entry) => entry.status === "pending");
    },
    async remove(_ownerId, exportId) {
      const index = rows.findIndex((entry) => entry.id === exportId);
      if (index >= 0) rows.splice(index, 1);
    },
    async reserve(_ownerId, _projectId, _exportId, seconds) {
      reservations.push(seconds);
      return { allowed: allow, secondsUsed: seconds, oldestAt: new Date(NOW).toISOString() };
    },
    async settleUsage(_ownerId, exportId, write) {
      settled.push({ exportId, status: write.status, seconds: write.secondsCounted });
    },
    async usageSince() {
      return { secondsUsed: 20, usdUsed: 0.15, oldestAt: new Date(NOW).toISOString() };
    },
  };

  return {
    store,
    rows,
    settled,
    reservations,
    deny: () => {
      allow = false;
    },
    seed: (entry: LipsyncExportRow) => rows.unshift(entry),
  };
}

function fakeMedia(objects: Map<string, Buffer>) {
  const created: Array<{ id: string; kind: string }> = [];
  const deleted: string[] = [];
  const media: MediaStore = {
    async createPending(_ownerId: string, _projectId: string, write: { id: string; kind: MediaRecord["kind"]; objectKey: string }) {
      created.push({ id: write.id, kind: write.kind });
      objects.set(write.objectKey, Buffer.alloc(0));
      return mediaRecord({ id: write.id, kind: write.kind, status: "pending" });
    },
    async get(_ownerId: string, _projectId: string, mediaId: string) {
      if (mediaId === SOURCE) return { media: mediaRecord(), objectKey: "media/source.mp4" };
      if (mediaId === AUDIO) {
        return { media: mediaRecord({ id: AUDIO, kind: "audio", contentType: "audio/mpeg" }), objectKey: "media/audio.mp3" };
      }
      const output = created.find((entry) => entry.id === mediaId);
      if (output) {
        return {
          media: mediaRecord({ id: mediaId, kind: "video", contentType: "video/mp4", byteSize: MP4.length }),
          objectKey: `media/${mediaId}`,
        };
      }
      return null;
    },
    async markReady(_ownerId: string, _projectId: string, mediaId: string) {
      return created.some((entry) => entry.id === mediaId);
    },
    async markDeleted(_ownerId: string, _projectId: string, mediaId: string) {
      deleted.push(mediaId);
      return true;
    },
    async usedBytes() {
      return 0;
    },
  } as unknown as MediaStore;
  return { media, created, deleted };
}

function fakeObjects(objects: Map<string, Buffer>) {
  const r2: R2Client = {
    presignPut: (key: string) => ({ url: `https://r2.test/put/${key}`, expiresAt: new Date(NOW + 900_000).toISOString() }),
    presignGet: (key: string) => ({ url: `https://r2.test/get/${key}`, expiresAt: new Date(NOW + 300_000).toISOString() }),
    head: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { byteSize: bytes.length, contentType: "video/mp4", etag: "etag", lastModified: null } : null;
    },
    get: async (key: string) => (key === "media/source.mp4" ? MP4 : key === "media/audio.mp3" ? Buffer.from([1, 2, 3]) : (objects.get(key) ?? null)),
    delete: async (key: string) => objects.delete(key),
  } as unknown as R2Client;
  return r2;
}

const MEDIA_LIMITS = {
  uploadUrlSeconds: 900,
  downloadUrlSeconds: 300,
  uploadTtlMs: 900_000,
  ownerStorageBytes: 1024 * 1024 * 1024,
  listLimit: 50,
} as unknown as MediaLimits;

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

function fakeFetch(options: { status?: string; result?: string; omitResult?: boolean; objects?: Map<string, Buffer> } = {}) {
  const calls: FetchCall[] = [];
  const providerStatus = options.status ?? "SUCCESS";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });


    if (url.includes("api.everypixel.com/v1/video_lipsync") || url.includes("api.everypixel.com/v1/image_lipsync")) {
      return new Response(JSON.stringify({ task_id: "task-1", status: "PENDING" }), { status: 200 });
    }
    if (url.includes("api.everypixel.com/v1/status")) {
      return new Response(
        JSON.stringify({
          task_id: "task-1",
          status: providerStatus,
          ...(options.omitResult
            ? {}
            : { result: options.result ?? "https://cdn.everypixel.com/out/final.mp4?sig=1" }),
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://cdn.everypixel.com/") || url.startsWith("https://evil.test/")) {
      return new Response(new Uint8Array(MP4), { status: 200 });
    }
    if (url.startsWith("https://r2.test/put/")) {
      // Stand in for the bucket: the uploaded body is what `head` will report.
      const key = url.replace("https://r2.test/put/", "");
      const body = init?.body;
      if (options.objects && body instanceof Uint8Array) options.objects.set(key, Buffer.from(body));
      return new Response("", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function service(options: {
  store: LipsyncStore;
  mediaStore: MediaStore;
  objects: R2Client;
  fetchImpl: typeof fetch;
  configured?: boolean;
}) {
  return createLipsyncService({
    store: options.store,
    media: options.mediaStore,
    objects: options.objects,
    settings: options.configured === false ? { clientId: null, clientSecret: null } : { clientId: "id", clientSecret: "secret" },
    limits: LIMITS,
    mediaLimits: MEDIA_LIMITS,
    fetchImpl: options.fetchImpl,
    now: () => NOW,
    logger: { error: () => undefined },
  });
}

describe("lipsync output host guard", () => {
  it("accepts Everypixel hosts only, plus explicit extra hosts", () => {
    expect(isLipsyncOutputHost("everypixel.com", [])).toBe(true);
    expect(isLipsyncOutputHost("cdn.everypixel.com", [])).toBe(true);
    expect(isLipsyncOutputHost("CDN.Everypixel.com", [])).toBe(true);
    expect(isLipsyncOutputHost("evil.test", [])).toBe(false);
    expect(isLipsyncOutputHost("everypixel.com.evil.test", [])).toBe(false);
    expect(isLipsyncOutputHost("s3.example.test", ["s3.example.test"])).toBe(true);
  });
});

describe("lipsync submit", () => {
  it("refuses without provider credentials", async () => {
    const store = memoryStore();
    const { fetchImpl } = fakeFetch();
    const objects = new Map<string, Buffer>();
    await expect(
      service({ store: store.store, mediaStore: fakeMedia(objects).media, objects: fakeObjects(objects), fetchImpl, configured: false }).submit(
        OWNER,
        PROJECT,
        { sourceMediaId: SOURCE, audioMediaId: AUDIO, resolution: "720p" },
        "key-1",
      ),
    ).rejects.toMatchObject({ status: 503, code: "LIPSYNC_PROVIDER_DISABLED" });
  });

  it("reserves the provider ceiling, then submits both files inline", async () => {
    const store = memoryStore();
    const objects = new Map<string, Buffer>();
    const media = fakeMedia(objects);
    const { fetchImpl, calls } = fakeFetch();
    const result = await service({ store: store.store, mediaStore: media.media, objects: fakeObjects(objects), fetchImpl }).submit(
      OWNER,
      PROJECT,
      { sourceMediaId: SOURCE, audioMediaId: AUDIO, resolution: "480p" },
      "key-1",
    );

    expect(store.reservations).toEqual([20]);
    expect(result.record).toMatchObject({ status: "pending", resolution: "480p", providerStatus: "PENDING" });
    expect(result.record.secondsEstimate).toBe(20);

    const submitted = calls.find((call) => call.url.includes("video_lipsync"));
    const body = JSON.parse(submitted?.body ?? "{}") as Record<string, string>;
    expect(body.audio_url).toBe(`data:audio/mpeg;base64,${Buffer.from([1, 2, 3]).toString("base64")}`);
    expect(body.video_url).toBe(`data:video/mp4;base64,${MP4.toString("base64")}`);
    expect(body.resolution).toBe("480p");
  });

  it("refuses when the seconds window is exhausted and settles nothing", async () => {
    const store = memoryStore();
    store.deny();
    const objects = new Map<string, Buffer>();
    const { fetchImpl, calls } = fakeFetch();

    await expect(
      service({ store: store.store, mediaStore: fakeMedia(objects).media, objects: fakeObjects(objects), fetchImpl }).submit(
        OWNER,
        PROJECT,
        { sourceMediaId: SOURCE, audioMediaId: AUDIO, resolution: "720p" },
        "key-1",
      ),
    ).rejects.toMatchObject({ status: 429, code: "LIPSYNC_DAILY_LIMIT" });

    expect(store.rows[0]?.status).toBe("failed");
    expect(store.rows[0]?.failureCode).toBe("LIPSYNC_DAILY_LIMIT");
    expect(calls.some((call) => call.url.includes("everypixel"))).toBe(false);
  });

  it("refuses an asset of the wrong kind", async () => {
    const store = memoryStore();
    const objects = new Map<string, Buffer>();
    const { fetchImpl } = fakeFetch();

    await expect(
      service({ store: store.store, mediaStore: fakeMedia(objects).media, objects: fakeObjects(objects), fetchImpl }).submit(
        OWNER,
        PROJECT,
        { sourceMediaId: AUDIO, audioMediaId: AUDIO, resolution: "720p" },
        "key-1",
      ),
    ).rejects.toMatchObject({ code: "LIPSYNC_MEDIA_NOT_READY" });
    expect(store.reservations).toEqual([]);
  });
});

describe("lipsync sweep", () => {
  it("copies a finished video from an allowlisted host and settles the seconds", async () => {
    const store = memoryStore([row()]);
    const objects = new Map<string, Buffer>();
    const media = fakeMedia(objects);
    const { fetchImpl } = fakeFetch({ objects });
    await service({ store: store.store, mediaStore: media.media, objects: fakeObjects(objects), fetchImpl }).sweep();

    const updated = store.rows[0];
    expect(updated.status).toBe("ready");
    expect(updated.outputMediaId).toBeTruthy();
    expect(updated.byteSize).toBe(MP4.length);
    expect(store.settled.at(-1)).toMatchObject({ status: "succeeded", seconds: 20 });
    expect(media.created).toHaveLength(1);
  });

  it("refuses a result on a host outside the allowlist", async () => {
    const store = memoryStore([row()]);
    const objects = new Map<string, Buffer>();
    const media = fakeMedia(objects);
    const { fetchImpl, calls } = fakeFetch({ result: "https://evil.test/final.mp4" });
    await service({ store: store.store, mediaStore: media.media, objects: fakeObjects(objects), fetchImpl }).sweep();

    expect(store.rows[0]).toMatchObject({ status: "failed", failureCode: "LIPSYNC_OUTPUT_HOST" });
    expect(calls.some((call) => call.url.startsWith("https://evil.test"))).toBe(false);
    expect(store.settled.at(-1)).toMatchObject({ status: "failed", seconds: 0 });
  });

  it("records a provider failure without counting any seconds", async () => {
    const store = memoryStore([row()]);
    const objects = new Map<string, Buffer>();
    const { fetchImpl } = fakeFetch({ status: "FAILURE" });
    await service({ store: store.store, mediaStore: fakeMedia(objects).media, objects: fakeObjects(objects), fetchImpl }).sweep();

    expect(store.rows[0]).toMatchObject({ status: "failed", failureCode: "LIPSYNC_PROVIDER_FAILED" });
    expect(store.settled.at(-1)).toMatchObject({ status: "failed", seconds: 0 });
  });

  it("fails a task that reports success without an output", async () => {
    const store = memoryStore([row()]);
    const objects = new Map<string, Buffer>();
    const { fetchImpl } = fakeFetch({ omitResult: true });
    await service({ store: store.store, mediaStore: fakeMedia(objects).media, objects: fakeObjects(objects), fetchImpl }).sweep();

    expect(store.rows[0]).toMatchObject({ status: "failed", failureCode: "LIPSYNC_OUTPUT_INVALID" });
  });
});
