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
export function formatLimits(config: AppConfig): string {
  const video = config.video.maxBytes;
  const input = config.lipsync.maxInputBytes;
  const output = config.lipsync.maxOutputBytes;

  return `[storyframe] Limits: video.maxBytes=${video} (${mib(video)}) lipsync.maxInputBytes=${input} (${mib(input)}) lipsync.maxOutputBytes=${output} (${mib(output)})`;
}
