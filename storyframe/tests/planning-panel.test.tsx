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
  window.sessionStorage.clear();
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

  it.each([
    ["IDEMPOTENCY_IN_PROGRESS", 409],
    ["LEDGER_UNAVAILABLE", 503],
  ])("keeps the Idempotency-Key after %s so Retry can replay", async (code, status) => {
    const keys: (string | null)[] = [];
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        const headers = new Headers(init?.headers);
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) {
          keys.push(headers.get("Idempotency-Key"));
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse({ ok: false, error: { code, message: "The attempt is not settled yet." } }, status);
          }
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText(code)).toBeTruthy();
    expect(keys[0]).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("persists the pending key across a reload so Retry still replays", async () => {
    const keys: (string | null)[] = [];
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) {
          keys.push(new Headers(init?.headers).get("Idempotency-Key"));
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse(
              { ok: false, error: { code: "IDEMPOTENCY_IN_PROGRESS", message: "Still running." } },
              409,
            );
          }
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );

    const first = render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );
    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("IDEMPOTENCY_IN_PROGRESS")).toBeTruthy();
    expect(keys[0]).toBeTruthy();

    // A reload destroys component state; the stored key must survive it.
    first.unmount();
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );
    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(window.sessionStorage.getItem(`storyframe.planning.pendingKey.${PROJECT_ID}`)).toBeNull();
  });

  it("starts a fresh key after a recorded refusal", async () => {
    const keys: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path.endsWith("/proposals")) return jsonResponse({ ok: true, proposals: [] });
        if (path.endsWith("/planning")) {
          keys.push(new Headers(init?.headers).get("Idempotency-Key"));
          if (keys.length === 1) {
            return jsonResponse(
              { ok: false, error: { code: "PLANNING_INVALID_JSON", message: "Refused after one repair." } },
              422,
            );
          }
          return jsonResponse({ ok: true, proposal: proposalFixture() }, 201);
        }
        return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }, 404);
      }),
    );
    render(
      <PlanningPanel
        projectId={PROJECT_ID}
        baseVersion={1}
        scenes={[sceneFixture()]}
        dirty={false}
        getAccessToken={async () => "token"}
        onAccepted={vi.fn()}
      />,
    );

    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("PLANNING_INVALID_JSON")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    expect(await screen.findByText("Accept and save")).toBeTruthy();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
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
