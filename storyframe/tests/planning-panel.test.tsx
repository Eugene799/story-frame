// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationProposalRecord } from "../shared/child-contract";
import type { PlanningPayload } from "../shared/planning-contract";
import type { ProjectRecord } from "../shared/project-contract";
import { PlanningPanel } from "../src/workspace/PlanningPanel";
import { documentFixture, sceneFixture } from "./project-fixture";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-11-25T12:00:00.000Z";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

function projectFixture(version = 1): ProjectRecord {
  return {
    id: PROJECT_ID,
    projectType: "story",
    title: "Planning subject",
    schemaVersion: 2,
    document: documentFixture(),
    version,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function proposalFixture(status: GenerationProposalRecord["status"] = "proposed"): GenerationProposalRecord {
  const payload: PlanningPayload = {
    summary: "One beat from the saved script.",
    notes: ["Kept the letter as the through-line."],
    angles: [],
    scenes: [
      {
        heading: "INT. TRAIN CAR - NIGHT",
        narration: "The letter is opened.",
        visualDirection: "Close on the envelope.",
        onScreenText: "",
        durationSeconds: 8,
      },
    ],
    clips: [],
    claims: [],
    route: "script",
    insufficientEvidence: false,
    repairAttempted: false,
  };
  return {
    id: PROPOSAL_ID,
    sceneKey: null,
    route: "script",
    baseVersion: 1,
    modelId: "gemma",
    prompt: "planning prompt",
    proposal: payload as unknown as Record<string, unknown>,
    status,
    createdAt: NOW,
  };
}

function installBackend() {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    requests.push({ method, path, body });

    if (path === `/api/projects/${PROJECT_ID}/proposals` && method === "GET") {
      return jsonResponse({ ok: true, proposals: [] });
    }
    if (path === `/api/projects/${PROJECT_ID}/planning` && method === "POST") {
      return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
    }
    if (path === `/api/projects/${PROJECT_ID}/proposals/${PROPOSAL_ID}/accept` && method === "POST") {
      const project = projectFixture(2);
      project.document.scenes[0].body = "The letter is opened.";
      return jsonResponse({
        ok: true,
        proposal: proposalFixture("accepted"),
        project,
        claimsRecorded: true,
      });
    }
    return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PlanningPanel", () => {
  it("generates, reviews, and accepts a proposal without applying it first", async () => {
    const backend = installBackend();
    const onAccepted = vi.fn();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={onAccepted}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "script" } });
    fireEvent.change(document.getElementById("planning-instruction") as HTMLTextAreaElement, {
      target: { value: "Keep it under ten seconds." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));

    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(screen.getByText("One beat from the saved script.")).toBeTruthy();
    expect(screen.getByText("The letter is opened.")).toBeTruthy();
    expect(screen.getByText("Proposed · v1 · gemma")).toBeTruthy();

    const generate = backend.requests.find((request) => request.path.endsWith("/planning"));
    expect(generate?.body).toEqual({
      route: "script",
      instruction: "Keep it under ten seconds.",
      baseVersion: 1,
    });
    // Generating alone does not apply anything.
    expect(onAccepted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Accept and save" }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(onAccepted.mock.calls[0][0].version).toBe(2);
    expect(await screen.findByText(/Accepted\. The project is now version 2\./)).toBeTruthy();
    expect(screen.getByText("Accepted")).toBeTruthy();
  });

  it("blocks generation and acceptance while the draft is dirty", async () => {
    installBackend();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    const generate = screen.getByRole("button", { name: "Generate proposal" }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    expect(screen.getByText(/Save or discard the draft first/)).toBeTruthy();
  });
});
