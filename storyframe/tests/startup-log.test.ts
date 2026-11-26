import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config";
import { formatBindWarning, formatLimits } from "../server/startup-log";

// Pure: reads the deploy file, loads config from a literal env, formats a string.
// No provider, Supabase, R2, or server request is made.

const deployConfig = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");

function deployValue(key: string): string {
  const match = new RegExp(`${key}\\n\\s+value: "([^"]+)"`).exec(deployConfig);
  const value = match?.[1];
  if (value === undefined) throw new Error(`render.yaml does not set ${key} to a literal value`);
  return value;
}

describe("startup limits line", () => {
  it("reports the caps render.yaml deploys", () => {
    const caps = {
      VIDEO_MAX_BYTES: deployValue("VIDEO_MAX_BYTES"),
      LIPSYNC_MAX_INPUT_BYTES: deployValue("LIPSYNC_MAX_INPUT_BYTES"),
      LIPSYNC_MAX_OUTPUT_BYTES: deployValue("LIPSYNC_MAX_OUTPUT_BYTES"),
    };

    expect(caps).toEqual({
      VIDEO_MAX_BYTES: "67108864",
      LIPSYNC_MAX_INPUT_BYTES: "16777216",
      LIPSYNC_MAX_OUTPUT_BYTES: "67108864",
    });
    expect(formatLimits(loadConfig(caps))).toBe(
      "[storyframe] Limits: video.maxBytes=67108864 (64 MiB) lipsync.maxInputBytes=16777216 (16 MiB) lipsync.maxOutputBytes=67108864 (64 MiB)",
    );
  });

  it("reports the code defaults when nothing overrides them", () => {
    expect(formatLimits(loadConfig({}))).toBe(
      "[storyframe] Limits: video.maxBytes=268435456 (256 MiB) lipsync.maxInputBytes=26214400 (25 MiB) lipsync.maxOutputBytes=268435456 (256 MiB)",
    );
  });
});

describe("deploy build command", () => {
  it("installs devDependencies, which NODE_ENV=production makes npm ci skip", () => {
    const buildCommand = /^\s+buildCommand:\s*(.+)$/m.exec(deployConfig)?.[1]?.trim();

    // Without --include=dev the build fails with TS2688 for the type packages in
    // devDependencies; the fix belongs in the deploy file, not in each job.
    expect(buildCommand).toBe("npm ci --include=dev && npm run build");
  });
});

describe("production bind warning", () => {
  const defaultHost = "127.0.0.1";

  it("warns when production is bound to loopback instead of the platform address", () => {
    expect(formatBindWarning(defaultHost, "production")).toBe(
      "[storyframe] WARNING: NODE_ENV=production but HOST=127.0.0.1 is a loopback address, so the platform cannot reach this server. Set HOST=0.0.0.0.",
    );
    for (const host of ["localhost", "::1", "[::1]"]) {
      expect(formatBindWarning(host, "production")).not.toBeNull();
    }
  });

  it("stays quiet for a routable bind and outside production", () => {
    expect(formatBindWarning("0.0.0.0", "production")).toBeNull();
    expect(formatBindWarning(defaultHost, "development")).toBeNull();
    expect(formatBindWarning(defaultHost, undefined)).toBeNull();
  });
});
