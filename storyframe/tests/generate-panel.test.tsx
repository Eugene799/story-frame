// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ImageModelView,
} from "../shared/image-generation-contract";
import type { MediaRecord } from "../shared/media-contract";
import type { ProjectScene } from "../shared/project-contract";
import { GeneratePanel } from "../src/workspace/GeneratePanel";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID = "99999999-9999-4999-8999-999999999999";
const GENERATION_ID = "77777777-7777-4777-8777-777777777777";
const REFERENCE_ID = "55555555-5555-4555-8555-555555555555";
const SCENE_ID = "s1";
const NOW = "2026-11-25T12:00:00.000Z";

const SCENES: ProjectScene[] = [
  {
    id: SCENE_ID,
    heading: "Opening",
    body: "The light sweeps the water.",
    visualDirection: "Stormy coast",
    assetIds: [],
    onScreenText: "",
    durationSeconds: 10,
    approved: false,
    approvedFingerprint: null,
    locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
  },
];

const MODELS: ImageModelView[] = [
  {
    key: "cloudflare:flux-1-schnell",
    provider: "cloudflare",
    label: "Cloudflare FLUX.1 schnell",
    width: 1024,
    height: 1024,
    steps: 4,
    maxPromptChars: 2048,
    configured: true,
    billing: {
      kind: "neurons",
      usdPerThousandNeurons: 0.011,
      neuralRates: { perTile: 4.8, perStep: 9.6 },
      note: "10,000 free neurons per day at the account level.",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
      verifiedOn: "2026-11-25",
    },
  },
  {
    key: "leonardo:phoenix-1.0",
    provider: "leonardo",
    label: "Leonardo Phoenix 1.0",
    width: 1024,
    height: 1024,
    steps: null,
    maxPromptChars: 2000,
    configured: false,
    billing: {
      kind: "api-credit",
      note: "Priced in API credit; no per-image USD rate is published.",
      sourceUrl: "https://docs.leonardo.ai/docs/api-pricing",
      verifiedOn: "2026-11-25",
    },
  },
];

const MEDIA: MediaRecord = {
  id: MEDIA_ID,
  kind: "image",
  status: "ready",
  sceneKey: null,
  contentType: "image/jpeg",
  byteSize: 698607,
  uploadExpiresAt: null,
  readyAt: NOW,
  deletedAt: null,
  createdAt: NOW,
  referenceCount: 0,
  provenance: null,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

interface BackendOptions {
  generationStatus?: "succeeded" | "pending";
  generationError?: { code: string; message: string };
}

function installBackend(options: BackendOptions = {}) {
  const { generationStatus = "succeeded", generationError } = options;
  const requests: { method: string; path: string; body: any }[] = [];
  let polled = false;

  const generationRecord = (status: "pending" | "succeeded", mediaId: string | null) => ({
    id: GENERATION_ID,
    projectId: PROJECT_ID,
    provider: "cloudflare",
    modelKey: "cloudflare:flux-1-schnell",
    prompt: "a lighthouse on a stormy coast",
    settings: { width: 1024, height: 1024, steps: 4 },
    status,
    jobId: status === "pending" ? "job-1" : null,
    mediaId,
    estimatedUsd: 0.001901,
    estimatedNeurons: 172.8,
    rateVersion: "cloudflare-flux-schnell-2026-11-25",
    providerCost: null,
    errorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as any) : null;
      requests.push({ method, path: url.pathname, body });

      if (url.pathname === "/api/image-models" && method === "GET") {
        return jsonResponse({ ok: true, models: MODELS });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/image-generations/estimate` && method === "POST") {
        return jsonResponse({
          ok: true,
          estimate: {
            modelKey: body.modelKey,
            provider: "cloudflare",
            width: 1024,
            height: 1024,
            steps: 4,
            estimatedNeurons: 172.8,
            estimatedUsd: 0.001901,
            rateVersion: "cloudflare-flux-schnell-2026-11-25",
            billing: MODELS[0].billing,
          },
        });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/image-generations` && method === "POST") {
        if (generationError) {
          return jsonResponse({ ok: false, error: generationError }, 502);
        }
        return jsonResponse(
          {
            ok: true,
            generation: generationRecord(generationStatus, generationStatus === "succeeded" ? MEDIA_ID : null),
            media: generationStatus === "succeeded" ? MEDIA : null,
          },
          generationStatus === "succeeded" ? 201 : 202,
        );
      }
      if (
        url.pathname === `/api/projects/${PROJECT_ID}/image-generations/${GENERATION_ID}/refresh` &&
        method === "POST"
      ) {
        polled = true;
        return jsonResponse({
          ok: true,
          generation: generationRecord("succeeded", MEDIA_ID),
          media: MEDIA,
        });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/media/${MEDIA_ID}/url` && method === "GET") {
        return jsonResponse({
          ok: true,
          url: "https://media.example/private/generated.jpg",
          expiresAt: "2026-11-25T12:05:00.000Z",
        });
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}/media/${MEDIA_ID}/references` && method === "POST") {
        return jsonResponse(
          {
            ok: true,
            reference: {
              id: REFERENCE_ID,
              mediaId: MEDIA_ID,
              refKind: "scene",
              refId: body.refId,
              createdAt: NOW,
            },
          },
          201,
        );
      }
      return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: url.pathname } }, 404);
    }),
  );

  return { requests, polled: () => polled };
}

function renderPanel(
  options: { onAttachAsset?: (sceneId: string, mediaId: string) => Promise<boolean> } = {},
) {
  const attach = vi.fn(options.onAttachAsset ?? (async () => true));
  render(
    <GeneratePanel
      projectId={PROJECT_ID}
      scenes={SCENES}
      getAccessToken={async () => "token"}
      onAttachAsset={attach}
    />,
  );
  return { attach };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GeneratePanel", () => {
  it("shows the verified estimate and waits for an explicit Generate", async () => {
    const backend = installBackend();
    renderPanel();

    const model = await screen.findByLabelText("Model");
    expect(within(model).getByRole("option", { name: "Cloudflare FLUX.1 schnell" })).toBeTruthy();
    const disabled = within(model).getByRole("option", { name: /Leonardo Phoenix 1.0 — credentials missing/ });
    expect((disabled as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Generate image" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "a lighthouse on a stormy coast" },
    });

    const cost = await screen.findByLabelText("Estimated cost");
    expect(await within(cost).findByText("$0.001901")).toBeTruthy();
    expect(within(cost).getByText(/172\.8 neurons/)).toBeTruthy();
    expect(within(cost).getByText(/rates verified 2026-11-25/)).toBeTruthy();
    expect(within(cost).getByRole("link", { name: "Pricing source" }).getAttribute("href")).toBe(
      "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    );
    expect(
      backend.requests.find((request) => request.path.endsWith("/estimate"))?.body,
    ).toEqual({ modelKey: "cloudflare:flux-1-schnell", prompt: "a lighthouse on a stormy coast" });
    expect(
      backend.requests.some((request) => request.path === `/api/projects/${PROJECT_ID}/image-generations`),
    ).toBe(false);
  });

  it("generates explicitly, previews the private asset, and attaches it to a scene", async () => {
    const backend = installBackend();
    const { attach } = renderPanel();

    fireEvent.change(await screen.findByLabelText("Prompt"), {
      target: { value: "a lighthouse on a stormy coast" },
    });
    await screen.findByText("$0.001901");
    expect(
      backend.requests.some((request) => request.method === "POST" && request.path.endsWith("/image-generations")),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    const preview = await screen.findByRole("img", { name: /Generated image: a lighthouse on a stormy coast/ });
    expect(preview.getAttribute("src")).toBe("https://media.example/private/generated.jpg");
    const generationRequest = backend.requests.find(
      (request) => request.path === `/api/projects/${PROJECT_ID}/image-generations` && request.method === "POST",
    );
    expect(generationRequest?.body).toEqual({
      modelKey: "cloudflare:flux-1-schnell",
      prompt: "a lighthouse on a stormy coast",
    });
    expect(await screen.findByText(/682 KiB/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Attach image to scene" }));

    await waitFor(() => expect(attach).toHaveBeenCalledWith(SCENE_ID, MEDIA_ID));
    const reference = backend.requests.find(
      (request) => request.path === `/api/projects/${PROJECT_ID}/media/${MEDIA_ID}/references`,
    );
    expect(reference?.body).toEqual({ refKind: "scene", refId: SCENE_ID });
    expect(await screen.findByText('Attached to "Opening" and saved.')).toBeTruthy();
  });

  it("keeps a pending job explicit and completes it through Refresh job", async () => {
    const backend = installBackend({ generationStatus: "pending" });
    renderPanel();

    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "a lighthouse" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    expect(await screen.findByText(/Generation queued \(job job-1\)/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh job" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh job" }));

    expect(await screen.findByRole("img", { name: /Generated image: a lighthouse/ })).toBeTruthy();
    expect(backend.polled()).toBe(true);
    expect(screen.queryByRole("button", { name: "Refresh job" })).toBeNull();
  });

  it("surfaces a sanitized provider failure without a preview", async () => {
    installBackend({
      generationError: {
        code: "IMAGE_PROVIDER_FAILED",
        message: "The provider reported no completed image.",
      },
    });
    renderPanel();

    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "a lighthouse" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("IMAGE_PROVIDER_FAILED")).toBeTruthy();
    expect(within(alert).getByText("The provider reported no completed image.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh job" })).toBeNull();
  });
});
