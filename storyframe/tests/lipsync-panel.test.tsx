// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaRecord } from "../shared/media-contract";
import type { LipsyncExportRecord, LipsyncUsageSummary } from "../shared/lipsync-contract";
import { LipsyncPanel } from "../src/workspace/LipsyncPanel";

/**
 * Lip sync panel against a fake API: nothing here reaches Everypixel, and the
 * panel only ever talks to our own routes.
 */

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const EXPORT_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "44444444-4444-4444-8444-444444444444";
const AUDIO_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-11-26T12:00:00.000Z";

const USAGE: LipsyncUsageSummary = {
  windowHours: 24,
  secondsUsed: 0,
  secondsLimit: 600,
  usdUsed: 0,
  usdLimit: 5,
  resetAt: null,
};

function media(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    id: SOURCE_ID,
    kind: "video",
    status: "ready",
    sceneKey: null,
    contentType: "video/mp4",
    byteSize: 2048,
    uploadExpiresAt: null,
    readyAt: NOW,
    deletedAt: null,
    createdAt: NOW,
    referenceCount: 1,
    provenance: null,
    ...overrides,
  };
}

function record(overrides: Partial<LipsyncExportRecord> = {}): LipsyncExportRecord {
  return {
    id: EXPORT_ID,
    projectId: PROJECT_ID,
    status: "pending",
    provider: "everypixel",
    providerStatus: "PENDING",
    sourceMediaId: SOURCE_ID,
    audioMediaId: AUDIO_ID,
    outputMediaId: null,
    resolution: "720p",
    secondsEstimate: 20,
    secondsCounted: null,
    usdEstimate: 0.15,
    byteSize: null,
    failureCode: null,
    failureMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

function installBackend(options: { initial?: LipsyncExportRecord[]; settled?: LipsyncExportRecord } = {}) {
  let exports = options.initial ?? [];
  let submitted = false;
  let listsAfterSubmit = 0;
  const requests: Array<{ method: string; path: string; body?: string }> = [];

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "https://app.test");
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });

    if (url.pathname === `/api/projects/${PROJECT_ID}/media` && method === "GET") {
      return jsonResponse({
        ok: true,
        media: [media(), media({ id: AUDIO_ID, kind: "audio", contentType: "audio/mpeg", byteSize: 512 })],
      });
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/exports/lipsync` && method === "GET") {
      // The submitted export stays pending for one read, then settles.
      if (submitted && options.settled) {
        listsAfterSubmit += 1;
        if (listsAfterSubmit >= 2) exports = [options.settled];
      }
      return jsonResponse({ ok: true, exports, usage: USAGE });
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/exports/lipsync` && method === "POST") {
      submitted = true;
      exports = [record()];
      return jsonResponse({ ok: true, export: record(), media: null, usage: USAGE }, 202);
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/exports/lipsync/${EXPORT_ID}/url`) {
      return jsonResponse({
        ok: true,
        url: "https://r2.test/get/media/output.mp4",
        expiresAt: NOW,
        contentType: "video/mp4",
        byteSize: 4096,
      });
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/exports/lipsync/${EXPORT_ID}` && method === "DELETE") {
      exports = [];
      return jsonResponse({ ok: true, deletedId: EXPORT_ID });
    }
    return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "unknown" } }, 404);
  });

  vi.stubGlobal("fetch", fetchImpl);
  return { requests };
}

function renderPanel() {
  return render(<LipsyncPanel projectId={PROJECT_ID} getAccessToken={async () => "token"} pollIntervalMs={20} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("lip sync panel", () => {
  it("shows the seconds window and refuses to submit until both files are chosen", async () => {
    installBackend();
    renderPanel();

    expect(await screen.findByLabelText("Lip sync usage")).toBeTruthy();
    expect(screen.getByText(/Last 24 hours: 0 s of 600 s lip sync time used/)).toBeTruthy();
    expect(screen.getByText(/about \$0.15 at the published 720p rate/)).toBeTruthy();

    const button = screen.getByRole("button", { name: "Run lip sync" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Choose both a source and an audio track.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Lip sync source"), { target: { value: SOURCE_ID } });
    expect((screen.getByRole("button", { name: "Run lip sync" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Lip sync audio"), { target: { value: AUDIO_ID } });
    expect((screen.getByRole("button", { name: "Run lip sync" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("submits once, polls while pending, then plays the stored copy", async () => {
    const backend = installBackend({
      settled: record({
        status: "ready",
        providerStatus: "SUCCESS",
        outputMediaId: "66666666-6666-4666-8666-666666666666",
        secondsCounted: 20,
        byteSize: 4096,
      }),
    });
    renderPanel();
    await screen.findByLabelText("Lip sync usage");

    fireEvent.change(screen.getByLabelText("Lip sync source"), { target: { value: SOURCE_ID } });
    fireEvent.change(screen.getByLabelText("Lip sync audio"), { target: { value: AUDIO_ID } });
    fireEvent.click(screen.getByRole("button", { name: "Run lip sync" }));

    expect(await screen.findByRole("heading", { name: "Latest lip sync" })).toBeTruthy();
    expect(screen.getByText(/Everypixel is processing this lip sync/)).toBeTruthy();

    const video = await screen.findByLabelText("Lip sync playback", {}, { timeout: 3000 });
    expect(video.getAttribute("src")).toBe("https://r2.test/get/media/output.mp4");
    expect(screen.getByText(/READY/)).toBeTruthy();

    const posts = backend.requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual({
      sourceMediaId: SOURCE_ID,
      audioMediaId: AUDIO_ID,
      resolution: "720p",
    });
  });

  it("deletes only after a confirmation and re-reads the list", async () => {
    const backend = installBackend({
      initial: [record({ status: "ready", providerStatus: "SUCCESS", secondsCounted: 20, byteSize: 4096 })],
    });
    renderPanel();
    await screen.findByRole("heading", { name: "Latest lip sync" });

    fireEvent.click(screen.getByRole("button", { name: "Delete lip sync" }));
    expect(screen.getByRole("button", { name: "Confirm delete lip sync" })).toBeTruthy();
    expect(backend.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete lip sync" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete lip sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete lip sync" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Latest lip sync" })).toBeNull());
    expect(backend.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    expect(screen.getByText(/The lip sync and its stored MP4 were deleted/)).toBeTruthy();

    const deleteIndex = backend.requests.findIndex((request) => request.method === "DELETE");
    expect(backend.requests.slice(deleteIndex + 1).some((request) => request.method === "GET")).toBe(true);
  });
});
