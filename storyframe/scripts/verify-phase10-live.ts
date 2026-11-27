import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "../server/app";
import type { ProjectDocumentV2, ProjectRecord, ProjectScene } from "../shared/project-contract";
import { sceneFingerprint } from "../shared/scene-fingerprint";

/**
 * Opt-in Phase 10 acceptance check. Drives one factual and one fiction project
 * through the real routes against hosted Supabase and the private R2 bucket,
 * generates one real Deepgram narration per project, and renders each through
 * JSON2Video. It verifies reload, JSON/script download, revision restore,
 * selective asset replacement, factual claims, fiction notes, and the exported
 * MP4 bytes, then deletes both projects and the disposable user.
 *
 * This spends provider credit: one 10-second render and one short narration per
 * requested mode (both modes by default).
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, a publishable key,
 * DEEPGRAM_API_KEY, JSON2VIDEO_API_KEY, and the R2 endpoint/bucket/credentials
 * (or the CLOUDFLARE_* fallbacks). It never prints keys or signed URLs.
 */
try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
const r2 = {
  endpoint: process.env.R2_ENDPOINT ?? process.env.CLOUDFLARE_S3_ENDPOINT_URL,
  bucket: process.env.R2_BUCKET_NAME ?? process.env.CLOUDFLARE_R2_BUCKET_NAME,
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? process.env.CLOUDFLARE_ACCESS_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
};

if (!base || !serviceRoleKey || !publishableKey) {
  console.error(
    "verify:phase10-live requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_PUBLISHABLE_KEY.",
  );
  process.exit(1);
}
if (!process.env.DEEPGRAM_API_KEY?.trim()) {
  console.error("verify:phase10-live requires DEEPGRAM_API_KEY for the real narration.");
  process.exit(1);
}
if (!process.env.JSON2VIDEO_API_KEY?.trim()) {
  console.error("verify:phase10-live requires JSON2VIDEO_API_KEY for the real render.");
  process.exit(1);
}
if (!r2.endpoint || !r2.bucket || !r2.accessKeyId || !r2.secretAccessKey) {
  console.error("verify:phase10-live requires the R2 endpoint, bucket, access key, and secret.");
  process.exit(1);
}

const adminHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};
const serviceHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createUser(): Promise<{ id: string; token: string }> {
  const email = `storyframe-phase10-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `R${randomUUID()}a1!`;
  const created = await fetch(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const createdBody = (await created.json().catch(() => ({}))) as { id?: string; user?: { id?: string } };
  const id = createdBody.id ?? createdBody.user?.id;
  if (!created.ok || typeof id !== "string") {
    throw new Error(`could not create a disposable user (HTTP ${created.status})`);
  }
  const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = (await login.json().catch(() => ({}))) as { access_token?: string };
  if (!login.ok || typeof session.access_token !== "string") {
    throw new Error(`could not sign in the disposable user (HTTP ${login.status})`);
  }
  return { id, token: session.access_token };
}

function approvedScene(
  id: string,
  heading: string,
  body: string,
  onScreenText: string,
  durationSeconds: number,
): ProjectScene {
  const scene: ProjectScene = {
    id,
    heading,
    body,
    visualDirection: "A slow push in.",
    assetIds: [],
    onScreenText,
    durationSeconds,
    approved: true,
    approvedFingerprint: "",
    locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
  };
  return { ...scene, approvedFingerprint: sceneFingerprint(scene) };
}

function documentFor(mode: "factual" | "fiction"): ProjectDocumentV2 {
  const factual = mode === "factual";
  return {
    schemaVersion: 2,
    summary: factual
      ? "How the 1912 night mail moved letters between stations."
      : "A courier carries a letter nobody claims.",
    brief: {
      topic: factual ? "The 1912 night mail" : "A letter that arrives too late",
      audience: factual ? "History viewers" : "Festival audiences",
      goal: factual ? "Explain how the mail moved overnight" : "Show the courier's choice",
      mode,
      targetDurationSeconds: 6,
      tone: "Neutral",
      preset: factual ? "Explainer" : "Story short",
      voicePreference: "neutral",
      planningBudgetUsd: 0,
    },
    ...(factual
      ? {}
      : {
          storyNotes: {
            characters: "Mara the courier wants the letter delivered; Elias wants it forgotten.",
            setting: "A night train in winter 1912, gas lamps and frost on the glass.",
            continuity: "The envelope stays sealed until scene two, and Mara never learns the sender.",
          },
        }),
    scenes: factual
      ? [
          approvedScene(
            "scene-1",
            "INT. MAIL CAR — NIGHT",
            "Sorters face a wall of pigeonholes as the train rocks across the coast.",
            "The Night Mail, 1912",
            5,
          ),
          approvedScene(
            "scene-2",
            "EXT. PLATFORM — DAWN",
            "A pouch is swung from the moving train and caught on the platform.",
            "Delivered at dawn",
            5,
          ),
        ]
      : [
          approvedScene(
            "scene-1",
            "INT. TRAIN CAR — NIGHT",
            "Mara turns the envelope over; there is no name on it.",
            "Winter, 1912",
            5,
          ),
          approvedScene(
            "scene-2",
            "EXT. PLATFORM — DAWN",
            "Elias waits under the clock as the train pulls out.",
            "The letter stays sealed",
            5,
          ),
        ],
  };
}

/** Attaching or replacing media changes the scene fingerprint, so it must be
 * re-approved explicitly, exactly as the editor does after a media change. */
function approveSceneAssets(
  document: ProjectDocumentV2,
  sceneId: string,
  assetIds: string[],
): ProjectDocumentV2 {
  return {
    ...document,
    scenes: document.scenes.map((scene) => {
      if (scene.id !== sceneId) return scene;
      const next = { ...scene, assetIds };
      return { ...next, approved: true, approvedFingerprint: sceneFingerprint(next) };
    }),
  };
}

async function main(): Promise<number> {
  const server = createStoryframeServer({
    env: { ...process.env, VIDEO_SWEEP_INTERVAL_MS: process.env.VIDEO_SWEEP_INTERVAL_MS ?? "3000" },
    logger: { error: () => undefined },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port assigned");
  const appUrl = `http://127.0.0.1:${address.port}`;

  async function api(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${appUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  async function serviceRows(query: string): Promise<any[]> {
    const response = await fetch(`${base}/rest/v1/${query}`, { headers: serviceHeaders });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null);
    return Array.isArray(payload) ? payload : [];
  }

  async function uploadImage(
    token: string,
    projectId: string,
  ): Promise<{ id: string; status: string; contentType: string; byteSize: number }> {
    const initiated = await api(token, "POST", `/api/projects/${projectId}/media`, {
      kind: "image",
      contentType: "image/png",
      byteSize: PNG.length,
    });
    if (initiated.status !== 201) throw new Error(`media initiation failed (HTTP ${initiated.status})`);
    const put = await fetch(initiated.body.upload.url, {
      method: "PUT",
      headers: initiated.body.upload.headers,
      body: new Uint8Array(PNG),
    });
    if (!put.ok) throw new Error(`R2 upload failed (HTTP ${put.status})`);
    const completed = await api(
      token,
      "POST",
      `/api/projects/${projectId}/media/${initiated.body.media.id}/complete`,
      {},
    );
    if (completed.status !== 200) throw new Error(`media completion failed (HTTP ${completed.status})`);
    return completed.body.media;
  }

  async function waitForExport(
    token: string,
    projectId: string,
    exportId: string,
    timeoutMs = 8 * 60 * 1000,
  ): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let last: any = null;
    while (Date.now() < deadline) {
      const current = await api(token, "GET", `/api/projects/${projectId}/exports/video/${exportId}`);
      last = current.body?.export ?? last;
      if (last?.status === "ready" || last?.status === "failed") return last;
      await sleep(3000);
    }
    return last;
  }

  let user: { id: string; token: string } | null = null;
  const projectIds: string[] = [];

  try {
    user = await createUser();

    const requested: ("factual" | "fiction")[] = process.argv.includes("--factual")
      ? ["factual"]
      : process.argv.includes("--fiction")
        ? ["fiction"]
        : ["factual", "fiction"];
    for (const mode of requested) {
      const label = mode === "factual" ? "Factual" : "Fiction";
      const document = documentFor(mode);
      const created = await api(user.token, "POST", "/api/projects", {
        projectType: "story",
        title: mode === "factual" ? "The Night Mail" : "The Late Letter",
        document,
      });
      const projectId = created.body?.project?.id ?? null;
      check(`${label}: project is created through the real route`, created.status === 201 && projectId !== null);
      if (!projectId) continue;
      projectIds.push(projectId);
      let current: ProjectRecord = created.body.project;

      if (mode === "fiction") {
        check(
          `${label}: continuity notes are stored on creation`,
          JSON.stringify(current.document.storyNotes) === JSON.stringify(document.storyNotes),
        );
      }

      // A second save, then restore revision 1: history appends, never rewrites.
      const changed: ProjectDocumentV2 = { ...current.document, summary: `${current.document.summary} Draft two.` };
      const saved = await api(user.token, "PUT", `/api/projects/${projectId}`, {
        title: current.title,
        document: changed,
        version: current.version,
      });
      check(`${label}: a second save appends a revision`, saved.status === 200 && saved.body?.project?.version > current.version);
      current = saved.body?.project ?? current;

      const restored = await api(user.token, "POST", `/api/projects/${projectId}/revisions/1/restore`, {
        version: current.version,
      });
      check(
        `${label}: restoring revision 1 appends a new version with the original document`,
        restored.status === 200 &&
          restored.body?.restoredFrom === 1 &&
          restored.body?.project?.version > current.version &&
          isDeepStrictEqual(restored.body?.project?.document, document),
        `status=${restored.status} v=${restored.body?.project?.version}`,
      );
      current = restored.body?.project ?? current;

      const reloaded = await api(user.token, "GET", `/api/projects/${projectId}`);
      check(
        `${label}: reload returns the restored revision`,
        reloaded.status === 200 &&
          reloaded.body?.project?.version === current.version &&
          isDeepStrictEqual(reloaded.body?.project?.document, document),
      );

      if (mode === "factual") {
        const source = await api(user.token, "POST", `/api/projects/${projectId}/sources`, {
          kind: "web",
          title: "Post Office railway mail service, 1912",
          url: "https://example.com/night-mail",
          excerpt: "The night mail was sorted aboard the train and dropped at lineside apparatus.",
          retrievedAt: "2026-11-20T10:00:00.000Z",
        });
        check(`${label}: the source is recorded`, source.status === 201);
        const claim = await api(user.token, "POST", `/api/projects/${projectId}/claims`, {
          statement: "Mail was sorted while the train was moving.",
          sourceId: source.body?.source?.id,
          sceneKey: "scene-1",
          quote: "The night mail was sorted aboard the train.",
        });
        check(`${label}: the claim starts unverified`, claim.status === 201 && claim.body?.claim?.status === "unverified");
        const reviewed = await api(
          user.token,
          "PATCH",
          `/api/projects/${projectId}/claims/${claim.body?.claim?.id}`,
          { status: "supported" },
        );
        check(`${label}: claim review records a supported verdict`, reviewed.status === 200 && reviewed.body?.claim?.status === "supported");
        const sourcesAfter = await api(user.token, "GET", `/api/projects/${projectId}/sources`);
        const claimsAfter = await api(user.token, "GET", `/api/projects/${projectId}/claims`);
        check(
          `${label}: sources and claims survive the reload`,
          sourcesAfter.body?.sources?.length === 1 && claimsAfter.body?.claims?.[0]?.status === "supported",
        );
      }

      const firstAsset = await uploadImage(user.token, projectId);
      const firstReference = await api(
        user.token,
        "POST",
        `/api/projects/${projectId}/media/${firstAsset.id}/references`,
        { refKind: "scene", refId: "scene-1" },
      );
      check(`${label}: the uploaded asset attaches to scene 1`, firstReference.status === 201);

      const withFirst = approveSceneAssets(current.document, "scene-1", [firstAsset.id]);
      const savedWithAsset = await api(user.token, "PUT", `/api/projects/${projectId}`, {
        title: current.title,
        document: withFirst,
        version: current.version,
      });
      check(`${label}: the scene asset id saves`, savedWithAsset.status === 200);
      current = savedWithAsset.body?.project ?? current;

      const reloadedWithAsset = await api(user.token, "GET", `/api/projects/${projectId}`);
      check(
        `${label}: reload keeps the attached asset and the untouched scene`,
        isDeepStrictEqual(reloadedWithAsset.body?.project?.document, withFirst),
      );

      const downloaded = await api(user.token, "POST", `/api/projects/${projectId}/export`, {
        title: current.title,
        document: current.document,
      });
      check(
        `${label}: the JSON/script export downloads the saved document`,
        downloaded.status === 200 &&
          isDeepStrictEqual(downloaded.body?.export?.document, current.document) &&
          downloaded.body?.export?.renderPayload?.scenes?.length === 2,
      );

      const replacement = await uploadImage(user.token, projectId);
      const replacementReference = await api(
        user.token,
        "POST",
        `/api/projects/${projectId}/media/${replacement.id}/references`,
        { refKind: "scene", refId: "scene-1" },
      );
      const withReplacement = approveSceneAssets(current.document, "scene-1", [replacement.id]);
      const savedReplacement = await api(user.token, "PUT", `/api/projects/${projectId}`, {
        title: current.title,
        document: withReplacement,
        version: current.version,
      });
      check(
        `${label}: selective replacement saves the new asset id`,
        replacementReference.status === 201 && savedReplacement.status === 200,
      );
      current = savedReplacement.body?.project ?? current;

      if (firstReference.body?.reference?.id) {
        await api(
          user.token,
          "DELETE",
          `/api/projects/${projectId}/media/${firstAsset.id}/references/${firstReference.body.reference.id}`,
        );
      }
      const removedOld = await api(user.token, "DELETE", `/api/projects/${projectId}/media/${firstAsset.id}`);
      const replacementPlayback = await api(user.token, "GET", `/api/projects/${projectId}/media/${replacement.id}/url`);
      const oldPlayback = await api(user.token, "GET", `/api/projects/${projectId}/media/${firstAsset.id}/url`);
      check(
        `${label}: the old asset deletes while the replacement still plays`,
        removedOld.status === 200 && replacementPlayback.status === 200 && oldPlayback.status === 409,
        `delete=${removedOld.status} new=${replacementPlayback.status} old=${oldPlayback.status}`,
      );

      // Narration belongs to the final approved script: generating it before a
      // media change would leave its fingerprint stale for the render gate.
      const narration = await api(user.token, "POST", `/api/projects/${projectId}/narration`, {
        voiceModel: "aura-2-thalia-en",
      });
      check(
        `${label}: real Deepgram narration becomes an active measured track`,
        narration.status === 201 &&
          narration.body?.track?.source === "deepgram" &&
          narration.body?.track?.status === "active" &&
          narration.body?.track?.durationSeconds > 0 &&
          narration.body?.media?.status === "ready",
        `status=${narration.status} code=${narration.body?.error?.code ?? "none"} duration=${narration.body?.track?.durationSeconds}`,
      );

      const expectedCredits = current.document.scenes.reduce(
        (total, scene) => total + scene.durationSeconds,
        0,
      );
      const submitted = await api(
        user.token,
        "POST",
        `/api/projects/${projectId}/exports/video`,
        { projectRevision: current.version },
        { "Idempotency-Key": `phase10-${mode}-${randomUUID()}` },
      );
      const exportId = submitted.body?.export?.id ?? null;
      check(
        `${label}: the render is accepted at the saved revision`,
        submitted.status === 202 &&
          submitted.body?.export?.projectRevision === current.version &&
          submitted.body?.export?.creditsEstimate === expectedCredits,
        `status=${submitted.status} code=${submitted.body?.error?.code ?? "none"} revision=${submitted.body?.export?.projectRevision}`,
      );
      if (!exportId) continue;

      const finished = await waitForExport(user.token, projectId, exportId);
      check(
        `${label}: the real JSON2Video render reaches ready`,
        finished?.status === "ready" &&
          finished?.durationSeconds > 0 &&
          finished?.byteSize > 0 &&
          finished?.creditsConsumed > 0,
        `status=${finished?.status} code=${finished?.failureCode ?? "none"} ${finished?.failureMessage ?? ""}`,
      );

      const playback = await api(user.token, "GET", `/api/projects/${projectId}/exports/video/${exportId}/url`);
      const bytes = playback.body?.url
        ? Buffer.from(await (await fetch(playback.body.url)).arrayBuffer())
        : Buffer.alloc(0);
      check(
        `${label}: the exported MP4 downloads from private storage`,
        playback.status === 200 &&
          bytes.length === finished?.byteSize &&
          bytes.subarray(4, 8).toString() === "ftyp",
        `bytes=${bytes.length}`,
      );

      const rows = await serviceRows(
        `media_metadata?select=id,kind,status&project_id=eq.${projectId}&kind=eq.video`,
      );
      check(`${label}: the render is stored as one ready video row`, rows.length === 1 && rows[0]?.status === "ready");

      const removedProject = await api(user.token, "DELETE", `/api/projects/${projectId}`);
      const afterDelete = await api(user.token, "GET", `/api/projects/${projectId}`);
      const leftovers = await serviceRows(`media_metadata?select=id&project_id=eq.${projectId}`);
      check(
        `${label}: cleanup removes the project, its rows, and its objects`,
        removedProject.status === 200 && afterDelete.status === 404 && leftovers.length === 0,
      );
      projectIds.splice(projectIds.indexOf(projectId), 1);
    }
  } finally {
    for (const projectId of projectIds) {
      if (user) await api(user.token, "DELETE", `/api/projects/${projectId}`).catch(() => undefined);
    }
    if (user) {
      await fetch(`${base}/auth/v1/admin/users/${user.id}`, {
        method: "DELETE",
        headers: adminHeaders,
      }).catch(() => undefined);
      const probe = await fetch(`${base}/auth/v1/admin/users/${user.id}`, { headers: adminHeaders });
      check("cleanup removes the disposable user", probe.status === 404, `probe=${probe.status}`);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
