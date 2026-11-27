// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectDocumentV2, ProjectRecord } from "../shared/project-contract";
import { SettingsPanel } from "../src/workspace/SettingsPanel";
import { documentFixture } from "./project-fixture";

const NOW = "2026-11-26T12:00:00.000Z";

function projectFixture(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectType: "story",
    title: "The Late Letter",
    schemaVersion: 2,
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
    document: documentFixture(),
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

describe("SettingsPanel revision restore", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("restores an older revision as a new version and reports it", async () => {
    const project = projectFixture();
    const restored = projectFixture({
      version: 4,
      title: "The Early Letter",
      document: documentFixture({ summary: "The first saved version." }),
    });
    const requests: { method: string; path: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method, path: url.pathname, body });

      if (url.pathname.endsWith("/revisions") && method === "GET") {
        return jsonResponse({
          ok: true,
          revisions: [
            { revision: 3, title: project.title, schemaVersion: 2, createdAt: NOW },
            { revision: 2, title: "Second", schemaVersion: 2, createdAt: NOW },
            { revision: 1, title: "The Early Letter", schemaVersion: 2, createdAt: NOW },
          ],
        });
      }
      if (url.pathname.endsWith("/revisions/1/restore") && method === "POST") {
        return jsonResponse({ ok: true, project: restored, restoredFrom: 1 });
      }
      throw new Error(`unexpected request ${method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onRestored = vi.fn();
    render(
      <SettingsPanel
        project={project}
        getAccessToken={async () => "token"}
        onDeleted={vi.fn()}
        onRestored={onRestored}
      />,
    );

    const restore = await screen.findByRole("button", { name: "Restore revision 1" });
    expect(screen.queryByRole("button", { name: "Restore revision 3" })).toBeNull();
    fireEvent.click(restore);
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));

    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(restored));
    expect(requests).toContainEqual({
      method: "POST",
      path: `/api/projects/${project.id}/revisions/1/restore`,
      body: { version: 3 },
    });
    expect(await screen.findByText(/Restored revision 1 as a new saved version/)).toBeTruthy();
    expect(screen.getByText("r4")).toBeTruthy();
    // The response already names the appended revision, so history is not re-fetched.
    expect(
      requests.filter((request) => request.method === "GET" && request.path.endsWith("/revisions")),
    ).toHaveLength(1);
  });
});
