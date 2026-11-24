import { describe, expect, it } from "vitest";
import type { MediaRecord, MediaReferenceRecord } from "../shared/media-contract";
import { USER_A, USER_B } from "./fake-supabase";
import { apiRequest, startTestServer } from "./server-helpers";

// MOCKED: Supabase and the S3 endpoint are local fakes served over HTTP. The
// SigV4 signing itself is checked separately by `npm run verify:r2-live`.

const DOCUMENT = {
  schemaVersion: 1,
  summary: "A courier finds a letter that was never meant to arrive.",
  scenes: [
    {
      id: "scene-1",
      heading: "INT. TRAIN CAR - NIGHT",
      body: "The letter waits under a seat, addressed to nobody.",
    },
  ],
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 1)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200, 0)]);
const MP4 = Buffer.alloc(64);
MP4.writeUInt32BE(24, 0);
MP4.write("ftyp", 4, "latin1");
MP4.write("isom", 8, "latin1");

interface MediaInitiateResponse {
  ok: true;
  media: MediaRecord;
  upload: { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };
}

async function createProject(appUrl: string, token: string = USER_A.token): Promise<string> {
  const response = await apiRequest(
    appUrl,
    "/api/projects",
    {
      method: "POST",
      body: JSON.stringify({ projectType: "story", title: "The Late Letter", document: DOCUMENT }),
    },
    token,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

async function initiateUpload(
  appUrl: string,
  projectId: string,
  body: Record<string, unknown>,
  token: string = USER_A.token,
): Promise<MediaInitiateResponse> {
  const response = await apiRequest(
    appUrl,
    `/api/projects/${projectId}/media`,
    { method: "POST", body: JSON.stringify(body) },
    token,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as MediaInitiateResponse;
}

/** Uploads directly to the bucket through the presigned URL, as a browser would. */
async function putObject(ticket: MediaInitiateResponse, bytes: Buffer): Promise<void> {
  const response = await fetch(ticket.upload.url, {
    method: "PUT",
    headers: ticket.upload.headers,
    body: new Uint8Array(bytes),
  });
  expect(response.status).toBe(200);
}

async function complete(appUrl: string, projectId: string, mediaId: string, token: string = USER_A.token) {
  return apiRequest(
    appUrl,
    `/api/projects/${projectId}/media/${mediaId}/complete`,
    { method: "POST" },
    token,
  );
}

describe("private media storage", () => {
  it("uploads, validates, and plays back an image through short-lived URLs", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
        sceneKey: "scene-1",
      });

      expect(ticket.media).toMatchObject({ kind: "image", status: "pending", byteSize: PNG.length });
      expect(ticket.upload.method).toBe("PUT");
      expect(ticket.upload.url).toContain(`/storyframe-test-media/media/${USER_A.id}/${ticket.media.id}?`);
      expect(ticket.upload.url).toContain("X-Amz-Signature=");
      // The secret never appears in the ticket.
      expect(ticket.upload.url).not.toContain("test-secret-access-key");

      await putObject(ticket, PNG);
      const completed = await complete(app.url, projectId, ticket.media.id);
      expect(completed.status).toBe(200);
      const completedBody = (await completed.json()) as { media: MediaRecord };
      expect(completedBody.media).toMatchObject({
        status: "ready",
        contentType: "image/png",
        byteSize: PNG.length,
        sceneKey: "scene-1",
      });

      const playbackResponse = await apiRequest(
        app.url,
        `/api/projects/${projectId}/media/${ticket.media.id}/url`,
      );
      expect(playbackResponse.status).toBe(200);
      const playback = (await playbackResponse.json()) as { url: string; contentType: string; byteSize: number };
      expect(playback.contentType).toBe("image/png");
      expect(playback.byteSize).toBe(PNG.length);

      const downloaded = Buffer.from(await (await fetch(playback.url)).arrayBuffer());
      expect(downloaded.equals(PNG)).toBe(true);

      const list = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      const listBody = (await list.json()) as { media: MediaRecord[] };
      expect(listBody.media).toHaveLength(1);
      expect(listBody.media[0].status).toBe("ready");
      expect(app.r2.puts).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("accepts audio and video only when the bytes match the declared kind", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);

      for (const candidate of [
        { kind: "audio", contentType: "audio/mpeg", bytes: MP3, detected: "audio/mpeg" },
        { kind: "video", contentType: "video/mp4", bytes: MP4, detected: "video/mp4" },
      ] as const) {
        const ticket = await initiateUpload(app.url, projectId, {
          kind: candidate.kind,
          contentType: candidate.contentType,
          byteSize: candidate.bytes.length,
        });
        await putObject(ticket, candidate.bytes);
        const completed = await complete(app.url, projectId, ticket.media.id);
        expect(completed.status).toBe(200);
        const body = (await completed.json()) as { media: MediaRecord };
        expect(body.media).toMatchObject({ kind: candidate.kind, status: "ready", contentType: candidate.detected });
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a file whose real type does not match and discards the object", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: MP4.length,
      });
      await putObject(ticket, MP4);

      const response = await complete(app.url, projectId, ticket.media.id);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "MEDIA_TYPE_MISMATCH" } });
      expect(app.r2.objects.size).toBe(0);
      expect(app.supabase.media[0].status).toBe("deleted");
    } finally {
      await app.close();
    }
  });

  it("refuses an oversized declaration and an account over its storage limit", async () => {
    const app = await startTestServer({ env: { MEDIA_OWNER_STORAGE_BYTES: "1024" } });
    try {
      const projectId = await createProject(app.url);

      const tooLarge = await apiRequest(app.url, `/api/projects/${projectId}/media`, {
        method: "POST",
        body: JSON.stringify({ kind: "image", contentType: "image/png", byteSize: 11 * 1024 * 1024 }),
      });
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.json()).toMatchObject({ ok: false, error: { code: "MEDIA_TOO_LARGE" } });

      const first = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      expect(first.media.status).toBe("pending");

      const overQuota = await apiRequest(app.url, `/api/projects/${projectId}/media`, {
        method: "POST",
        body: JSON.stringify({ kind: "image", contentType: "image/png", byteSize: 2048 }),
      });
      expect(overQuota.status).toBe(413);
      expect(await overQuota.json()).toMatchObject({ ok: false, error: { code: "MEDIA_STORAGE_LIMIT" } });
    } finally {
      await app.close();
    }
  });

  it("never exposes one account's media to another account", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(ticket, PNG);
      expect((await complete(app.url, projectId, ticket.media.id)).status).toBe(200);

      const otherPlayback = await apiRequest(
        app.url,
        `/api/projects/${projectId}/media/${ticket.media.id}/url`,
        {},
        USER_B.token,
      );
      expect(otherPlayback.status).toBe(404);
      expect(await otherPlayback.json()).toMatchObject({ ok: false, error: { code: "PROJECT_NOT_FOUND" } });

      const otherComplete = await complete(app.url, projectId, ticket.media.id, USER_B.token);
      expect(otherComplete.status).toBe(404);

      const otherDelete = await apiRequest(
        app.url,
        `/api/projects/${projectId}/media/${ticket.media.id}`,
        { method: "DELETE" },
        USER_B.token,
      );
      expect(otherDelete.status).toBe(404);
      expect(app.r2.objects.size).toBe(1);
      expect(app.supabase.media[0].status).toBe("ready");
    } finally {
      await app.close();
    }
  });

  it("keeps a shared asset valid until its last reference is released", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "audio",
        contentType: "audio/mpeg",
        byteSize: MP3.length,
      });
      await putObject(ticket, MP3);
      expect((await complete(app.url, projectId, ticket.media.id)).status).toBe(200);

      const base = `/api/projects/${projectId}/media/${ticket.media.id}`;
      const first = await apiRequest(app.url, `${base}/references`, {
        method: "POST",
        body: JSON.stringify({ refKind: "scene", refId: "scene-1" }),
      });
      expect(first.status).toBe(201);
      const firstRef = ((await first.json()) as { reference: MediaReferenceRecord }).reference;

      const duplicate = await apiRequest(app.url, `${base}/references`, {
        method: "POST",
        body: JSON.stringify({ refKind: "scene", refId: "scene-1" }),
      });
      expect(duplicate.status).toBe(201);
      expect(((await duplicate.json()) as { reference: MediaReferenceRecord }).reference.id).toBe(firstRef.id);

      const second = await apiRequest(app.url, `${base}/references`, {
        method: "POST",
        body: JSON.stringify({ refKind: "render", refId: "render-42" }),
      });
      expect(second.status).toBe(201);

      const blocked = await apiRequest(app.url, base, { method: "DELETE" });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ ok: false, error: { code: "MEDIA_IN_USE" } });
      expect(app.r2.objects.size).toBe(1);

      expect((await apiRequest(app.url, `${base}/references/${firstRef.id}`, { method: "DELETE" })).status).toBe(200);
      const stillPlayable = await apiRequest(app.url, `${base}/url`);
      expect(stillPlayable.status).toBe(200);
      expect(app.r2.objects.size).toBe(1);

      const references = await apiRequest(app.url, `${base}/references`);
      expect(((await references.json()) as { references: MediaReferenceRecord[] }).references).toHaveLength(1);

      expect(
        (await apiRequest(app.url, `${base}/references/${firstRef.id}`, { method: "DELETE" })).status,
      ).toBe(404);

      const { references: remaining } = (await (await apiRequest(app.url, `${base}/references`)).json()) as {
        references: MediaReferenceRecord[];
      };
      expect((await apiRequest(app.url, `${base}/references/${remaining[0].id}`, { method: "DELETE" })).status).toBe(
        200,
      );

      const deleted = await apiRequest(app.url, base, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(app.r2.objects.size).toBe(0);
      expect(app.supabase.media[0].status).toBe("deleted");
    } finally {
      await app.close();
    }
  });

  it("reports a missing object and a pending asset clearly", async () => {
    const app = await startTestServer();
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });

      const playback = await apiRequest(app.url, `/api/projects/${projectId}/media/${ticket.media.id}/url`);
      expect(playback.status).toBe(409);
      expect(await playback.json()).toMatchObject({ ok: false, error: { code: "MEDIA_NOT_READY" } });

      const missing = await complete(app.url, projectId, ticket.media.id);
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({ ok: false, error: { code: "MEDIA_OBJECT_MISSING" } });
    } finally {
      await app.close();
    }
  });

  it("cleans up an interrupted upload after its window and expired deletions later", async () => {
    let clock = Date.now();
    const app = await startTestServer({
      now: () => clock,
      env: { MEDIA_UPLOAD_TTL_MS: "0", MEDIA_DELETED_RETENTION_MS: "0" },
    });
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(ticket, PNG);

      clock += 1000;
      const afterSweep = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      const list = (await afterSweep.json()) as { media: MediaRecord[] };
      expect(list.media).toHaveLength(0);
      expect(app.supabase.media).toHaveLength(0);
      expect(app.r2.objects.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("purges an unreferenced ready asset after its retention window", async () => {
    let clock = Date.now();
    const app = await startTestServer({ now: () => clock, env: { MEDIA_UNREFERENCED_RETENTION_MS: "0" } });
    try {
      const projectId = await createProject(app.url);
      const ticket = await initiateUpload(app.url, projectId, {
        kind: "image",
        contentType: "image/png",
        byteSize: PNG.length,
      });
      await putObject(ticket, PNG);
      expect((await complete(app.url, projectId, ticket.media.id)).status).toBe(200);
      expect(app.r2.objects.size).toBe(1);

      clock += 1000;
      const afterSweep = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      expect(((await afterSweep.json()) as { media: MediaRecord[] }).media).toHaveLength(0);
      expect(app.r2.objects.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("rejects media requests when the bucket is not configured", async () => {
    const app = await startTestServer({ env: { R2_ENDPOINT: "", R2_BUCKET_NAME: "" } });
    try {
      const projectId = await createProject(app.url);
      const response = await apiRequest(app.url, `/api/projects/${projectId}/media`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "MEDIA_NOT_CONFIGURED" } });
    } finally {
      await app.close();
    }
  });
});
