import type { MediaRecord } from "./media-contract";

/**
 * Phase 9: explicit, credit-estimated video export through JSON2Video.
 *
 * JSON2Video bills one credit per second of output at any resolution and
 * publishes no credits-to-dollars rate, so this contract speaks in credits and
 * seconds and never invents a USD price. Failed renders are not billed; the
 * guard still counts an ambiguous failure (see the plan).
 */

export const VIDEO_PROVIDER = "json2video" as const;
export const VIDEO_CREDITS_PER_SECOND = 1;
/** Rate card the estimates and settled rows are recorded against. */
export const JSON2VIDEO_RATE_VERSION = "json2video-2026-11-25";

/** Provider bound: a movie JSON over 2 MB is refused with HTTP 413. */
export const VIDEO_MOVIE_MAX_BYTES = 2 * 1024 * 1024;
export const VIDEO_MAX_SCENES = 50;
export const VIDEO_TEXT_MAX_CHARS = 2000;
/** Speech is never cut, so a small measurement rounding margin is allowed. */
export const VIDEO_DEFAULT_TIMING_TOLERANCE_SECONDS = 0.5;

/**
 * Documented `resolution` values. `custom` is deliberately absent: the project
 * document has no canvas size, so a custom size would be invented.
 */
export const VIDEO_RESOLUTIONS = [
  "sd",
  "hd",
  "full-hd",
  "squared",
  "instagram-story",
  "instagram-feed",
  "twitter-landscape",
  "twitter-portrait",
] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
export const VIDEO_DEFAULT_RESOLUTION: VideoResolution = "full-hd";

/**
 * Only presets whose pixel size is documented are recorded. The rest stay null
 * until the status response reports the real output dimensions.
 */
export const VIDEO_RESOLUTION_DIMENSIONS: Partial<
  Record<VideoResolution, { width: number; height: number }>
> = {
  "full-hd": { width: 1920, height: 1080 },
};

export type VideoExportStatus = "pending" | "ready" | "failed";
/** Mirrors the provider's `movie.status`, plus its client-computed timeout. */
export type VideoProviderStatus = "pending" | "running" | "done" | "error" | "timeout";

/** Stable codes for a failed export row. Provider text is never stored here. */
export type VideoFailureCode =
  | "VIDEO_SCRIPT_NOT_APPROVED"
  | "VIDEO_NARRATION_STALE"
  | "VIDEO_NARRATION_OVERFLOW"
  | "VIDEO_MEDIA_NOT_READY"
  | "VIDEO_RENDER_TIMEOUT"
  | "VIDEO_RENDER_ABANDONED"
  | "VIDEO_JOB_NOT_FOUND"
  | "VIDEO_PROVIDER_REJECTED"
  | "VIDEO_PROVIDER_QUOTA"
  | "VIDEO_PROVIDER_UNAVAILABLE"
  | "VIDEO_OUTPUT_INVALID"
  | "VIDEO_OUTPUT_COPY_FAILED";

export interface VideoExportInput {
  projectRevision: number;
}

/** What a render will cost before a single provider call is made. */
export interface VideoEstimate {
  projectRevision: number;
  scenes: number;
  /** Scenes that will render as on-screen-text cards. */
  scenesWithoutVisual: number;
  durationSeconds: number;
  credits: number;
  resolution: VideoResolution;
  /** Null when the preset's pixel size is not documented. */
  width: number | null;
  height: number | null;
  rateVersion: string;
}

export interface VideoExportRecord {
  id: string;
  projectId: string;
  projectRevision: number;
  status: VideoExportStatus;
  provider: typeof VIDEO_PROVIDER;
  providerStatus: VideoProviderStatus | null;
  jobId: string | null;
  mediaId: string | null;
  outputKey: string | null;
  failureCode: VideoFailureCode | null;
  failureMessage: string | null;
  /** Measured from the stored MP4, never estimated. */
  durationSeconds: number | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  creditsEstimate: number;
  creditsConsumed: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface VideoUsageSummary {
  windowHours: number;
  creditsUsed: number;
  creditsLimit: number | null;
  resetAt: string | null;
}

export interface VideoEstimateResponse {
  ok: true;
  estimate: VideoEstimate;
  usage: VideoUsageSummary;
}

export interface VideoExportsResponse {
  ok: true;
  exports: VideoExportRecord[];
  usage: VideoUsageSummary;
}

export interface VideoExportResponse {
  ok: true;
  export: VideoExportRecord;
  /** The stored MP4, only once it is in private R2. */
  media: MediaRecord | null;
  usage: VideoUsageSummary;
}

export interface VideoExportUrlResponse {
  ok: true;
  url: string;
  expiresAt: string;
  contentType: string;
  byteSize: number;
}
