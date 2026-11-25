import { describe, expect, it, vi } from "vitest";
import {
  JSON2VIDEO_MOVIES_URL,
  JSON2VIDEO_RENDER_TIMEOUT_MS,
  Json2VideoError,
  deleteMovie,
  getMovie,
  loadJson2VideoSettings,
  resolveVideoResolution,
  submitMovie,
  totalConsumedCredits,
  type Json2VideoMovie,
  type Json2VideoSettings,
} from "../server/json2video";

const SETTINGS: Json2VideoSettings = { apiKey: "j2v-secret" };

const MOVIE: Json2VideoMovie = {
  resolution: "full-hd",
  quality: "high",
  "client-data": { renderId: "render-1", projectRevision: 2 },
  scenes: [{ duration: 3, elements: [] }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function options(fetchImpl: typeof fetch, apiKey: string | null = SETTINGS.apiKey) {
  return { settings: { apiKey }, fetchImpl, timeoutMs: 1000 };
}

describe("JSON2Video adapter", () => {
  it("posts the movie to /v2/movies with the x-api-key header", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, project: "JkGxEoPRF9EgRb32", timestamp: "2026-11-25T10:00:00.000Z" }),
    ) as unknown as typeof fetch;

    const result = await submitMovie(options(fetchImpl), MOVIE);

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(String(url)).toBe(JSON2VIDEO_MOVIES_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("j2v-secret");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(MOVIE);
    expect(result).toEqual({ project: "JkGxEoPRF9EgRb32" });
  });

  it("refuses without a key and never calls the provider", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(submitMovie(options(fetchImpl, null), MOVIE)).rejects.toMatchObject({
      status: 503,
      code: "VIDEO_PROVIDER_DISABLED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a validation rejection without echoing the provider body", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ success: false, message: "bad key j2v-secret in Scene #1" }, 400)) as unknown as typeof fetch;

    const error = await submitMovie(options(fetchImpl), MOVIE).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Json2VideoError);
    expect(error).toMatchObject({ status: 422, code: "VIDEO_PROVIDER_REJECTED", retryable: false });
    expect(String((error as Error).message)).not.toContain("j2v-secret");
    expect(String((error as Error).message)).not.toContain("Scene #1");
  });

  it("distinguishes a quota refusal from a suspended account and a bad role", async () => {
    const quota = (async () =>
      jsonResponse({ success: false, message: "no credits" }, 401)) as unknown as typeof fetch;
    await expect(submitMovie(options(quota), MOVIE)).rejects.toMatchObject({
      status: 429,
      code: "VIDEO_PROVIDER_QUOTA",
    });

    const suspended = (async () =>
      jsonResponse({ success: false, code: "account_suspended" }, 403)) as unknown as typeof fetch;
    await expect(submitMovie(options(suspended), MOVIE)).rejects.toMatchObject({
      status: 429,
      code: "VIDEO_PROVIDER_QUOTA",
    });

    const role = (async () =>
      jsonResponse({ success: false, message: "Insufficient permissions" }, 403)) as unknown as typeof fetch;
    await expect(submitMovie(options(role), MOVIE)).rejects.toMatchObject({
      status: 502,
      code: "VIDEO_PROVIDER_UNAVAILABLE",
      retryable: false,
    });
  });

  it("maps an oversized movie and retries only server failures", async () => {
    const tooLarge = (async () =>
      jsonResponse({ success: false, message: "too large" }, 413)) as unknown as typeof fetch;
    await expect(submitMovie(options(tooLarge), MOVIE)).rejects.toMatchObject({
      status: 422,
      code: "VIDEO_MOVIE_TOO_LARGE",
    });

    const serverError = (async () =>
      jsonResponse({ success: false, message: "try again" }, 500)) as unknown as typeof fetch;
    await expect(submitMovie(options(serverError), MOVIE)).rejects.toMatchObject({
      status: 502,
      code: "VIDEO_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
  });

  it("treats an unreachable provider as retryable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    await expect(submitMovie(options(fetchImpl), MOVIE)).rejects.toMatchObject({
      status: 502,
      code: "VIDEO_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
  });

  it("rejects an unconfirmed or unreadable submission", async () => {
    const unconfirmed = (async () =>
      jsonResponse({ success: false, project: "JkGxEoPRF9EgRb32" })) as unknown as typeof fetch;
    await expect(submitMovie(options(unconfirmed), MOVIE)).rejects.toMatchObject({
      code: "VIDEO_PROVIDER_UNAVAILABLE",
    });

    const shortId = (async () => jsonResponse({ success: true, project: "short" })) as unknown as typeof fetch;
    await expect(submitMovie(options(shortId), MOVIE)).rejects.toMatchObject({
      code: "VIDEO_PROVIDER_UNAVAILABLE",
    });
  });

  it("reads one render with format=simple and normalizes the fields", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        success: true,
        movie: {
          success: true,
          status: "done",
          message: "",
          project: "JkGxEoPRF9EgRb32",
          url: "https://assets.json2video.com/clients/x/renders/one.mp4",
          thumbnail: "https://assets.json2video.com/clients/x/renders/one.jpg",
          created_at: "2026-11-25T10:00:00.000Z",
          ended_at: "2026-11-25T10:02:00.000Z",
          duration: 12.5,
          size: 1234567,
          width: 1920,
          height: 1080,
          consumed_credits: [12.5, { step: "render", credits: 99 }],
        },
        remaining_quota: { time: 600 },
      })) as unknown as typeof fetch;

    const status = await getMovie(options(fetchImpl), "JkGxEoPRF9EgRb32", Date.parse("2026-11-25T10:05:00.000Z"));

    const [url, init] = (fetchImpl as any).mock.calls[0];
    const parsed = new URL(String(url));
    expect(`${parsed.origin}${parsed.pathname}`).toBe(JSON2VIDEO_MOVIES_URL);
    expect(parsed.searchParams.get("project")).toBe("JkGxEoPRF9EgRb32");
    expect(parsed.searchParams.get("format")).toBe("simple");
    expect(init.headers["x-api-key"]).toBe("j2v-secret");

    expect(status).toMatchObject({
      status: "done",
      success: true,
      durationSeconds: 12.5,
      byteSize: 1234567,
      width: 1920,
      height: 1080,
      // A mixed breakdown is unusable, so the caller settles from duration.
      consumedCredits: null,
      createdAt: "2026-11-25T10:00:00.000Z",
    });
  });

  it("computes the 15-minute timeout for a stuck render", async () => {
    const createdAt = "2026-11-25T10:00:00.000Z";
    const fetchImpl = (async () =>
      jsonResponse({
        success: true,
        movie: { success: true, status: "running", message: "", project: "JkGxEoPRF9EgRb32", created_at: createdAt },
      })) as unknown as typeof fetch;

    const stillRunning = await getMovie(options(fetchImpl), "JkGxEoPRF9EgRb32", Date.parse(createdAt) + 1000);
    expect(stillRunning.status).toBe("running");

    const stuck = await getMovie(
      options(fetchImpl),
      "JkGxEoPRF9EgRb32",
      Date.parse(createdAt) + JSON2VIDEO_RENDER_TIMEOUT_MS + 1000,
    );
    expect(stuck.status).toBe("timeout");
  });

  it("keeps a failed render's message and rejects an unknown status", async () => {
    const failed = (async () =>
      jsonResponse({
        success: true,
        movie: { success: false, status: "error", message: "media fetch failed", project: "JkGxEoPRF9EgRb32" },
      })) as unknown as typeof fetch;

    const status = await getMovie(options(failed), "JkGxEoPRF9EgRb32");
    expect(status).toMatchObject({ status: "error", success: false, message: "media fetch failed", url: null });

    const unknown = (async () =>
      jsonResponse({
        success: true,
        movie: { success: true, status: "almost-done", message: "", project: "JkGxEoPRF9EgRb32" },
      })) as unknown as typeof fetch;
    await expect(getMovie(options(unknown), "JkGxEoPRF9EgRb32")).rejects.toMatchObject({
      code: "VIDEO_PROVIDER_UNAVAILABLE",
    });
  });

  it("treats a 400 on a single-project read as a job that does not exist", async () => {
    const missing = (async () =>
      jsonResponse({ success: false, message: "Movie JkGxEoPRF9EgRb32 not found." }, 400)) as unknown as typeof fetch;
    await expect(getMovie(options(missing), "JkGxEoPRF9EgRb32")).rejects.toMatchObject({
      status: 404,
      code: "VIDEO_JOB_NOT_FOUND",
      retryable: false,
    });
  });

  it("deletes the provider copy and reports an already-deleted one as false", async () => {
    const deleted = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    await expect(deleteMovie(options(deleted), "JkGxEoPRF9EgRb32")).resolves.toBe(true);
    const [url, init] = (deleted as any).mock.calls[0];
    expect(new URL(String(url)).searchParams.get("project")).toBe("JkGxEoPRF9EgRb32");
    expect(init.method).toBe("DELETE");

    const gone = (async () => jsonResponse({ success: false }, 404)) as unknown as typeof fetch;
    await expect(deleteMovie(options(gone), "JkGxEoPRF9EgRb32")).resolves.toBe(false);
  });

  it("settles from duration whenever any credit entry is not a plain number", () => {
    expect(totalConsumedCredits([12.5, 1.5])).toBe(14);
    expect(totalConsumedCredits(12.5)).toBe(12.5);
    expect(totalConsumedCredits([12.5, { step: "render", credits: 99 }])).toBeNull();
    expect(totalConsumedCredits([{ step: "render" }])).toBeNull();
    expect(totalConsumedCredits([1, "2"])).toBeNull();
    expect(totalConsumedCredits([1, Number.NaN])).toBeNull();
    expect(totalConsumedCredits([])).toBeNull();
    expect(totalConsumedCredits(null)).toBeNull();
  });
});

describe("JSON2Video configuration", () => {
  it("reads the key from the environment only", () => {
    expect(loadJson2VideoSettings({} as NodeJS.ProcessEnv)).toEqual({ apiKey: null });
    expect(loadJson2VideoSettings({ JSON2VIDEO_API_KEY: "  " } as NodeJS.ProcessEnv)).toEqual({
      apiKey: null,
    });
    expect(loadJson2VideoSettings({ JSON2VIDEO_API_KEY: " j2v-secret " } as NodeJS.ProcessEnv)).toEqual({
      apiKey: "j2v-secret",
    });
  });

  it("defaults to full-hd and refuses an unknown or custom resolution", () => {
    expect(resolveVideoResolution(undefined)).toBe("full-hd");
    expect(resolveVideoResolution("hd")).toBe("hd");
    expect(() => resolveVideoResolution("custom")).toThrow(/VIDEO_RESOLUTION/);
    expect(() => resolveVideoResolution("4k")).toThrow(/VIDEO_RESOLUTION/);
  });
});
