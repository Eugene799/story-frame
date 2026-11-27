// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProductAdConceptRecord } from "../shared/ad-concept-contract";
import type { CampaignRecord, ProductRecord } from "../shared/product-contract";
import type { ReadyImageOption } from "../shared/media-contract";
import type { ProjectRecord, ProjectSummary } from "../shared/project-contract";
import { CatalogPanel } from "../src/workspace/CatalogPanel";

const NOW = "2026-11-27T12:00:00.000Z";

const PRODUCT: ProductRecord = {
  id: "77777777-7777-4777-8777-777777777777",
  name: "Harbor Serum",
  variant: "30 ml",
  brandSettings: { voice: "calm", colors: "deep blue", notes: "" },
  approvedClaims: [
    { id: "claim-1", text: "Clinically tested", evidence: "Independent 2026 lab report." },
  ],
  prohibitedWording: ["cures"],
  assetMediaIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
  logoMediaId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  createdAt: NOW,
  updatedAt: NOW,
};

const PROJECT: ProjectSummary = {
  id: "88888888-8888-4888-8888-888888888888",
  projectType: "product-ad",
  title: "Harbor launch",
  schemaVersion: 2,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const ASSET_IMAGE: ReadyImageOption = {
  id: PRODUCT.assetMediaIds[0],
  projectId: PROJECT.id,
  projectTitle: PROJECT.title,
  contentType: "image/png",
  byteSize: 245_760,
  readyAt: NOW,
  createdAt: NOW,
  provenance: null,
};

const LOGO_IMAGE: ReadyImageOption = {
  ...ASSET_IMAGE,
  id: PRODUCT.logoMediaId ?? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  contentType: "image/webp",
  byteSize: 8192,
};

const CAMPAIGN: CampaignRecord = {
  id: "99999999-9999-4999-8999-999999999999",
  productId: PRODUCT.id,
  projectId: PROJECT.id,
  audience: "Adults with sensitive skin",
  offer: "20% off the starter kit",
  price: 24.5,
  currency: "USD",
  promotionStart: null,
  promotionEnd: null,
  timezone: "UTC",
  cta: "Shop the kit",
  destination: "https://example.com/starter-kit",
  durationSeconds: 15,
  aspectRatio: "16:9",
  disclaimer: "",
  createdAt: NOW,
  updatedAt: NOW,
};

const SIBLING_CAMPAIGN: CampaignRecord = {
  ...CAMPAIGN,
  id: "bbbbbbbb-9999-4999-8999-999999999999",
  cta: "Book a consult",
  offer: "Free sample",
};

function conceptSetFixture(status: "proposed" | "selected"): ProductAdConceptRecord {
  const concepts = [1, 2, 3].map((number) => ({
    id: `concept-${number}`,
    title: `Concept ${number}`,
    hook: `Hook ${number}`,
    hookVariants: [`Alternate ${number}a`, `Alternate ${number}b`],
    beats: [
      {
        heading: `Beat ${number}`,
        narration: "Skin can be calm.",
        visualDirection: "Product on a wet counter.",
        onScreenText: "",
        durationSeconds: 8,
        assetMediaId: null,
      },
      {
        heading: "Offer",
        narration: "Twenty percent off.",
        visualDirection: "Offer card.",
        onScreenText: "Shop the kit",
        durationSeconds: 7,
        assetMediaId: null,
      },
    ],
    claimIds: [],
    totalSeconds: 15,
  }));

  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    productId: PRODUCT.id,
    campaignId: CAMPAIGN.id,
    status,
    snapshot: {
      version: 1,
      capturedAt: NOW,
      product: {
        id: PRODUCT.id,
        name: PRODUCT.name,
        variant: PRODUCT.variant,
        brandSettings: PRODUCT.brandSettings,
        approvedClaims: PRODUCT.approvedClaims,
        prohibitedWording: PRODUCT.prohibitedWording,
        assetMediaIds: PRODUCT.assetMediaIds,
        logoMediaId: PRODUCT.logoMediaId,
      },
      campaign: {
        id: CAMPAIGN.id,
        productId: PRODUCT.id,
        projectId: PROJECT.id,
        audience: CAMPAIGN.audience,
        offer: CAMPAIGN.offer,
        price: CAMPAIGN.price,
        currency: CAMPAIGN.currency,
        promotionStart: null,
        promotionEnd: null,
        timezone: CAMPAIGN.timezone,
        cta: CAMPAIGN.cta,
        destination: CAMPAIGN.destination,
        durationSeconds: CAMPAIGN.durationSeconds,
        aspectRatio: CAMPAIGN.aspectRatio,
        disclaimer: "",
      },
    },
    snapshotHash: "a".repeat(64),
    modelId: "gemma",
    repairAttempted: false,
    summary: "Three grounded routes.",
    notes: [],
    concepts,
    selectedIndex: status === "selected" ? 0 : null,
    manifest:
      status === "selected"
        ? {
            version: 1,
            snapshotHash: "a".repeat(64),
            productId: PRODUCT.id,
            campaignId: CAMPAIGN.id,
            projectId: PROJECT.id,
            productName: PRODUCT.name,
            productVariant: PRODUCT.variant,
            logoMediaId: PRODUCT.logoMediaId,
            conceptId: concepts[0].id,
            title: concepts[0].title,
            hook: concepts[0].hook,
            hooks: [concepts[0].hook, ...concepts[0].hookVariants],
            beats: concepts[0].beats,
            totalSeconds: 15,
            aspectRatio: "16:9",
            durationSeconds: 15,
            callToAction: CAMPAIGN.cta,
            destination: CAMPAIGN.destination,
            disclaimer: "",
            claims: [],
            prohibitedWording: PRODUCT.prohibitedWording,
            createdAt: NOW,
          }
        : null,
    createdAt: NOW,
    updatedAt: NOW,
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

describe("CatalogPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a catalog entry, generates from the frozen facts, and selects a manifest", async () => {
    const requests: { method: string; path: string; body: unknown; idempotency?: string }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({
        method,
        path: url.pathname,
        body,
        idempotency: (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"],
      });

      if (url.pathname === "/api/media/images" && method === "GET") {
        return jsonResponse({ ok: true, images: [ASSET_IMAGE, LOGO_IMAGE] });
      }
      if (url.pathname === "/api/products" && method === "GET") {
        return jsonResponse({ ok: true, products: [] });
      }
      if (url.pathname === "/api/products" && method === "POST") {
        return jsonResponse({ ok: true, product: PRODUCT }, 201);
      }
      if (url.pathname === "/api/projects" && method === "GET") {
        return jsonResponse({ ok: true, projects: [PROJECT] });
      }
      if (url.pathname === "/api/campaigns" && method === "GET") {
        return jsonResponse({ ok: true, campaigns: [] });
      }
      if (url.pathname === "/api/campaigns" && method === "POST") {
        return jsonResponse({ ok: true, campaign: CAMPAIGN }, 201);
      }
      if (url.pathname === "/api/ad-concepts" && method === "GET") {
        return jsonResponse({ ok: true, conceptSets: [] });
      }
      if (url.pathname === `/api/products/${PRODUCT.id}/ad-concepts` && method === "POST") {
        return jsonResponse({ ok: true, conceptSet: conceptSetFixture("proposed") }, 201);
      }
      if (
        url.pathname === `/api/ad-concepts/${conceptSetFixture("proposed").id}/select` &&
        method === "POST"
      ) {
        return jsonResponse({ ok: true, conceptSet: conceptSetFixture("selected") });
      }
      if (
        url.pathname === `/api/ad-concepts/${conceptSetFixture("selected").id}/project` &&
        method === "POST"
      ) {
        const project: ProjectRecord = {
          ...PROJECT,
          version: 2,
          document: {
            schemaVersion: 2,
            summary: "",
            brief: {
              topic: "",
              audience: "",
              goal: "",
              mode: "factual",
              targetDurationSeconds: 15,
              tone: "",
              preset: "",
              voicePreference: "none",
              planningBudgetUsd: 0,
            },
            scenes: [],
          },
        };
        return jsonResponse({ ok: true, project, projectRevision: 2 });
      }
      if (url.pathname === `/api/products/${PRODUCT.id}` && method === "DELETE") {
        return jsonResponse({ ok: true, deletedId: PRODUCT.id });
      }
      throw new Error(`unexpected request ${method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CatalogPanel getAccessToken={async () => "token"} />);

    expect(await screen.findByText(/No products yet/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Harbor launch · PNG · 240 KB/ }));
    fireEvent.change(screen.getByLabelText("Logo image"), { target: { value: LOGO_IMAGE.id } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Harbor Serum" } });
    fireEvent.change(screen.getByLabelText("Claim 1"), { target: { value: "Clinically tested" } });
    fireEvent.change(screen.getByLabelText("Evidence for claim 1"), {
      target: { value: "Independent 2026 lab report." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));

    expect(await screen.findByText(/Saved product "Harbor Serum"/)).toBeTruthy();
    const productPost = requests.find(
      (request) => request.method === "POST" && request.path === "/api/products",
    );
    expect(productPost?.body).toMatchObject({
      name: "Harbor Serum",
      approvedClaims: [{ text: "Clinically tested", evidence: "Independent 2026 lab report." }],
      assetMediaIds: [ASSET_IMAGE.id],
      logoMediaId: LOGO_IMAGE.id,
    });

    fireEvent.change(screen.getByLabelText("Product"), { target: { value: PRODUCT.id } });
    fireEvent.change(screen.getByLabelText("Render project"), { target: { value: PROJECT.id } });
    fireEvent.change(screen.getByLabelText("Audience"), {
      target: { value: "Adults with sensitive skin" },
    });
    fireEvent.change(screen.getByLabelText("Offer"), {
      target: { value: "20% off the starter kit" },
    });
    fireEvent.change(screen.getByLabelText("Call to action"), { target: { value: "Shop the kit" } });
    fireEvent.change(screen.getByLabelText("Destination URL"), {
      target: { value: "https://example.com/starter-kit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(await screen.findByText(/Saved campaign "Shop the kit"/)).toBeTruthy();
    const campaignPost = requests.find(
      (request) => request.method === "POST" && request.path === "/api/campaigns",
    );
    expect(campaignPost?.body).toMatchObject({ productId: PRODUCT.id, projectId: PROJECT.id });

    fireEvent.click(screen.getByRole("button", { name: "Generate three concepts" }));
    expect(
      await screen.findByText(/Three grounded concepts generated from the frozen product snapshot/),
    ).toBeTruthy();
    const generation = requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/ad-concepts"),
    );
    expect(generation?.path).toBe(`/api/products/${PRODUCT.id}/ad-concepts`);
    expect(generation?.body).toEqual({ campaignId: CAMPAIGN.id });
    expect(generation?.idempotency).toMatch(/^[0-9a-f-]{36}$/i);

    fireEvent.click(screen.getAllByRole("button", { name: "Select concept 1" })[0]);
    await waitFor(() => expect(screen.getByText("Selected concept")).toBeTruthy());
    expect(screen.getByText("Frozen manifest")).toBeTruthy();
    expect(requests.some((request) => request.path.endsWith("/select"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Apply to project" }));
    expect(await screen.findByText(/as revision 2/)).toBeTruthy();
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.path === `/api/ad-concepts/${conceptSetFixture("selected").id}/project`,
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete product" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete product" }));
    expect(await screen.findByText(/Deleted product "Harbor Serum" and its campaigns/)).toBeTruthy();
    expect(
      requests.some(
        (request) => request.method === "DELETE" && request.path === `/api/products/${PRODUCT.id}`,
      ),
    ).toBe(true);
    expect(screen.queryByText("Frozen manifest")).toBeNull();
  });

  it("edits a product and campaign, then deletes only the campaign", async () => {
    const requests: { method: string; path: string; body: unknown }[] = [];
    const updatedProduct: ProductRecord = {
      ...PRODUCT,
      name: "Harbor Serum Corrected",
      approvedClaims: [
        { ...PRODUCT.approvedClaims[0], text: "Clinically tested, updated" },
      ],
    };
    const updatedCampaign: CampaignRecord = {
      ...CAMPAIGN,
      offer: "30% off the starter kit",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method, path: url.pathname, body });

      if (url.pathname === "/api/media/images" && method === "GET") {
        return jsonResponse({ ok: true, images: [ASSET_IMAGE, LOGO_IMAGE] });
      }
      if (url.pathname === "/api/products" && method === "GET") {
        return jsonResponse({ ok: true, products: [PRODUCT] });
      }
      if (url.pathname === "/api/projects" && method === "GET") {
        return jsonResponse({ ok: true, projects: [PROJECT] });
      }
      if (url.pathname === "/api/campaigns" && method === "GET") {
        return jsonResponse({ ok: true, campaigns: [CAMPAIGN, SIBLING_CAMPAIGN] });
      }
      if (url.pathname === "/api/ad-concepts" && method === "GET") {
        return jsonResponse({ ok: true, conceptSets: [conceptSetFixture("selected")] });
      }
      if (url.pathname === `/api/products/${PRODUCT.id}` && method === "PATCH") {
        return jsonResponse({ ok: true, product: updatedProduct });
      }
      if (url.pathname === `/api/campaigns/${CAMPAIGN.id}` && method === "PATCH") {
        return jsonResponse({ ok: true, campaign: updatedCampaign });
      }
      if (url.pathname === `/api/campaigns/${CAMPAIGN.id}` && method === "DELETE") {
        return jsonResponse({ ok: true, deletedId: CAMPAIGN.id });
      }
      throw new Error(`unexpected request ${method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CatalogPanel getAccessToken={async () => "token"} />);
    expect(await screen.findByText(/1 claim\(s\) with evidence/)).toBeTruthy();
    expect(screen.getByText("Three grounded routes.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit product" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Harbor Serum");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Harbor Serum Corrected" },
    });
    fireEvent.change(screen.getByLabelText("Claim 1"), {
      target: { value: "Clinically tested, updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save product" }));
    expect(await screen.findByText(/Saved product "Harbor Serum Corrected"/)).toBeTruthy();
    const productPatch = requests.find(
      (request) => request.method === "PATCH" && request.path === `/api/products/${PRODUCT.id}`,
    );
    expect(productPatch?.body).toMatchObject({
      name: "Harbor Serum Corrected",
      approvedClaims: [{ text: "Clinically tested, updated", evidence: "Independent 2026 lab report." }],
      assetMediaIds: [ASSET_IMAGE.id],
      logoMediaId: LOGO_IMAGE.id,
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit campaign" }));
    expect((screen.getByLabelText("Offer") as HTMLInputElement).value).toBe(
      "20% off the starter kit",
    );
    expect((screen.getByLabelText("Product") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Offer"), {
      target: { value: "30% off the starter kit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save campaign" }));
    expect(await screen.findByText(/Saved campaign "Shop the kit"/)).toBeTruthy();
    const campaignPatch = requests.find(
      (request) => request.method === "PATCH" && request.path === `/api/campaigns/${CAMPAIGN.id}`,
    );
    expect(campaignPatch?.body).toMatchObject({ offer: "30% off the starter kit" });
    expect(campaignPatch?.body).not.toHaveProperty("productId");

    // Open the editor again, then delete the campaign while it is being edited.
    fireEvent.click(screen.getByRole("button", { name: "Edit campaign" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete campaign" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete campaign" }));
    expect(
      await screen.findByText(/Deleted campaign "Shop the kit" and its concept sets. The product remains./),
    ).toBeTruthy();
    expect(
      requests.filter(
        (request) =>
          request.method === "DELETE" && request.path === `/api/campaigns/${CAMPAIGN.id}`,
      ),
    ).toHaveLength(1);
    expect(screen.queryByText("Three grounded routes.")).toBeNull();
    expect(screen.getByRole("heading", { name: "New campaign" })).toBeTruthy();
    expect((screen.getByLabelText("Offer") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("option", { name: /Book a consult/ })).toBeTruthy();
    expect(screen.queryByText(/No campaign yet/)).toBeNull();
    expect(screen.getByRole("button", { name: "Edit product" })).toBeTruthy();
  });

  it("cancels edits without writing and clears unavailable media before saving", async () => {
    const requests: { method: string; path: string; body: unknown }[] = [];
    const clearedProduct: ProductRecord = {
      ...PRODUCT,
      assetMediaIds: [],
      logoMediaId: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method, path: url.pathname, body });

      if (url.pathname === "/api/media/images" && method === "GET") {
        return jsonResponse({ ok: true, images: [] });
      }
      if (url.pathname === "/api/products" && method === "GET") {
        return jsonResponse({ ok: true, products: [PRODUCT] });
      }
      if (url.pathname === "/api/projects" && method === "GET") {
        return jsonResponse({ ok: true, projects: [PROJECT] });
      }
      if (url.pathname === "/api/campaigns" && method === "GET") {
        return jsonResponse({ ok: true, campaigns: [CAMPAIGN] });
      }
      if (url.pathname === "/api/ad-concepts" && method === "GET") {
        return jsonResponse({ ok: true, conceptSets: [] });
      }
      if (url.pathname === `/api/products/${PRODUCT.id}` && method === "PATCH") {
        return jsonResponse({ ok: true, product: clearedProduct });
      }
      throw new Error(`unexpected request ${method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CatalogPanel getAccessToken={async () => "token"} />);
    expect(await screen.findByText(/1 claim\(s\) with evidence/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit product" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel product edit" }));
    expect(screen.getByRole("heading", { name: "New product" })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Edit campaign" }));
    fireEvent.change(screen.getByLabelText("Offer"), { target: { value: "Unsaved offer" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel campaign edit" }));
    expect(screen.getByRole("heading", { name: "New campaign" })).toBeTruthy();
    expect((screen.getByLabelText("Offer") as HTMLInputElement).value).toBe("");
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Edit product" }));
    expect(screen.getByText(/1 selected image is no longer ready/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "Unavailable image (current selection)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear product images" }));
    fireEvent.change(screen.getByLabelText("Logo image"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save product" }));
    expect(await screen.findByText(/Saved product "Harbor Serum"/)).toBeTruthy();
    const productPatch = requests.find(
      (request) => request.method === "PATCH" && request.path === `/api/products/${PRODUCT.id}`,
    );
    expect(productPatch?.body).toMatchObject({ assetMediaIds: [], logoMediaId: null });
  });
});
