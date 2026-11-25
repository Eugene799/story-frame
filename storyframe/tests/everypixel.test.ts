import { describe, expect, it } from "vitest";
import {
  EVERYPIXEL_IMAGE_LIPSYNC_URL,
  EVERYPIXEL_STATUS_URL,
  EVERYPIXEL_VIDEO_LIPSYNC_URL,
  EverypixelError,
  loadEverypixelSettings,
  pollLipsync,
  submitLipsync,
} from "../server/everypixel";
import { lipsyncEstimateUsd, lipsyncSourceKind, lipsyncStatusFromProvider } from "../shared/lipsync-contract";

const settings = { clientId: "client-id", clientSecret: "client-secret" };
const audio = { bytes: new Uint8Array([1, 2, 3, 4]), contentType: "audio/mpeg" };
const video = { bytes: new Uint8Array([5, 6, 7]), contentType: "video/mp4" };

interface Call {
  url: URL;
  init: RequestInit;
}

function fakeFetch(responses: Array<{ status?: number; body: unknown }>): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next?.body ?? {}), {
      status: next?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Everypixel settings", () => {
  it("accepts EVERYPIXEL_SECRET_ID and EVERYPIXEL_CLIENT_SECRET by the same name", () => {
    expect(loadEverypixelSettings({ EVERYPIXEL_CLIENT_ID: "a", EVERYPIXEL_SECRET_ID: "b" })).toEqual({
      clientId: "a",
      clientSecret: "b",
    });
    expect(loadEverypixelSettings({ EVERYPIXEL_CLIENT_ID: "a", EVERYPIXEL_CLIENT_SECRET: "c" })).toEqual({
      clientId: "a",
      clientSecret: "c",
    });
    expect(loadEverypixelSettings({})).toEqual({ clientId: null, clientSecret: null });
  });
});

describe("Everypixel lip sync submit", () => {
  it("posts both inputs as data URIs with basic auth and returns the task", async () => {
    const { calls, fetchImpl } = fakeFetch([{ body: { task_id: "task-1", status: "PENDING" } }]);

    const task = await submitLipsync({
      settings,
      audio,
      source: video,
      sourceSeconds: 6,
      resolution: "480p",
      callbackUrl: "https://example.test/lipsync/callback",
      fetchImpl,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
    });

    expect(task).toEqual({ taskId: "task-1", providerStatus: "PENDING", status: "pending" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.toString()).toBe(EVERYPIXEL_VIDEO_LIPSYNC_URL);
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.audio_url).toBe(`data:audio/mpeg;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`);
    expect(body.video_url).toBe(`data:video/mp4;base64,${Buffer.from([5, 6, 7]).toString("base64")}`);
    expect(body.resolution).toBe("480p");
    expect(body.callback_url).toBe("https://example.test/lipsync/callback");
    expect(body.image_url).toBeUndefined();
  });

  it("uses the image endpoint for a still portrait and omits the callback by default", async () => {
    const { calls, fetchImpl } = fakeFetch([{ body: { task_id: "task-2", status: "STARTED" } }]);

    const task = await submitLipsync({
      settings,
      audio,
      source: { bytes: new Uint8Array([9]), contentType: "image/png" },
      sourceSeconds: 3,
      fetchImpl,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
    });

    expect(task.status).toBe("pending");
    expect(calls[0]?.url.toString()).toBe(EVERYPIXEL_IMAGE_LIPSYNC_URL);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.image_url).toBe(`data:image/png;base64,${Buffer.from([9]).toString("base64")}`);
    expect(body.video_url).toBeUndefined();
    expect(body.callback_url).toBeUndefined();
    expect(body.resolution).toBe("720p");
  });

  it("refuses an unconfigured provider before any request", async () => {
    const { calls, fetchImpl } = fakeFetch([{ body: {} }]);
    await expect(
      submitLipsync({
        settings: { clientId: null, clientSecret: null },
        audio,
        source: video,
        sourceSeconds: 4,
        fetchImpl,
        timeoutMs: 5000,
        maxInputBytes: 1024 * 1024,
      }),
    ).rejects.toMatchObject({ status: 503, code: "LIPSYNC_PROVIDER_DISABLED" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a source, audio format or length the provider cannot take", async () => {
    const base = { settings, audio, source: video, sourceSeconds: 4, timeoutMs: 5000, maxInputBytes: 1024 * 1024 };

    await expect(
      submitLipsync({ ...base, source: { bytes: new Uint8Array([1]), contentType: "image/gif" } }),
    ).rejects.toMatchObject({ status: 422, code: "LIPSYNC_SOURCE_INVALID" });

    await expect(
      submitLipsync({ ...base, audio: { bytes: new Uint8Array([1]), contentType: "audio/midi-none" } }),
    ).rejects.toMatchObject({ status: 422, code: "LIPSYNC_AUDIO_INVALID" });

    await expect(submitLipsync({ ...base, sourceSeconds: 20.01 })).rejects.toMatchObject({
      status: 422,
      code: "LIPSYNC_SOURCE_TOO_LONG",
    });

    await expect(
      submitLipsync({ ...base, maxInputBytes: 2 }),
    ).rejects.toMatchObject({ status: 422, code: "LIPSYNC_INPUT_TOO_LARGE" });

    await expect(
      submitLipsync({ ...base, resolution: "1080p" as unknown as "720p" }),
    ).rejects.toMatchObject({ status: 422, code: "LIPSYNC_RESOLUTION_INVALID" });
  });

  it("never surfaces the provider's own rejection text", async () => {
    const { fetchImpl } = fakeFetch([{ status: 401, body: { status: "error", message: "bad key client-secret" } }]);

    const failure = await submitLipsync({
      settings,
      audio,
      source: video,
      sourceSeconds: 4,
      fetchImpl,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EverypixelError);
    expect((failure as EverypixelError).status).toBe(502);
    expect((failure as EverypixelError).retryable).toBe(false);
    expect((failure as Error).message).toContain("401");
    expect((failure as Error).message).not.toContain("client-secret");
  });

  it("treats an unreachable provider as retryable", async () => {
    const fetchImpl = (() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch;

    const failure = await submitLipsync({
      settings,
      audio,
      source: video,
      sourceSeconds: 4,
      fetchImpl,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EverypixelError);
    expect((failure as EverypixelError).retryable).toBe(true);
    expect((failure as Error).message).not.toContain("socket");
  });
});

describe("Everypixel lip sync status", () => {
  it("reports a task that is still queued as pending", async () => {
    const { calls, fetchImpl } = fakeFetch([{ body: { task_id: "t", status: "STARTED", queue: 2 } }]);
    const state = await pollLipsync({ settings, taskId: "t", fetchImpl, timeoutMs: 5000 });

    expect(state).toMatchObject({ taskId: "t", status: "pending", resultUrl: null, error: null });
    expect(calls[0]?.url.pathname.endsWith("/status")).toBe(true);
    expect(calls[0]?.url.searchParams.get("task_id")).toBe("t");
    expect(calls[0]?.url.origin + calls[0]?.url.pathname).toBe(EVERYPIXEL_STATUS_URL);
  });

  it("returns the finished output URL intact, signature included", async () => {
    const result = "https://cdn.example.test/out/final.mp4?X-Amz-Signature=abc&Expires=99";
    const { fetchImpl } = fakeFetch([{ body: { task_id: "t", status: "SUCCESS", result } }]);

    const state = await pollLipsync({ settings, taskId: "t", fetchImpl, timeoutMs: 5000 });
    expect(state).toMatchObject({ status: "ready", resultUrl: result, error: null });
  });

  it("turns FAILURE and REVOKED into fixed failure reasons", async () => {
    const failed = await pollLipsync({
      settings,
      taskId: "t",
      fetchImpl: fakeFetch([{ body: { task_id: "t", status: "FAILURE" } }]).fetchImpl,
      timeoutMs: 5000,
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("clear face");
    expect(failed.resultUrl).toBeNull();

    const revoked = await pollLipsync({
      settings,
      taskId: "t",
      fetchImpl: fakeFetch([{ body: { task_id: "t", status: "REVOKED" } }]).fetchImpl,
      timeoutMs: 5000,
    });
    expect(revoked.status).toBe("failed");
    expect(revoked.error).toContain("cancelled");
  });

  it("rejects success without a usable https output", async () => {
    const { fetchImpl } = fakeFetch([{ body: { task_id: "t", status: "SUCCESS" } }]);
    await expect(pollLipsync({ settings, taskId: "t", fetchImpl, timeoutMs: 5000 })).rejects.toMatchObject({
      status: 502,
      code: "LIPSYNC_RESULT_INVALID",
    });

    const insecure = fakeFetch([{ body: { task_id: "t", status: "SUCCESS", result: "http://cdn.test/x.mp4" } }]);
    await expect(
      pollLipsync({ settings, taskId: "t", fetchImpl: insecure.fetchImpl, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: "LIPSYNC_RESULT_INVALID" });
  });

  it("rejects an unknown provider status instead of guessing", async () => {
    const { fetchImpl } = fakeFetch([{ body: { task_id: "t", status: "QUEUED_FOREVER" } }]);
    await expect(pollLipsync({ settings, taskId: "t", fetchImpl, timeoutMs: 5000 })).rejects.toMatchObject({
      code: "LIPSYNC_PROVIDER_RESPONSE_INVALID",
    });
  });

  it("rejects a create response with no task id", async () => {
    const { fetchImpl } = fakeFetch([{ body: { status: "PENDING" } }]);
    await expect(
      submitLipsync({
        settings,
        audio,
        source: video,
        sourceSeconds: 4,
        fetchImpl,
        timeoutMs: 5000,
        maxInputBytes: 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: "LIPSYNC_PROVIDER_RESPONSE_INVALID" });
  });
});

describe("lip sync contract helpers", () => {
  it("classifies sources and maps provider states", () => {
    expect(lipsyncSourceKind("video/quicktime")).toBe("video");
    expect(lipsyncSourceKind("image/webp")).toBe("image");
    expect(lipsyncSourceKind("image/gif")).toBeNull();
    expect(lipsyncStatusFromProvider("SUCCESS")).toBe("ready");
    expect(lipsyncStatusFromProvider("REVOKED")).toBe("failed");
    expect(lipsyncStatusFromProvider("WHAT")).toBeNull();
  });

  it("estimates from the published 720p floor without guessing cheaper tiers", () => {
    expect(lipsyncEstimateUsd(20)).toBe(0.15);
    expect(lipsyncEstimateUsd(6)).toBe(0.045);
  });
});
