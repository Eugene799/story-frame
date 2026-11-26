import type { AppConfig } from "./config";

function mib(bytes: number): string {
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`;
}

/**
 * The one startup line that reports the byte caps actually in force.
 *
 * The deploy config lowers them below the code defaults for a 512 MB instance,
 * so the host's logs are the evidence that those limits — not the defaults —
 * are what the running process enforces.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/**
 * A production process bound to loopback is unreachable from the host's proxy,
 * and the symptom is a port-scan timeout rather than an error naming the bind,
 * so the mistake has to be called out where it is made.
 *
 * Returns null when there is nothing to warn about.
 */
export function formatBindWarning(host: string, nodeEnv: string | undefined): string | null {
  if (nodeEnv !== "production") return null;
  if (!LOOPBACK_HOSTS.has(host.trim().toLowerCase())) return null;

  return `[storyframe] WARNING: NODE_ENV=production but HOST=${host} is a loopback address, so the platform cannot reach this server. Set HOST=0.0.0.0.`;
}

export function formatLimits(config: AppConfig): string {
  const video = config.video.maxBytes;
  const input = config.lipsync.maxInputBytes;
  const output = config.lipsync.maxOutputBytes;

  return `[storyframe] Limits: video.maxBytes=${video} (${mib(video)}) lipsync.maxInputBytes=${input} (${mib(input)}) lipsync.maxOutputBytes=${output} (${mib(output)})`;
}
