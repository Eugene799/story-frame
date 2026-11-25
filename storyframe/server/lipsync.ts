import { ApiError } from "./api-error";
import { detectMediaType, mediaObjectKey, newMediaId, type MediaLimits, type MediaStore } from "./media";
import { readMp4DurationSeconds } from "./mp4";
import { R2Error, type R2Client } from "./r2";
import {
  EverypixelError,
  everypixelConfigured,
  pollLipsync,
  submitLipsync,
  type EverypixelSettings,
  type LipsyncMedia,
} from "./everypixel";
import {
  LIPSYNC_ESTIMATE_USD_PER_SECOND,
  LIPSYNC_MAX_SOURCE_SECONDS,
  LIPSYNC_PROVIDER,
  LIPSYNC_RATE_VERSION,
  lipsyncEstimateUsd,
  type LipsyncExportInput,
  type LipsyncExportRecord,
  type LipsyncFailureCode,
  type LipsyncResolution,
  type LipsyncUsageSummary,
} from "../shared/lipsync-contract";
import type { MediaRecord } from "../shared/media-contract";

/**
 * Lip sync store and service.
 *
 * The service owns every paid step: it reserves seconds before the submit, only
 * ever reads a provider status from the sweep, and copies a finished MP4 into
 * private storage after checking the output host against an allowlist. A client
 * never sees the provider's URL, and no GET triggers a provider call.
 */

// ---------------------------------------------------------------------------
// Host guard
// ---------------------------------------------------------------------------

/** Everypixel serves results from its own domain; subdomains are covered. */
export const LIPSYNC_OUTPUT_HOST_SUFFIX = ".everypixel.com";
export const LIPSYNC_OUTPUT_ROOT_HOST = "everypixel.com";
/** Redirect hops we follow while each one is re-checked. */
export const LIPSYNC_REDIRECT_LIMIT = 3;

/**
 * True when a host may serve a lip sync result. Anything else is refused before
 * a byte is downloaded, so a compromised or mistaken response cannot make the
 * server fetch an arbitrary address.
 */
export function isLipsyncOutputHost(host: string, extraHosts: readonly string[]): boolean {
  const normalised = host.trim().toLowerCase().replace(/\.$/, "");
  if (normalised === LIPSYNC_OUTPUT_ROOT_HOST || normalised.endsWith(LIPSYNC_OUTPUT_HOST_SUFFIX)) return true;
  return extraHosts.some((entry) => entry.trim().toLowerCase() === normalised);
}

// ---------------------------------------------------------------------------
// Limits and rows
// ---------------------------------------------------------------------------

export interface LipsyncLimits {
  timeoutMs: number;
  sweepIntervalMs: number;
  pollIntervalMs: number;
  abandonAfterMs: number;
  downloadTimeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  redirectLimit: number;
  outputHosts: readonly string[];
  dailySecondsLimit: number;
  dailyUsdLimit: number;
  spendWindowMs: number;
}

export interface LipsyncExportRow {
  id: string;
  ownerId: string;
  projectId: string;
  status: LiquSyncStatusValue;
  providerStatus: string | null;
  providerTaskId: string | null;
  sourceMediaId: string | null;
  audioMediaId: string | null;
  outputMediaId: string | null;
  resolution: LipsyncResolution;
  secondsEstimate: number;
  secondsCounted: number | null;
  usdEstimate: number;
  byteSize: number | null;
  failureCode: LipsyncFailureCode | null;
  failureMessage: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type LiquSyncStatusValue = "pending" | "ready" | "failed";

export interface LipsyncExportWrite {
  id: string;
  sourceMediaId: string;
  audioMediaId: string;
  resolution: LipsyncResolution;
  secondsEstimate: number;
  usdEstimate: number;
  idempotencyKey: string | null;
}

export interface LipsyncExportUpdate {
  status?: LiquSyncStatusValue;
  providerStatus?: string | null;
  providerTaskId?: string | null;
  outputMediaId?: string | null;
  secondsCounted?: number | null;
  byteSize?: number | null;
  failureCode?: LipsyncFailureCode | null;
  failureMessage?: string | null;
  lastPolledAt?: string | null;
}

export interface LipsyncUsageReservation {
  allowed: boolean;
  secondsUsed: number;
  oldestAt: string | null;
}

export interface LipsyncUsageTotals {
  secondsUsed: number;
  usdUsed: number;
  oldestAt: string | null;
}

export interface LipsyncStore {
  findByKey(ownerId: string, key: string): Promise<LipsyncExportRow | null>;
  findLive(projectId: string): Promise<LipsyncExportRow | null>;
  create(ownerId: string, projectId: string, write: LipsyncExportWrite): Promise<LipsyncExportRow>;
  get(ownerId: string, projectId: string, exportId: string): Promise<LipsyncExportRow>;
  list(ownerId: string, projectId: string, limit: number): Promise<LipsyncExportRow[]>;
  update(ownerId: string, exportId: string, patch: LipsyncExportUpdate): Promise<void>;
  /** Pending rows across accounts, oldest first, for the sweep. */
  live(limit: number): Promise<LipsyncExportRow[]>;
  remove(ownerId: string, exportId: string): Promise<void>;
  reserve(
    ownerId: string,
    projectId: string,
    exportId: string,
    seconds: number,
    usd: number,
    limits: { secondLimit: number; windowSeconds: number },
  ): Promise<LipsyncUsageReservation>;
  settleUsage(
    ownerId: string,
    exportId: string,
    write: { status: "succeeded" | "failed"; secondsCounted: number },
  ): Promise<void>;
  usageSince(ownerId: string, sinceIso: string): Promise<LipsyncUsageTotals>;
}

// ---------------------------------------------------------------------------
// Supabase store
// ---------------------------------------------------------------------------

interface SupabaseStoreOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toRow(raw: Record<string, unknown>): LipsyncExportRow {
  return {
    id: String(raw.id),
    ownerId: String(raw.owner_id),
    projectId: String(raw.project_id),
    status: (raw.status as LiquSyncStatusValue) ?? "pending",
    providerStatus: text(raw.provider_status),
    providerTaskId: text(raw.provider_task_id),
    sourceMediaId: text(raw.source_media_id),
    audioMediaId: text(raw.audio_media_id),
    outputMediaId: text(raw.output_media_id),
    resolution: (raw.resolution as LipsyncResolution) ?? "720p",
    secondsEstimate: num(raw.seconds_estimate) ?? 0,
    secondsCounted: num(raw.seconds_counted),
    usdEstimate: num(raw.usd_estimate) ?? 0,
    byteSize: num(raw.byte_size),
    failureCode: (raw.failure_code as LipsyncFailureCode | null) ?? null,
    failureMessage: text(raw.failure_message),
    lastPolledAt: text(raw.last_polled_at),
    createdAt: String(raw.created_at),
    updatedAt: String(raw.updated_at),
  };
}

export function createSupabaseLipsyncStore(options: SupabaseStoreOptions): LipsyncStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const headers = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  async function call(target: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${base}/${target}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      await response.text().catch(() => undefined);
      throw new ApiError(503, "LIPSYNC_STORE_UNAVAILABLE", "The lip sync store is temporarily unavailable.");
    }
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }

  async function one(target: string, init: RequestInit = { method: "GET" }): Promise<LipsyncExportRow | null> {
    const rows = (await call(target, init)) as Record<string, unknown>[] | null;
    const first = Array.isArray(rows) ? rows[0] : null;
    return first ? toRow(first) : null;
  }

  const columns =
    "id,owner_id,project_id,status,provider_status,provider_task_id,source_media_id,audio_media_id,output_media_id,resolution,seconds_estimate,seconds_counted,usd_estimate,byte_size,failure_code,failure_message,last_polled_at,created_at,updated_at";

  return {
    async findByKey(ownerId, key) {
      return one(
        `lipsync_exports?owner_id=eq.${ownerId}&idempotency_key=eq.${encodeURIComponent(key)}&select=${columns}&limit=1`,
      );
    },
    async findLive(projectId) {
      return one(
        `lipsync_exports?project_id=eq.${projectId}&status=eq.pending&select=${columns}&order=created_at.desc&limit=1`,
      );
    },
    async create(ownerId, projectId, write) {
      const row = await one("lipsync_exports?select=" + columns, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          id: write.id,
          owner_id: ownerId,
          project_id: projectId,
          status: "pending",
          source_media_id: write.sourceMediaId,
          audio_media_id: write.audioMediaId,
          resolution: write.resolution,
          seconds_estimate: write.secondsEstimate,
          usd_estimate: write.usdEstimate,
          idempotency_key: write.idempotencyKey,
        }),
      });
      if (!row) throw new ApiError(503, "LIPSYNC_STORE_UNAVAILABLE", "The lip sync row could not be written.");
      return row;
    },
    async get(ownerId, projectId, exportId) {
      const row = await one(
        `lipsync_exports?id=eq.${exportId}&project_id=eq.${projectId}&owner_id=eq.${ownerId}&select=${columns}&limit=1`,
      );
      if (!row) throw new ApiError(404, "LIPSYNC_NOT_FOUND", "No lip sync export with that id belongs to this project.");
      return row;
    },
    async list(ownerId, projectId, limit) {
      const rows = (await call(
        `lipsync_exports?project_id=eq.${projectId}&owner_id=eq.${ownerId}&select=${columns}&order=created_at.desc&limit=${limit}`,
        { method: "GET" },
      )) as Record<string, unknown>[] | null;
      return (rows ?? []).map(toRow);
    },
    async update(ownerId, exportId, patch) {
      const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.status !== undefined) body.status = patch.status;
      if (patch.providerStatus !== undefined) body.provider_status = patch.providerStatus;
      if (patch.providerTaskId !== undefined) body.provider_task_id = patch.providerTaskId;
      if (patch.outputMediaId !== undefined) body.output_media_id = patch.outputMediaId;
      if (patch.secondsCounted !== undefined) body.seconds_counted = patch.secondsCounted;
      if (patch.byteSize !== undefined) body.byte_size = patch.byteSize;
      if (patch.failureCode !== undefined) body.failure_code = patch.failureCode;
      if (patch.failureMessage !== undefined) body.failure_message = patch.failureMessage;
      if (patch.lastPolledAt !== undefined) body.last_polled_at = patch.lastPolledAt;
      await call(`lipsync_exports?id=eq.${exportId}&owner_id=eq.${ownerId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
    async live(limit) {
      const rows = (await call(
        `lipsync_exports?status=eq.pending&select=${columns}&order=created_at.asc&limit=${limit}`,
        { method: "GET" },
      )) as Record<string, unknown>[] | null;
      return (rows ?? []).map(toRow);
    },
    async remove(ownerId, exportId) {
      await call(`lipsync_exports?id=eq.${exportId}&owner_id=eq.${ownerId}`, { method: "DELETE" });
    },
    async reserve(ownerId, projectId, exportId, seconds, usd, limits) {
      const result = (await call("rpc/reserve_lipsync_usage", {
        method: "POST",
        body: JSON.stringify({
          p_owner_id: ownerId,
          p_project_id: projectId,
          p_export_id: exportId,
          p_seconds_estimate: seconds,
          p_usd_estimate: usd,
          p_rate_version: LIPSYNC_RATE_VERSION,
          p_second_limit: limits.secondLimit,
          p_window_seconds: limits.windowSeconds,
        }),
      })) as Record<string, unknown>[] | null;
      const row = Array.isArray(result) ? result[0] : null;
      return {
        allowed: row?.allowed === true,
        secondsUsed: num(row?.seconds_used) ?? 0,
        oldestAt: text(row?.oldest_at),
      };
    },
    async settleUsage(ownerId, exportId, write) {
      await call(`lipsync_usage?export_id=eq.${exportId}&owner_id=eq.${ownerId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: write.status,
          seconds_counted: write.secondsCounted,
          updated_at: new Date().toISOString(),
        }),
      });
    },
    async usageSince(ownerId, sinceIso) {
      const rows = (await call(
        `lipsync_usage?owner_id=eq.${ownerId}&created_at=gte.${encodeURIComponent(sinceIso)}&select=seconds_counted,usd_estimate,created_at`,
        { method: "GET" },
      )) as Record<string, unknown>[] | null;
      let secondsUsed = 0;
      let usdUsed = 0;
      let oldestAt: string | null = null;
      for (const row of rows ?? []) {
        secondsUsed += num(row.seconds_counted) ?? 0;
        usdUsed += num(row.usd_estimate) ?? 0;
        if (oldestAt === null) oldestAt = text(row.created_at);
      }
      return {
        secondsUsed: Number(secondsUsed.toFixed(3)),
        usdUsed: Number(usdUsed.toFixed(4)),
        oldestAt,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface LipsyncDeps {
  store: LipsyncStore;
  media: MediaStore;
  objects: R2Client;
  settings: EverypixelSettings;
  limits: LipsyncLimits;
  mediaLimits: MediaLimits;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: { error(message: string): void };
}

export interface LipsyncDetail {
  record: LipsyncExportRecord;
  media: MediaRecord | null;
  usage: LipsyncUsageSummary;
}

export interface LipsyncPlayback {
  url: string;
  expiresAt: string;
  contentType: string;
  byteSize: number;
}

export interface LipsyncService {
  submit(ownerId: string, projectId: string, input: LipsyncExportInput, idempotencyKey: string): Promise<LipsyncDetail>;
  list(ownerId: string, projectId: string): Promise<{ exports: LipsyncExportRecord[]; usage: LipsyncUsageSummary }>;
  get(ownerId: string, projectId: string, exportId: string): Promise<LipsyncDetail>;
  playback(ownerId: string, projectId: string, exportId: string): Promise<LipsyncPlayback>;
  remove(ownerId: string, projectId: string, exportId: string): Promise<void>;
  sweep(): Promise<void>;
}

export function toRecord(row: LipsyncExportRow): LipsyncExportRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    provider: LIPSYNC_PROVIDER,
    providerStatus: row.providerStatus,
    sourceMediaId: row.sourceMediaId,
    audioMediaId: row.audioMediaId,
    outputMediaId: row.outputMediaId,
    resolution: row.resolution,
    secondsEstimate: row.secondsEstimate,
    secondsCounted: row.secondsCounted,
    usdEstimate: row.usdEstimate,
    byteSize: row.byteSize,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SWEEP_BATCH = 5;

/** How long a pending row may exist before a missing task id is a real fault. */
export const LIPSYNC_TASK_ID_GRACE_MS = 5 * 60 * 1000;

export function createLipsyncService(deps: LipsyncDeps): LipsyncService {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.logger ?? console;
  const limits = deps.limits;

  // One paid submission per account at a time, so two tabs cannot both submit.
  const submitting = new Set<string>();
  let sweeping: Promise<void> | null = null;

  async function usageSummary(ownerId: string): Promise<LipsyncUsageSummary> {
    const since = new Date(now() - limits.spendWindowMs).toISOString();
    const totals = await deps.store.usageSince(ownerId, since);
    return {
      windowHours: limits.spendWindowMs / (60 * 60 * 1000),
      secondsUsed: totals.secondsUsed,
      secondsLimit: limits.dailySecondsLimit > 0 ? limits.dailySecondsLimit : null,
      usdUsed: totals.usdUsed,
      usdLimit: limits.dailyUsdLimit > 0 ? limits.dailyUsdLimit : null,
      resetAt: totals.oldestAt === null ? null : new Date(Date.parse(totals.oldestAt) + limits.spendWindowMs).toISOString(),
    };
  }

  async function fail(row: LipsyncExportRow, code: LipsyncFailureCode, message: string, counted: number): Promise<void> {
    await deps.store.update(row.ownerId, row.id, {
      status: "failed",
      failureCode: code,
      failureMessage: message,
      secondsCounted: counted,
    });
    await deps.store.settleUsage(row.ownerId, row.id, {
      status: counted > 0 ? "succeeded" : "failed",
      secondsCounted: counted,
    });
  }

  /** Reads one media row and insists it is a ready asset of the expected kinds. */
  async function requireMedia(
    ownerId: string,
    projectId: string,
    mediaId: string,
    kinds: readonly ("video" | "image" | "audio")[],
  ): Promise<{ media: MediaRecord; objectKey: string }> {
    const stored = await deps.media.get(ownerId, projectId, mediaId);
    if (!stored || stored.media.status !== "ready") {
      throw new ApiError(409, "LIPSYNC_MEDIA_NOT_READY", "Lip sync needs ready media files from this project.");
    }
    if (!kinds.includes(stored.media.kind)) {
      throw new ApiError(
        409,
        "LIPSYNC_MEDIA_NOT_READY",
        `That asset is ${stored.media.kind}; lip sync needs ${kinds.join(" or ")}.`,
      );
    }
    if (stored.media.byteSize > limits.maxInputBytes) {
      throw new ApiError(
        422,
        "LIPSYNC_INPUT_TOO_LARGE",
        `Lip sync inlines its inputs, so one file may be at most ${Math.floor(limits.maxInputBytes / (1024 * 1024))} MB.`,
      );
    }
    return { media: stored.media, objectKey: stored.objectKey };
  }

  async function readMedia(stored: { media: MediaRecord; objectKey: string }): Promise<LipsyncMedia> {
    const bytes = await deps.objects.get(stored.objectKey).catch((error: unknown) => {
      if (error instanceof R2Error) {
        throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "The private media bucket is temporarily unavailable.");
      }
      throw error;
    });
    if (bytes === null) {
      throw new ApiError(409, "LIPSYNC_MEDIA_NOT_READY", "A media file needed by this lip sync is missing.");
    }
    return { bytes, contentType: stored.media.contentType };
  }

  /**
   * Downloads the provider's output, re-checking the host on every redirect hop
   * and refusing anything bigger than the configured cap.
   */
  async function downloadOutput(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    let target = url;
    for (let hop = 0; hop <= limits.redirectLimit; hop += 1) {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        throw new ApiError(502, "LIPSYNC_OUTPUT_INVALID", "Everypixel reported an output that is not a URL.");
      }
      if (parsed.protocol !== "https:") {
        throw new ApiError(502, "LIPSYNC_OUTPUT_INVALID", "Everypixel reported a non-https output.");
      }
      if (!isLipsyncOutputHost(parsed.host, limits.outputHosts)) {
        throw new ApiError(
          502,
          "LIPSYNC_OUTPUT_HOST",
          `Refusing to download a lip sync from ${parsed.host}: it is not an allowlisted Everypixel output host.`,
        );
      }

      const response = await fetchImpl(parsed, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(limits.downloadTimeoutMs),
      }).catch(() => {
        throw new ApiError(502, "LIPSYNC_OUTPUT_COPY_FAILED", "The finished lip sync could not be downloaded.");
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.arrayBuffer().catch(() => undefined);
        if (!location) {
          throw new ApiError(502, "LIPSYNC_OUTPUT_INVALID", "Everypixel redirected the output without a target.");
        }
        target = new URL(location, parsed).toString();
        continue;
      }
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        throw new ApiError(502, "LIPSYNC_OUTPUT_COPY_FAILED", `The finished lip sync could not be downloaded (HTTP ${response.status}).`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) {
        throw new ApiError(502, "LIPSYNC_OUTPUT_INVALID", "Everypixel returned an empty file.");
      }
      if (bytes.length > limits.maxOutputBytes) {
        throw new ApiError(502, "LIPSYNC_OUTPUT_TOO_LARGE", "The finished lip sync is larger than this server accepts.");
      }
      const detected = detectMediaType(bytes);
      if (!detected || detected.kind !== "video") {
        throw new ApiError(502, "LIPSYNC_OUTPUT_INVALID", "Everypixel's output was not recognized as video.");
      }
      return { bytes, contentType: detected.contentType };
    }
    throw new ApiError(502, "LIPSYNC_OUTPUT_INVALID", "Everypixel redirected the output too many times.");
  }

  /** Copies the finished MP4 into private storage under a new media row. */
  async function storeOutput(
    ownerId: string,
    projectId: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<{ mediaId: string; objectKey: string; byteSize: number }> {
    const used = await deps.media.usedBytes(ownerId);
    if (used + bytes.length > deps.mediaLimits.ownerStorageBytes) {
      throw new ApiError(413, "LIPSYNC_STORAGE_LIMIT", "This account's media storage limit leaves no room for the lip sync.");
    }

    const mediaId = newMediaId();
    const objectKey = mediaObjectKey(ownerId, mediaId);
    const upload = deps.objects.presignPut(objectKey, deps.mediaLimits.uploadUrlSeconds);
    const uploadExpiresAt = new Date(
      now() + Math.min(deps.mediaLimits.uploadTtlMs, deps.mediaLimits.uploadUrlSeconds * 1000),
    ).toISOString();

    await deps.media.createPending(ownerId, projectId, {
      id: mediaId,
      kind: "video",
      contentType,
      byteSize: bytes.length,
      sceneKey: null,
      objectKey,
      uploadExpiresAt,
    });

    try {
      const put = await fetchImpl(upload.url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(limits.downloadTimeoutMs),
      });
      if (!put.ok) {
        throw new ApiError(502, "LIPSYNC_OUTPUT_COPY_FAILED", "Private storage rejected the finished lip sync.");
      }
      const head = await deps.objects.head(objectKey);
      if (head === null) {
        throw new ApiError(502, "LIPSYNC_OUTPUT_COPY_FAILED", "The finished lip sync was not found in the bucket.");
      }
      const ready = await deps.media.markReady(ownerId, projectId, mediaId, {
        contentType,
        byteSize: head.byteSize,
      });
      if (!ready) {
        throw new ApiError(409, "LIPSYNC_OUTPUT_COPY_FAILED", "The stored lip sync changed while it was saved.");
      }
      return { mediaId, objectKey, byteSize: head.byteSize };
    } catch (error) {
      await deps.media.markDeleted(ownerId, projectId, mediaId).catch(() => false);
      await deps.objects.delete(objectKey).catch(() => false);
      throw error;
    }
  }

  async function advance(row: LipsyncExportRow): Promise<void> {
    if (!row.providerTaskId) {
      // The row is written before the provider call, so the sweep can see it
      // mid-submit with no task id yet. Failing it here would kill a request the
      // provider has already been paid for; only a row older than the submit
      // window is genuinely lost.
      if (now() - Date.parse(row.createdAt) < LIPSYNC_TASK_ID_GRACE_MS) return;
      // The submit may have been accepted before the task id was stored, so this
      // cannot be followed but may still be billed: the ceiling stands rather
      // than reporting a request the provider ran as free.
      await fail(
        row,
        "LIPSYNC_PROVIDER_FAILED",
        "The provider task id was lost, so this lip sync cannot be followed.",
        row.secondsEstimate,
      );
      return;
    }

    let state;
    try {
      state = await pollLipsync({
        settings: deps.settings,
        taskId: row.providerTaskId,
        fetchImpl,
        timeoutMs: limits.timeoutMs,
      });
    } catch (error) {
      // A success reported without a usable URL will never become usable, so it
      // fails now; every other status error is transient and retried.
      if (error instanceof ApiError && error.code === "LIPSYNC_RESULT_INVALID") {
        // SUCCESS without a usable URL still means the provider ran and billed
        // this request, so the reservation is kept rather than recorded as free.
        await fail(row, "LIPSYNC_OUTPUT_INVALID", error.message, row.secondsEstimate);
        return;
      }
      log.error(`[lipsync] LIPSYNC_POLL_FAILED ${error instanceof Error ? error.name : "unknown"}`);
      return;
    }

    if (state.status === "pending") {
      await deps.store.update(row.ownerId, row.id, {
        providerStatus: state.providerStatus,
        lastPolledAt: new Date(now()).toISOString(),
      });
      return;
    }

    if (state.status === "failed") {
      // The provider reports failure before it bills anything, so nothing is counted.
      await fail(row, "LIPSYNC_PROVIDER_FAILED", state.error ?? "Everypixel could not finish this lip sync.", 0);
      return;
    }

    try {
      const download = await downloadOutput(state.resultUrl ?? "");
      // Bill the seconds the file actually holds, not the ceiling reserved for it.
      const measured = readMp4DurationSeconds(download.bytes);
      if (measured === null) {
        // A fragmented or malformed header: keep the reservation rather than guessing low.
        log.error("[lipsync] LIPSYNC_DURATION_UNMEASURED");
      } else if (measured > row.secondsEstimate) {
        // The request could not have produced more than its own ceiling, so a
        // longer header is broken. Never let it inflate the ledger.
        log.error("[lipsync] LIPSYNC_DURATION_OUT_OF_RANGE");
      }
      const counted = measured === null || measured > row.secondsEstimate ? row.secondsEstimate : measured;
      const stored = await storeOutput(row.ownerId, row.projectId, download.bytes, download.contentType);
      await deps.store.update(row.ownerId, row.id, {
        status: "ready",
        providerStatus: state.providerStatus,
        outputMediaId: stored.mediaId,
        byteSize: stored.byteSize,
        secondsCounted: counted,
        lastPolledAt: new Date(now()).toISOString(),
      });
      await deps.store.settleUsage(row.ownerId, row.id, { status: "succeeded", secondsCounted: counted });
    } catch (error) {
      const code = error instanceof ApiError && error.code.startsWith("LIPSYNC_") ? (error.code as LipsyncFailureCode) : "LIPSYNC_OUTPUT_COPY_FAILED";
      const message = error instanceof ApiError ? error.message : "The finished lip sync could not be stored.";
      // Reached only after the provider reported SUCCESS, so it has billed the
      // request even when we refuse or cannot keep the output.
      await fail(row, code, message, row.secondsEstimate);
    }
  }

  async function submit(
    ownerId: string,
    projectId: string,
    input: LipsyncExportInput,
    idempotencyKey: string,
  ): Promise<LipsyncDetail> {
    const replayed = await deps.store.findByKey(ownerId, idempotencyKey);
    if (replayed) return detailOf(replayed);

    const live = await deps.store.findLive(projectId);
    if (live) {
      throw new ApiError(409, "LIPSYNC_ALREADY_RUNNING", "A lip sync is already running for this project. Wait for it to finish.");
    }

    if (!everypixelConfigured(deps.settings)) {
      throw new ApiError(
        503,
        "LIPSYNC_PROVIDER_DISABLED",
        "Everypixel lip sync is disabled because EVERYPIXEL_CLIENT_ID or EVERYPIXEL_SECRET_ID is not configured.",
      );
    }
    if (submitting.has(ownerId)) {
      throw new ApiError(429, "LIPSYNC_SUBMIT_IN_PROGRESS", "Another lip sync is being submitted for this account.");
    }

    // The guard reserves the provider's ceiling for one request, never a
    // client-declared length, so a short clip cannot slip past the window.
    const secondsEstimate = LIPSYNC_MAX_SOURCE_SECONDS;
    const usdEstimate = lipsyncEstimateUsd(secondsEstimate);

    submitting.add(ownerId);
    try {
      const source = await requireMedia(ownerId, projectId, input.sourceMediaId, ["video", "image"]);
      const audio = await requireMedia(ownerId, projectId, input.audioMediaId, ["audio"]);

      const created = await deps.store.create(ownerId, projectId, {
        id: crypto.randomUUID(),
        sourceMediaId: input.sourceMediaId,
        audioMediaId: input.audioMediaId,
        resolution: input.resolution,
        secondsEstimate,
        usdEstimate,
        idempotencyKey,
      });

      const reservation = await deps.store.reserve(ownerId, projectId, created.id, secondsEstimate, usdEstimate, {
        secondLimit: limits.dailySecondsLimit,
        windowSeconds: Math.round(limits.spendWindowMs / 1000),
      });
      if (!reservation.allowed) {
        await fail(created, "LIPSYNC_DAILY_LIMIT", "This account's rolling lip sync window has no seconds left.", 0);
        throw new ApiError(
          429,
          "LIPSYNC_DAILY_LIMIT",
          `This account may lip sync ${limits.dailySecondsLimit} seconds per ${Math.round(limits.spendWindowMs / 3_600_000)} hours.`,
        );
      }

      const [sourceBytes, audioBytes] = [await readMedia(source), await readMedia(audio)];

      let task;
      try {
        task = await submitLipsync({
          settings: deps.settings,
          audio: audioBytes,
          source: sourceBytes,
          sourceSeconds: secondsEstimate,
          resolution: input.resolution,
          fetchImpl,
          timeoutMs: limits.timeoutMs,
          maxInputBytes: limits.maxInputBytes,
        });
      } catch (error) {
        const retryable = error instanceof EverypixelError ? error.retryable : false;
        // A definitive rejection bills nothing; an ambiguous one keeps its estimate.
        await fail(
          created,
          "LIPSYNC_PROVIDER_FAILED",
          error instanceof Error ? error.message : "Everypixel rejected the lip sync.",
          retryable ? secondsEstimate : 0,
        );
        throw error;
      }

      await deps.store.update(ownerId, created.id, {
        providerTaskId: task.taskId,
        providerStatus: task.providerStatus,
        lastPolledAt: new Date(now()).toISOString(),
      });
      const stored = await deps.store.get(ownerId, projectId, created.id);
      return detailOf(stored);
    } finally {
      submitting.delete(ownerId);
    }

    async function detailOf(row: LipsyncExportRow): Promise<LipsyncDetail> {
      const media = row.outputMediaId
        ? ((await deps.media.get(ownerId, row.projectId, row.outputMediaId))?.media ?? null)
        : null;
      return { record: toRecord(row), media, usage: await usageSummary(ownerId) };
    }
  }

  async function list(
    ownerId: string,
    projectId: string,
  ): Promise<{ exports: LipsyncExportRecord[]; usage: LipsyncUsageSummary }> {
    const rows = await deps.store.list(ownerId, projectId, 20);
    return { exports: rows.map(toRecord), usage: await usageSummary(ownerId) };
  }

  async function get(ownerId: string, projectId: string, exportId: string): Promise<LipsyncDetail> {
    const row = await deps.store.get(ownerId, projectId, exportId);
    const media = row.outputMediaId
      ? ((await deps.media.get(ownerId, projectId, row.outputMediaId))?.media ?? null)
      : null;
    return { record: toRecord(row), media, usage: await usageSummary(ownerId) };
  }

  async function playback(ownerId: string, projectId: string, exportId: string): Promise<LipsyncPlayback> {
    const row = await deps.store.get(ownerId, projectId, exportId);
    if (row.status !== "ready" || !row.outputMediaId) {
      throw new ApiError(409, "LIPSYNC_NOT_READY", "This lip sync has no finished video to play yet.");
    }
    const stored = await deps.media.get(ownerId, projectId, row.outputMediaId);
    if (!stored || stored.media.status !== "ready") {
      throw new ApiError(409, "LIPSYNC_NOT_READY", "The stored lip sync is no longer available.");
    }
    const presigned = deps.objects.presignGet(stored.objectKey, deps.mediaLimits.downloadUrlSeconds);
    return {
      url: presigned.url,
      expiresAt: presigned.expiresAt,
      contentType: stored.media.contentType,
      byteSize: stored.media.byteSize,
    };
  }

  async function remove(ownerId: string, projectId: string, exportId: string): Promise<void> {
    const row = await deps.store.get(ownerId, projectId, exportId);
    if (row.status === "pending") {
      throw new ApiError(409, "LIPSYNC_ALREADY_RUNNING", "A lip sync in progress cannot be cancelled or deleted.");
    }
    if (row.outputMediaId) {
      const stored = await deps.media.get(ownerId, projectId, row.outputMediaId);
      if (stored) {
        await deps.media.markDeleted(ownerId, projectId, row.outputMediaId).catch(() => false);
        await deps.objects.delete(stored.objectKey).catch(() => false);
      }
    }
    await deps.store.remove(ownerId, exportId);
  }

  async function sweep(): Promise<void> {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const rows = await deps.store.live(SWEEP_BATCH);
      for (const row of rows) {
        const lastPolled = row.lastPolledAt ? Date.parse(row.lastPolledAt) : 0;
        const age = now() - Date.parse(row.createdAt);
        if (age > limits.abandonAfterMs) {
          await fail(row, "LIPSYNC_ABANDONED", "This lip sync was abandoned before the provider finished it.", 0);
          continue;
        }
        if (lastPolled !== 0 && now() - lastPolled < limits.pollIntervalMs) continue;
        await advance(row).catch((error: unknown) => {
          log.error(`[lipsync] LIPSYNC_ADVANCE_FAILED ${error instanceof Error ? error.name : "unknown"}`);
        });
      }
    })().finally(() => {
      sweeping = null;
    });
    return sweeping;
  }

  return { submit, list, get, playback, remove, sweep };
}
