import { ApiError } from "./api-error";
import type { ProjectDocumentV2 } from "../shared/project-contract";
import {
  JSON2VIDEO_RATE_VERSION,
  VIDEO_CREDITS_PER_SECOND,
  VIDEO_DEFAULT_RESOLUTION,
  VIDEO_DEFAULT_TIMING_TOLERANCE_SECONDS,
  VIDEO_MAX_SCENES,
  VIDEO_MOVIE_MAX_BYTES,
  VIDEO_RESOLUTIONS,
  VIDEO_RESOLUTION_DIMENSIONS,
  VIDEO_TEXT_MAX_CHARS,
  type VideoEstimate,
  type VideoExportInput,
  type VideoProviderStatus,
  type VideoResolution,
} from "../shared/video-contract";

/**
 * Phase 9: JSON2Video adapter, movie builder, and cost math.
 *
 * Two halves, both testable without a key or a network:
 * - a pure builder that turns a project document plus resolved input URLs into
 *   the provider's Movie JSON, and refuses anything it cannot render honestly;
 * - a thin adapter over POST/GET/DELETE /v2/movies that validates every
 *   response and never puts the API key or the provider's body text into a
 *   message this server surfaces.
 *
 * Output delivery is ours: JSON2Video only supports Amazon S3 destinations, so
 * R2 cannot receive the render and the server copies the finished MP4 itself.
 */

export const JSON2VIDEO_BASE_URL = "https://api.json2video.com/v2";
export const JSON2VIDEO_MOVIES_URL = `${JSON2VIDEO_BASE_URL}/movies`;
/** The provider never reports a render as failed before this age. */
export const JSON2VIDEO_RENDER_TIMEOUT_MS = 15 * 60 * 1000;

export interface Json2VideoSettings {
  apiKey: string | null;
}

export function loadJson2VideoSettings(env: NodeJS.ProcessEnv): Json2VideoSettings {
  const key = env.JSON2VIDEO_API_KEY?.trim();
  return { apiKey: key && key.length > 0 ? key : null };
}

/** A provider error that also says whether the same request is worth retrying. */
export class Json2VideoError extends ApiError {
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(status, code, message);
    this.name = "Json2VideoError";
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// Movie JSON
// ---------------------------------------------------------------------------

export interface Json2VideoVisualElement {
  type: "image" | "video";
  src: string;
  duration: -2;
  resize: "cover";
  position: "center-center";
  muted?: true;
}

export interface Json2VideoTextElement {
  type: "text";
  text: string;
  x: "center";
  y: "bottom";
}

export interface Json2VideoAudioElement {
  type: "audio";
  src: string;
  duration: -1 | -2;
  loop?: -1;
  volume: number;
  muted?: true;
}

export type Json2VideoElement =
  | Json2VideoVisualElement
  | Json2VideoTextElement
  | Json2VideoAudioElement;

export interface Json2VideoScene {
  duration: number;
  elements: Json2VideoElement[];
}

export interface Json2VideoMovie {
  resolution: VideoResolution;
  quality: "high";
  /** Correlates a poll result with our own row; hyphenated, as the API requires. */
  "client-data": { renderId: string; projectRevision: number };
  scenes: Json2VideoScene[];
  elements?: Json2VideoAudioElement[];
}

/** One scene's chosen visual, already resolved to a presigned GET URL. */
export interface VideoRenderVisual {
  kind: "image" | "video";
  url: string;
}

export interface VideoRenderAudio {
  url: string;
  volume: number;
  muted: boolean;
}

export interface BuildVideoMovieInput {
  renderId: string;
  projectRevision: number;
  document: ProjectDocumentV2;
  resolution: VideoResolution;
  maxSeconds: number;
  /** Keyed by scene id; a scene without an entry becomes an on-screen-text card. */
  visuals: Readonly<Record<string, VideoRenderVisual>>;
  narration: VideoRenderAudio | null;
  music: VideoRenderAudio | null;
}

export interface BuiltVideoMovie {
  movie: Json2VideoMovie;
  durationSeconds: number;
  scenesWithoutVisual: number;
  byteSize: number;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

/** Provider `src` must be a public http(s) URL; everything we hand it is https. */
function assertHttpsUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(422, "VIDEO_INPUT_INVALID", "A render input URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new ApiError(422, "VIDEO_INPUT_INVALID", "Render input URLs must use https.");
  }
}

/**
 * The render gate: a video may only be produced from approved, positively
 * timed scenes, within the provider's scene and duration bounds.
 */
export function assertRenderableDocument(
  document: ProjectDocumentV2,
  maxSeconds: number,
): number {
  const scenes = document.scenes;
  if (scenes.length === 0) {
    throw new ApiError(422, "VIDEO_TIMELINE_INVALID", "Add at least one scene before exporting a video.");
  }
  if (scenes.length > VIDEO_MAX_SCENES) {
    throw new ApiError(
      422,
      "VIDEO_TIMELINE_INVALID",
      `A render accepts at most ${VIDEO_MAX_SCENES} scenes; this document has ${scenes.length}.`,
    );
  }
  if (scenes.some((scene) => !scene.approved || scene.approvedFingerprint === null)) {
    throw new ApiError(
      409,
      "VIDEO_SCRIPT_NOT_APPROVED",
      "Approve every scene before exporting, so the video belongs to a fixed script.",
    );
  }

  let total = 0;
  scenes.forEach((scene, index) => {
    if (!Number.isFinite(scene.durationSeconds) || scene.durationSeconds <= 0) {
      throw new ApiError(
        422,
        "VIDEO_TIMELINE_INVALID",
        `Scene ${index + 1} needs a positive duration in seconds.`,
      );
    }
    total += scene.durationSeconds;
  });

  const durationSeconds = round3(total);
  if (durationSeconds < 1) {
    throw new ApiError(422, "VIDEO_TIMELINE_INVALID", "A render needs at least one second of scenes.");
  }
  if (durationSeconds > maxSeconds) {
    throw new ApiError(
      422,
      "VIDEO_TIMELINE_INVALID",
      `The scene timeline is ${durationSeconds}s, above the ${maxSeconds}s render limit.`,
    );
  }
  return durationSeconds;
}

/**
 * Speech is measured, not estimated, and it is never cut or sped up: a track
 * that does not fit is a refusal, not something to stretch.
 */
export function assertNarrationFits(
  narrationSeconds: number,
  timelineSeconds: number,
  toleranceSeconds: number = VIDEO_DEFAULT_TIMING_TOLERANCE_SECONDS,
): void {
  if (!Number.isFinite(narrationSeconds) || narrationSeconds < 0) {
    throw new ApiError(422, "VIDEO_TIMELINE_INVALID", "The measured narration duration is not usable.");
  }
  const tolerance =
    Number.isFinite(toleranceSeconds) && toleranceSeconds >= 0
      ? toleranceSeconds
      : VIDEO_DEFAULT_TIMING_TOLERANCE_SECONDS;
  if (narrationSeconds > timelineSeconds + tolerance) {
    throw new ApiError(
      409,
      "VIDEO_NARRATION_OVERFLOW",
      `Narration is ${round3(narrationSeconds)}s but the scene timeline is ${round3(timelineSeconds)}s. ` +
        "Edit the timing or the script so the audio is not cut.",
    );
  }
}

export function assertMovieFits(byteSize: number): void {
  if (byteSize > VIDEO_MOVIE_MAX_BYTES) {
    throw new ApiError(
      422,
      "VIDEO_MOVIE_TOO_LARGE",
      `The movie JSON is ${byteSize} bytes; JSON2Video accepts at most ${VIDEO_MOVIE_MAX_BYTES}.`,
    );
  }
}

function visualElement(visual: VideoRenderVisual): Json2VideoVisualElement {
  assertHttpsUrl(visual.url);
  return {
    type: visual.kind,
    src: visual.url,
    duration: -2,
    resize: "cover",
    position: "center-center",
    // A clip's own audio must not fight the narration or the music.
    ...(visual.kind === "video" ? { muted: true as const } : {}),
  };
}

function audioElement(audio: VideoRenderAudio, loop: boolean): Json2VideoAudioElement {
  assertHttpsUrl(audio.url);
  if (!Number.isFinite(audio.volume) || audio.volume < 0 || audio.volume > 10) {
    throw new ApiError(422, "VIDEO_AUDIO_INVALID", "Audio volume must be between 0 and 10.");
  }
  return {
    type: "audio",
    src: audio.url,
    // Narration plays its natural length; music fills the timeline and loops.
    duration: loop ? -2 : -1,
    ...(loop ? { loop: -1 as const } : {}),
    volume: audio.volume,
    ...(audio.muted ? { muted: true as const } : {}),
  };
}

/**
 * Builds the Movie JSON. Scene durations drive the timeline; on-screen text is
 * the document's own text, never generated subtitles. A scene with no visual
 * becomes a text-only card on the provider's default background.
 */
export function buildVideoMovie(input: BuildVideoMovieInput): BuiltVideoMovie {
  const durationSeconds = assertRenderableDocument(input.document, input.maxSeconds);
  let scenesWithoutVisual = 0;

  const scenes = input.document.scenes.map((scene) => {
    const elements: Json2VideoElement[] = [];
    const visual = input.visuals[scene.id];
    if (visual) {
      elements.push(visualElement(visual));
    } else {
      scenesWithoutVisual += 1;
    }

    const text = scene.onScreenText.trim();
    if (text.length > 0) {
      if (Array.from(text).length > VIDEO_TEXT_MAX_CHARS) {
        throw new ApiError(
          422,
          "VIDEO_TEXT_TOO_LONG",
          `On-screen text is limited to ${VIDEO_TEXT_MAX_CHARS} characters per scene.`,
        );
      }
      // Visual first, text on top of it.
      elements.push({ type: "text", text, x: "center", y: "bottom" });
    }

    return { duration: round3(scene.durationSeconds), elements };
  });

  const movieElements: Json2VideoAudioElement[] = [];
  if (input.narration) movieElements.push(audioElement(input.narration, false));
  if (input.music) movieElements.push(audioElement(input.music, true));

  const movie: Json2VideoMovie = {
    resolution: input.resolution,
    quality: "high",
    "client-data": { renderId: input.renderId, projectRevision: input.projectRevision },
    scenes,
    ...(movieElements.length > 0 ? { elements: movieElements } : {}),
  };

  const byteSize = Buffer.byteLength(JSON.stringify(movie), "utf8");
  assertMovieFits(byteSize);
  return { movie, durationSeconds, scenesWithoutVisual, byteSize };
}

export interface VideoEstimateInput {
  projectRevision: number;
  document: ProjectDocumentV2;
  resolution: VideoResolution;
  maxSeconds: number;
  visuals: Readonly<Record<string, VideoRenderVisual>>;
}

/** Cost preview. JSON2Video bills one credit per second, any resolution. */
export function estimateVideoExport(input: VideoEstimateInput): VideoEstimate {
  const durationSeconds = assertRenderableDocument(input.document, input.maxSeconds);
  const sizes = VIDEO_RESOLUTION_DIMENSIONS[input.resolution];
  return {
    projectRevision: input.projectRevision,
    scenes: input.document.scenes.length,
    scenesWithoutVisual: input.document.scenes.filter((scene) => !input.visuals[scene.id]).length,
    durationSeconds,
    credits: Math.ceil(durationSeconds * VIDEO_CREDITS_PER_SECOND),
    resolution: input.resolution,
    width: sizes?.width ?? null,
    height: sizes?.height ?? null,
    rateVersion: JSON2VIDEO_RATE_VERSION,
  };
}

export function parseVideoExportInput(input: unknown): VideoExportInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "INVALID_VIDEO_EXPORT", "Request body must be a JSON object.");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(["projectRevision"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNEXPECTED_FIELD", "Request body may only contain projectRevision.");
    }
  }
  const revision = record.projectRevision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new ApiError(400, "INVALID_VIDEO_EXPORT", "projectRevision must be a positive integer.");
  }
  return { projectRevision: revision };
}

/** `custom` is not accepted: the document has no canvas size to honour. */
export function resolveVideoResolution(raw: string | undefined): VideoResolution {
  const value = raw?.trim();
  if (!value) return VIDEO_DEFAULT_RESOLUTION;
  if (!(VIDEO_RESOLUTIONS as readonly string[]).includes(value)) {
    throw new Error(
      `VIDEO_RESOLUTION must be one of ${VIDEO_RESOLUTIONS.join(", ")}; received "${value}".`,
    );
  }
  return value as VideoResolution;
}

// ---------------------------------------------------------------------------
// HTTP adapter
// ---------------------------------------------------------------------------

export interface Json2VideoRequestOptions {
  settings: Json2VideoSettings;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}

export interface Json2VideoMovieStatus {
  project: string;
  status: VideoProviderStatus;
  success: boolean;
  message: string;
  url: string | null;
  thumbnail: string | null;
  durationSeconds: number | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  /** Null when the provider's breakdown shape yields no numeric total. */
  consumedCredits: number | null;
  createdAt: string | null;
}

const PROVIDER_STATUSES: readonly VideoProviderStatus[] = [
  "pending",
  "running",
  "done",
  "error",
  "timeout",
];

function apiKey(settings: Json2VideoSettings): string {
  if (!settings.apiKey) {
    throw new Json2VideoError(
      503,
      "VIDEO_PROVIDER_DISABLED",
      "JSON2Video export is disabled because JSON2VIDEO_API_KEY is not configured.",
      false,
    );
  }
  return settings.apiKey;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The credit entries are documented only as a "per-step breakdown" whose item
 * shape is not published. A breakdown is usable only when every entry is a
 * plain number: a single object entry makes the whole total null, so the
 * caller settles from the measured duration instead of under-counting spend.
 */
export function totalConsumedCredits(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!Array.isArray(value) || value.length === 0) return null;
  let total = 0;
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    total += entry;
  }
  return round3(total);
}

async function request(
  options: Json2VideoRequestOptions,
  url: string | URL,
  init: RequestInit,
  action: string,
): Promise<{ status: number; payload: unknown }> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new Json2VideoError(
      502,
      "VIDEO_PROVIDER_UNAVAILABLE",
      `JSON2Video could not be reached for ${action}.`,
      true,
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  return { status: response.status, payload };
}

/**
 * Maps a synchronous provider failure by HTTP status only: JSON2Video's error
 * strings are explicitly not stable identifiers, and its body is never echoed.
 */
function providerError(status: number, payload: unknown): Json2VideoError {
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const code = typeof body?.code === "string" ? body.code : null;

  if (status === 400) {
    return new Json2VideoError(
      422,
      "VIDEO_PROVIDER_REJECTED",
      "JSON2Video rejected the render request (HTTP 400); check the movie it was given.",
      false,
    );
  }
  if (status === 401) {
    return new Json2VideoError(
      429,
      "VIDEO_PROVIDER_QUOTA",
      "JSON2Video has no credits or plan quota left for a new render (HTTP 401).",
      false,
    );
  }
  if (status === 403) {
    if (code === "account_suspended") {
      return new Json2VideoError(
        429,
        "VIDEO_PROVIDER_QUOTA",
        "The JSON2Video account is paused because it is out of credits (HTTP 403).",
        false,
      );
    }
    return new Json2VideoError(
      502,
      "VIDEO_PROVIDER_UNAVAILABLE",
      "JSON2Video refused this API key's role for the request (HTTP 403).",
      false,
    );
  }
  if (status === 404) {
    return new Json2VideoError(
      422,
      "VIDEO_PROVIDER_REJECTED",
      "JSON2Video could not find the referenced resource (HTTP 404).",
      false,
    );
  }
  if (status === 409) {
    return new Json2VideoError(
      422,
      "VIDEO_PROVIDER_REJECTED",
      "JSON2Video reported a conflict for this request (HTTP 409).",
      false,
    );
  }
  if (status === 413) {
    return new Json2VideoError(
      422,
      "VIDEO_MOVIE_TOO_LARGE",
      "JSON2Video refused the movie JSON as too large (HTTP 413).",
      false,
    );
  }
  if (status >= 500) {
    return new Json2VideoError(
      502,
      "VIDEO_PROVIDER_UNAVAILABLE",
      `JSON2Video failed while handling the request (HTTP ${status}).`,
      true,
    );
  }
  return new Json2VideoError(
    422,
    "VIDEO_PROVIDER_REJECTED",
    `JSON2Video rejected the request (HTTP ${status}).`,
    false,
  );
}

export async function submitMovie(
  options: Json2VideoRequestOptions,
  movie: Json2VideoMovie,
): Promise<{ project: string }> {
  const key = apiKey(options.settings);
  const { status, payload } = await request(
    options,
    JSON2VIDEO_MOVIES_URL,
    {
      method: "POST",
      headers: {
        "x-api-key": key,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(movie),
    },
    "the render submission",
  );

  if (status < 200 || status >= 300) throw providerError(status, payload);

  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (!body || body.success !== true) {
    throw new Json2VideoError(
      502,
      "VIDEO_PROVIDER_UNAVAILABLE",
      "JSON2Video did not confirm the render submission.",
      true,
    );
  }
  const project = body.project;
  if (typeof project !== "string" || project.length !== 16) {
    throw new Json2VideoError(
      502,
      "VIDEO_PROVIDER_UNAVAILABLE",
      "JSON2Video returned an unreadable render id.",
      true,
    );
  }
  return { project };
}

/**
 * Reads one render. `timeout` is computed here because the provider keeps a
 * stuck render at `running` forever; callers treat it as fatal.
 */
export async function getMovie(
  options: Json2VideoRequestOptions,
  project: string,
  now: number = Date.now(),
): Promise<Json2VideoMovieStatus> {
  const key = apiKey(options.settings);
  const url = new URL(JSON2VIDEO_MOVIES_URL);
  url.searchParams.set("project", project);
  url.searchParams.set("format", "simple");

  const { status, payload } = await request(
    options,
    url,
    { method: "GET", headers: { "x-api-key": key, Accept: "application/json" } },
    "the render status",
  );

  // A single-project GET only answers 400 when the id is not this account's.
  if (status === 400) {
    throw new Json2VideoError(
      404,
      "VIDEO_JOB_NOT_FOUND",
      "JSON2Video does not know this render job.",
      false,
    );
  }
  if (status < 200 || status >= 300) throw providerError(status, payload);

  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const movie =
    body && body.success === true && body.movie && typeof body.movie === "object"
      ? (body.movie as Record<string, unknown>)
      : null;
  if (!movie) {
    throw new Json2VideoError(
      502,
      "VIDEO_PROVIDER_UNAVAILABLE",
      "JSON2Video returned an unreadable render status.",
      true,
    );
  }

  const rawStatus = movie.status;
  if (typeof rawStatus !== "string" || !(PROVIDER_STATUSES as readonly string[]).includes(rawStatus)) {
    throw new Json2VideoError(
      502,
      "VIDEO_PROVIDER_UNAVAILABLE",
      "JSON2Video returned an unknown render status.",
      true,
    );
  }

  const createdAt = stringOrNull(movie.created_at);
  let normalized = rawStatus as VideoProviderStatus;
  if (
    normalized === "running" &&
    createdAt !== null &&
    now - Date.parse(createdAt) > JSON2VIDEO_RENDER_TIMEOUT_MS
  ) {
    normalized = "timeout";
  }

  return {
    project: typeof movie.project === "string" ? movie.project : project,
    status: normalized,
    success: movie.success === true,
    message: typeof movie.message === "string" ? movie.message : "",
    url: stringOrNull(movie.url),
    thumbnail: stringOrNull(movie.thumbnail),
    durationSeconds: numberOrNull(movie.duration),
    byteSize: numberOrNull(movie.size),
    width: numberOrNull(movie.width),
    height: numberOrNull(movie.height),
    consumedCredits: totalConsumedCredits(movie.consumed_credits),
    createdAt,
  };
}

/** Best-effort delete of the provider's copy; false means it was already gone. */
export async function deleteMovie(
  options: Json2VideoRequestOptions,
  project: string,
): Promise<boolean> {
  const key = apiKey(options.settings);
  const url = new URL(JSON2VIDEO_MOVIES_URL);
  url.searchParams.set("project", project);

  const { status, payload } = await request(
    options,
    url,
    { method: "DELETE", headers: { "x-api-key": key, Accept: "application/json" } },
    "the render deletion",
  );

  if (status >= 200 && status < 300) return true;
  if (status === 404) return false;
  throw providerError(status, payload);
}
