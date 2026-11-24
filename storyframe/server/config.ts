import { resolveModels, type ResolvedModel } from "./models";
import { OLLAMA_BASE_URL } from "./ollama";

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
  models: ResolvedModel[];
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
    models: resolveModels(env),
  };
}
