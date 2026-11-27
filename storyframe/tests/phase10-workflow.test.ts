import { describe, expect, it } from "vitest";
import type {
  ClaimRecord,
  ClaimsResponse,
  SourceRecord,
  SourcesResponse,
} from "../shared/child-contract";
import type { MediaRecord, MediaReferenceRecord } from "../shared/media-contract";
import type {
  ProjectDocumentV2,
  ProjectRecord,
  ProjectResponse,
  ProjectStoryNotes,
} from "../shared/project-contract";
import type { ProjectExportPayload } from "../shared/project-export";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import { briefFixture, documentFixture, sceneFixture } from "./project-fixture";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

// MOCKED: Supabase Auth/PostgREST and the S3 endpoint are local fakes spoken to
// over real HTTP. Every provider key is blank, so this workflow never calls
// Ollama, Deepgram, JSON2Video, or any stock/image service.

const PNG_A = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(96, 0x11)]);
const PNG_B = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(160, 0x22)]);

const PROVIDER_FREE_ENV = {
  OLLAMA_API_KEY: "",
  DEEPGRAM_API_KEY: "",
  JSON2VIDEO_API_KEY: "",
  EVERYPIXEL_CLIENT_ID: "",
  EVERYPIXEL_SECRET_ID: "",
  PEXELS_API_KEY: "",
  PIXABAY_API_KEY: "",
  CLOUDFLARE_ACCOUNT_ID: "",
  CLOUDFLARE_AI_API_TOKEN: "",
  LEONARDO_API_KEY: "",
};

interface MediaTicket {
  ok: true;
  media: MediaRecord;
  upload: { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };
}

interface MediaResponse {
  ok: true;
  media: MediaRecord;
}

interface MediaReferenceResponse {
  ok: true;
  reference: MediaReferenceRecord;
}

interface ProjectExportResponse {
  ok: true;
  export: ProjectExportPayload;
}

async function createProject(
  app: TestApp,
  title: string,
  document: ProjectDocumentV2,
): Promise<ProjectRecord> {
  const response = await apiRequest(app.url, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ projectType: "story", title, document }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as ProjectResponse).project;
}

async function reloadProject(app: TestApp, projectId: string): Promise<ProjectRecord> {
  const response = await apiRequest(app.url, `/api/projects/${projectId}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as ProjectResponse).project;
}

async function saveProject(
  app: TestApp,
  project: ProjectRecord,
  document: ProjectDocumentV2,
): Promise<ProjectRecord> {
  const response = await apiRequest(app.url, `/api/projects/${project.id}`, {
    method: "PUT",
    body: JSON.stringify({ title: project.title, document, version: project.version }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as ProjectResponse).project;
}

async function uploadImage(app: TestApp, projectId: string, bytes: Buffer): Promise<MediaRecord> {
  const initiate = await apiRequest(app.url, `/api/projects/${projectId}/media`, {
    method: "POST",
    body: JSON.stringify({ kind: "image", contentType: "image/png", byteSize: bytes.length }),
  });
  expect(initiate.status).toBe(201);
  const ticket = (await initiate.json()) as MediaTicket;

  const put = await fetch(ticket.upload.url, {
    method: "PUT",
    headers: ticket.upload.headers,
    body: new Uint8Array(bytes),
  });
  expect(put.status).toBe(200);

  const completed = await apiRequest(
    app.url,
    `/api/projects/${projectId}/media/${ticket.media.id}/complete`,
    { method: "POST" },
  );
  expect(completed.status).toBe(200);
  const media = ((await completed.json()) as MediaResponse).media;
  expect(media).toMatchObject({
    id: ticket.media.id,
    kind: "image",
    status: "ready",
    contentType: "image/png",
    byteSize: bytes.length,
  });
  return media;
}

async function attachToScene(
  app: TestApp,
  projectId: string,
  mediaId: string,
  sceneId: string,
): Promise<MediaReferenceRecord> {
  const response = await apiRequest(
    app.url,
    `/api/projects/${projectId}/media/${mediaId}/references`,
    { method: "POST", body: JSON.stringify({ refKind: "scene", refId: sceneId }) },
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as MediaReferenceResponse).reference;
}

async function detachFromScene(
  app: TestApp,
  projectId: string,
  mediaId: string,
  referenceId: string,
): Promise<Response> {
  return apiRequest(
    app.url,
    `/api/projects/${projectId}/media/${mediaId}/references/${referenceId}`,
    { method: "DELETE" },
  );
}

async function deleteMedia(app: TestApp, projectId: string, mediaId: string): Promise<Response> {
  return apiRequest(app.url, `/api/projects/${projectId}/media/${mediaId}`, { method: "DELETE" });
}

async function playback(app: TestApp, projectId: string, mediaId: string): Promise<Response> {
  return apiRequest(app.url, `/api/projects/${projectId}/media/${mediaId}/url`);
}

async function listSources(app: TestApp, projectId: string): Promise<SourceRecord[]> {
  const response = await apiRequest(app.url, `/api/projects/${projectId}/sources`);
  expect(response.status).toBe(200);
  return ((await response.json()) as SourcesResponse).sources;
}

async function listClaims(app: TestApp, projectId: string): Promise<ClaimRecord[]> {
  const response = await apiRequest(app.url, `/api/projects/${projectId}/claims`);
  expect(response.status).toBe(200);
  return ((await response.json()) as ClaimsResponse).claims;
}

async function exportProject(
  app: TestApp,
  project: ProjectRecord,
): Promise<ProjectExportPayload> {
  const response = await apiRequest(app.url, `/api/projects/${project.id}/export`, {
    method: "POST",
    body: JSON.stringify({ title: project.title, document: project.document }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as ProjectExportResponse).export;
}

/** Changes only the named scene's asset ids; every other field stays as loaded. */
function withSceneAssets(
  document: ProjectDocumentV2,
  sceneId: string,
  assetIds: string[],
): ProjectDocumentV2 {
  return {
    ...document,
    scenes: document.scenes.map((scene) =>
      scene.id === sceneId ? { ...scene, assetIds } : scene,
    ),
  };
}

function approvedScene(overrides: Parameters<typeof sceneFixture>[0]) {
  const scene = sceneFixture(overrides);
  return { ...scene, approved: true, approvedFingerprint: sceneFingerprint(scene) };
}

function factualProjectFixture(): { title: string; document: ProjectDocumentV2 } {
  return {
    title: "The Night Mail",
    document: documentFixture({
      summary: "How the 1912 night mail moved letters between stations.",
      brief: briefFixture({
        mode: "factual",
        topic: "The 1912 night mail",
        audience: "History viewers",
        goal: "Explain how the mail moved overnight",
        preset: "Explainer",
        voicePreference: "neutral",
        targetDurationSeconds: 30,
      }),
      scenes: [
        sceneFixture({
          id: "scene-1",
          heading: "INT. MAIL CAR — NIGHT",
          body: "Sorters face a wall of pigeonholes as the train rocks.",
          visualDirection: "Wide shot down the mail car; envelopes blur past.",
          onScreenText: "The Night Mail, 1912",
          durationSeconds: 12,
        }),
        approvedScene({
          id: "scene-2",
          heading: "EXT. PLATFORM — DAWN",
          body: "A pouch is swung from the moving train and caught on the platform.",
          visualDirection: "Low angle on the catcher's arms.",
          onScreenText: "",
          durationSeconds: 9,
          locks: {
            narration: true,
            visualDirection: false,
            onScreenText: false,
            duration: false,
          },
        }),
      ],
    }),
  };
}

function fictionProjectFixture(): {
  title: string;
  document: ProjectDocumentV2;
  storyNotes: ProjectStoryNotes;
} {
  const storyNotes: ProjectStoryNotes = {
    characters: "Mara the courier wants the letter delivered; Elias wants it forgotten.",
    setting: "A night train in winter 1912, gas lamps and frost on the glass.",
    continuity: "The envelope stays sealed until scene two, and Mara never learns the sender.",
  };
  return {
    title: "The Late Letter",
    document: documentFixture({
      summary: "A courier carries a letter nobody claims.",
      brief: briefFixture({
        mode: "fiction",
        topic: "A letter that arrives too late",
        audience: "Festival audiences",
        goal: "Show the courier's choice",
        preset: "Story short",
        targetDurationSeconds: 40,
      }),
      storyNotes,
      scenes: [
        sceneFixture({
          id: "scene-1",
          heading: "INT. TRAIN CAR — NIGHT",
          body: "Mara turns the envelope over; there is no name on it.",
          visualDirection: "Close on her thumb over the blank address line.",
          onScreenText: "Winter, 1912",
          durationSeconds: 14,
        }),
        approvedScene({
          id: "scene-2",
          heading: "EXT. PLATFORM — DAWN",
          body: "Elias waits under the clock as the train pulls out.",
          visualDirection: "Long lens through the steam.",
          onScreenText: "",
          durationSeconds: 11,
          locks: {
            narration: false,
            visualDirection: true,
            onScreenText: false,
            duration: false,
          },
        }),
      ],
    }),
    storyNotes,
  };
}

async function seedFactualEvidence(
  app: TestApp,
  projectId: string,
): Promise<{ source: SourceRecord; claims: ClaimRecord[] }> {
  const sourceCreated = await apiRequest(app.url, `/api/projects/${projectId}/sources`, {
    method: "POST",
    body: JSON.stringify({
      kind: "web",
      title: "Post Office railway mail service, 1912",
      url: "https://example.com/night-mail",
      excerpt: "The night mail was sorted aboard the train and dropped at lineside apparatus.",
      retrievedAt: "2026-11-20T10:00:00.000Z",
    }),
  });
  expect(sourceCreated.status).toBe(201);
  const source = ((await sourceCreated.json()) as { source: SourceRecord }).source;

  const supportedCreated = await apiRequest(app.url, `/api/projects/${projectId}/claims`, {
    method: "POST",
    body: JSON.stringify({
      statement: "Mail was sorted while the train was moving.",
      sourceId: source.id,
      sceneKey: "scene-1",
      quote: "The night mail was sorted aboard the train.",
    }),
  });
  expect(supportedCreated.status).toBe(201);
  const supported = ((await supportedCreated.json()) as { claim: ClaimRecord }).claim;
  expect(supported.status).toBe("unverified");

  const unresolvedCreated = await apiRequest(app.url, `/api/projects/${projectId}/claims`, {
    method: "POST",
    body: JSON.stringify({
      statement: "Every station on the route used the same catcher.",
      sourceId: source.id,
      sceneKey: "scene-2",
    }),
  });
  expect(unresolvedCreated.status).toBe(201);
  const unresolved = ((await unresolvedCreated.json()) as { claim: ClaimRecord }).claim;

  const reviewed = await apiRequest(
    app.url,
    `/api/projects/${projectId}/claims/${supported.id}`,
    { method: "PATCH", body: JSON.stringify({ status: "supported" }) },
  );
  expect(reviewed.status).toBe(200);
  const reviewedClaim = ((await reviewed.json()) as { claim: ClaimRecord }).claim;
  expect(reviewedClaim.status).toBe("supported");

  return { source, claims: [reviewedClaim, unresolved] };
}

/**
 * The one scene-asset replacement path both modes use: upload and attach the
 * first asset, save and reload it, export the editor draft, then attach and
 * save a replacement and release the old asset.
 */
async function runSceneAssetReplacementWorkflow(app: TestApp, project: ProjectRecord): Promise<void> {
  const firstAsset = await uploadImage(app, project.id, PNG_A);
  const firstReference = await attachToScene(app, project.id, firstAsset.id, "scene-1");
  const withFirstAsset = withSceneAssets(project.document, "scene-1", [firstAsset.id]);

  const saved = await saveProject(app, project, withFirstAsset);
  expect(saved.version).toBe(project.version + 1);
  expect(saved.document).toEqual(withFirstAsset);

  const reloaded = await reloadProject(app, project.id);
  expect(reloaded.title).toBe(project.title);
  expect(reloaded.version).toBe(saved.version);
  expect(reloaded.document).toEqual(withFirstAsset);

  // The export route deliberately builds from the editor draft posted here, so
  // its document is an echo of the request and proves nothing about storage;
  // the reload above does that. The server-built render payload and credits
  // are what this check adds.
  const exported = await exportProject(app, reloaded);
  expect(exported.renderPayload.scenes.map((scene) => scene.sceneId)).toEqual([
    "scene-1",
    "scene-2",
  ]);
  expect(exported.renderPayload.scenes[0]).toMatchObject({
    heading: withFirstAsset.scenes[0].heading,
    durationSeconds: withFirstAsset.scenes[0].durationSeconds,
  });
  // An uploaded file has no stock provenance, so the export invents no credit.
  expect(exported.credits).toEqual([]);

  const replacement = await uploadImage(app, project.id, PNG_B);
  await attachToScene(app, project.id, replacement.id, "scene-1");
  const withReplacement = withSceneAssets(reloaded.document, "scene-1", [replacement.id]);

  const replaced = await saveProject(app, reloaded, withReplacement);
  expect(replaced.document).toEqual(withReplacement);

  const afterReplacement = await reloadProject(app, project.id);
  expect(afterReplacement.version).toBe(replaced.version);
  expect(afterReplacement.document).toEqual(withReplacement);

  // The render payload lists only stock-provenance assets, so an uploaded image
  // never appears there. Replacement is proven by the saved document above and
  // by the old asset now being releasable, deletable, and gone from the bucket.
  expect((await detachFromScene(app, project.id, firstAsset.id, firstReference.id)).status).toBe(200);
  expect((await deleteMedia(app, project.id, firstAsset.id)).status).toBe(200);
  expect(app.r2.objects.size).toBe(1);

  const replacementPlayback = await playback(app, project.id, replacement.id);
  expect(replacementPlayback.status).toBe(200);
  const replacementUrl = (await replacementPlayback.json()) as { url: string; byteSize: number };
  expect(replacementUrl.byteSize).toBe(PNG_B.length);
  const served = Buffer.from(await (await fetch(replacementUrl.url)).arrayBuffer());
  expect(served.equals(PNG_B)).toBe(true);

  const oldPlayback = await playback(app, project.id, firstAsset.id);
  expect(oldPlayback.status).toBe(409);
  expect(await oldPlayback.json()).toMatchObject({ error: { code: "MEDIA_NOT_READY" } });
  expect(app.supabase.media.find((row) => row.id === firstAsset.id)?.status).toBe("deleted");
}

function claimStates(claims: ClaimRecord[]): string[] {
  return claims.map((claim) => `${claim.id}:${claim.status}`).sort();
}

describe("phase 10 provider-free workflows", () => {
  it("drives a factual project through saved review, reload, export, and a scene-asset replacement", async () => {
    const app = await startTestServer({ env: PROVIDER_FREE_ENV });

    try {
      const { title, document } = factualProjectFixture();
      const project = await createProject(app, title, document);
      const { source, claims } = await seedFactualEvidence(app, project.id);

      // Evidence rows live outside the document, so compare them after the
      // workflow has saved, reloaded, and replaced an asset.
      await runSceneAssetReplacementWorkflow(app, project);

      expect(await listSources(app, project.id)).toEqual([source]);
      expect(claimStates(await listClaims(app, project.id))).toEqual(claimStates(claims));
    } finally {
      await app.close();
    }
  });

  it("drives a fiction project through continuity notes, reload, export, and a scene-asset replacement", async () => {
    const app = await startTestServer({ env: PROVIDER_FREE_ENV });

    try {
      const { title, document, storyNotes } = fictionProjectFixture();
      const project = await createProject(app, title, document);
      expect(project.document.storyNotes).toEqual(storyNotes);

      // The shared workflow compares whole documents after every save and
      // reload, so the notes are covered at each step.
      await runSceneAssetReplacementWorkflow(app, project);
    } finally {
      await app.close();
    }
  });
});
