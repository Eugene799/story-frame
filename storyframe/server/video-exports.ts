import { randomUUID } from "node:crypto";
import type { MediaRecord } from "../shared/media-contract";
import type { ProjectDocumentV2 } from "../shared/project-contract";
import {
  JSON2VIDEO_RATE_VERSION,
  VIDEO_CREDITS_PER_SECOND,
  VIDEO_PROVIDER,
  type VideoExportRecord,
  type VideoExportStatus,
  type VideoFailureCode,
  type VideoProviderStatus,
  type VideoResolution,
  type VideoUsageSummary,
} from "../shared/video-contract";
import { ApiError } from "./api-error";
import {
  assertNarrationFits,
  assertRenderableDocument,
  buildVideoMovie,
  deleteMovie,
  getMovie,
  Json2VideoError,
  submitMovie,
  type Json2VideoMovieStatus,
  type Json2VideoRequestOptions,
  type Json2VideoSettings,
  type VideoRenderAudio,
  type VideoRenderVisual,
} from "./json2video";
import {
  detectMediaType,
  mediaObjectKey,
  mediaTypeMatches,
  newMediaId,
  type MediaLimits,
  type MediaStore,
} from "./media";
import type { NarrationStore } from "./narration";
import { buildNarrationScript } from "./narration";
import type { ProjectStore } from "./projects";
import type { R2Client } from "./r2";
import { R2Error } from "./r2";

/**
 * Phase 9 slice 1: the export row, its provider job, and the single copy.
 *
 * State lives in Postgres (`render_snapshots` + `provider_jobs`, both marked
 * `kind = 'video-export'`), never in this process, so a restart resumes a paid
 * render instead of orphaning it. The sweep is the only clock: `GET` never
 * calls the provider. A copy happens once; a failed copy is terminal in this
 * slice and keeps the provider URL in the job result for a later retry path.
 */

/** The only host the finished MP4 may be downloaded from. */
export const JSON2VIDEO_OUTPUT_HOST = "assets.json2video.com";

/** Provider statuses kept in `render_snapshots.provider_status`. */
const PROVIDER_STATUSES: readonly VideoProviderStatus[] = [
  "pending",
  "running",
  "done",
  "error",
  "timeout",
];

const FAILURE_CODES: readonly VideoFailureCode[] = [
  "VIDEO_SCRIPT_NOT_APPROVED",
  "VIDEO_NARRATION_STALE",
  "VIDEO_NARRATION_OVERFLOW",
  "VIDEO_MEDIA_NOT_READY",
  "VIDEO_RENDER_TIMEOUT",
  "VIDEO_RENDER_ABANDONED",
  "VIDEO_JOB_NOT_FOUND",
  "VIDEO_PROVIDER_REJECTED",
  "VIDEO_PROVIDER_QUOTA",
  "VIDEO_PROVIDER_UNAVAILABLE",
  "VIDEO_OUTPUT_INVALID",
  "VIDEO_OUTPUT_COPY_FAILED",
];

const EXPORT_NOT_FOUND = "No video export with that id belongs to this project.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function isFailureCode(value: string): value is VideoFailureCode {
  return (FAILURE_CODES as readonly string[]).includes(value);
}

export interface VideoLimits {
  resolution: VideoResolution;
  timeoutMs: number;
  renderTimeoutMs: number;
  abandonAfterMs: number;
  inputUrlSeconds: number;
  downloadTimeoutMs: number;
  maxBytes: number;
  maxSeconds: number;
  timingToleranceSeconds: number;
  dailyCreditsLimit: number;
  spendWindowMs: number;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface VideoExportJobRow {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  externalId: string | null;
  createdAt: string;
  request: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
}

export interface VideoExportRow {
  id: string;
  ownerId: string;
  projectId: string;
  projectRevision: number;
  status: VideoExportStatus;
  providerStatus: VideoProviderStatus | null;
  mediaId: string | null;
  outputKey: string | null;
  failureCode: VideoFailureCode | null;
  failureMessage: string | null;
  durationSeconds: number | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  creditsEstimate: number;
  creditsConsumed: number | null;
  createdAt: string;
  updatedAt: string;
  job: VideoExportJobRow | null;
}

export interface VideoExportWrite {
  id: string;
  projectRevision: number;
  creditsEstimate: number;
  idempotencyKey: string | null;
}

export interface VideoUsageReservation {
  usageId: string | null;
  allowed: boolean;
  creditsUsed: number;
  oldestAt: string | null;
}

/** A pending render row plus the job link the sweep needs. */
export interface VideoExportCursor {
  id: string;
  ownerId: string;
  projectId: string;
  createdAt: string;
  creditsEstimate: number;
  creditsConsumed: number | null;
  projectRevision: number;
  job: VideoExportJobRow | null;
}

/** Fields a completed or failed export may set. */
export interface VideoExportUpdate {
  status?: VideoExportStatus;
  providerStatus?: VideoProviderStatus | null;
  mediaId?: string | null;
  outputKey?: string | null;
  failureCode?: VideoFailureCode | null;
  failureMessage?: string | null;
  durationSeconds?: number | null;
  byteSize?: number | null;
  width?: number | null;
  height?: number | null;
  creditsConsumed?: number | null;
  providerUrlExpiresAt?: string | null;
}

export interface VideoExportStore {
  findByIdempotencyKey(ownerId: string, key: string): Promise<VideoExportRecord | null>;
  findLive(ownerId: string, projectId: string): Promise<VideoExportRecord | null>;
  create(ownerId: string, projectId: string, write: VideoExportWrite): Promise<VideoExportRecord>;
  get(ownerId: string, projectId: string, exportId: string): Promise<VideoExportRecord>;
  list(ownerId: string, projectId: string, limit: number): Promise<VideoExportRecord[]>;
  update(ownerId: string, exportId: string, patch: VideoExportUpdate): Promise<void>;
  /** Pending exports across accounts; the sweep advances them oldest first. */
  live(limit: number): Promise<VideoExportCursor[]>;

  createJob(
    ownerId: string,
    projectId: string,
    write: { externalId: string | null; request: Record<string, unknown> },
  ): Promise<VideoExportJobRow>;
  attachJob(ownerId: string, exportId: string, jobId: string): Promise<void>;
  updateJob(
    ownerId: string,
    jobId: string,
    patch: { status: VideoExportJobRow["status"]; externalId?: string | null; result?: Record<string, unknown> | null },
  ): Promise<void>;

  remove(ownerId: string, projectId: string, exportId: string): Promise<VideoExportJobRow | null>;

  reserve(
    ownerId: string,
    projectId: string,
    exportId: string,
    credits: number,
    limits: { creditLimit: number; windowSeconds: number },
  ): Promise<VideoUsageReservation>;
  settleUsage(
    ownerId: string,
    exportId: string,
    write: { status: "succeeded" | "failed"; creditsCounted: number; durationSeconds: number | null },
  ): Promise<void>;
  usageSince(ownerId: string, sinceIso: string): Promise<{ creditsUsed: number; oldestAt: string | null }>;
}

const RENDER_COLUMNS =
  "id,owner_id,project_id,project_revision,status,provider_status,media_id,job_id,output_key,failure_code," +
  "failure_message,duration_seconds,byte_size,width,height,credits_estimate,credits_consumed,created_at,updated_at";
const JOB_COLUMNS = "id,status,external_id,request,result,created_at";
const EXPORT_KIND = "video-export";

function corrupt(field: string): never {
  throw new ApiError(503, "VIDEO_STORE_CORRUPT", `The video export store returned a malformed row (${field}).`);
}

function text(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  return typeof value === "string" ? value : corrupt(name);
}

function nullableText(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : corrupt(name);
}

/** numeric/bigint columns arrive as strings from PostgREST. */
function nullableNumber(row: Record<string, unknown>, name: string): number | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : corrupt(name);
}

function numberValue(row: Record<string, unknown>, name: string): number {
  const value = nullableNumber(row, name);
  return value === null ? corrupt(name) : value;
}

function toJob(row: Record<string, unknown>): VideoExportJobRow {
  const status = row.status;
  if (status !== "queued" && status !== "running" && status !== "succeeded" && status !== "failed") {
    corrupt("job.status");
  }
  return {
    id: text(row, "id"),
    status,
    externalId: nullableText(row, "external_id"),
    createdAt: text(row, "created_at"),
    request: isRecord(row.request) ? row.request : null,
    result: isRecord(row.result) ? row.result : null,
  };
}

function toRow(row: Record<string, unknown>, job: VideoExportJobRow | null): VideoExportRow {
  const status = row.status;
  if (status !== "pending" && status !== "ready" && status !== "failed") corrupt("status");
  const providerStatus = row.provider_status;
  if (
    providerStatus !== null &&
    providerStatus !== undefined &&
    !(PROVIDER_STATUSES as readonly string[]).includes(String(providerStatus))
  ) {
    corrupt("provider_status");
  }
  const failureCode = nullableText(row, "failure_code");
  if (failureCode !== null && !isFailureCode(failureCode)) corrupt("failure_code");
  return {
    id: text(row, "id"),
    ownerId: text(row, "owner_id"),
    projectId: text(row, "project_id"),
    projectRevision: numberValue(row, "project_revision"),
    status,
    providerStatus: providerStatus === null || providerStatus === undefined
      ? null
      : (providerStatus as VideoProviderStatus),
    mediaId: nullableText(row, "media_id"),
    outputKey: nullableText(row, "output_key"),
    failureCode,
    failureMessage: nullableText(row, "failure_message"),
    durationSeconds: nullableNumber(row, "duration_seconds"),
    byteSize: nullableNumber(row, "byte_size"),
    width: nullableNumber(row, "width"),
    height: nullableNumber(row, "height"),
    creditsEstimate: numberValue(row, "credits_estimate"),
    creditsConsumed: nullableNumber(row, "credits_consumed"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    job,
  };
}

export function toRecord(row: VideoExportRow): VideoExportRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    projectRevision: row.projectRevision,
    status: row.status,
    provider: VIDEO_PROVIDER,
    providerStatus: row.providerStatus,
    jobId: row.job?.id ?? null,
    mediaId: row.mediaId,
    outputKey: row.outputKey,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    durationSeconds: row.durationSeconds,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    creditsEstimate: row.creditsEstimate,
    creditsConsumed: row.creditsConsumed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCursor(row: VideoExportRow): VideoExportCursor {
  return {
    id: row.id,
    ownerId: row.ownerId,
    projectId: row.projectId,
    createdAt: row.createdAt,
    creditsEstimate: row.creditsEstimate,
    creditsConsumed: row.creditsConsumed,
    projectRevision: row.projectRevision,
    job: row.job,
  };
}

interface SupabaseVideoStoreOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

export function createSupabaseVideoExportStore(
  options: SupabaseVideoStoreOptions,
): VideoExportStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };
  const readHeaders = { ...authHeaders, Accept: "application/json" };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json", Accept: "application/json" };
  const writeHeaders = { ...jsonHeaders, Prefer: "return=representation" };

  async function raw(
    target: string,
    init: RequestInit,
    action: string,
  ): Promise<{ status: number; payload: unknown }> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "VIDEO_STORE_UNAVAILABLE", "The video export store is unreachable.");
    }
    const payload: unknown = await response.json().catch(() => null);
    return { status: response.status, payload };
  }

  async function request(target: string, init: RequestInit, action: string): Promise<unknown> {
    const { status, payload } = await raw(target, init, action);
    if (status < 200 || status >= 300) {
      throw new ApiError(
        503,
        "VIDEO_STORE_UNAVAILABLE",
        `The video export store rejected ${action} (HTTP ${status}).`,
      );
    }
    return payload;
  }

  function rows(payload: unknown): Record<string, unknown>[] {
    if (!Array.isArray(payload)) {
      throw new ApiError(503, "VIDEO_STORE_UNAVAILABLE", "The video export store returned an unreadable response.");
    }
    return payload.map((row) => (isRecord(row) ? row : {}));
  }

  function url(table: string, query: Record<string, string> = {}): string {
    return `${base}/${table}?${new URLSearchParams(query)}`;
  }

  async function jobsFor(renderRows: Record<string, unknown>[]): Promise<Map<string, VideoExportJobRow>> {
    const ids = renderRows
      .map((row) => row.job_id)
      .filter((id): id is string => typeof id === "string");
    const jobs = new Map<string, VideoExportJobRow>();
    if (ids.length === 0) return jobs;
    const found = rows(
      await request(
        url("provider_jobs", {
          select: JOB_COLUMNS,
          owner_id: `eq.${text(renderRows[0], "owner_id")}`,
          id: `in.(${ids.join(",")})`,
          limit: "100",
        }),
        { headers: readHeaders },
        "the export job read",
      ),
    );
    for (const job of found.map(toJob)) jobs.set(job.id, job);
    return jobs;
  }

  function withJobs(renderRows: Record<string, unknown>[], jobs: Map<string, VideoExportJobRow>): VideoExportRow[] {
    return renderRows.map((row) => {
      const jobId = typeof row.job_id === "string" ? row.job_id : null;
      return toRow(row, jobId === null ? null : (jobs.get(jobId) ?? null));
    });
  }

  async function load(
    query: Record<string, string>,
    action: string,
  ): Promise<VideoExportRow[]> {
    const found = rows(
      await request(
        url("render_snapshots", {
          select: RENDER_COLUMNS,
          kind: `eq.${EXPORT_KIND}`,
          ...query,
        }),
        { headers: readHeaders },
        action,
      ),
    );
    if (found.length === 0) return [];
    return withJobs(found, await jobsFor(found));
  }

  function updateBody(patch: VideoExportUpdate): Record<string, unknown> {
    const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const map: Record<keyof VideoExportUpdate, string> = {
      status: "status",
      providerStatus: "provider_status",
      mediaId: "media_id",
      outputKey: "output_key",
      failureCode: "failure_code",
      failureMessage: "failure_message",
      durationSeconds: "duration_seconds",
      byteSize: "byte_size",
      width: "width",
      height: "height",
      creditsConsumed: "credits_consumed",
      providerUrlExpiresAt: "provider_url_expires_at",
    };
    for (const [field, column] of Object.entries(map) as [keyof VideoExportUpdate, string][]) {
      if (patch[field] !== undefined) body[column] = patch[field];
    }
    return body;
  }

  return {
    async findByIdempotencyKey(ownerId, key) {
      const found = await load(
        {
          owner_id: `eq.${ownerId}`,
          idempotency_key: `eq.${key}`,
          order: "created_at.asc",
          limit: "1",
        },
        "the export replay read",
      );
      return found.length === 0 ? null : toRecord(found[0]);
    },

    async findLive(ownerId, projectId) {
      const found = await load(
        {
          owner_id: `eq.${ownerId}`,
          project_id: `eq.${projectId}`,
          status: "eq.pending",
          order: "created_at.asc",
          limit: "1",
        },
        "the live export read",
      );
      return found.length === 0 ? null : toRecord(found[0]);
    },

    async create(ownerId, projectId, write) {
      const { status, payload } = await raw(
        url("render_snapshots"),
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({
            id: write.id,
            owner_id: ownerId,
            project_id: projectId,
            project_revision: write.projectRevision,
            status: "pending",
            kind: EXPORT_KIND,
            credits_estimate: write.creditsEstimate,
            idempotency_key: write.idempotencyKey,
            updated_at: new Date().toISOString(),
          }),
        },
        "the export save",
      );
      if (status < 200 || status >= 300) {
        const detail = isRecord(payload) ? payload : null;
        const pgCode = detail && typeof detail.code === "string" ? detail.code : null;
        // The composite foreign key refuses a revision this project never had.
        if (pgCode === "23503" || status === 400) {
          throw new ApiError(
            409,
            "PROJECT_REVISION_NOT_FOUND",
            "projectRevision must name a saved revision of this project.",
          );
        }
        // The one-live-export index makes a parallel submit lose the race.
        if (pgCode === "23505" || status === 409) {
          throw new ApiError(
            429,
            "VIDEO_RENDER_IN_FLIGHT",
            "A video export is already running for this project. Wait for it to finish.",
          );
        }
        throw new ApiError(
          503,
          "VIDEO_STORE_UNAVAILABLE",
          `The video export store rejected the export save (HTTP ${status}).`,
        );
      }
      const created = rows(payload);
      if (created.length === 0) {
        throw new ApiError(503, "VIDEO_STORE_UNAVAILABLE", "The video export store did not confirm the export.");
      }
      return toRecord(toRow(created[0], null));
    },

    async get(ownerId, projectId, exportId) {
      const found = await load(
        { id: `eq.${exportId}`, owner_id: `eq.${ownerId}`, project_id: `eq.${projectId}`, limit: "1" },
        "the export read",
      );
      if (found.length === 0) throw new ApiError(404, "VIDEO_EXPORT_NOT_FOUND", EXPORT_NOT_FOUND);
      return toRecord(found[0]);
    },

    async list(ownerId, projectId, limit) {
      const found = await load(
        {
          owner_id: `eq.${ownerId}`,
          project_id: `eq.${projectId}`,
          order: "created_at.desc",
          limit: String(limit),
        },
        "the export list",
      );
      return found.map(toRecord);
    },

    async update(ownerId, exportId, patch) {
      await request(
        url("render_snapshots", {
          id: `eq.${exportId}`,
          owner_id: `eq.${ownerId}`,
          kind: `eq.${EXPORT_KIND}`,
        }),
        { method: "PATCH", headers: writeHeaders, body: JSON.stringify(updateBody(patch)) },
        "the export update",
      );
    },

    async live(limit) {
      const found = rows(
        await request(
          url("render_snapshots", {
            select: RENDER_COLUMNS,
            kind: `eq.${EXPORT_KIND}`,
            status: "eq.pending",
            order: "created_at.asc",
            limit: String(limit),
          }),
          { headers: readHeaders },
          "the live export list",
        ),
      );
      if (found.length === 0) return [];
      const ids = found.map((row) => text(row, "id"));
      const jobIds = found
        .map((row) => row.job_id)
        .filter((id): id is string => typeof id === "string");
      const jobs = new Map<string, VideoExportJobRow>();
      if (jobIds.length > 0) {
        const jobRows = rows(
          await request(
            url("provider_jobs", {
              select: JOB_COLUMNS,
              id: `in.(${jobIds.join(",")})`,
              limit: "100",
            }),
            { headers: readHeaders },
            "the live export job read",
          ),
        );
        for (const job of jobRows.map(toJob)) jobs.set(job.id, job);
      }
      return withJobs(found, jobs)
        .filter((row) => ids.includes(row.id))
        .map(toCursor);
    },

    async createJob(ownerId, projectId, write) {
      const created = rows(
        await request(
          url("provider_jobs"),
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              owner_id: ownerId,
              project_id: projectId,
              provider: VIDEO_PROVIDER,
              kind: EXPORT_KIND,
              status: "queued",
              external_id: write.externalId,
              request: write.request,
            }),
          },
          "the export job save",
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "VIDEO_STORE_UNAVAILABLE", "The video export store did not confirm the job.");
      }
      return toJob(created[0]);
    },

    async attachJob(ownerId, exportId, jobId) {
      await request(
        url("render_snapshots", { id: `eq.${exportId}`, owner_id: `eq.${ownerId}`, kind: `eq.${EXPORT_KIND}` }),
        { method: "PATCH", headers: writeHeaders, body: JSON.stringify({ job_id: jobId }) },
        "the export job link",
      );
    },

    async updateJob(ownerId, jobId, patch) {
      const body: Record<string, unknown> = {
        status: patch.status,
        updated_at: new Date().toISOString(),
      };
      if (patch.externalId !== undefined) body.external_id = patch.externalId;
      if (patch.result !== undefined) body.result = patch.result;
      await request(
        url("provider_jobs", { id: `eq.${jobId}`, owner_id: `eq.${ownerId}`, kind: `eq.${EXPORT_KIND}` }),
        { method: "PATCH", headers: writeHeaders, body: JSON.stringify(body) },
        "the export job update",
      );
    },

    async remove(ownerId, projectId, exportId) {
      const found = await load(
        { id: `eq.${exportId}`, owner_id: `eq.${ownerId}`, project_id: `eq.${projectId}`, limit: "1" },
        "the export removal read",
      );
      if (found.length === 0) throw new ApiError(404, "VIDEO_EXPORT_NOT_FOUND", EXPORT_NOT_FOUND);
      const job = found[0].job ?? null;
      const removed = rows(
        await request(
          url("render_snapshots", {
            id: `eq.${exportId}`,
            owner_id: `eq.${ownerId}`,
            project_id: `eq.${projectId}`,
            kind: `eq.${EXPORT_KIND}`,
          }),
          { method: "DELETE", headers: { ...readHeaders, Prefer: "return=representation" } },
          "the export removal",
        ),
      );
      if (removed.length === 0) throw new ApiError(404, "VIDEO_EXPORT_NOT_FOUND", EXPORT_NOT_FOUND);
      if (job) {
        await request(
          url("provider_jobs", { id: `eq.${job.id}`, owner_id: `eq.${ownerId}`, kind: `eq.${EXPORT_KIND}` }),
          { method: "DELETE", headers: readHeaders },
          "the export job removal",
        ).catch(() => undefined);
      }
      return job;
    },

    async reserve(ownerId, projectId, exportId, credits, limits) {
      const payload = await request(
        `${base}/rpc/reserve_video_usage`,
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({
            p_owner_id: ownerId,
            p_project_id: projectId,
            p_render_id: exportId,
            p_credits_estimate: credits,
            p_rate_version: JSON2VIDEO_RATE_VERSION,
            p_credit_limit: limits.creditLimit,
            p_window_seconds: limits.windowSeconds,
          }),
        },
        "the video usage reservation",
      );
      const row = rows(payload)[0];
      if (!row || typeof row.allowed !== "boolean") {
        throw new ApiError(503, "VIDEO_STORE_UNAVAILABLE", "The video usage ledger did not confirm the reservation.");
      }
      return {
        usageId: typeof row.usage_id === "string" ? row.usage_id : null,
        allowed: row.allowed,
        creditsUsed: nullableNumber(row, "credits_used") ?? 0,
        oldestAt: nullableText(row, "oldest_at"),
      };
    },

    async settleUsage(ownerId, exportId, write) {
      await request(
        url("video_usage", { owner_id: `eq.${ownerId}`, render_id: `eq.${exportId}` }),
        {
          method: "PATCH",
          headers: writeHeaders,
          body: JSON.stringify({
            status: write.status,
            credits_counted: write.creditsCounted,
            duration_seconds: write.durationSeconds,
            updated_at: new Date().toISOString(),
          }),
        },
        "the video usage settlement",
      );
    },

    async usageSince(ownerId, sinceIso) {
      const found = rows(
        await request(
          url("video_usage", {
            select: "credits_counted,created_at",
            owner_id: `eq.${ownerId}`,
            created_at: `gte.${sinceIso}`,
            order: "created_at.asc",
            limit: "2000",
          }),
          { headers: readHeaders },
          "the video usage total",
        ),
      );
      let creditsUsed = 0;
      let oldestAt: string | null = null;
      for (const row of found) {
        creditsUsed += nullableNumber(row, "credits_counted") ?? 0;
        if (oldestAt === null) oldestAt = nullableText(row, "created_at");
      }
      return { creditsUsed: round3(creditsUsed), oldestAt };
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface VideoExportDeps {
  store: VideoExportStore;
  media: MediaStore;
  narration: NarrationStore;
  projects: ProjectStore;
  objects: R2Client;
  settings: Json2VideoSettings;
  limits: VideoLimits;
  mediaLimits: MediaLimits;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: { error(message: string): void };
}

export interface VideoExportSubmitResult {
  record: VideoExportRecord;
  usage: VideoUsageSummary;
  replayed: boolean;
}

export interface VideoExportDetail {
  record: VideoExportRecord;
  media: MediaRecord | null;
  usage: VideoUsageSummary;
}

export interface VideoExportPlayback {
  url: string;
  expiresAt: string;
  contentType: string;
  byteSize: number;
}

export interface VideoExportService {
  submit(
    ownerId: string,
    projectId: string,
    input: { projectRevision: number },
    idempotencyKey: string,
  ): Promise<VideoExportSubmitResult>;
  list(ownerId: string, projectId: string): Promise<{ exports: VideoExportRecord[]; usage: VideoUsageSummary }>;
  get(ownerId: string, projectId: string, exportId: string): Promise<VideoExportDetail>;
  playback(ownerId: string, projectId: string, exportId: string): Promise<VideoExportPlayback>;
  remove(ownerId: string, projectId: string, exportId: string): Promise<void>;
  /** One bounded sweep pass; the only place a provider status is read. */
  sweep(): Promise<void>;
}

interface ResolvedInputs {
  visuals: Record<string, VideoRenderVisual>;
  narration: VideoRenderAudio | null;
  music: VideoRenderAudio | null;
  /** What the stored request may keep: keys and expiries, never signed URLs. */
  stored: Record<string, unknown>;
  scenesWithoutVisual: number;
}

/**
 * Store, lifecycle, single copy, and the spend guard, all in one place so the
 * routes stay thin and every paid step is preceded by a recorded reservation.
 */
export function createVideoExportService(deps: VideoExportDeps): VideoExportService {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.logger ?? console;
  const limits = deps.limits;

  // One paid submission per account at a time, like the narration slot: two
  // tabs cannot both reserve and submit.
  const submitting = new Set<string>();
  let sweeping: Promise<void> | null = null;

  function providerOptions(): Json2VideoRequestOptions {
    return { settings: deps.settings, fetchImpl, timeoutMs: limits.timeoutMs };
  }

  async function usageSummary(ownerId: string): Promise<VideoUsageSummary> {
    const since = new Date(now() - limits.spendWindowMs).toISOString();
    const totals = await deps.store.usageSince(ownerId, since);
    return {
      windowHours: limits.spendWindowMs / (60 * 60 * 1000),
      creditsUsed: totals.creditsUsed,
      creditsLimit: limits.dailyCreditsLimit > 0 ? limits.dailyCreditsLimit : null,
      resetAt:
        totals.oldestAt === null
          ? null
          : new Date(Date.parse(totals.oldestAt) + limits.spendWindowMs).toISOString(),
    };
  }

  async function presignMedia(
    ownerId: string,
    projectId: string,
    mediaId: string,
    expected: "audio" | "visual",
  ): Promise<{ key: string; url: string; expiresAt: string; media: MediaRecord }> {
    const stored = await deps.media.get(ownerId, projectId, mediaId);
    if (!stored || stored.media.status !== "ready") {
      throw new ApiError(
        409,
        "VIDEO_MEDIA_NOT_READY",
        "Every asset used by a render must be a ready file of this project.",
      );
    }
    if (expected === "audio" && stored.media.kind !== "audio") {
      throw new ApiError(409, "VIDEO_MEDIA_NOT_READY", "The attached audio file is not a ready audio asset.");
    }
    const presigned = deps.objects.presignGet(stored.objectKey, limits.inputUrlSeconds);
    return {
      key: stored.objectKey,
      url: presigned.url,
      expiresAt: presigned.expiresAt,
      media: stored.media,
    };
  }

  async function resolveInputs(
    ownerId: string,
    projectId: string,
    document: ProjectDocumentV2,
    timelineSeconds: number,
  ): Promise<ResolvedInputs> {
    const listed = await deps.media.list(ownerId, projectId, deps.mediaLimits.listLimit);
    const byId = new Map(listed.map((media) => [media.id, media]));
    const visuals: Record<string, VideoRenderVisual> = {};
    const storedScenes: Record<string, unknown>[] = [];
    let scenesWithoutVisual = 0;

    for (const scene of document.scenes) {
      let chosen: { mediaId: string; kind: "image" | "video"; key: string; url: string; expiresAt: string } | null =
        null;
      for (const assetId of scene.assetIds) {
        const listedMedia = byId.get(assetId);
        if (!listedMedia) {
          throw new ApiError(
            409,
            "VIDEO_MEDIA_NOT_READY",
            `Scene "${scene.heading}" lists an asset that is not in this project.`,
          );
        }
        // Audio in assetIds is ignored; narration and music are attached separately.
        if (listedMedia.kind === "audio") continue;
        if (listedMedia.status !== "ready") {
          throw new ApiError(
            409,
            "VIDEO_MEDIA_NOT_READY",
            `Scene "${scene.heading}" uses an asset that is still pending or was deleted.`,
          );
        }
        const presigned = await presignMedia(ownerId, projectId, assetId, "visual");
        chosen = {
          mediaId: assetId,
          kind: listedMedia.kind === "video" ? "video" : "image",
          key: presigned.key,
          url: presigned.url,
          expiresAt: presigned.expiresAt,
        };
        break;
      }

      if (chosen === null) {
        scenesWithoutVisual += 1;
        storedScenes.push({ sceneId: scene.id, durationSeconds: round3(scene.durationSeconds) });
        continue;
      }
      visuals[scene.id] = { kind: chosen.kind, url: chosen.url };
      storedScenes.push({
        sceneId: scene.id,
        durationSeconds: round3(scene.durationSeconds),
        mediaId: chosen.mediaId,
        objectKey: chosen.key,
        urlExpiresAt: chosen.expiresAt,
      });
    }

    const active = await deps.narration.active(ownerId, projectId);
    let narration: VideoRenderAudio | null = null;
    let music: VideoRenderAudio | null = null;
    let storedNarration: Record<string, unknown> | null = null;
    let storedMusic: Record<string, unknown> | null = null;

    if (active.narration) {
      const track = active.narration;
      let fingerprint: string | null = null;
      try {
        fingerprint = buildNarrationScript(document).fingerprint;
      } catch {
        throw new ApiError(
          409,
          "VIDEO_NARRATION_STALE",
          "The attached narration belongs to an earlier script. Regenerate it before exporting.",
        );
      }
      if (track.scriptFingerprint === null || track.scriptFingerprint !== fingerprint) {
        throw new ApiError(
          409,
          "VIDEO_NARRATION_STALE",
          "The attached narration belongs to an earlier script. Regenerate it before exporting.",
        );
      }
      if (track.mediaId === null) {
        throw new ApiError(409, "VIDEO_MEDIA_NOT_READY", "The attached narration has no audio file.");
      }
      if (track.durationSeconds === null) {
        throw new ApiError(
          422,
          "VIDEO_TIMELINE_INVALID",
          "The attached narration has no measured duration, so it cannot be timed against the scenes.",
        );
      }
      // Speech is measured and never cut: a track that does not fit is a refusal.
      assertNarrationFits(track.durationSeconds, timelineSeconds, limits.timingToleranceSeconds);
      const presigned = await presignMedia(ownerId, projectId, track.mediaId, "audio");
      narration = {
        url: presigned.url,
        volume: track.volume,
        muted: track.muted,
      };
      storedNarration = {
        mediaId: track.mediaId,
        objectKey: presigned.key,
        urlExpiresAt: presigned.expiresAt,
        durationSeconds: track.durationSeconds,
      };
    }

    if (active.music && active.music.mediaId !== null) {
      const presigned = await presignMedia(ownerId, projectId, active.music.mediaId, "audio");
      music = { url: presigned.url, volume: active.music.volume, muted: active.music.muted };
      storedMusic = {
        mediaId: active.music.mediaId,
        objectKey: presigned.key,
        urlExpiresAt: presigned.expiresAt,
      };
    }

    return {
      visuals,
      narration,
      music,
      scenesWithoutVisual,
      stored: {
        scenes: storedScenes,
        narration: storedNarration,
        music: storedMusic,
      },
    };
  }

  function outputUrl(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError(422, "VIDEO_OUTPUT_INVALID", "The provider returned an unreadable output URL.");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== JSON2VIDEO_OUTPUT_HOST) {
      throw new ApiError(
        422,
        "VIDEO_OUTPUT_INVALID",
        "The provider returned an output URL outside assets.json2video.com; nothing was downloaded.",
      );
    }
    return parsed;
  }

  /** Streams the MP4 with a hard byte cap, not a Content-Length promise. */
  async function downloadOutput(url: string): Promise<Buffer> {
    const target = outputUrl(url);
    let response: Response;
    try {
      response = await fetchImpl(target, {
        redirect: "error",
        signal: AbortSignal.timeout(limits.downloadTimeoutMs),
      });
    } catch {
      throw new ApiError(502, "VIDEO_OUTPUT_COPY_FAILED", "The provider output could not be downloaded.");
    }
    if (!response.ok || response.body === null) {
      throw new ApiError(
        502,
        "VIDEO_OUTPUT_COPY_FAILED",
        `The provider output download failed (HTTP ${response.status}).`,
      );
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(
          422,
          "VIDEO_OUTPUT_INVALID",
          `The provider output is larger than the ${limits.maxBytes}-byte render limit.`,
        );
      }
      chunks.push(Buffer.from(value));
    }
    if (total === 0) {
      throw new ApiError(422, "VIDEO_OUTPUT_INVALID", "The provider output was empty.");
    }
    return Buffer.concat(chunks);
  }

  /** Writes the MP4 through the same private-media path every upload uses. */
  async function storeOutput(
    ownerId: string,
    projectId: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<{ mediaId: string; objectKey: string; byteSize: number }> {
    const used = await deps.media.usedBytes(ownerId);
    if (used + bytes.length > deps.mediaLimits.ownerStorageBytes) {
      throw new ApiError(
        413,
        "VIDEO_OUTPUT_COPY_FAILED",
        `This account's media storage limit is ${deps.mediaLimits.ownerStorageBytes} bytes; the render was not stored.`,
      );
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
        throw new ApiError(502, "VIDEO_OUTPUT_COPY_FAILED", "Private storage rejected the finished render.");
      }
      const head = await bucketCall(() => deps.objects.head(objectKey));
      if (head === null) {
        throw new ApiError(502, "VIDEO_OUTPUT_COPY_FAILED", "The finished render was not found in the bucket.");
      }
      const ready = await deps.media.markReady(ownerId, projectId, mediaId, {
        contentType,
        byteSize: head.byteSize,
      });
      if (!ready) {
        throw new ApiError(409, "VIDEO_OUTPUT_COPY_FAILED", "The stored render changed while it was saved.");
      }
      return { mediaId, objectKey, byteSize: head.byteSize };
    } catch (error) {
      await deps.media.markDeleted(ownerId, projectId, mediaId).catch(() => false);
      await deps.objects.delete(objectKey).catch(() => false);
      throw error;
    }
  }

  async function bucketCall<T>(action: () => Promise<T>): Promise<T> {
    return action().catch((error: unknown) => {
      if (error instanceof R2Error) {
        throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "The private media bucket is temporarily unavailable.");
      }
      throw error;
    });
  }

  async function settle(
    ownerId: string,
    exportId: string,
    status: "succeeded" | "failed",
    creditsCounted: number,
    durationSeconds: number | null,
  ): Promise<void> {
    await deps.store
      .settleUsage(ownerId, exportId, {
        status,
        creditsCounted: round3(Math.max(0, creditsCounted)),
        durationSeconds,
      })
      .catch(() => log.error("[video] VIDEO_USAGE_SETTLE_FAILED"));
  }

  async function failExport(
    cursor: VideoExportCursor,
    code: VideoFailureCode,
    message: string,
    settlement: "zero" | "estimate",
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const credits = settlement === "zero" ? 0 : (cursor.creditsConsumed ?? cursor.creditsEstimate);
    await deps.store.update(cursor.ownerId, cursor.id, {
      status: "failed",
      failureCode: code,
      failureMessage: message.slice(0, 500),
    });
    if (cursor.job) {
      await deps.store
        .updateJob(cursor.ownerId, cursor.job.id, {
          status: "failed",
          result: {
            ...(cursor.job.result ?? {}),
            failureCode: code,
            providerStatus: cursor.job.result?.providerStatus ?? null,
            ...details,
          },
        })
        .catch(() => log.error("[video] VIDEO_JOB_SETTLE_FAILED"));
    }
    await settle(cursor.ownerId, cursor.id, "failed", credits, null);
  }

  /** Best-effort provider delete: our copy is the durable one. */
  async function deleteProviderCopy(externalId: string | null): Promise<void> {
    if (externalId === null) return;
    try {
      await deleteMovie(providerOptions(), externalId);
    } catch {
      log.error("[video] VIDEO_PROVIDER_DELETE_FAILED");
    }
  }

  async function copyFinished(
    cursor: VideoExportCursor,
    status: Json2VideoMovieStatus,
    url: string,
  ): Promise<void> {
    const bytes = await downloadOutput(url);
    const detected = detectMediaType(bytes);
    if (!detected || !mediaTypeMatches("video", detected)) {
      throw new ApiError(
        422,
        "VIDEO_OUTPUT_INVALID",
        "The provider output is not a supported video file; nothing was stored.",
      );
    }

    const stored = await storeOutput(cursor.ownerId, cursor.projectId, bytes, detected.contentType);
    const credits =
      status.consumedCredits !== null
        ? status.consumedCredits
        : Math.ceil(status.durationSeconds ?? cursor.creditsEstimate);

    await deps.store.update(cursor.ownerId, cursor.id, {
      status: "ready",
      providerStatus: "done",
      mediaId: stored.mediaId,
      outputKey: stored.objectKey,
      failureCode: null,
      failureMessage: null,
      durationSeconds: status.durationSeconds,
      byteSize: stored.byteSize,
      width: status.width,
      height: status.height,
      creditsConsumed: credits,
    });
    if (cursor.job) {
      await deps.store.updateJob(cursor.ownerId, cursor.job.id, {
        status: "succeeded",
        result: {
          providerStatus: "done",
          durationSeconds: status.durationSeconds,
          byteSize: status.byteSize,
          width: status.width,
          height: status.height,
          consumedCredits: status.consumedCredits,
          providerUrl: url,
          providerUrlExpiresAt: null,
        },
      });
    }
    await settle(cursor.ownerId, cursor.id, "succeeded", credits, status.durationSeconds);
    // Referenced by the render row, so retention cannot delete a finished MP4.
    await deps.media
      .addReference(cursor.ownerId, cursor.projectId, stored.mediaId, {
        refKind: "render",
        refId: cursor.id,
      })
      .catch(() => log.error("[video] VIDEO_MEDIA_REFERENCE_FAILED"));
    await deleteProviderCopy(cursor.job?.externalId ?? null);
  }

  async function advance(cursor: VideoExportCursor): Promise<void> {
    const job = cursor.job;
    const startedAt = Date.parse(job?.createdAt ?? cursor.createdAt);
    const age = Number.isFinite(startedAt) ? now() - startedAt : 0;

    // A row that never reached the provider cannot be polled; settle it so it
    // cannot block the project forever.
    if (age > limits.abandonAfterMs) {
      await deleteProviderCopy(job?.externalId ?? null);
      await failExport(
        cursor,
        "VIDEO_RENDER_ABANDONED",
        "This render did not report back in time and was settled as abandoned. No further copy is attempted.",
        "estimate",
      );
      return;
    }

    if (job === null || job.externalId === null) {
      // Submission is not confirmed yet; the submit request settles it or the
      // abandonment above does.
      return;
    }

    if (age > limits.renderTimeoutMs) {
      await deleteProviderCopy(job.externalId);
      await failExport(
        cursor,
        "VIDEO_RENDER_TIMEOUT",
        "The render passed the provider's time limit before it finished.",
        "estimate",
      );
      return;
    }

    let status: Json2VideoMovieStatus;
    try {
      status = await getMovie(providerOptions(), job.externalId, now());
    } catch (error) {
      if (!(error instanceof Json2VideoError)) throw error;
      if (error.code === "VIDEO_PROVIDER_DISABLED") return;
      if (error.code === "VIDEO_JOB_NOT_FOUND") {
        await failExport(
          cursor,
          "VIDEO_JOB_NOT_FOUND",
          "JSON2Video does not know this render any more, so polling stopped.",
          "estimate",
        );
        return;
      }
      if (error.retryable) {
        log.error("[video] VIDEO_POLL_DEFERRED");
        return;
      }
      await failExport(
        cursor,
        error.code === "VIDEO_PROVIDER_QUOTA" ? "VIDEO_PROVIDER_QUOTA" : "VIDEO_PROVIDER_UNAVAILABLE",
        error.message,
        "estimate",
      );
      return;
    }

    if (status.status === "pending" || status.status === "running") {
      await deps.store.update(cursor.ownerId, cursor.id, { providerStatus: status.status });
      if (cursor.job) {
        await deps.store
          .updateJob(cursor.ownerId, cursor.job.id, {
            status: "running",
            result: { providerStatus: status.status, createdAt: status.createdAt },
          })
          .catch(() => log.error("[video] VIDEO_JOB_UPDATE_FAILED"));
      }
      return;
    }

    if (status.status === "error") {
      await failExport(
        cursor,
        "VIDEO_PROVIDER_REJECTED",
        status.message.length > 0
          ? `JSON2Video could not render this movie: ${status.message}`
          : "JSON2Video could not render this movie.",
        "zero",
      );
      return;
    }

    if (status.status === "timeout") {
      await deleteProviderCopy(job.externalId);
      await failExport(
        cursor,
        "VIDEO_RENDER_TIMEOUT",
        "The render passed the provider's time limit before it finished.",
        "estimate",
      );
      return;
    }

    if (status.url === null) {
      await failExport(
        cursor,
        "VIDEO_OUTPUT_INVALID",
        "JSON2Video reported the render as done without an output file.",
        "estimate",
      );
      return;
    }

    try {
      await copyFinished(cursor, status, status.url);
    } catch (error) {
      const code =
        error instanceof ApiError && isFailureCode(error.code) ? error.code : "VIDEO_OUTPUT_COPY_FAILED";
      const message =
        error instanceof ApiError ? error.message : "The finished render could not be copied into storage.";
      // The provider copy is kept, not deleted, and its URL stays in the job
      // result so a later slice can retry the copy instead of paying again.
      await failExport(cursor, code, message, "estimate", {
        providerStatus: "done",
        providerUrl: status.url,
        providerUrlExpiresAt: null,
      });
    }
  }

  function sweep(): Promise<void> {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      try {
        const live = await deps.store.live(25);
        for (const cursor of live) {
          try {
            await advance(cursor);
          } catch {
            // One bad row must not stop the rest of the pass.
            log.error("[video] VIDEO_EXPORT_ADVANCE_FAILED");
          }
        }
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  }

  async function submit(
    ownerId: string,
    projectId: string,
    input: { projectRevision: number },
    idempotencyKey: string,
  ): Promise<VideoExportSubmitResult> {
    const replay = await deps.store.findByIdempotencyKey(ownerId, idempotencyKey);
    if (replay) {
      if (replay.projectId !== projectId) {
        throw new ApiError(404, "VIDEO_EXPORT_NOT_FOUND", EXPORT_NOT_FOUND);
      }
      return { record: replay, usage: await usageSummary(ownerId), replayed: true };
    }

    if (!deps.settings.apiKey) {
      throw new ApiError(
        503,
        "VIDEO_PROVIDER_DISABLED",
        "JSON2Video export is disabled because JSON2VIDEO_API_KEY is not configured.",
      );
    }
    if (submitting.has(ownerId)) {
      throw new ApiError(
        429,
        "VIDEO_RENDER_IN_FLIGHT",
        "A video export is already being submitted for this account. Wait for it to finish.",
      );
    }
    submitting.add(ownerId);

    try {
      if (await deps.store.findLive(ownerId, projectId)) {
        throw new ApiError(
          429,
          "VIDEO_RENDER_IN_FLIGHT",
          "A video export is already running for this project. Wait for it to finish.",
        );
      }

      const project = await deps.projects.get(ownerId, projectId);
      if (project.version !== input.projectRevision) {
        throw new ApiError(
          409,
          "PROJECT_REVISION_NOT_FOUND",
          "projectRevision must be the project's saved revision. Save the project, then export.",
        );
      }

      // Approval and duration gates run before any reservation or provider call.
      const timelineSeconds = assertRenderableDocument(project.document, limits.maxSeconds);
      const inputs = await resolveInputs(ownerId, projectId, project.document, timelineSeconds);

      const exportId = randomUUID();
      const creditsEstimate = Math.ceil(timelineSeconds * VIDEO_CREDITS_PER_SECOND);
      await deps.store.create(ownerId, projectId, {
        id: exportId,
        projectRevision: input.projectRevision,
        creditsEstimate,
        idempotencyKey,
      });

      const reservation = await deps.store.reserve(ownerId, projectId, exportId, creditsEstimate, {
        creditLimit: limits.dailyCreditsLimit,
        windowSeconds: Math.floor(limits.spendWindowMs / 1000),
      });
      if (!reservation.allowed) {
        // Nothing was rendered: drop the pending row so it cannot block the project.
        await deps.store.remove(ownerId, projectId, exportId).catch(() => undefined);
        throw new ApiError(
          429,
          "VIDEO_BUDGET_EXCEEDED",
          `This account has used ${round3(reservation.creditsUsed)} of ${limits.dailyCreditsLimit} video credits ` +
            `in the last ${limits.spendWindowMs / (60 * 60 * 1000)} hours; this render needs ${creditsEstimate} more.`,
        );
      }

      let exportRow: VideoExportRecord;
      let settled = false;
      let attempted = false;
      try {
        const built = buildVideoMovie({
          renderId: exportId,
          projectRevision: input.projectRevision,
          document: project.document,
          resolution: limits.resolution,
          maxSeconds: limits.maxSeconds,
          visuals: inputs.visuals,
          narration: inputs.narration,
          music: inputs.music,
        });

        const job = await deps.store.createJob(ownerId, projectId, {
          externalId: null,
          // Signed URLs never enter storage: keys and expiries only.
          request: {
            kind: EXPORT_KIND,
            projectRevision: input.projectRevision,
            resolution: limits.resolution,
            durationSeconds: built.durationSeconds,
            scenesWithoutVisual: built.scenesWithoutVisual,
            movieBytes: built.byteSize,
            ...inputs.stored,
          },
        });
        await deps.store.attachJob(ownerId, exportId, job.id);

        let submitted: { project: string } | null = null;
        let lastError: Json2VideoError | null = null;
        for (let attempt = 1; attempt <= 3 && submitted === null; attempt += 1) {
          attempted = true;
          try {
            submitted = await submitMovie(providerOptions(), built.movie);
          } catch (error) {
            if (!(error instanceof Json2VideoError)) throw error;
            lastError = error;
            // A definitive rejection is not retried; a transient one is.
            if (!error.retryable) break;
            if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
          }
        }

        if (submitted === null) {
          const error =
            lastError ??
            new Json2VideoError(
              502,
              "VIDEO_PROVIDER_UNAVAILABLE",
              "JSON2Video did not accept the render.",
              true,
            );
          const definite = !error.retryable;
          // Only a confirmed refusal is a rejection; an outage that outlasted
          // the retries is reported as unavailable.
          const failureCode: VideoFailureCode =
            error.code === "VIDEO_PROVIDER_QUOTA"
              ? "VIDEO_PROVIDER_QUOTA"
              : definite
                ? "VIDEO_PROVIDER_REJECTED"
                : "VIDEO_PROVIDER_UNAVAILABLE";
          await deps.store.update(ownerId, exportId, {
            status: "failed",
            providerStatus: null,
            failureCode,
            failureMessage: error.message.slice(0, 500),
          });
          await deps.store
            .updateJob(ownerId, job.id, {
              status: "failed",
              result: { submission: definite ? "rejected" : "ambiguous", failureCode },
            })
            .catch(() => undefined);
          // A confirmed rejection is not billed; an ambiguous one keeps its estimate.
          await settle(ownerId, exportId, "failed", definite ? 0 : creditsEstimate, null);
          settled = true;
          throw error;
        }

        await deps.store.update(ownerId, exportId, { providerStatus: "running" });
        await deps.store.updateJob(ownerId, job.id, {
          status: "running",
          externalId: submitted.project,
          result: { providerStatus: "running", acceptedAt: new Date(now()).toISOString() },
        });
        exportRow = await deps.store.get(ownerId, projectId, exportId);
      } catch (error) {
        if (!settled) {
          if (!attempted && error instanceof ApiError && error.status < 500) {
            // A local refusal before any provider call leaves no export row,
            // and its reservation settles at zero.
            await settle(ownerId, exportId, "failed", 0, null);
            await deps.store.remove(ownerId, projectId, exportId).catch(() => undefined);
          } else {
            await deps.store
              .update(ownerId, exportId, {
                status: "failed",
                failureCode: "VIDEO_PROVIDER_UNAVAILABLE",
                failureMessage: (error instanceof Error
                  ? error.message
                  : "The export could not be submitted."
                ).slice(0, 500),
              })
              .catch(() => undefined);
            // Nothing is billed when the render never reached the provider.
            await settle(ownerId, exportId, "failed", attempted ? creditsEstimate : 0, null);
          }
        }
        throw error;
      }

      return { record: exportRow, usage: await usageSummary(ownerId), replayed: false };
    } finally {
      submitting.delete(ownerId);
    }
  }

  async function get(ownerId: string, projectId: string, exportId: string): Promise<VideoExportDetail> {
    const record = await deps.store.get(ownerId, projectId, exportId);
    const media =
      record.mediaId === null
        ? null
        : await deps.media
            .get(ownerId, projectId, record.mediaId)
            .then((stored) => stored?.media ?? null)
            .catch(() => null);
    return { record, media, usage: await usageSummary(ownerId) };
  }

  async function playback(
    ownerId: string,
    projectId: string,
    exportId: string,
  ): Promise<VideoExportPlayback> {
    const record = await deps.store.get(ownerId, projectId, exportId);
    if (record.status !== "ready" || record.mediaId === null) {
      throw new ApiError(409, "VIDEO_RENDER_NOT_READY", "This video export is not ready for playback yet.");
    }
    const stored = await deps.media.get(ownerId, projectId, record.mediaId);
    if (!stored || stored.media.status !== "ready") {
      throw new ApiError(409, "VIDEO_RENDER_NOT_READY", "The stored render is no longer available.");
    }
    const head = await bucketCall(() => deps.objects.head(stored.objectKey));
    if (head === null) {
      throw new ApiError(409, "VIDEO_RENDER_NOT_READY", "The stored render is missing from the bucket.");
    }
    const presigned = deps.objects.presignGet(stored.objectKey, deps.mediaLimits.downloadUrlSeconds);
    return {
      url: presigned.url,
      expiresAt: presigned.expiresAt,
      contentType: stored.media.contentType,
      byteSize: head.byteSize,
    };
  }

  async function remove(ownerId: string, projectId: string, exportId: string): Promise<void> {
    const record = await deps.store.get(ownerId, projectId, exportId);
    const job = await deps.store.remove(ownerId, projectId, exportId);

    if (record.mediaId !== null) {
      const references = await deps.media.listReferences(ownerId, projectId, record.mediaId).catch(() => []);
      for (const reference of references) {
        if (reference.refKind !== "render" || reference.refId !== exportId) continue;
        await deps.media.removeReference(ownerId, projectId, record.mediaId, reference.id).catch(() => false);
      }
      const stored = await deps.media.get(ownerId, projectId, record.mediaId).catch(() => null);
      if (stored) {
        await deps.media.markDeleted(ownerId, projectId, record.mediaId).catch(() => false);
        // The row is already removed, so a bucket failure cannot expose a ready
        // row without its object; retention retries the object removal.
        await deps.objects.delete(stored.objectKey).catch(() => log.error("[video] R2_DELETE_FAILED"));
      }
    }

    await deleteProviderCopy(job?.externalId ?? null);
  }

  return {
    submit,
    list: async (ownerId, projectId) => ({
      exports: await deps.store.list(ownerId, projectId, 50),
      usage: await usageSummary(ownerId),
    }),
    get,
    playback,
    remove,
    sweep,
  };
}

