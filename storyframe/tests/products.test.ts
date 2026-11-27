import { afterEach, describe, expect, it } from "vitest";
import type {
  CampaignRecord,
  CampaignWrite,
  ProductRecord,
  ProductWrite,
} from "../shared/product-contract";
import type { ReadyImagesResponse } from "../shared/media-contract";
import { emptyDocument } from "../shared/project-defaults";
import { USER_A, USER_B } from "./fake-supabase";
import { apiRequest, startTestServer, type TestApp } from "./server-helpers";

const NOW = "2026-11-27T12:00:00.000Z";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const LOGO_ID = "44444444-4444-4444-8444-444444444444";
const LIBRARY_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const AUDIO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PENDING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DELETED_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOREIGN_ID = "66666666-6666-4666-8666-666666666666";
const SECOND_ASSET_ID = "55555555-5555-4555-8555-555555555551";
const SECOND_LOGO_ID = "55555555-5555-4555-8555-555555555552";
const PROJECT_ID = "77777777-7777-4777-8777-777777777777";

const PRODUCT_BODY: ProductWrite = {
  name: "Harbor Serum",
  variant: "30 ml",
  brandSettings: { voice: "calm and precise", colors: "deep blue", notes: "no exclamation marks" },
  approvedClaims: [
    { text: "Clinically tested", evidence: "Independent 2026 lab report, file LAB-26-04." },
    { text: "Fragrance free", evidence: "Final formula sheet rev 7." },
  ],
  prohibitedWording: ["cures", "miracle"],
  assetMediaIds: [ASSET_ID],
  logoMediaId: LOGO_ID,
};

const CAMPAIGN_BODY: CampaignWrite = {
  productId: "",
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
};

type ErrorBody = { error: { code: string; message: string } };

let app: TestApp | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestApp> {
  app = await startTestServer(options);
  return app;
}

async function post(testApp: TestApp, path: string, body: unknown): Promise<Response> {
  return apiRequest(testApp.url, path, { method: "POST", body: JSON.stringify(body) });
}

async function patch(
  testApp: TestApp,
  path: string,
  body: unknown,
  token: string = USER_A.token,
): Promise<Response> {
  return apiRequest(testApp.url, path, { method: "PATCH", body: JSON.stringify(body) }, token);
}

async function remove(testApp: TestApp, path: string, token: string = USER_A.token): Promise<Response> {
  return apiRequest(testApp.url, path, { method: "DELETE" }, token);
}

/** A ready image row, matching what the media store knows as an asset. */
function seedImage(testApp: TestApp, id: string, ownerId: string = USER_A.id, kind = "image"): void {
  if (testApp.supabase.media.some((row) => row.id === id)) return;
  testApp.supabase.media.push({
    id,
    owner_id: ownerId,
    project_id: "99999999-9999-4999-8999-999999999999",
    status: "ready",
    kind,
  });
}

/** A complete ready-image row, including the fields the picker shows. */
function seedLibraryImage(
  testApp: TestApp,
  options: {
    id: string;
    ownerId?: string;
    projectId?: string;
    kind?: string;
    status?: string;
    contentType?: string;
    byteSize?: number;
  },
): void {
  testApp.supabase.media.push({
    id: options.id,
    owner_id: options.ownerId ?? USER_A.id,
    project_id: options.projectId ?? LIBRARY_PROJECT_ID,
    status: options.status ?? "ready",
    kind: options.kind ?? "image",
    content_type: options.contentType ?? "image/png",
    byte_size: options.byteSize ?? 2048,
    ready_at: (options.status ?? "ready") === "ready" ? NOW : null,
    deleted_at: null,
    created_at: NOW,
  });
}

function seedProject(testApp: TestApp, id: string, title: string): void {
  testApp.supabase.projects.push({
    id,
    owner_id: USER_A.id,
    project_type: "product-ad",
    title,
    schema_version: 2,
    document: emptyDocument("product-ad"),
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
}

async function createProduct(
  testApp: TestApp,
  body: ProductWrite = PRODUCT_BODY,
): Promise<ProductRecord> {
  seedImage(testApp, ASSET_ID);
  seedImage(testApp, LOGO_ID);
  const response = await post(testApp, "/api/products", body);
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { product: ProductRecord };
  return payload.product;
}

describe("ready image library", () => {
  it("lists only this account's ready images with their project for the catalog picker", async () => {
    const testApp = await start();
    seedProject(testApp, LIBRARY_PROJECT_ID, "Harbor launch");
    seedLibraryImage(testApp, { id: ASSET_ID, byteSize: 245_760 });
    seedLibraryImage(testApp, { id: LOGO_ID, byteSize: 8192, contentType: "image/webp" });
    seedLibraryImage(testApp, { id: AUDIO_ID, kind: "audio" });
    seedLibraryImage(testApp, { id: PENDING_ID, status: "pending" });
    seedLibraryImage(testApp, { id: DELETED_ID, status: "deleted" });
    seedLibraryImage(testApp, { id: FOREIGN_ID, ownerId: USER_B.id });

    const response = await apiRequest(testApp.url, "/api/media/images");
    expect(response.status).toBe(200);
    const { images } = (await response.json()) as ReadyImagesResponse;
    // Only ready images from this account: no pending, deleted, audio, or foreign rows.
    expect(images.map((image) => image.id).sort()).toEqual([ASSET_ID, LOGO_ID].sort());
    expect(images).toContainEqual({
      id: ASSET_ID,
      projectId: LIBRARY_PROJECT_ID,
      projectTitle: "Harbor launch",
      contentType: "image/png",
      byteSize: 245_760,
      readyAt: NOW,
      createdAt: NOW,
      provenance: null,
    });

    const anonymous = await apiRequest(testApp.url, "/api/media/images", {}, null);
    expect(anonymous.status).toBe(401);

    const wrongMethod = await apiRequest(testApp.url, "/api/media/images", {
      method: "POST",
      body: "{}",
    });
    expect(wrongMethod.status).toBe(405);
  });
});

describe("product catalog", () => {
  it("stores approved claims, prohibited wording, and real asset ids, scoped to the owner", async () => {
    const testApp = await start();
    const product = await createProduct(testApp);

    expect(product.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(product.name).toBe("Harbor Serum");
    expect(product.variant).toBe("30 ml");
    expect(product.brandSettings).toEqual(PRODUCT_BODY.brandSettings);
    expect(product.approvedClaims).toHaveLength(2);
    expect(product.approvedClaims[0]).toMatchObject({
      text: "Clinically tested",
      evidence: "Independent 2026 lab report, file LAB-26-04.",
    });
    expect(product.approvedClaims[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(product.prohibitedWording).toEqual(["cures", "miracle"]);
    expect(product.assetMediaIds).toEqual([ASSET_ID]);
    expect(product.logoMediaId).toBe(LOGO_ID);

    // Both images carry a retention reference, so the media sweep cannot retire
    // a catalog image as unreferenced after its retention window.
    expect(testApp.supabase.mediaReferences).toHaveLength(2);
    for (const mediaId of [ASSET_ID, LOGO_ID]) {
      expect(testApp.supabase.mediaReferences).toContainEqual(
        expect.objectContaining({
          media_id: mediaId,
          owner_id: USER_A.id,
          ref_kind: "other",
          ref_id: product.id,
        }),
      );
    }

    const list = await apiRequest(testApp.url, "/api/products");
    expect(list.status).toBe(200);
    expect(((await list.json()) as { products: ProductRecord[] }).products).toHaveLength(1);

    const read = await apiRequest(testApp.url, `/api/products/${product.id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { product: ProductRecord }).product.id).toBe(product.id);

    // Another account sees neither the row nor its contents.
    const foreignRead = await apiRequest(testApp.url, `/api/products/${product.id}`, {}, USER_B.token);
    expect(foreignRead.status).toBe(404);
    expect(((await foreignRead.json()) as ErrorBody).error.code).toBe("PRODUCT_NOT_FOUND");

    const foreignList = await apiRequest(testApp.url, "/api/products", {}, USER_B.token);
    expect(((await foreignList.json()) as { products: ProductRecord[] }).products).toHaveLength(0);
  });

  it("rejects malformed products before anything is stored", async () => {
    const testApp = await start();
    const cases: { label: string; body: Record<string, unknown>; message: string }[] = [
      { label: "empty name", body: { ...PRODUCT_BODY, name: "  " }, message: "name" },
      { label: "extra field", body: { ...PRODUCT_BODY, price: 3 }, message: "may only contain" },
      {
        label: "duplicate prohibited wording",
        body: { ...PRODUCT_BODY, prohibitedWording: ["cures", "Cures"] },
        message: "must not repeat",
      },
      {
        label: "claim without text",
        body: { ...PRODUCT_BODY, approvedClaims: [{ evidence: "no claim" }] },
        message: "approvedClaims[0].text",
      },
      {
        label: "duplicate claim",
        body: {
          ...PRODUCT_BODY,
          approvedClaims: [{ text: "Fragrance free" }, { text: "fragrance free" }],
        },
        message: "must not repeat",
      },
      {
        label: "bad asset id",
        body: { ...PRODUCT_BODY, assetMediaIds: ["not-a-uuid"] },
        message: "assetMediaIds[0]",
      },
      {
        label: "unknown brand setting",
        body: { ...PRODUCT_BODY, brandSettings: { logo: "x" } },
        message: "brandSettings",
      },
    ];

    for (const { label, body, message } of cases) {
      const response = await post(testApp, "/api/products", body);
      expect(response.status, label).toBe(400);
      const payload = (await response.json()) as ErrorBody;
      expect(payload.error.code, label).toBe("INVALID_PRODUCT");
      expect(payload.error.message, label).toContain(message);
    }
    expect(testApp.supabase.products).toHaveLength(0);
  });

  it("deletes a product, releases its media references, and cascades its campaign and concept set", async () => {
    const testApp = await start();
    const product = await createProduct(testApp);
    const campaignResponse = await post(testApp, "/api/campaigns", {
      ...CAMPAIGN_BODY,
      productId: product.id,
    });
    expect(campaignResponse.status).toBe(201);
    const campaign = ((await campaignResponse.json()) as { campaign: CampaignRecord }).campaign;
    testApp.supabase.productAdConcepts.push({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      owner_id: USER_A.id,
      product_id: product.id,
      campaign_id: campaign.id,
    });

    const deleted = await apiRequest(testApp.url, `/api/products/${product.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { deletedId: string }).deletedId).toBe(product.id);
    expect(testApp.supabase.products).toHaveLength(0);
    expect(testApp.supabase.campaigns).toHaveLength(0);
    expect(testApp.supabase.productAdConcepts).toHaveLength(0);
    // The sweep may now retire the images; no catalog reference holds them.
    expect(testApp.supabase.mediaReferences).toHaveLength(0);

    const foreign = await apiRequest(testApp.url, `/api/products/${product.id}`, { method: "DELETE" }, USER_B.token);
    expect(foreign.status).toBe(404);
  });

  it("patches a product in place, preserves claim ids, and reconciles its media references", async () => {
    const testApp = await start();
    const product = await createProduct(testApp);
    const campaignResponse = await post(testApp, "/api/campaigns", {
      ...CAMPAIGN_BODY,
      productId: product.id,
    });
    expect(campaignResponse.status).toBe(201);
    const campaign = ((await campaignResponse.json()) as { campaign: CampaignRecord }).campaign;
    testApp.supabase.productAdConcepts.push({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      owner_id: USER_A.id,
      product_id: product.id,
      campaign_id: campaign.id,
    });
    seedImage(testApp, SECOND_ASSET_ID);
    seedImage(testApp, SECOND_LOGO_ID);

    const response = await patch(testApp, `/api/products/${product.id}`, {
      name: "Harbor Serum Corrected",
      brandSettings: { voice: "direct" },
      approvedClaims: [
        { text: product.approvedClaims[0].text, evidence: product.approvedClaims[0].evidence },
        { text: "New claim", evidence: "New evidence" },
      ],
      prohibitedWording: ["cures"],
      assetMediaIds: [SECOND_ASSET_ID],
      logoMediaId: SECOND_LOGO_ID,
    });
    expect(response.status).toBe(200);
    const updated = ((await response.json()) as { product: ProductRecord }).product;
    expect(updated.name).toBe("Harbor Serum Corrected");
    expect(updated.brandSettings).toEqual({
      voice: "direct",
      colors: "deep blue",
      notes: "no exclamation marks",
    });
    expect(updated.approvedClaims).toHaveLength(2);
    expect(updated.approvedClaims[0].id).toBe(product.approvedClaims[0].id);
    expect(updated.approvedClaims[1].id).not.toBe(product.approvedClaims[1].id);
    expect(updated.assetMediaIds).toEqual([SECOND_ASSET_ID]);
    expect(updated.logoMediaId).toBe(SECOND_LOGO_ID);
    expect(updated.prohibitedWording).toEqual(["cures"]);

    // The correction leaves the product's campaigns and frozen concept sets intact.
    expect(testApp.supabase.campaigns).toHaveLength(1);
    expect(testApp.supabase.productAdConcepts).toHaveLength(1);

    const references = testApp.supabase.mediaReferences.filter((row) => row.ref_id === product.id);
    expect(references.map((row) => row.media_id).sort()).toEqual(
      [SECOND_ASSET_ID, SECOND_LOGO_ID].sort(),
    );
    const oldReferences = references.filter(
      (row) => row.media_id === ASSET_ID || row.media_id === LOGO_ID,
    );
    expect(oldReferences).toHaveLength(0);

    const cleared = await patch(testApp, `/api/products/${product.id}`, {
      assetMediaIds: [],
      logoMediaId: null,
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { product: ProductRecord }).product.assetMediaIds).toEqual([]);
    expect(testApp.supabase.mediaReferences.filter((row) => row.ref_id === product.id)).toHaveLength(0);
  });

  it("rolls back a newly added media reference when the product row update fails", async () => {
    const testApp = await start({
      supabase: { failTableWrite: { table: "products", method: "PATCH" } },
    });
    const product = await createProduct(testApp);
    seedImage(testApp, SECOND_ASSET_ID);

    const response = await patch(testApp, `/api/products/${product.id}`, {
      assetMediaIds: [ASSET_ID, SECOND_ASSET_ID],
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as ErrorBody).error.code).toBe("CATALOG_STORE_UNAVAILABLE");

    const read = await apiRequest(testApp.url, `/api/products/${product.id}`);
    const unchanged = ((await read.json()) as { product: ProductRecord }).product;
    expect(unchanged.assetMediaIds).toEqual([ASSET_ID]);
    expect(
      testApp.supabase.mediaReferences.filter((row) => row.media_id === SECOND_ASSET_ID),
    ).toHaveLength(0);
    expect(testApp.supabase.mediaReferences).toHaveLength(2);
  });

  it("refuses a product patch with foreign media or an unknown field without changing the row", async () => {
    const testApp = await start();
    const product = await createProduct(testApp);
    seedImage(testApp, FOREIGN_ID, USER_B.id);

    const foreignAsset = await patch(testApp, `/api/products/${product.id}`, {
      assetMediaIds: [FOREIGN_ID],
    });
    expect(foreignAsset.status).toBe(422);
    expect(((await foreignAsset.json()) as ErrorBody).error.code).toBe("PRODUCT_ASSET_INVALID");
    expect(testApp.supabase.mediaReferences).toHaveLength(2);

    const unknown = await patch(testApp, `/api/products/${product.id}`, { price: 3 });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as ErrorBody).error.code).toBe("INVALID_PRODUCT");

    const foreignProduct = await patch(
      testApp,
      `/api/products/${product.id}`,
      { name: "Not yours" },
      USER_B.token,
    );
    expect(foreignProduct.status).toBe(404);
    expect(((await foreignProduct.json()) as ErrorBody).error.code).toBe("PRODUCT_NOT_FOUND");

    const read = await apiRequest(testApp.url, `/api/products/${product.id}`);
    const unchanged = ((await read.json()) as { product: ProductRecord }).product;
    expect(unchanged.name).toBe(product.name);
    expect(unchanged.assetMediaIds).toEqual([ASSET_ID]);
  });

  it("refuses a media id the caller does not own, or one that is not a ready image", async () => {
    const testApp = await start();
    const foreignId = "66666666-6666-4666-8666-666666666666";
    const audioId = "77777777-7777-4777-8777-777777777777";
    seedImage(testApp, foreignId, USER_B.id);
    seedImage(testApp, audioId, USER_A.id, "audio");

    const foreign = await post(testApp, "/api/products", {
      ...PRODUCT_BODY,
      assetMediaIds: [foreignId],
    });
    expect(foreign.status).toBe(422);
    expect(((await foreign.json()) as ErrorBody).error.code).toBe("PRODUCT_ASSET_INVALID");

    const audioLogo = await post(testApp, "/api/products", {
      ...PRODUCT_BODY,
      logoMediaId: audioId,
    });
    expect(audioLogo.status).toBe(422);
    expect(((await audioLogo.json()) as ErrorBody).error.code).toBe("PRODUCT_ASSET_INVALID");

    expect(testApp.supabase.products).toHaveLength(0);
  });
});

describe("campaigns", () => {
  it("stores the offer against an owned product and lists it by product", async () => {
    const testApp = await start();
    const product = await createProduct(testApp);

    const response = await post(testApp, "/api/campaigns", {
      ...CAMPAIGN_BODY,
      productId: product.id,
    });
    expect(response.status).toBe(201);
    const campaign = ((await response.json()) as { campaign: CampaignRecord }).campaign;

    expect(campaign.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(campaign.productId).toBe(product.id);
    expect(campaign.projectId).toBeNull();
    expect(campaign.price).toBe(24.5);
    expect(campaign.currency).toBe("USD");
    expect(campaign.promotionStart).toBe("2026-12-01T00:00:00.000Z");
    expect(campaign.promotionEnd).toBe("2026-12-15T00:00:00.000Z");
    expect(campaign.timezone).toBe("America/New_York");
    expect(campaign.aspectRatio).toBe("9:16");
    expect(campaign.durationSeconds).toBe(15);
    expect(campaign.disclaimer).toBe("Offer ends December 15.");

    const list = await apiRequest(testApp.url, `/api/campaigns?productId=${product.id}`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { campaigns: CampaignRecord[] }).campaigns).toHaveLength(1);

    const read = await apiRequest(testApp.url, `/api/campaigns/${campaign.id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { campaign: CampaignRecord }).campaign.productId).toBe(product.id);

    const foreignRead = await apiRequest(testApp.url, `/api/campaigns/${campaign.id}`, {}, USER_B.token);
    expect(foreignRead.status).toBe(404);
    expect(((await foreignRead.json()) as ErrorBody).error.code).toBe("CAMPAIGN_NOT_FOUND");

    const foreignList = await apiRequest(
      testApp.url,
      `/api/campaigns?productId=${product.id}`,
      {},
      USER_B.token,
    );
    expect(foreignList.status).toBe(404);
    expect(((await foreignList.json()) as ErrorBody).error.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("refuses a campaign for another account's product", async () => {
    const testApp = await start();
    const product = await createProduct(testApp);

    const response = await post(testApp, "/api/campaigns", {
      ...CAMPAIGN_BODY,
      productId: product.id,
    });
    expect(response.status).toBe(201);

    const foreign = await apiRequest(
      testApp.url,
      "/api/campaigns",
      {
        method: "POST",
        body: JSON.stringify({ ...CAMPAIGN_BODY, productId: product.id }),
      },
      USER_B.token,
    );
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as ErrorBody).error.code).toBe("PRODUCT_NOT_FOUND");
    expect(testApp.supabase.campaigns).toHaveLength(1);
  });

  it("rejects malformed campaigns and unknown projects", async () => {
    const testApp = await start();
    const product = await createProduct(testApp);
    const valid = { ...CAMPAIGN_BODY, productId: product.id };

    const cases: { label: string; body: Record<string, unknown>; message: string }[] = [
      {
        label: "end before start",
        body: { ...valid, promotionEnd: "2026-11-01T00:00:00.000Z" },
        message: "promotionEnd",
      },
      { label: "lowercase currency", body: { ...valid, currency: "usd" }, message: "currency" },
      { label: "bad aspect ratio", body: { ...valid, aspectRatio: "3:2" }, message: "aspectRatio" },
      {
        label: "non-http destination",
        body: { ...valid, destination: "ftp://example.com/kit" },
        message: "http(s)",
      },
      { label: "too short", body: { ...valid, durationSeconds: 2 }, message: "durationSeconds" },
      { label: "unknown timezone", body: { ...valid, timezone: "Mars/Olympus" }, message: "time zone" },
      { label: "negative price", body: { ...valid, price: -1 }, message: "price" },
      { label: "bad product id", body: { ...valid, productId: "nope" }, message: "productId" },
    ];

    for (const { label, body, message } of cases) {
      const response = await post(testApp, "/api/campaigns", body);
      expect(response.status, label).toBe(400);
      const payload = (await response.json()) as ErrorBody;
      expect(payload.error.code, label).toBe("INVALID_CAMPAIGN");
      expect(payload.error.message, label).toContain(message);
    }

    const unknownProject = await post(testApp, "/api/campaigns", {
      ...valid,
      projectId: "55555555-5555-4555-8555-555555555555",
    });
    expect(unknownProject.status).toBe(404);
    expect(((await unknownProject.json()) as ErrorBody).error.code).toBe("PROJECT_NOT_FOUND");
    expect(testApp.supabase.campaigns).toHaveLength(0);
  });

  it("patches a campaign's mutable fields and keeps its product fixed", async () => {
    const testApp = await start();
    seedProject(testApp, PROJECT_ID, "Campaign project");
    const product = await createProduct(testApp);
    const created = await post(testApp, "/api/campaigns", {
      ...CAMPAIGN_BODY,
      productId: product.id,
    });
    expect(created.status).toBe(201);
    const campaign = ((await created.json()) as { campaign: CampaignRecord }).campaign;

    const response = await patch(testApp, `/api/campaigns/${campaign.id}`, {
      audience: "Adults who want a simple routine",
      offer: "Free travel size with the starter kit",
      price: 31,
      projectId: PROJECT_ID,
      cta: "Start a routine",
      disclaimer: "While supplies last.",
    });
    expect(response.status).toBe(200);
    const updated = ((await response.json()) as { campaign: CampaignRecord }).campaign;
    expect(updated.productId).toBe(product.id);
    expect(updated.audience).toBe("Adults who want a simple routine");
    expect(updated.offer).toBe("Free travel size with the starter kit");
    expect(updated.price).toBe(31);
    expect(updated.projectId).toBe(PROJECT_ID);
    expect(updated.cta).toBe("Start a routine");
    expect(updated.disclaimer).toBe("While supplies last.");
    // Omitted fields survive the correction.
    expect(updated.promotionStart).toBe(campaign.promotionStart);
    expect(updated.timezone).toBe(campaign.timezone);
    expect(updated.durationSeconds).toBe(campaign.durationSeconds);

    const immutableProduct = await patch(testApp, `/api/campaigns/${campaign.id}`, {
      productId: DELETED_ID,
    });
    expect(immutableProduct.status).toBe(400);
    const immutableError = (await immutableProduct.json()) as ErrorBody;
    expect(immutableError.error.code).toBe("INVALID_CAMPAIGN");
    expect(immutableError.error.message).toContain("productId");

    const unknownProject = await patch(testApp, `/api/campaigns/${campaign.id}`, {
      projectId: "55555555-5555-4555-8555-555555555556",
    });
    expect(unknownProject.status).toBe(404);
    expect(((await unknownProject.json()) as ErrorBody).error.code).toBe("PROJECT_NOT_FOUND");

    const foreign = await patch(
      testApp,
      `/api/campaigns/${campaign.id}`,
      { offer: "Not yours" },
      USER_B.token,
    );
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as ErrorBody).error.code).toBe("CAMPAIGN_NOT_FOUND");
  });

  it("deletes one campaign and its concept sets without deleting the product or its sibling", async () => {
    const testApp = await start();
    const product = await createProduct(testApp);
    const firstResponse = await post(testApp, "/api/campaigns", {
      ...CAMPAIGN_BODY,
      productId: product.id,
    });
    const secondResponse = await post(testApp, "/api/campaigns", {
      ...CAMPAIGN_BODY,
      productId: product.id,
    });
    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    const first = ((await firstResponse.json()) as { campaign: CampaignRecord }).campaign;
    const second = ((await secondResponse.json()) as { campaign: CampaignRecord }).campaign;
    testApp.supabase.productAdConcepts.push(
      {
        id: PENDING_ID,
        owner_id: USER_A.id,
        product_id: product.id,
        campaign_id: first.id,
      },
      {
        id: DELETED_ID,
        owner_id: USER_A.id,
        product_id: product.id,
        campaign_id: second.id,
      },
    );

    const deleted = await remove(testApp, `/api/campaigns/${first.id}`);
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { deletedId: string }).deletedId).toBe(first.id);
    expect(testApp.supabase.campaigns.map((row) => row.id)).toEqual([second.id]);
    expect(testApp.supabase.productAdConcepts.map((row) => row.campaign_id)).toEqual([second.id]);
    expect(testApp.supabase.products.map((row) => row.id)).toEqual([product.id]);
    // Deleting a campaign does not release the product's media references.
    expect(testApp.supabase.mediaReferences).toHaveLength(2);

    const again = await remove(testApp, `/api/campaigns/${first.id}`);
    expect(again.status).toBe(404);
    expect(((await again.json()) as ErrorBody).error.code).toBe("CAMPAIGN_NOT_FOUND");

    const foreign = await remove(testApp, `/api/campaigns/${second.id}`, USER_B.token);
    expect(foreign.status).toBe(404);
    expect(testApp.supabase.campaigns.map((row) => row.id)).toEqual([second.id]);
  });
});
