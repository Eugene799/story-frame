// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDocumentV2, ProjectScene } from "../shared/project-contract";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import type { VideoExportRecord, VideoUsageSummary } from "../shared/video-contract";
import { PreviewPanel } from "../src/workspace/PreviewPanel";
import { documentFixture, sceneFixture } from "./project-fixture";

/**
 * Phase 9 export UI, exercised against a fake API. Nothing here reaches
 * JSON2Video: the panel only ever talks to our own routes.
 */

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const EXPORT_ID = "33333333-3333-4333-8333-333333333333";
const MEDIA_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-11-25T12:00:00.000Z";

const USAGE: VideoUsageSummary = {
  windowHours: 24,
  creditsUsed: 10,
  creditsLimit: 600,
  resetAt: null,
};

function approvedScene(overrides: Partial<ProjectScene> = {}): ProjectScene {
  const base = sceneFixture({ approved: true, approvedFingerprint: "pending", ...overrides });
  return { ...base, approvedFingerprint: sceneFingerprint(base) };
}

/** Two approved ten-second scenes: ten credits at one credit per second. */
const DOCUMENT: ProjectDocumentV2 = documentFixture({
  scenes: [approvedScene({ id: "a", durationSeconds: 5 }), approvedScene({ id: "b", durationSeconds: 5 })],
});

function exportRecord(overrides: Partial<VideoExportRecord> = {}): VideoExportRecord {
  return {
    id: EXPORT_ID,
    projectId: PROJECT_ID,
    projectRevision: 7,
    status: "pending",
    provider: "json2video",
    providerStatus: null,
    jobId: null,
    mediaId: null,
    outputKey: null,
    failureCode: null,
    failureMessage: null,
    durationSeconds: null,
    byteSize: null,
    width: null,
    height: null,
    creditsEstimate: 10,
    creditsConsumed: null,
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

interface BackendOptions {
  initial?: VideoExportRecord[];
  /** What the sweep reports once the export has been picked up twice. */
  settled?: VideoExportRecord;
}

function installBackend(options: BackendOptions = {}) {
  let exports = options.initial ?? [];
  let submitted = false;
  let pollsAfterSubmit = 0;
  const requests: { method: string; path: string; body: any; idempotencyKey: string | null }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as any) : null;
      const idempotencyKey = new Headers(init?.headers as HeadersInit).get("Idempotency-Key");
      requests.push({ method, path: url.pathname, body, idempotencyKey });

      if (url.pathname === `/api/projects/${PROJECT_ID}/exports/video` && method === "GET") {
        if (submitted && options.settled) {
          pollsAfterSubmit += 1;
          if (pollsAfterSubmit >= 2) exports = [options.settled];
        }
        return jsonResponse({ ok: true, exports, usage: USAGE });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/exports/video` && method === "POST") {
        const created = exportRecord({ projectRevision: body.projectRevision });
        exports = [created];
        submitted = true;
        return jsonResponse({ ok: true, export: created, media: null, usage: USAGE }, 202);
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/exports/video/${EXPORT_ID}` && method === "DELETE") {
        exports = exports.filter((row) => row.id !== EXPORT_ID);
        return jsonResponse({ ok: true, deletedId: EXPORT_ID });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/exports/video/${EXPORT_ID}/url`) {
        return jsonResponse({
          ok: true,
          url: "https://r2.example/render.mp4",
          expiresAt: NOW,
          contentType: "video/mp4",
          byteSize: 2048,
        });
      }
      return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: url.pathname } }, 404);
    }),
  );

  return { requests };
}

function panel(options: { document?: ProjectDocumentV2; dirty?: boolean; pollIntervalMs?: number } = {}) {
  return (
    <PreviewPanel
      title="Rain"
      projectDocument={options.document ?? DOCUMENT}
      projectId={PROJECT_ID}
      projectVersion={7}
      dirty={options.dirty ?? false}
      getAccessToken={async () => "token"}
      pollIntervalMs={options.pollIntervalMs ?? 25}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("video export panel", () => {
  it("shows credit usage and the estimate, submits once, then plays the stored MP4", async () => {
    const backend = installBackend({
      settled: exportRecord({
        status: "ready",
        providerStatus: "done",
        mediaId: MEDIA_ID,
        outputKey: "media/render.mp4",
        creditsConsumed: 8,
        durationSeconds: 10,
        byteSize: 2048,
        width: 1920,
        height: 1080,
      }),
    });
    render(panel());

    expect(await screen.findByLabelText("Video credit usage")).toHaveTextContent(
      "Last 24 hours: 10 of 600 video credits used",
    );
    expect(screen.getByText(/This render: 0:10 of footage · about 10 credits/)).toBeTruthy();
    // The Phase 4 placeholder copy is replaced by a real export control.
    expect(screen.queryByText(/rendering belongs to Phase 9/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Export video" }));
    await waitFor(() => expect(backend.requests.filter((request) => request.method === "POST")).toHaveLength(1));
    const post = backend.requests.find((request) => request.method === "POST");
    expect(post?.body).toEqual({ projectRevision: 7 });
    expect(post?.idempotencyKey).toBeTruthy();

    // A live status comes from the server, not from the click.
    expect(await screen.findByText(/JSON2Video is rendering this export/)).toBeTruthy();

    const playback = await screen.findByLabelText("Video export playback");
    expect(playback.getAttribute("src")).toBe("https://r2.example/render.mp4");
    expect(playback.getAttribute("src")).not.toContain("json2video");
    expect(screen.getByText(/8 credits used · 0:10 · 2 KiB · 1920×1080/)).toBeTruthy();
    // Polling is what advanced the row, and it never submitted a second render.
    expect(backend.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(backend.requests.some((request) => request.path.endsWith(`/${EXPORT_ID}/url`))).toBe(true);
  });

  it("deletes the latest export only after a confirmation and re-reads the list", async () => {
    const backend = installBackend({
      initial: [
        exportRecord({
          status: "ready",
          providerStatus: "done",
          mediaId: MEDIA_ID,
          creditsConsumed: 6,
          durationSeconds: 6,
          byteSize: 2048,
          width: 1920,
          height: 1080,
        }),
      ],
    });
    render(panel());

    expect(await screen.findByRole("heading", { name: "Latest export" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete export" }));

    // Confirmation stands between the click and deleting a paid render's row.
    expect(screen.getByRole("button", { name: "Confirm delete export" })).toBeTruthy();
    expect(backend.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete export" })).toBeTruthy();
    expect(backend.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete export" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete export" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Latest export" })).toBeNull());
    expect(backend.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    expect(screen.getByText(/The export and its stored MP4 were deleted/)).toBeTruthy();

    // The card disappears because the list is re-read, not because of local state trimming.
    const deleteIndex = backend.requests.findIndex((request) => request.method === "DELETE");
    expect(backend.requests.slice(deleteIndex + 1).some((request) => request.method === "GET")).toBe(true);
  });

  it("cannot delete a render that is still in progress", async () => {
    const backend = installBackend({ initial: [exportRecord()] });
    render(panel());

    expect(await screen.findByRole("heading", { name: "Latest export" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Delete export" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/a render in progress cannot be cancelled/)).toBeTruthy();
    expect(backend.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  });

  it("shows the failure reason of a failed export and no playback", async () => {
    installBackend({
      initial: [
        exportRecord({
          status: "failed",
          providerStatus: "done",
          failureCode: "VIDEO_NARRATION_STALE",
          failureMessage: "The attached narration belongs to an earlier script. Regenerate it before exporting.",
          creditsConsumed: 10,
        }),
      ],
    });
    render(panel());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("VIDEO_NARRATION_STALE");
    expect(alert).toHaveTextContent("Regenerate it before exporting");
    expect(screen.getByText(/10 credits used/)).toBeTruthy();
    expect(screen.queryByLabelText("Video export playback")).toBeNull();
    // A failed export does not block a new one.
    expect((screen.getByRole("button", { name: "Export video" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables the export with a reason for unapproved scenes or unsaved changes", async () => {
    const backend = installBackend();
    const unapproved: ProjectDocumentV2 = documentFixture({
      scenes: [sceneFixture({ id: "a", durationSeconds: 5, approved: false, approvedFingerprint: null })],
    });
    const view = render(panel({ document: unapproved }));

    const blocked = (await screen.findByRole("button", { name: "Export video" })) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(screen.getByText("Approve every scene before exporting video.")).toBeTruthy();

    view.rerender(panel({ dirty: true }));
    await waitFor(() =>
      expect(screen.getByText(/Save the project before exporting, so the render matches this preview/)).toBeTruthy(),
    );
    expect((screen.getByRole("button", { name: "Export video" }) as HTMLButtonElement).disabled).toBe(true);
    expect(backend.requests.some((request) => request.method === "POST")).toBe(false);
  });
});
