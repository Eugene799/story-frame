// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { MediaRecord } from "../shared/media-contract";
import { PreRenderChecklist } from "../src/workspace/PreRenderChecklist";
import { sceneFixture } from "./project-fixture";

function mediaFixture(id: string, status: MediaRecord["status"]): MediaRecord {
  return {
    id,
    kind: "image",
    status,
    sceneKey: null,
    contentType: "image/jpeg",
    byteSize: 1024,
    uploadExpiresAt: null,
    readyAt: status === "ready" ? "2026-11-26T12:00:00.000Z" : null,
    deletedAt: status === "deleted" ? "2026-11-26T12:00:00.000Z" : null,
    createdAt: "2026-11-26T12:00:00.000Z",
    referenceCount: 1,
    provenance: null,
  };
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

describe("PreRenderChecklist", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names missing and pending assets, text-only scenes, and measured narration", async () => {
    const scenes = [
      sceneFixture({
        id: "scene-1",
        heading: "Opening",
        durationSeconds: 10,
        assetIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
      }),
      sceneFixture({
        id: "scene-2",
        heading: "Closing",
        durationSeconds: 5,
        assetIds: [],
      }),
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/media")) {
          return jsonResponse({
            ok: true,
            media: [mediaFixture("22222222-2222-4222-8222-222222222222", "pending")],
          });
        }
        if (path.endsWith("/narration")) {
          return jsonResponse({
            ok: true,
            narration: { durationSeconds: 16.5 },
            music: null,
            script: null,
            scriptBlocked: null,
            stale: false,
            timing: null,
            limits: { maxChars: 2000, usdPer1kChars: 0.03, rateVersion: "test" },
            usage: {
              windowHours: 24,
              previews: 0,
              generations: 0,
              characters: 0,
              spentUsd: 0,
              limits: { characters: null, usd: null },
              resetAt: null,
            },
          });
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );

    render(
      <PreRenderChecklist
        projectId="project-1"
        scenes={scenes}
        projectVersion={4}
        dirty={false}
        getAccessToken={async () => "token"}
      />,
    );

    await waitFor(() => expect(screen.getByText("2 issues")).toBeTruthy());
    expect(screen.getByText(/lists 11111111: not in this project/)).toBeTruthy();
    expect(screen.getByText(/lists 22222222: upload not complete/)).toBeTruthy();
    expect(screen.getByText(/Scene 2: Closing/)).toBeTruthy();
    expect(screen.getByText(/Measured narration: 16.5s/)).toBeTruthy();
    expect(screen.getByLabelText("Render snapshot").textContent).toContain("revision v4");
  });
});
