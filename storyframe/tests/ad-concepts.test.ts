import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AD_CONCEPT_LIMITS, type ProductAdConceptRecord } from "../shared/ad-concept-contract";
import type { CampaignRecord, ProductRecord } from "../shared/product-contract";
import type { ProjectRecord } from "../shared/project-contract";
import { emptyDocument } from "../shared/project-defaults";
import { buildAdConceptPrompt, buildAdSnapshot, validateAdConceptPayload } from "../server/ad-concepts";
import { PLANNING_LIMITS, PLANNING_ROUTE_OUTPUT_LIMITS } from "../server/planning";
import { PRODUCT_LIMITS } from "../server/products";
import { USER_A, USER_B } from "./fake-supabase";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

// MOCKED: the planning provider is a local stub and Supabase is the local fake.
// `npm run verify:sql` proves the ad-concept table and its constraints.

const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const LOGO_ID = "44444444-4444-4444-8444-444444444444";

interface ProviderCall {
  model: string;
  prompt: string;
  numPredict: number;
}

/** Queued replies; the last reply repeats when the server asks again. */
function stubProvider() {
  const calls: ProviderCall[] = [];
  const replies: string[] = [];
  let index = 0;
  const impl = vi.fn<typeof fetch>(async (input, init) => {
    if (!String(input).endsWith("/api/chat")) return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      messages?: { content?: string }[];
      options?: { num_predict?: number };
    };
    calls.push({
      model: body.model ?? "",
      prompt: body.messages?.[0]?.content ?? "",
      numPredict: body.options?.num_predict ?? 0,
    });
    const reply = replies[Math.min(index, replies.length - 1)] ?? "";
    index += 1;
    return new Response(
      JSON.stringify({ model: body.model ?? "gemma4:31b", message: { content: reply }, done: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { impl, calls, replies };
}

let app: TestApp | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

function seedImage(
  testApp: TestApp,
  id: string,
  projectId: string = "99999999-9999-4999-8999-999999999999",
): void {
  if (testApp.supabase.media.some((row) => row.id === id)) return;
  testApp.supabase.media.push({
    id,
    owner_id: USER_A.id,
    project_id: projectId,
    status: "ready",
    kind: "image",
  });
}

async function createProject(testApp: TestApp): Promise<ProjectRecord> {
  const response = await apiRequest(testApp.url, "/api/projects", {
    method: "POST",
    body: JSON.stringify({
      projectType: "product-ad",
      title: "Harbor launch",
      document: emptyDocument("product-ad"),
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: ProjectRecord }).project;
}

async function createProduct(testApp: TestApp): Promise<ProductRecord> {
  seedImage(testApp, ASSET_ID);
  seedImage(testApp, LOGO_ID);
  const response = await apiRequest(testApp.url, "/api/products", {
    method: "POST",
    body: JSON.stringify({
      name: "Harbor Serum",
      variant: "30 ml",
      brandSettings: { voice: "calm and precise", colors: "deep blue", notes: "" },
      approvedClaims: [
        { text: "Clinically tested", evidence: "Independent 2026 lab report, file LAB-26-04." },
        { text: "Fragrance free", evidence: "Final formula sheet rev 7." },
      ],
      prohibitedWording: ["cures", "miracle"],
      assetMediaIds: [ASSET_ID],
      logoMediaId: LOGO_ID,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { product: ProductRecord }).product;
}

async function createCampaign(
  testApp: TestApp,
  productId: string,
  token: string = USER_A.token,
  projectId: string | null = null,
): Promise<CampaignRecord> {
  const response = await apiRequest(
    testApp.url,
    "/api/campaigns",
    {
      method: "POST",
      body: JSON.stringify({
        productId,
        projectId,
        audience: "Adults with sensitive skin",
        offer: "20% off the starter kit",
        price: 24.5,
        currency: "USD",
        promotionStart: "2026-12-01T00:00:00.000Z",
        promotionEnd: "2026-12-15T00:00:00.000Z",
        timezone: "America/New_York",
        cta: "Shop the kit",
        destination: "https://example.com/starter-kit",
        durationSeconds: 15,
        aspectRatio: "9:16",
        disclaimer: "Offer ends December 15.",
      }),
    },
    token,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { campaign: CampaignRecord }).campaign;
}

/** One bean per beat: three 5-second beats total the campaign's 15 seconds. */
function beats(assetMediaId: string | null) {
  return [
    {
      heading: "The bottle on a wet counter",
      narration: "Skin can be calm without a ceremony.",
      visualDirection: "Slow push in on the serum bottle.",
      onScreenText: "",
      durationSeconds: 5,
      assetMediaId,
    },
    {
      heading: "The formula, not the promise",
      narration: "Two ingredients, tested and fragrance free.",
      visualDirection: "Macro of the dropper.",
      onScreenText: "Clinically tested",
      durationSeconds: 5,
      assetMediaId: null,
    },
    {
      heading: "The offer",
      narration: "The starter kit is twenty percent off.",
      visualDirection: "Product beside the offer card.",
      onScreenText: "Shop the kit",
      durationSeconds: 5,
      assetMediaId: null,
    },
  ];
}

function conceptReply(claimId: string): string {
  return JSON.stringify({
    summary: "Three grounded routes: proof, ritual, and offer.",
    notes: ["Only the approved claim is cited."],
    concepts: [
      {
        title: "Proof before promises",
        hook: "Clinically tested, not just promised.",
        hookVariants: ["The lab result came first.", "Proof, then the bottle."],
        beats: beats(ASSET_ID),
        claimIds: [claimId],
      },
      {
        title: "A quieter ritual",
        hook: "Five calm seconds, morning and night.",
        hookVariants: ["Less noise, more skin.", "A ritual without the theatre."],
        beats: beats(LOGO_ID),
        claimIds: [],
      },
      {
        title: "The starter kit",
        hook: "Everything you need, twenty percent lighter.",
        hookVariants: ["Start with the kit.", "Twenty percent off the first step."],
        beats: beats(null),
        claimIds: [],
      },
    ],
  });
}

const MAX_LOGO_ID = "20000000-0000-4000-8000-000000000000";

function maxAssetId(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** A unique string at exactly `length` characters, so each product bound is exercised. */
function exactText(letter: string, length: number, index: number): string {
  const suffix = `-${index}`;
  return letter.repeat(length - suffix.length) + suffix;
}

function maximalProductBody(): Record<string, unknown> {
  return {
    name: exactText("N", PRODUCT_LIMITS.nameChars, 0),
    variant: exactText("V", PRODUCT_LIMITS.variantChars, 0),
    brandSettings: {
      voice: exactText("A", PRODUCT_LIMITS.brandSettingChars, 0),
      colors: exactText("B", PRODUCT_LIMITS.brandSettingChars, 0),
      notes: exactText("C", PRODUCT_LIMITS.brandSettingChars, 0),
    },
    approvedClaims: Array.from({ length: PRODUCT_LIMITS.claims }, (_, index) => ({
      text: exactText("T", PRODUCT_LIMITS.claimChars, index),
      evidence: exactText("E", PRODUCT_LIMITS.evidenceChars, index),
    })),
    prohibitedWording: Array.from({ length: PRODUCT_LIMITS.prohibited }, (_, index) =>
      exactText("P", PRODUCT_LIMITS.prohibitedChars, index),
    ),
    assetMediaIds: Array.from({ length: PRODUCT_LIMITS.assets }, (_, index) => maxAssetId(index)),
    logoMediaId: MAX_LOGO_ID,
  };
}

function maximalCampaignBody(productId: string): Record<string, unknown> {
  const destination = "https://example.com/";
  return {
    productId,
    projectId: null,
    audience: exactText("U", PRODUCT_LIMITS.audienceChars, 0),
    offer: exactText("O", PRODUCT_LIMITS.offerChars, 0),
    price: PRODUCT_LIMITS.priceMax,
    currency: "USD",
    promotionStart: "2026-12-01T00:00:00.000Z",
    promotionEnd: "2026-12-15T00:00:00.000Z",
    timezone: "America/Argentina/ComodRivadavia",
    cta: exactText("C", PRODUCT_LIMITS.ctaChars, 0),
    destination: destination + "d".repeat(PRODUCT_LIMITS.destinationChars - destination.length),
    durationSeconds: PRODUCT_LIMITS.maxDurationSeconds,
    aspectRatio: "9:16",
    disclaimer: exactText("D", PRODUCT_LIMITS.disclaimerChars, 0),
  };
}

/** A reply with every accepted text bound at its maximum and every list full. */
function maximalReply(product: ProductRecord, campaign: CampaignRecord) {
  const assets = [...product.assetMediaIds, ...(product.logoMediaId ? [product.logoMediaId] : [])];
  return {
    summary: exactText("M", AD_CONCEPT_LIMITS.summaryChars, 0),
    notes: Array.from({ length: AD_CONCEPT_LIMITS.notes }, (_, index) =>
      exactText("W", AD_CONCEPT_LIMITS.noteChars, index),
    ),
    concepts: Array.from({ length: AD_CONCEPT_LIMITS.concepts }, (_, conceptIndex) => ({
      title: exactText("H", AD_CONCEPT_LIMITS.titleChars, conceptIndex),
      hook: exactText("J", AD_CONCEPT_LIMITS.hookChars, conceptIndex),
      hookVariants: [
        exactText("K", AD_CONCEPT_LIMITS.hookChars, conceptIndex),
        exactText("L", AD_CONCEPT_LIMITS.hookChars, conceptIndex),
      ],
      claimIds: product.approvedClaims.slice(0, AD_CONCEPT_LIMITS.claimIds).map((claim) => claim.id),
      beats: Array.from({ length: AD_CONCEPT_LIMITS.maxBeats }, (_, beatIndex) => ({
        heading: exactText("A", AD_CONCEPT_LIMITS.headingChars, conceptIndex * 10 + beatIndex),
        narration: exactText("N", AD_CONCEPT_LIMITS.narrationChars, conceptIndex * 10 + beatIndex),
        visualDirection: exactText("V", AD_CONCEPT_LIMITS.visualChars, conceptIndex * 10 + beatIndex),
        onScreenText:
          beatIndex === AD_CONCEPT_LIMITS.maxBeats - 1
            ? campaign.cta +
              "S".repeat(AD_CONCEPT_LIMITS.onScreenChars - campaign.cta.length)
            : exactText("S", AD_CONCEPT_LIMITS.onScreenChars, conceptIndex * 10 + beatIndex),
        durationSeconds: campaign.durationSeconds / AD_CONCEPT_LIMITS.maxBeats,
        assetMediaId: assets[(conceptIndex + beatIndex) % assets.length] ?? null,
      })),
    })),
  };
}

function generate(
  testApp: TestApp,
  productId: string,
  campaignId: string,
  idempotencyKey: string = randomUUID(),
  token: string = USER_A.token,
) {
  return apiRequest(
    testApp.url,
    `/api/products/${productId}/ad-concepts`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ campaignId }),
    },
    token,
  );
}

describe("grounded ad concepts", () => {
  it("generates three concepts from the frozen product facts, replays one key, and selects with a manifest", async () => {
    const provider = stubProvider();
    const testApp = await startTestServer({ fetchImpl: provider.impl });
    app = testApp;
    const product = await createProduct(testApp);
    const campaign = await createCampaign(testApp, product.id);
    provider.replies.push(conceptReply(product.approvedClaims[0].id));

    const key = randomUUID();
    const response = await generate(testApp, product.id, campaign.id, key);
    expect(response.status).toBe(201);
    const created = ((await response.json()) as { conceptSet: ProductAdConceptRecord }).conceptSet;

    expect(provider.calls).toHaveLength(1);
    const prompt = provider.calls[0].prompt;
    expect(prompt).toContain("Harbor Serum");
    expect(prompt).toContain("Clinically tested");
    expect(prompt).toContain("Independent 2026 lab report");
    expect(prompt).toContain("cures, miracle");
    expect(prompt).toContain("Shop the kit");
    expect(prompt).toContain("untrusted data");

    expect(created.status).toBe("proposed");
    expect(created.modelId).toBe("gemma");
    expect(created.concepts).toHaveLength(3);
    expect(created.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.snapshot.product.name).toBe("Harbor Serum");
    expect(created.snapshot.campaign.offer).toBe("20% off the starter kit");
    for (const concept of created.concepts) {
      expect(concept.hookVariants).toHaveLength(2);
      expect(concept.totalSeconds).toBe(15);
      expect(concept.id).toMatch(/^[0-9a-f-]{36}$/i);
    }

    // The same key returns the stored answer without a second provider call.
    const replay = await generate(testApp, product.id, campaign.id, key);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { conceptSet: ProductAdConceptRecord }).conceptSet.id).toBe(created.id);
    expect(provider.calls).toHaveLength(1);

    // The key is scoped to this request, not just this account.
    const otherCampaign = await createCampaign(testApp, product.id);
    const reused = await generate(testApp, product.id, otherCampaign.id, key);
    expect(reused.status).toBe(409);
    expect(((await reused.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    // Another account can neither read nor list the set.
    const foreignRead = await apiRequest(testApp.url, `/api/ad-concepts/${created.id}`, {}, USER_B.token);
    expect(foreignRead.status).toBe(404);
    const foreignList = await apiRequest(
      testApp.url,
      `/api/ad-concepts?productId=${product.id}`,
      {},
      USER_B.token,
    );
    expect(foreignList.status).toBe(404);
    expect(((await foreignList.json()) as { error: { code: string } }).error.code).toBe("PRODUCT_NOT_FOUND");

    const list = await apiRequest(testApp.url, `/api/ad-concepts?productId=${product.id}`);
    expect(((await list.json()) as { conceptSets: ProductAdConceptRecord[] }).conceptSets).toHaveLength(1);

    // A later catalog edit cannot rewrite the frozen facts or the manifest.
    testApp.supabase.products[0].name = "Renamed after generation";
    testApp.supabase.campaigns[0].offer = "Changed offer";

    const selection = await apiRequest(testApp.url, `/api/ad-concepts/${created.id}/select`, {
      method: "POST",
      body: JSON.stringify({ index: 1 }),
    });
    expect(selection.status).toBe(200);
    const selected = ((await selection.json()) as { conceptSet: ProductAdConceptRecord }).conceptSet;
    expect(selected.status).toBe("selected");
    expect(selected.selectedIndex).toBe(1);
    expect(selected.snapshot.product.name).toBe("Harbor Serum");
    expect(selected.snapshot.campaign.offer).toBe("20% off the starter kit");

    const manifest = selected.manifest;
    expect(manifest).not.toBeNull();
    expect(manifest?.snapshotHash).toBe(created.snapshotHash);
    expect(manifest?.productName).toBe("Harbor Serum");
    expect(manifest?.projectId).toBeNull();
    expect(manifest?.logoMediaId).toBe(LOGO_ID);
    expect(manifest?.callToAction).toBe("Shop the kit");
    expect(manifest?.aspectRatio).toBe("9:16");
    expect(manifest?.durationSeconds).toBe(15);
    expect(manifest?.hooks).toHaveLength(3);
    expect(manifest?.beats).toHaveLength(3);
    expect(manifest?.beats[0].assetMediaId).toBe(LOGO_ID);
    expect(manifest?.claims).toEqual([]);
    expect(manifest?.disclaimer).toBe("Offer ends December 15.");

    // Selecting the same concept again is idempotent; a different one is refused.
    const again = await apiRequest(testApp.url, `/api/ad-concepts/${created.id}/select`, {
      method: "POST",
      body: JSON.stringify({ index: 1 }),
    });
    expect(again.status).toBe(200);
    const different = await apiRequest(testApp.url, `/api/ad-concepts/${created.id}/select`, {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
    });
    expect(different.status).toBe(409);
    expect(((await different.json()) as { error: { code: string } }).error.code).toBe(
      "AD_CONCEPT_ALREADY_SELECTED",
    );

    // The provider call is recorded once, as a success, with no project scope.
    const usage = testApp.supabase.usage.filter((row) => row.idempotency_key === key);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ status: "success", project_id: null, model_id: "gemma" });
  });

  it("repairs one invalid reply and refuses a second invalid reply without storing a row", async () => {
    const provider = stubProvider();
    const testApp = await startTestServer({ fetchImpl: provider.impl });
    app = testApp;
    const product = await createProduct(testApp);
    const campaign = await createCampaign(testApp, product.id);

    const unknownClaim = JSON.parse(conceptReply(product.approvedClaims[0].id)) as Record<string, unknown>;
    (unknownClaim.concepts as { claimIds: string[] }[])[0].claimIds = ["not-a-claim"];
    provider.replies.push(JSON.stringify(unknownClaim), conceptReply(product.approvedClaims[0].id));

    const repaired = await generate(testApp, product.id, campaign.id);
    expect(repaired.status).toBe(201);
    const repairedSet = ((await repaired.json()) as { conceptSet: ProductAdConceptRecord }).conceptSet;
    expect(repairedSet.repairAttempted).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].prompt).toContain("rejected by validation");

    const broken = JSON.stringify(unknownClaim);
    provider.replies.push(broken, broken);
    const refused = await generate(testApp, product.id, campaign.id);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "AD_CONCEPT_INVALID_JSON",
    );
    expect(testApp.supabase.productAdConcepts).toHaveLength(1);
  });

  it("requires every concept to close on the campaign call to action", async () => {
    const testApp = await startTestServer();
    app = testApp;
    const product = await createProduct(testApp);
    const campaign = await createCampaign(testApp, product.id);
    const reply = JSON.parse(conceptReply(product.approvedClaims[0].id)) as {
      concepts: { beats: { onScreenText: string }[] }[];
    };
    reply.concepts[0].beats[reply.concepts[0].beats.length - 1].onScreenText = "No offer here";

    const snapshot = buildAdSnapshot(product, campaign, new Date().toISOString());
    expect(() => validateAdConceptPayload(reply, snapshot)).toThrow(/call to action/);
  });

  it("enforces product, campaign, and snapshot integrity before a paid concept is offered", async () => {
    const provider = stubProvider();
    const testApp = await startTestServer({ fetchImpl: provider.impl });
    app = testApp;
    const product = await createProduct(testApp);
    const otherProduct = await createProduct(testApp);
    const otherCampaign = await createCampaign(testApp, otherProduct.id);
    provider.replies.push(conceptReply(product.approvedClaims[0].id));

    const mismatched = await generate(testApp, product.id, otherCampaign.id);
    expect(mismatched.status).toBe(400);
    expect(((await mismatched.json()) as { error: { code: string } }).error.code).toBe(
      "CAMPAIGN_PRODUCT_MISMATCH",
    );
    expect(provider.calls).toHaveLength(0);

    const campaign = await createCampaign(testApp, product.id);
    const created = await generate(testApp, product.id, campaign.id);
    expect(created.status).toBe(201);
    const conceptSet = ((await created.json()) as { conceptSet: ProductAdConceptRecord }).conceptSet;

    // A tampered snapshot must not produce a manifest that claims those facts.
    const row = testApp.supabase.productAdConcepts.find((candidate) => candidate.id === conceptSet.id);
    expect(row).toBeDefined();
    row!.snapshot_hash = "0".repeat(64);
    const tampered = await apiRequest(testApp.url, `/api/ad-concepts/${conceptSet.id}/select`, {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
    });
    expect(tampered.status).toBe(503);
    expect(((await tampered.json()) as { error: { code: string } }).error.code).toBe(
      "AD_CONCEPT_SNAPSHOT_INVALID",
    );

    // A foreign campaign is not found even when its id is known.
    const foreignProductResponse = await apiRequest(
      testApp.url,
      "/api/products",
      { method: "POST", body: JSON.stringify({ name: "B product" }) },
      USER_B.token,
    );
    expect(foreignProductResponse.status).toBe(201);
    const foreignProduct = ((await foreignProductResponse.json()) as { product: ProductRecord }).product;
    const foreignCampaign = await createCampaign(testApp, foreignProduct.id, USER_B.token);
    const foreign = await generate(testApp, product.id, foreignCampaign.id);
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe("CAMPAIGN_NOT_FOUND");
    expect(USER_A.id).not.toBe(USER_B.id);
  });

  it("applies a selected manifest to the campaign's project as approved scenes", async () => {
    const provider = stubProvider();
    const testApp = await startTestServer({ fetchImpl: provider.impl });
    app = testApp;
    const project = await createProject(testApp);
    seedImage(testApp, ASSET_ID, project.id);
    seedImage(testApp, LOGO_ID, project.id);
    const product = await createProduct(testApp);
    const campaign = await createCampaign(testApp, product.id, USER_A.token, project.id);
    provider.replies.push(conceptReply(product.approvedClaims[0].id));

    const created = ((
      await (await generate(testApp, product.id, campaign.id)).json()
    ) as { conceptSet: ProductAdConceptRecord }).conceptSet;
    const selected = ((
      await (
        await apiRequest(testApp.url, `/api/ad-concepts/${created.id}/select`, {
          method: "POST",
          body: JSON.stringify({ index: 0 }),
        })
      ).json()
    ) as { conceptSet: ProductAdConceptRecord }).conceptSet;
    expect(selected.manifest?.projectId).toBe(project.id);

    const applied = await apiRequest(testApp.url, `/api/ad-concepts/${created.id}/project`, {
      method: "POST",
      body: "{}",
    });
    expect(applied.status).toBe(200);
    const body = (await applied.json()) as { project: ProjectRecord; projectRevision: number };
    expect(body.projectRevision).toBe(2);
    expect(body.project.id).toBe(project.id);
    expect(body.project.document.scenes).toHaveLength(3);

    const scenes = body.project.document.scenes;
    for (const [index, scene] of scenes.entries()) {
      expect(scene.id).toBe(`ad-${selected.concepts[0].id}-${index + 1}`);
      expect(scene.approved).toBe(true);
      expect(scene.approvedFingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(scene.durationSeconds).toBe(5);
    }
    expect(scenes[0].assetIds).toEqual([ASSET_ID]);
    expect(scenes[0].body).toBe("Skin can be calm without a ceremony.");
    expect(scenes.at(-1)?.onScreenText).toContain("Shop the kit");
    expect(testApp.supabase.projects[0]).toMatchObject({ version: 2 });
    expect(testApp.supabase.revisions.map((revision) => revision.revision)).toEqual([1, 2]);

    // The same manifest replaces its own scenes instead of duplicating them.
    const again = await apiRequest(testApp.url, `/api/ad-concepts/${created.id}/project`, {
      method: "POST",
      body: "{}",
    });
    expect(again.status).toBe(200);
    const reapplied = (await again.json()) as { project: ProjectRecord; projectRevision: number };
    expect(reapplied.projectRevision).toBe(3);
    expect(reapplied.project.document.scenes).toHaveLength(3);

    // An image that has since been deleted cannot enter the render project.
    const logoRow = testApp.supabase.media.find((row) => row.id === LOGO_ID);
    expect(logoRow).toBeDefined();
    logoRow!.status = "deleted";
    const stale = await apiRequest(testApp.url, `/api/ad-concepts/${created.id}/project`, {
      method: "POST",
      body: "{}",
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      "AD_CONCEPT_MEDIA_INVALID",
    );
    expect(testApp.supabase.projects[0]).toMatchObject({ version: 3 });

    logoRow!.status = "ready";
    // A campaign with no render project has nowhere to apply its manifest.
    const unboundCampaign = await createCampaign(testApp, product.id);
    provider.replies.push(conceptReply(product.approvedClaims[0].id));
    const unbound = ((
      await (await generate(testApp, product.id, unboundCampaign.id)).json()
    ) as { conceptSet: ProductAdConceptRecord }).conceptSet;
    await apiRequest(testApp.url, `/api/ad-concepts/${unbound.id}/select`, {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
    });
    const noProject = await apiRequest(testApp.url, `/api/ad-concepts/${unbound.id}/project`, {
      method: "POST",
      body: "{}",
    });
    expect(noProject.status).toBe(409);
    expect(((await noProject.json()) as { error: { code: string } }).error.code).toBe(
      "AD_CONCEPT_PROJECT_REQUIRED",
    );
  });

  it("revalidates catalog images before a paid generation and before freezing a manifest", async () => {
    const provider = stubProvider();
    const testApp = await startTestServer({ fetchImpl: provider.impl });
    app = testApp;
    const product = await createProduct(testApp);
    const campaign = await createCampaign(testApp, product.id);
    provider.replies.push(conceptReply(product.approvedClaims[0].id));

    const assetRow = testApp.supabase.media.find((row) => row.id === ASSET_ID);
    expect(assetRow).toBeDefined();
    assetRow!.status = "deleted";

    // A stale entry must not spend a provider call or store a doomed set.
    const blocked = await generate(testApp, product.id, campaign.id);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      "AD_CONCEPT_MEDIA_INVALID",
    );
    expect(provider.calls).toHaveLength(0);
    expect(testApp.supabase.productAdConcepts).toHaveLength(0);

    // The set exists from before the image was retired; it cannot become a manifest.
    assetRow!.status = "ready";
    const created = ((
      await (await generate(testApp, product.id, campaign.id)).json()
    ) as { conceptSet: ProductAdConceptRecord }).conceptSet;
    assetRow!.status = "deleted";
    const refused = await apiRequest(testApp.url, `/api/ad-concepts/${created.id}/select`, {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "AD_CONCEPT_MEDIA_INVALID",
    );
    expect(testApp.supabase.productAdConcepts[0]).toMatchObject({ status: "proposed", manifest: null });
  });

  it("refuses a project delete that would strand catalog media, then keeps generation and selection valid", async () => {
    const provider = stubProvider();
    const testApp = await startTestServer({ fetchImpl: provider.impl });
    app = testApp;
    const project = await createProject(testApp);
    seedImage(testApp, ASSET_ID, project.id);
    seedImage(testApp, LOGO_ID, project.id);
    // The object keys are what a successful project delete has to clean up.
    for (const id of [ASSET_ID, LOGO_ID]) {
      const row = testApp.supabase.media.find((candidate) => candidate.id === id);
      expect(row).toBeDefined();
      row!.object_key = `media/${USER_A.id}/${id}`;
    }
    const product = await createProduct(testApp);
    const campaign = await createCampaign(testApp, product.id, USER_A.token, project.id);
    provider.replies.push(conceptReply(product.approvedClaims[0].id));

    // The product's references must outlive the project rows. Deleting the
    // project would cascade its images away while the catalog still names
    // them, so the delete is refused before any row or object is touched.
    const refused = await apiRequest(testApp.url, `/api/projects/${project.id}`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "PROJECT_MEDIA_IN_USE",
    );
    expect(testApp.supabase.projects).toHaveLength(1);
    expect(testApp.supabase.media.filter((row) => row.project_id === project.id)).toHaveLength(2);
    expect(testApp.supabase.mediaReferences).toHaveLength(2);

    // With the images intact, the frozen snapshot and its manifest still name
    // only ready media in the render project.
    const created = ((
      await (await generate(testApp, product.id, campaign.id)).json()
    ) as { conceptSet: ProductAdConceptRecord }).conceptSet;
    const selected = ((
      await (
        await apiRequest(testApp.url, `/api/ad-concepts/${created.id}/select`, {
          method: "POST",
          body: JSON.stringify({ index: 0 }),
        })
      ).json()
    ) as { conceptSet: ProductAdConceptRecord }).conceptSet;
    expect(selected.manifest?.logoMediaId).toBe(LOGO_ID);

    // Deleting the product releases the references, so the project can then be
    // deleted and its media rows cascade away with it.
    const deletedProduct = await apiRequest(testApp.url, `/api/products/${product.id}`, {
      method: "DELETE",
    });
    expect(deletedProduct.status).toBe(200);
    const deletedProject = await apiRequest(testApp.url, `/api/projects/${project.id}`, {
      method: "DELETE",
    });
    expect(deletedProject.status).toBe(200);
    expect(testApp.supabase.media.filter((row) => row.project_id === project.id)).toHaveLength(0);
  });

  it("fits a maximal catalog product and reply inside the ad-concept route budget", async () => {
    const provider = stubProvider();
    const testApp = await startTestServer({ fetchImpl: provider.impl });
    app = testApp;

    for (let index = 0; index < PRODUCT_LIMITS.assets; index += 1) {
      seedImage(testApp, maxAssetId(index));
    }
    seedImage(testApp, MAX_LOGO_ID);

    const productResponse = await apiRequest(testApp.url, "/api/products", {
      method: "POST",
      body: JSON.stringify(maximalProductBody()),
    });
    expect(productResponse.status).toBe(201);
    const product = ((await productResponse.json()) as { product: ProductRecord }).product;
    expect(product.approvedClaims).toHaveLength(PRODUCT_LIMITS.claims);

    const campaignResponse = await apiRequest(testApp.url, "/api/campaigns", {
      method: "POST",
      body: JSON.stringify(maximalCampaignBody(product.id)),
    });
    expect(campaignResponse.status).toBe(201);
    const campaign = ((await campaignResponse.json()) as { campaign: CampaignRecord }).campaign;

    const reply = maximalReply(product, campaign);
    const replyJson = JSON.stringify(reply);
    // The route gets an 8,000-token cap; at a conservative three characters per
    // token, the largest accepted reply must fit with room to spare.
    expect(replyJson.length).toBeLessThanOrEqual(PLANNING_ROUTE_OUTPUT_LIMITS["ad-concept"] * 3);
    expect(() =>
      validateAdConceptPayload(reply, buildAdSnapshot(product, campaign, "2026-11-27T12:00:00.000Z")),
    ).not.toThrow();

    provider.replies.push(replyJson);
    const generated = await generate(testApp, product.id, campaign.id);
    expect(generated.status).toBe(201);
    const conceptSet = ((await generated.json()) as { conceptSet: ProductAdConceptRecord }).conceptSet;
    expect(conceptSet.summary).toHaveLength(AD_CONCEPT_LIMITS.summaryChars);
    expect(conceptSet.concepts[0].beats).toHaveLength(AD_CONCEPT_LIMITS.maxBeats);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].numPredict).toBe(PLANNING_ROUTE_OUTPUT_LIMITS["ad-concept"]);
    expect(provider.calls[0].prompt.length).toBeLessThanOrEqual(PLANNING_LIMITS.promptChars);
    expect(provider.calls[0].prompt).not.toContain("facts truncated");

    const prompt = provider.calls[0].prompt;
    expect(prompt).toContain("Task: return one JSON object with only these keys:");
    expect(prompt).toContain("Keep JSON valid: double quotes, no trailing commas, no comments.");
    expect(prompt).toContain(product.approvedClaims.at(-1)!.id);
    expect(prompt).toContain(product.approvedClaims.at(-1)!.evidence);
    expect(prompt).toContain(product.prohibitedWording.at(-1)!);
    expect(prompt).toContain(product.assetMediaIds.at(-1)!);
    expect(prompt).toContain(product.logoMediaId!);
    expect(prompt).toContain(campaign.disclaimer);

    // A forced over-budget prompt drops facts from the head but keeps the whole
    // task schema and instruction, so the model is never asked for a contract
    // it cannot read.
    const truncated = buildAdConceptPrompt(
      buildAdSnapshot(product, campaign, "2026-11-27T12:00:00.000Z"),
      "i".repeat(AD_CONCEPT_LIMITS.instructionChars),
      5000,
    );
    expect(truncated.length).toBeLessThanOrEqual(5000);
    expect(truncated).toContain("facts truncated");
    expect(truncated).toContain("Task: return one JSON object with only these keys:");
    expect(truncated).toContain("Keep JSON valid: double quotes, no trailing commas, no comments.");
    expect(truncated).toContain("Additional instruction:");
    expect(truncated).not.toContain(product.approvedClaims.at(-1)!.evidence);
  });
});
