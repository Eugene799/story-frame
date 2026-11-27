import { describe, expect, it } from "vitest";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import type {
  ProjectDocumentV2,
  ProjectRecord,
  ProjectResponse,
  ProjectRevisionListResponse,
  ProjectRevisionRestoreResponse,
} from "../shared/project-contract";
import { USER_A, USER_B } from "./fake-supabase";
import { documentFixture, sceneFixture } from "./project-fixture";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

// MOCKED: Supabase is a local fake serving Auth and PostgREST over real HTTP.

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function createProject(
  app: TestApp,
  document: ProjectDocumentV2,
  token: string = USER_A.token,
): Promise<ProjectRecord> {
  const response = await apiRequest(
    app.url,
    "/api/projects",
    {
      method: "POST",
      body: JSON.stringify({ projectType: "story", title: "The Late Letter", document }),
    },
    token,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as ProjectResponse).project;
}

async function saveProject(
  app: TestApp,
  project: ProjectRecord,
  document: ProjectDocumentV2,
  token: string = USER_A.token,
): Promise<Response> {
  return apiRequest(
    app.url,
    `/api/projects/${project.id}`,
    {
      method: "PUT",
      body: JSON.stringify({ title: project.title, document, version: project.version }),
    },
    token,
  );
}

describe("project document v2", () => {
  it("migrates a stored v1 document on read and writes v2 on the next save", async () => {
    const app = await startTestServer();

    try {
      const now = new Date().toISOString();
      app.supabase.projects.push({
        id: "44444444-4444-4444-8444-444444444444",
        owner_id: USER_A.id,
        project_type: "story",
        title: "Legacy project",
        schema_version: 1,
        document: {
          schemaVersion: 1,
          summary: "Written before Phase 4.",
          scenes: [{ id: "legacy-scene", heading: "Old heading", body: "Old narration" }],
        },
        version: 1,
        created_at: now,
        updated_at: now,
      });

      const read = await apiRequest(app.url, "/api/projects/44444444-4444-4444-8444-444444444444");
      expect(read.status).toBe(200);
      const project = ((await read.json()) as ProjectResponse).project;
      expect(project.document).toMatchObject({
        schemaVersion: 2,
        summary: "Written before Phase 4.",
        scenes: [
          {
            id: "legacy-scene",
            heading: "Old heading",
            body: "Old narration",
            visualDirection: "",
            assetIds: [],
            onScreenText: "",
            durationSeconds: 0,
            approved: false,
            approvedFingerprint: null,
            locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
          },
        ],
      });
      expect(project.document.brief).toMatchObject({ preset: "Story short", mode: "fiction" });

      const response = await saveProject(app, project, project.document);
      expect(response.status).toBe(200);
      const saved = ((await response.json()) as ProjectResponse).project;
      expect(saved).toMatchObject({ schemaVersion: 2, version: 2 });
      expect(app.supabase.projects[0]).toMatchObject({ schema_version: 2, version: 2 });
      expect(app.supabase.revisions.map((revision) => revision.schema_version)).toEqual([2]);
    } finally {
      await app.close();
    }
  });

  it("refuses a locked component until the scene is unlocked, and allows unlocking plus editing together", async () => {
    const app = await startTestServer();

    try {
      const document = documentFixture({
        scenes: [
          sceneFixture({
            locks: { narration: true, visualDirection: false, onScreenText: false, duration: false },
          }),
        ],
      });
      const project = await createProject(app, document);
      expect(project.document.scenes[0].locks.narration).toBe(true);

      const edited = clone(document);
      edited.scenes[0].body = "The courier opens the envelope.";

      const blocked = await saveProject(app, project, edited);
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({
        ok: false,
        error: { code: "SCENE_FIELD_LOCKED" },
      });
      expect(app.supabase.projects[0]).toMatchObject({ version: 1 });

      // Unlocking is the user's decision, so the same write may carry the edit.
      const unlocked = clone(edited);
      unlocked.scenes[0].locks.narration = false;
      const allowed = await saveProject(app, project, unlocked);
      expect(allowed.status).toBe(200);
      const saved = ((await allowed.json()) as ProjectResponse).project;
      expect(saved.document.scenes[0]).toMatchObject({
        body: "The courier opens the envelope.",
        locks: { narration: false },
      });
    } finally {
      await app.close();
    }
  });

  it("does not delete a scene with any locked component", async () => {
    const app = await startTestServer();

    try {
      const document = documentFixture({
        scenes: [
          sceneFixture({
            locks: { narration: false, visualDirection: false, onScreenText: false, duration: true },
          }),
        ],
      });
      const project = await createProject(app, document);

      const blocked = await saveProject(app, project, { ...document, scenes: [] });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ ok: false, error: { code: "SCENE_LOCKED" } });

      const unlock = clone(document);
      unlock.scenes[0].locks.duration = false;
      const unlocked = await saveProject(app, project, unlock);
      expect(unlocked.status).toBe(200);
      const loaded = ((await unlocked.json()) as ProjectResponse).project;

      const removed = await saveProject(app, loaded, { ...unlock, scenes: [] });
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as ProjectResponse).project.document.scenes).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("keeps an approval only for the exact content fingerprint it covers", async () => {
    const app = await startTestServer();

    try {
      const scene = sceneFixture({
        approved: true,
        approvedFingerprint: null,
      });
      const fingerprint = sceneFingerprint(scene);
      const approvedDocument = documentFixture({
        scenes: [{ ...scene, approvedFingerprint: fingerprint }],
      });

      const project = await createProject(app, approvedDocument);
      expect(project.document.scenes[0]).toMatchObject({
        approved: true,
        approvedFingerprint: fingerprint,
      });
      expect(sceneFingerprint(project.document.scenes[0])).toBe(fingerprint);

      // A mismatched fingerprint does not approve the content it was not given.
      const mismatched = await createProject(
        app,
        documentFixture({ scenes: [{ ...scene, approvedFingerprint: "0000000000000000" }] }),
        USER_B.token,
      );
      expect(mismatched.document.scenes[0]).toMatchObject({
        approved: false,
        approvedFingerprint: null,
      });

      // Editing the narration invalidates the approval instead of carrying it.
      const edited = clone(project.document);
      edited.scenes[0].body = `${edited.scenes[0].body} The courier notices.`;
      const savedResponse = await saveProject(app, project, edited);
      expect(savedResponse.status).toBe(200);
      const saved = ((await savedResponse.json()) as ProjectResponse).project;
      expect(saved.document.scenes[0]).toMatchObject({ approved: false, approvedFingerprint: null });
      expect(sceneFingerprint(saved.document.scenes[0])).not.toBe(fingerprint);

      // Approving the new content stores its own fingerprint.
      const reapproved = clone(saved.document);
      reapproved.scenes[0].approved = true;
      reapproved.scenes[0].approvedFingerprint = sceneFingerprint(reapproved.scenes[0]);
      const done = await saveProject(app, saved, reapproved);
      expect(done.status).toBe(200);
      const approved = ((await done.json()) as ProjectResponse).project;
      expect(approved.document.scenes[0].approved).toBe(true);
      expect(approved.document.scenes[0].approvedFingerprint).toBe(
        sceneFingerprint(approved.document.scenes[0]),
      );
    } finally {
      await app.close();
    }
  });

  it("preserves optional fiction continuity notes through save and reload", async () => {
    const app = await startTestServer();

    try {
      const storyNotes = {
        characters: "Mara wants the letter delivered; Elias wants it forgotten.",
        setting: "Night train, winter 1912, gas lamps and frost.",
        continuity: "The envelope stays sealed until scene three.",
      };
      const project = await createProject(app, documentFixture({ storyNotes }));
      expect(project.document.storyNotes).toEqual(storyNotes);

      const edited = clone(project.document);
      edited.summary = "A later summary";
      const saved = await saveProject(app, project, edited);
      expect(saved.status).toBe(200);
      const body = (await saved.json()) as ProjectResponse;
      expect(body.project.document.storyNotes).toEqual(storyNotes);

      const reloaded = await apiRequest(app.url, `/api/projects/${project.id}`);
      expect(reloaded.status).toBe(200);
      const reloadedBody = (await reloaded.json()) as ProjectResponse;
      expect(reloadedBody.project.document.storyNotes).toEqual(storyNotes);

      const malformed = await apiRequest(
        app.url,
        "/api/projects",
        {
          method: "POST",
          body: JSON.stringify({
            projectType: "story",
            title: "Malformed notes",
            document: { ...documentFixture(), storyNotes: { characters: "only one field" } },
          }),
        },
        USER_B.token,
      );
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ ok: false, error: { code: "INVALID_PROJECT" } });
    } finally {
      await app.close();
    }
  });

  it("keeps scene ids stable through reordering and refuses duplicate ids", async () => {
    const app = await startTestServer();

    try {
      const document = documentFixture({
        scenes: [
          sceneFixture({ id: "scene-a", heading: "A" }),
          sceneFixture({ id: "scene-b", heading: "B" }),
          sceneFixture({ id: "scene-c", heading: "C" }),
        ],
      });
      const project = await createProject(app, document);
      const reordered = clone(document);
      reordered.scenes = [reordered.scenes[2], reordered.scenes[0], reordered.scenes[1]];

      const response = await saveProject(app, project, reordered);
      expect(response.status).toBe(200);
      const saved = ((await response.json()) as ProjectResponse).project;
      expect(saved.document.scenes.map((scene) => scene.id)).toEqual(["scene-c", "scene-a", "scene-b"]);

      const rejected = await apiRequest(
        app.url,
        "/api/projects",
        {
          method: "POST",
          body: JSON.stringify({
            projectType: "story",
            title: "Duplicates",
            document: documentFixture({
              scenes: [sceneFixture({ id: "same" }), sceneFixture({ id: "same", heading: "Again" })],
            }),
          }),
        },
        USER_B.token,
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        ok: false,
        error: { code: "DUPLICATE_SCENE_ID" },
      });
    } finally {
      await app.close();
    }
  });

  it("restores a saved revision as a new version without rewriting history", async () => {
    const app = await startTestServer();

    try {
      const first = await createProject(
        app,
        documentFixture({ summary: "Revision one" }),
      );

      const secondDocument = clone(first.document);
      secondDocument.summary = "Revision two";
      secondDocument.scenes[0].body = "The courier opens the envelope.";
      const second = await saveProject(app, first, secondDocument);
      expect(second.status).toBe(200);
      const atTwo = ((await second.json()) as ProjectResponse).project;

      const thirdDocument = clone(atTwo.document);
      thirdDocument.summary = "Revision three";
      const third = await saveProject(app, atTwo, thirdDocument);
      expect(third.status).toBe(200);
      const atThree = ((await third.json()) as ProjectResponse).project;

      const restored = await apiRequest(
        app.url,
        `/api/projects/${first.id}/revisions/1/restore`,
        { method: "POST", body: JSON.stringify({ version: atThree.version }) },
      );
      expect(restored.status).toBe(200);
      const body = (await restored.json()) as ProjectRevisionRestoreResponse;
      expect(body.restoredFrom).toBe(1);
      expect(body.project).toMatchObject({
        version: 4,
        title: first.title,
        document: { summary: "Revision one" },
      });
      expect(body.project.document.scenes[0].body).toBe(first.document.scenes[0].body);
      expect(app.supabase.revisions.map((revision) => revision.revision).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(app.supabase.revisions.find((revision) => revision.revision === 4)?.document).toMatchObject({
        summary: "Revision one",
      });

      const stale = await apiRequest(
        app.url,
        `/api/projects/${first.id}/revisions/1/restore`,
        { method: "POST", body: JSON.stringify({ version: atThree.version }) },
      );
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        ok: false,
        error: { code: "PROJECT_VERSION_CONFLICT" },
      });

      const unknown = await apiRequest(
        app.url,
        `/api/projects/${first.id}/revisions/999/restore`,
        { method: "POST", body: JSON.stringify({ version: 4 }) },
      );
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({
        ok: false,
        error: { code: "PROJECT_REVISION_NOT_FOUND" },
      });

      // A lock on the current scene blocks a restore that would overwrite it.
      const lockedDocument = clone(body.project.document);
      lockedDocument.scenes[0].locks.narration = true;
      const locked = await saveProject(app, body.project, lockedDocument);
      expect(locked.status).toBe(200);
      const atFive = ((await locked.json()) as ProjectResponse).project;
      // Restoring content that matches the locked component keeps the current
      // lock; the old revision cannot clear it just because it predates it.
      const keptLock = await apiRequest(
        app.url,
        `/api/projects/${first.id}/revisions/1/restore`,
        { method: "POST", body: JSON.stringify({ version: atFive.version }) },
      );
      expect(keptLock.status).toBe(200);
      const atSix = ((await keptLock.json()) as ProjectRevisionRestoreResponse).project;
      expect(atSix.version).toBe(6);
      expect(atSix.document.scenes[0].locks.narration).toBe(true);

      const blocked = await apiRequest(
        app.url,
        `/api/projects/${first.id}/revisions/2/restore`,
        { method: "POST", body: JSON.stringify({ version: atSix.version }) },
      );
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({
        ok: false,
        error: { code: "SCENE_FIELD_LOCKED" },
      });

      const foreign = await apiRequest(
        app.url,
        `/api/projects/${first.id}/revisions/1/restore`,
        { method: "POST", body: JSON.stringify({ version: atSix.version }) },
        USER_B.token,
      );
      expect(foreign.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("lists bounded revision summaries newest first, scoped to the owner", async () => {
    const app = await startTestServer();

    try {
      const project = await createProject(app, documentFixture());
      const second = clone(project.document);
      second.summary = "Revision two";
      const updated = await saveProject(app, project, second);
      expect(updated.status).toBe(200);
      const loaded = ((await updated.json()) as ProjectResponse).project;

      const third = clone(loaded.document);
      third.summary = "Revision three";
      const updatedAgain = await saveProject(app, loaded, third);
      expect(updatedAgain.status).toBe(200);

      const response = await apiRequest(app.url, `/api/projects/${project.id}/revisions`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as ProjectRevisionListResponse;
      expect(body.revisions.map((revision) => revision.revision)).toEqual([3, 2, 1]);
      expect(body.revisions[0]).toMatchObject({ title: "The Late Letter", schemaVersion: 2 });
      expect(body.revisions[0]).not.toHaveProperty("document");

      expect(
        (await apiRequest(app.url, `/api/projects/${project.id}/revisions`, {}, USER_B.token)).status,
      ).toBe(404);
      expect(
        (await apiRequest(app.url, "/api/projects/99999999-9999-4999-8999-999999999999/revisions"))
          .status,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
