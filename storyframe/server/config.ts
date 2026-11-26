import { resolveModels, type ResolvedModel } from "./models";
import { loadMediaLimits, type MediaLimits } from "./media";
import { loadStockLimits, type StockLimits } from "./stock";
import { resolveVideoResolution } from "./json2video";
import type { VideoLimits } from "./video-exports";
import type { LipsyncLimits } from "./lipsync";
import { OLLAMA_BASE_URL } from "./ollama";
import {
  MAX_PLANNING_PROVIDER_CALLS,
  resolvePlanningRoutes,
  type ResolvedPlanningRoute,
} from "./planning";
import type { R2Config } from "./r2";

export interface AppConfig {
  apiKey: string | null;
  supabaseUrl: string | null;
  supabasePublishableKey: string | null;
  supabaseServiceRoleKey: string | null;
  authTimeoutMs: number;
  allowedOrigin: string | null;
  promptMaxChars: number;
  bodyMaxBytes: number;
  providerTimeoutMs: number;
  maxOutputTokens: number;
  requestsPerMinute: number;
  abandonAfterMs: number;
  /** Covers the initial planning call plus its one repair. */
  planningAbandonAfterMs: number;
  models: ResolvedModel[];
  r2: R2Config | null;
  media: MediaLimits;
  /** Phase 6 provider keys, cache windows, and import bounds. */
  stock: StockLimits;
  /** Phase 7 generation bounds, polling, and the per-user spending guard. */
  image: {
    pollIntervalMs: number;
    pollTimeoutMs: number;
    downloadTimeoutMs: number;
    dailyImageLimit: number;
    dailyUsdLimit: number;
    spendWindowMs: number;
    pendingAbandonAfterMs: number;
    pendingSweepIntervalMs: number;
  };
  /** Phase 8 narration bounds. Credentials are loaded separately. */
  narration: {
    timeoutMs: number;
    maxAudioBytes: number;
    dailyCharLimit: number;
    dailyUsdLimit: number;
    usageWindowMs: number;
  };
  /** One configured model per planning route; see Phase 5 in the README. */
  planning: { routes: ResolvedPlanningRoute[] };
  /** Phase 9 render bounds, single-copy download limits, and the credit guard. */
  video: VideoLimits & { sweepIntervalMs: number };
  /** Lip sync bounds, output-host allowlist, and the seconds guard. */
  lipsync: LipsyncLimits;
  /** Durable advancement leases shared by every background sweep. */
  jobs: { leaseTtlMs: number };
}

function intEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function usdEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function stringEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function supabaseUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = stringEnv(env, "SUPABASE_URL");
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SUPABASE_URL must be a valid URL.");
  }

  const localHost = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) {
    throw new Error("SUPABASE_URL must use https outside local development.");
  }

  return raw.replace(/\/+$/, "");
}

function r2Config(env: NodeJS.ProcessEnv): R2Config | null {
  const endpoint = stringEnv(env, "R2_ENDPOINT") ?? stringEnv(env, "CLOUDFLARE_S3_ENDPOINT_URL");
  const bucket = stringEnv(env, "R2_BUCKET_NAME") ?? stringEnv(env, "CLOUDFLARE_R2_BUCKET_NAME");
  const accessKeyId = stringEnv(env, "R2_ACCESS_KEY_ID") ?? stringEnv(env, "CLOUDFLARE_ACCESS_ID");
  const secretAccessKey = stringEnv(env, "R2_SECRET_ACCESS_KEY") ?? stringEnv(env, "CLOUDFLARE_SECRET_ACCESS_KEY");
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("R2_ENDPOINT must be a valid URL.");
  }
  const localHost = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) {
    throw new Error("R2_ENDPOINT must use https outside local development.");
  }

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configuredBase = env.OLLAMA_BASE_URL?.trim();
  if (configuredBase && configuredBase.replace(/\/+$/, "") !== OLLAMA_BASE_URL) {
    throw new Error(`OLLAMA_BASE_URL must be ${OLLAMA_BASE_URL}`);
  }

  const providerTimeoutMs = intEnv(env, "AI_TIMEOUT_MS", 30000, 1000, 120000);
  const authTimeoutMs = intEnv(env, "AUTH_TIMEOUT_MS", 5000, 1000, 15000);
  // A reservation must never be abandoned while its request could still be
  // running: session check + reservation + provider call + completion.
  const abandonAfterMs = Math.max(
    intEnv(env, "AI_ABANDON_AFTER_MS", 90000, 30000, 3600000),
    providerTimeoutMs + 3 * authTimeoutMs,
  );
  const planningAbandonAfterMs = Math.max(
    abandonAfterMs,
    MAX_PLANNING_PROVIDER_CALLS * providerTimeoutMs + 3 * authTimeoutMs,
  );

  const media = loadMediaLimits(env);

  return {
    apiKey: stringEnv(env, "OLLAMA_API_KEY"),
    supabaseUrl: supabaseUrl(env),
    supabasePublishableKey:
      stringEnv(env, "SUPABASE_PUBLISHABLE_KEY") ?? stringEnv(env, "SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: stringEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    authTimeoutMs,
    allowedOrigin: stringEnv(env, "APP_ORIGIN"),
    promptMaxChars: intEnv(env, "AI_MAX_PROMPT_CHARS", 500, 1, 2000),
    bodyMaxBytes: intEnv(env, "AI_MAX_BODY_BYTES", 4096, 256, 65536),
    providerTimeoutMs,
    maxOutputTokens: intEnv(env, "AI_MAX_OUTPUT_TOKENS", 120, 16, 512),
    requestsPerMinute: intEnv(env, "AI_MAX_REQUESTS_PER_MINUTE", 6, 1, 60),
    abandonAfterMs,
    planningAbandonAfterMs,
    models: resolveModels(env),
    r2: r2Config(env),
    media,
    stock: loadStockLimits(env, media),
    image: {
      pollIntervalMs: intEnv(env, "IMAGE_POLL_INTERVAL_MS", 1500, 100, 10000),
      pollTimeoutMs: intEnv(env, "IMAGE_GENERATION_TIMEOUT_MS", 60000, 1000, 300000),
      downloadTimeoutMs: intEnv(env, "IMAGE_DOWNLOAD_TIMEOUT_MS", 30000, 1000, 120000),
      // A rolling 24-hour cap per account. Zero disables that dimension.
      dailyImageLimit: intEnv(env, "IMAGE_DAILY_IMAGES_PER_USER", 20, 0, 1000),
      dailyUsdLimit: usdEnv(env, "IMAGE_DAILY_USD_PER_USER", 1, 0, 1000),
      spendWindowMs: 24 * 60 * 60 * 1000,
      // A job whose provider no longer reports back is settled so it cannot
      // block the account forever.
      pendingAbandonAfterMs: intEnv(env, "IMAGE_PENDING_ABANDON_AFTER_MS", 15 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
      pendingSweepIntervalMs: intEnv(env, "IMAGE_PENDING_SWEEP_INTERVAL_MS", 60_000, 0, 60 * 60 * 1000),
    },
    narration: {
      timeoutMs: intEnv(env, "NARRATION_TIMEOUT_MS", 60_000, 1_000, 180_000),
      maxAudioBytes: intEnv(env, "NARRATION_MAX_AUDIO_BYTES", 25 * 1024 * 1024, 1024, 100 * 1024 * 1024),
      // Rolling 24-hour guard. Zero disables that dimension. Previews count too.
      dailyCharLimit: intEnv(env, "NARRATION_DAILY_CHARS_PER_USER", 100_000, 0, 10_000_000),
      dailyUsdLimit: usdEnv(env, "NARRATION_DAILY_USD_PER_USER", 3, 0, 1000),
      usageWindowMs: 24 * 60 * 60 * 1000,
    },
    planning: { routes: planningRoutes(env) },
    video: {
      resolution: resolveVideoResolution(env.VIDEO_RESOLUTION),
      timeoutMs: intEnv(env, "VIDEO_TIMEOUT_MS", 30_000, 5_000, 120_000),
      // Zero disables the timer; the tests use a short cadence instead.
      sweepIntervalMs: intEnv(env, "VIDEO_SWEEP_INTERVAL_MS", 60_000, 0, 600_000),
      // Never below the provider's own 15-minute timeout.
      renderTimeoutMs: intEnv(env, "VIDEO_RENDER_TIMEOUT_MS", 20 * 60 * 1000, 15 * 60 * 1000, 6 * 60 * 60 * 1000),
      abandonAfterMs: intEnv(env, "VIDEO_ABANDON_AFTER_MS", 45 * 60 * 1000, 15 * 60 * 1000, 12 * 60 * 60 * 1000),
      // Must outlive queueing plus the render window; the floor is 20 minutes.
      inputUrlSeconds: intEnv(env, "VIDEO_INPUT_URL_SECONDS", 7_200, 1_200, 604_800),
      downloadTimeoutMs: intEnv(env, "VIDEO_DOWNLOAD_TIMEOUT_MS", 60_000, 5_000, 300_000),
      maxBytes: intEnv(env, "VIDEO_MAX_BYTES", 256 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024),
      maxSeconds: intEnv(env, "VIDEO_MAX_SECONDS", 600, 1, 3600),
      timingToleranceSeconds: usdEnv(env, "VIDEO_TIMING_TOLERANCE_SECONDS", 0.5, 0, 5),
      // Rolling 24-hour credit window. Zero disables the dimension.
      dailyCreditsLimit: intEnv(env, "VIDEO_DAILY_CREDITS_PER_USER", 600, 0, 100_000),
      spendWindowMs: 24 * 60 * 60 * 1000,
    },
    // How long a crashed holder's lease survives. Each pass renews its lease,
    // so this bounds recovery after a crash, not the length of a pass.
    jobs: { leaseTtlMs: intEnv(env, "JOB_LEASE_TTL_MS", 90_000, 30_000, 3_600_000) },
    lipsync: {
      timeoutMs: intEnv(env, "LIPSYNC_TIMEOUT_MS", 60_000, 5_000, 180_000),
      // The provider queues sequentially, so a status read every few seconds is plenty.
      pollIntervalMs: intEnv(env, "LIPSYNC_POLL_INTERVAL_MS", 5_000, 0, 120_000),
      sweepIntervalMs: intEnv(env, "LIPSYNC_SWEEP_INTERVAL_MS", 10_000, 0, 600_000),
      abandonAfterMs: intEnv(env, "LIPSYNC_ABANDON_AFTER_MS", 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
      downloadTimeoutMs: intEnv(env, "LIPSYNC_DOWNLOAD_TIMEOUT_MS", 60_000, 5_000, 300_000),
      // Both inputs are inlined as base64, so this stays well below the media cap.
      maxInputBytes: intEnv(env, "LIPSYNC_MAX_INPUT_BYTES", 25 * 1024 * 1024, 1024, 100 * 1024 * 1024),
      maxOutputBytes: intEnv(env, "LIPSYNC_MAX_OUTPUT_BYTES", 256 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024),
      redirectLimit: intEnv(env, "LIPSYNC_REDIRECTS", 3, 0, 5),
      // Extra hosts beyond everypixel.com, so a real output host can be pinned
      // without a redeploy. Empty by default: only Everypixel is trusted.
      outputHosts: (env.LIPSYNC_OUTPUT_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0),
      // Rolling 24-hour guard in provider seconds. Zero disables the dimension.
      dailySecondsLimit: intEnv(env, "LIPSYNC_DAILY_SECONDS_PER_USER", 600, 0, 100_000),
      dailyUsdLimit: usdEnv(env, "LIPSYNC_DAILY_USD_PER_USER", 5, 0, 1000),
      spendWindowMs: 24 * 60 * 60 * 1000,
    },
  };
}

function planningRoutes(env: NodeJS.ProcessEnv): ResolvedPlanningRoute[] {
  return resolvePlanningRoutes(env, resolveModels(env));
}
