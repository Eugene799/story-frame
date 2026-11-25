import { ApiError } from "./api-error";
import {
  LIPSYNC_DEFAULT_RESOLUTION,
  LIPSYNC_MAX_SOURCE_SECONDS,
  isLipsyncAudio,
  isLipsyncResolution,
  lipsyncSourceKind,
  lipsyncStatusFromProvider,
  type LipsyncProviderStatus,
  type LipsyncResolution,
  type LipsyncStatus,
} from "../shared/lipsync-contract";

/**
 * Everypixel Labs lip sync adapter.
 *
 * Two calls and no state of its own:
 * - POST /v1/video_lipsync or /v1/image_lipsync with both media inputs inlined
 *   as base64 Data URIs, authenticated with HTTP Basic (client id and secret);
 * - GET /v1/status?task_id= until the task reaches a terminal state.
 *
 * The provider never receives a URL from us and we never trust its bodies: any
 * provider text is dropped in favour of a stable code plus the HTTP status, so
 * an echoed key or an upstream stack trace cannot reach a client.
 */

export const EVERYPIXEL_API_BASE = "https://api.everypixel.com/v1";
export const EVERYPIXEL_VIDEO_LIPSYNC_URL = `${EVERYPIXEL_API_BASE}/video_lipsync`;
export const EVERYPIXEL_IMAGE_LIPSYNC_URL = `${EVERYPIXEL_API_BASE}/image_lipsync`;
export const EVERYPIXEL_STATUS_URL = `${EVERYPIXEL_API_BASE}/status`;

export interface EverypixelSettings {
  clientId: string | null;
  clientSecret: string | null;
}

/**
 * EVERYPIXEL_SECRET_ID is the name this project already carries; the docs call
 * it the client secret, so both spellings are accepted and neither is logged.
 */
export function loadEverypixelSettings(env: NodeJS.ProcessEnv): EverypixelSettings {
  const clientId = env.EVERYPIXEL_CLIENT_ID?.trim();
  const clientSecret = (env.EVERYPIXEL_SECRET_ID ?? env.EVERYPIXEL_CLIENT_SECRET)?.trim();
  return {
    clientId: clientId && clientId.length > 0 ? clientId : null,
    clientSecret: clientSecret && clientSecret.length > 0 ? clientSecret : null,
  };
}

export function everypixelConfigured(settings: EverypixelSettings): boolean {
  return settings.clientId !== null && settings.clientSecret !== null;
}

/** A provider error that also says whether an identical request is worth retrying. */
export class EverypixelError extends ApiError {
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(status, code, message);
    this.name = "EverypixelError";
    this.retryable = retryable;
  }
}

function authorization(settings: EverypixelSettings): string {
  const encoded = Buffer.from(`${settings.clientId}:${settings.clientSecret}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

export interface LipsyncMedia {
  /** Raw file bytes, already fetched from private storage. */
  bytes: Uint8Array;
  contentType: string;
}

export interface SubmitLipsyncOptions {
  settings: EverypixelSettings;
  audio: LipsyncMedia;
  /** A talking-head clip or a still portrait; its type decides the endpoint. */
  source: LipsyncMedia;
  /** Spoken length, used for limits and the estimate. */
  sourceSeconds: number;
  resolution?: LipsyncResolution;
  callbackUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  /** Largest single input we will inline; base64 adds a third on top. */
  maxInputBytes: number;
}

export interface LipsyncTask {
  taskId: string;
  providerStatus: LipsyncProviderStatus;
  status: LipsyncStatus;
}

export function toDataUri(media: LipsyncMedia): string {
  const contentType = media.contentType.trim().toLowerCase();
  return `data:${contentType};base64,${Buffer.from(media.bytes).toString("base64")}`;
}

function providerStatusOf(body: unknown): { taskId: string; providerStatus: string } {
  const record = body as { task_id?: unknown; status?: unknown } | null;
  const taskId = typeof record?.task_id === "string" ? record.task_id.trim() : "";
  const status = typeof record?.status === "string" ? record.status.trim().toUpperCase() : "";
  if (taskId.length === 0) {
    throw new EverypixelError(502, "LIPSYNC_PROVIDER_RESPONSE_INVALID", "Everypixel returned no task id.", false);
  }
  return { taskId, providerStatus: status };
}

export async function submitLipsync(options: SubmitLipsyncOptions): Promise<LipsyncTask> {
  if (!everypixelConfigured(options.settings)) {
    throw new ApiError(
      503,
      "LIPSYNC_PROVIDER_DISABLED",
      "Everypixel lip sync is disabled because EVERYPIXEL_CLIENT_ID or EVERYPIXEL_SECRET_ID is not configured.",
    );
  }

  const kind = lipsyncSourceKind(options.source.contentType);
  if (kind === null) {
    throw new ApiError(
      422,
      "LIPSYNC_SOURCE_INVALID",
      `${options.source.contentType} is not a source Everypixel lip sync accepts; use an MP4/MOV/WebM clip or a PNG/JPEG/WebP portrait.`,
    );
  }
  if (!isLipsyncAudio(options.audio.contentType)) {
    throw new ApiError(
      422,
      "LIPSYNC_AUDIO_INVALID",
      `${options.audio.contentType} is not an audio format Everypixel lip sync accepts.`,
    );
  }
  if (options.sourceSeconds <= 0 || options.sourceSeconds > LIPSYNC_MAX_SOURCE_SECONDS) {
    throw new ApiError(
      422,
      "LIPSYNC_SOURCE_TOO_LONG",
      `Everypixel lip sync accepts at most ${LIPSYNC_MAX_SOURCE_SECONDS} seconds of source media; this is ${options.sourceSeconds.toFixed(2)}s.`,
    );
  }
  for (const media of [options.audio, options.source]) {
    if (media.bytes.byteLength > options.maxInputBytes) {
      throw new ApiError(
        422,
        "LIPSYNC_INPUT_TOO_LARGE",
        `Lip sync inlines its inputs, so one file may be at most ${Math.floor(options.maxInputBytes / (1024 * 1024))} MB; this one is ${(media.bytes.byteLength / (1024 * 1024)).toFixed(1)} MB.`,
      );
    }
  }

  const resolution = options.resolution ?? LIPSYNC_DEFAULT_RESOLUTION;
  if (!isLipsyncResolution(resolution)) {
    throw new ApiError(422, "LIPSYNC_RESOLUTION_INVALID", `Everypixel lip sync renders 360p, 480p or 720p, not ${resolution}.`);
  }

  const body: Record<string, unknown> = {
    audio_url: toDataUri(options.audio),
    resolution,
  };
  body[kind === "video" ? "video_url" : "image_url"] = toDataUri(options.source);
  if (options.callbackUrl) body.callback_url = options.callbackUrl;

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(kind === "video" ? EVERYPIXEL_VIDEO_LIPSYNC_URL : EVERYPIXEL_IMAGE_LIPSYNC_URL, {
      method: "POST",
      headers: {
        Authorization: authorization(options.settings),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new EverypixelError(502, "LIPSYNC_PROVIDER_FAILED", "Everypixel could not be reached.", true);
  }

  if (!response.ok) {
    // The body can echo the request, including the inline media; never read it into a message.
    await response.arrayBuffer().catch(() => undefined);
    const retryable = response.status === 502 || response.status === 429 || response.status >= 500;
    throw new EverypixelError(
      502,
      "LIPSYNC_PROVIDER_FAILED",
      response.status === 401
        ? "Everypixel rejected the credentials (HTTP 401)."
        : response.status === 429
          ? "Everypixel refused the request because the account is out of quota (HTTP 429)."
          : `Everypixel rejected the lip sync request (HTTP ${response.status}).`,
      retryable,
    );
  }

  const parsed = await response.json().catch(() => null);
  const { taskId, providerStatus } = providerStatusOf(parsed);
  const status = lipsyncStatusFromProvider(providerStatus);
  if (status !== "pending") {
    throw new EverypixelError(
      502,
      "LIPSYNC_PROVIDER_RESPONSE_INVALID",
      `Everypixel created a task that is already ${providerStatus || "unknown"}.`,
      false,
    );
  }
  return { taskId, providerStatus: providerStatus as LipsyncProviderStatus, status };
}

export interface PollLipsyncOptions {
  settings: EverypixelSettings;
  taskId: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}

export interface LipsyncTaskState {
  taskId: string;
  providerStatus: string;
  status: LipsyncStatus;
  /** Present only when ready: the provider's own output URL, which we copy and never expose. */
  resultUrl: string | null;
  /** Our fixed explanation when the task failed. */
  error: string | null;
}

export async function pollLipsync(options: PollLipsyncOptions): Promise<LipsyncTaskState> {
  if (!everypixelConfigured(options.settings)) {
    throw new ApiError(
      503,
      "LIPSYNC_PROVIDER_DISABLED",
      "Everypixel lip sync is disabled because EVERYPIXEL_CLIENT_ID or EVERYPIXEL_SECRET_ID is not configured.",
    );
  }

  const url = new URL(EVERYPIXEL_STATUS_URL);
  url.searchParams.set("task_id", options.taskId);

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { Authorization: authorization(options.settings) },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new EverypixelError(502, "LIPSYNC_PROVIDER_FAILED", "Everypixel could not be reached.", true);
  }

  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new EverypixelError(
      502,
      "LIPSYNC_PROVIDER_FAILED",
      `Everypixel refused the status request (HTTP ${response.status}).`,
      response.status === 429 || response.status >= 500,
    );
  }

  const parsed = (await response.json().catch(() => null)) as
    | { task_id?: unknown; status?: unknown; result?: unknown }
    | null;
  const providerStatus = typeof parsed?.status === "string" ? parsed.status.trim().toUpperCase() : "";
  const status = lipsyncStatusFromProvider(providerStatus);
  if (status === null) {
    throw new EverypixelError(
      502,
      "LIPSYNC_PROVIDER_RESPONSE_INVALID",
      `Everypixel reported an unexpected task status (${providerStatus || "empty"}).`,
      false,
    );
  }

  if (status === "pending") {
    return { taskId: options.taskId, providerStatus, status, resultUrl: null, error: null };
  }

  if (status === "failed") {
    return {
      taskId: options.taskId,
      providerStatus,
      status,
      resultUrl: null,
      error:
        providerStatus === "REVOKED"
          ? "Everypixel cancelled this lip sync before it finished."
          : "Everypixel could not finish this lip sync; the source may have no clear face.",
    };
  }

  const raw = typeof parsed?.result === "string" ? parsed.result.trim() : "";
  let resultUrl: string;
  try {
    const parsedUrl = new URL(raw);
    if (parsedUrl.protocol !== "https:") throw new Error("not https");
    // Kept whole: provider output links are usually signed, so their query is part of the file address.
    resultUrl = parsedUrl.href;
  } catch {
    throw new EverypixelError(502, "LIPSYNC_RESULT_INVALID", "Everypixel reported success without a usable output URL.", true);
  }
  return { taskId: options.taskId, providerStatus, status, resultUrl, error: null };
}
