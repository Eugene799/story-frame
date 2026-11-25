/**
 * Lip sync through Everypixel Labs.
 *
 * One source clip (a talking face) or one still portrait, plus a spoken audio
 * track, becomes a new video whose mouth matches the audio. Both media inputs
 * travel inside the JSON body as base64 Data URIs rather than as URLs, so every
 * bound here is expressed in bytes and seconds, and the provider's async task
 * is the only thing that carries state between requests.
 */

export const LIPSYNC_PROVIDER = "everypixel";
/** Bumped whenever the price or the accepted shapes below change. */
export const LIPSYNC_RATE_VERSION = "everypixel-lipsync-2026-11";

export const LIPSYNC_RESOLUTIONS = ["360p", "480p", "720p"] as const;
export type LipsyncResolution = (typeof LIPSYNC_RESOLUTIONS)[number];
export const LIPSYNC_DEFAULT_RESOLUTION: LipsyncResolution = "720p";

/** At 720p the provider accepts at most this much source video, and this much audio. */
export const LIPSYNC_MAX_SOURCE_SECONDS = 20;

/**
 * Published floor ("from $0.0075 per output second", 720p). 360p and 480p are
 * cheaper per the docs but no per-resolution figure is public, so the UI shows
 * an estimate at this rate and the settled cost is recomputed from the provider
 * only once a real invoice figure exists.
 */
export const LIPSYNC_ESTIMATE_USD_PER_SECOND = 0.0075;

/** Formats the provider documents for `audio_url`. */
export const LIPSYNC_AUDIO_CONTENT_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
  "audio/opus",
  "audio/aiff",
  "audio/x-aiff",
  "audio/x-ms-wma",
  "audio/webm",
  "audio/x-mid",
  "audio/midi",
  "audio/basic",
] as const;

/** Formats the provider documents for `video_url`. */
export const LIPSYNC_VIDEO_CONTENT_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/avi",
  "video/webm",
  "video/mpeg",
  "video/mpg",
  "video/x-m4v",
  "video/x-ms-wmv",
  "video/ogg",
] as const;

/**
 * The docs ask for "a clear portrait-style source image" without listing
 * formats; these are the still formats our media store already holds.
 */
export const LIPSYNC_IMAGE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Our own lifecycle for one lip sync, independent of the provider's words. */
export type LipsyncStatus = "pending" | "ready" | "failed";
/** Everypixel's task states, verbatim. */
export const LIPSYNC_PROVIDER_STATUSES = ["PENDING", "STARTED", "SUCCESS", "FAILURE", "REVOKED"] as const;
export type LipsyncProviderStatus = (typeof LIPSYNC_PROVIDER_STATUSES)[number];

export function isLipsyncResolution(value: unknown): value is LipsyncResolution {
  return typeof value === "string" && (LIPSYNC_RESOLUTIONS as readonly string[]).includes(value);
}

/** Which endpoint a source belongs to, decided by the bytes' own content type. */
export function lipsyncSourceKind(contentType: string): "video" | "image" | null {
  const normalised = contentType.trim().toLowerCase();
  if ((LIPSYNC_VIDEO_CONTENT_TYPES as readonly string[]).includes(normalised)) return "video";
  if ((LIPSYNC_IMAGE_CONTENT_TYPES as readonly string[]).includes(normalised)) return "image";
  return null;
}

export function isLipsyncAudio(contentType: string): boolean {
  return (LIPSYNC_AUDIO_CONTENT_TYPES as readonly string[]).includes(contentType.trim().toLowerCase());
}

/** Maps a provider task status onto ours; unknown words stay pending while the task lives. */
export function lipsyncStatusFromProvider(status: string): LipsyncStatus | null {
  switch (status) {
    case "PENDING":
    case "STARTED":
      return "pending";
    case "SUCCESS":
      return "ready";
    case "FAILURE":
    case "REVOKED":
      return "failed";
    default:
      return null;
  }
}

/**
 * Estimated cost at the published 720p floor. Lower resolutions are cheaper but
 * unpriced publicly, so the estimate deliberately does not guess a discount.
 */
export function lipsyncEstimateUsd(seconds: number): number {
  return Number((seconds * LIPSYNC_ESTIMATE_USD_PER_SECOND).toFixed(4));
}

/** Stable codes a failed export may carry, so the UI never parses prose. */
export const LIPSYNC_FAILURE_CODES = [
  "LIPSYNC_PROVIDER_DISABLED",
  "LIPSYNC_MEDIA_NOT_READY",
  "LIPSYNC_SOURCE_TOO_LONG",
  "LIPSYNC_INPUT_TOO_LARGE",
  "LIPSYNC_DAILY_LIMIT",
  "LIPSYNC_PROVIDER_FAILED",
  "LIPSYNC_OUTPUT_HOST",
  "LIPSYNC_OUTPUT_INVALID",
  "LIPSYNC_OUTPUT_TOO_LARGE",
  "LIPSYNC_STORAGE_LIMIT",
  "LIPSYNC_OUTPUT_COPY_FAILED",
  "LIPSYNC_ABANDONED",
] as const;
export type LipsyncFailureCode = (typeof LIPSYNC_FAILURE_CODES)[number];

export interface LipsyncExportRecord {
  id: string;
  projectId: string;
  status: LipsyncStatus;
  provider: typeof LIPSYNC_PROVIDER;
  providerStatus: string | null;
  sourceMediaId: string | null;
  audioMediaId: string | null;
  outputMediaId: string | null;
  resolution: LipsyncResolution;
  /** Reserved seconds: the provider's 20-second ceiling for one request. */
  secondsEstimate: number;
  secondsCounted: number | null;
  usdEstimate: number;
  byteSize: number | null;
  failureCode: LipsyncFailureCode | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LipsyncUsageSummary {
  windowHours: number;
  secondsUsed: number;
  secondsLimit: number | null;
  usdUsed: number;
  usdLimit: number | null;
  resetAt: string | null;
}

export interface LipsyncExportInput {
  sourceMediaId: string;
  audioMediaId: string;
  resolution: LipsyncResolution;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates the request body the routes accept; nothing optional hides here. */
export function parseLipsyncExportInput(input: unknown): LipsyncExportInput {
  const record = (input ?? {}) as Record<string, unknown>;
  const sourceMediaId = typeof record.sourceMediaId === "string" ? record.sourceMediaId.trim() : "";
  const audioMediaId = typeof record.audioMediaId === "string" ? record.audioMediaId.trim() : "";
  if (!UUID_PATTERN.test(sourceMediaId)) {
    throw new Error("sourceMediaId must be the id of a media asset in this project.");
  }
  if (!UUID_PATTERN.test(audioMediaId)) {
    throw new Error("audioMediaId must be the id of a media asset in this project.");
  }
  const resolution = record.resolution === undefined ? LIPSYNC_DEFAULT_RESOLUTION : record.resolution;
  if (!isLipsyncResolution(resolution)) {
    throw new Error("resolution must be 360p, 480p or 720p.");
  }
  return { sourceMediaId, audioMediaId, resolution };
}
