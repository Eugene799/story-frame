import { randomUUID } from "node:crypto";
import { ApiError } from "./api-error";
import type {
  CampaignAspectRatio,
  CampaignRecord,
  CampaignWrite,
  ProductBrandSettings,
  ProductClaim,
  ProductRecord,
  ProductWrite,
} from "../shared/product-contract";

/** Upper bounds for one catalog or campaign write. Larger input is refused. */
export const PRODUCT_LIMITS = {
  bodyBytes: 64 * 1024,
  listLimit: 100,
  nameChars: 200,
  variantChars: 200,
  brandSettingChars: 500,
  // The ad-concept prompt carries every claim and prohibited phrase, so these
  // bounds (not just the reply bounds) decide whether the task schema fits.
  claims: 8,
  claimChars: 300,
  evidenceChars: 400,
  prohibited: 12,
  prohibitedChars: 80,
  assets: 12,
  audienceChars: 300,
  offerChars: 600,
  priceMax: 1_000_000_000,
  timezoneChars: 64,
  ctaChars: 200,
  destinationChars: 1024,
  disclaimerChars: 1000,
  minDurationSeconds: 5,
  maxDurationSeconds: 600,
} as const;

export const PRODUCT_NOT_FOUND_MESSAGE = "No product with that id is owned by this account.";
export const CAMPAIGN_NOT_FOUND_MESSAGE = "No campaign with that id is owned by this account.";

/** Parsed product write with the server-assigned claim ids preserved. */
export interface ProductWriteWithClaims {
  name: string;
  variant: string;
  brandSettings: ProductBrandSettings;
  approvedClaims: ProductClaim[];
  prohibitedWording: string[];
  assetMediaIds: string[];
  logoMediaId: string | null;
}

const PRODUCT_FIELDS = [
  "name",
  "variant",
  "brandSettings",
  "approvedClaims",
  "prohibitedWording",
  "assetMediaIds",
  "logoMediaId",
] as const;

const CAMPAIGN_FIELDS = [
  "productId",
  "projectId",
  "audience",
  "offer",
  "price",
  "currency",
  "promotionStart",
  "promotionEnd",
  "timezone",
  "cta",
  "destination",
  "durationSeconds",
  "aspectRatio",
  "disclaimer",
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ASPECT_RATIOS: readonly CampaignAspectRatio[] = ["16:9", "9:16", "1:1", "4:5"];

export function isProductId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readBody(input: unknown, allowed: readonly string[], code: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new ApiError(400, code, "Request body must be a JSON object.");
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, code, `Request body may only contain ${allowed.join(", ")}.`);
    }
  }
  return input;
}

function readText(value: unknown, label: string, maxChars: number, code: string): string {
  if (typeof value !== "string") {
    throw new ApiError(400, code, `${label} must be a string.`);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new ApiError(400, code, `${label} must not be empty.`);
  }
  if (text.length > maxChars) {
    throw new ApiError(400, code, `${label} must be at most ${maxChars} characters.`);
  }
  return text;
}

function readOptionalText(
  value: unknown,
  label: string,
  maxChars: number,
  code: string,
): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new ApiError(400, code, `${label} must be a string.`);
  }
  const text = value.trim();
  if (text.length > maxChars) {
    throw new ApiError(400, code, `${label} must be at most ${maxChars} characters.`);
  }
  return text;
}

function readUuid(value: unknown, label: string, code: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError(400, code, `${label} must be a valid id.`);
  }
  return value;
}

function readStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxChars: number,
  code: string,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ApiError(400, code, `${label} must be an array of at most ${maxItems} items.`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const text = readText(item, `${label}[${index}]`, maxChars, code);
    const key = text.toLowerCase();
    if (seen.has(key)) {
      throw new ApiError(400, code, `${label} must not repeat "${text}".`);
    }
    seen.add(key);
    return text;
  });
}

function parseBrandSettings(value: unknown): ProductBrandSettings {
  const code = "INVALID_PRODUCT";
  if (value === undefined || value === null) return { voice: "", colors: "", notes: "" };
  if (!isRecord(value)) {
    throw new ApiError(400, code, "brandSettings must be a JSON object.");
  }
  const allowed = ["voice", "colors", "notes"] as const;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key as (typeof allowed)[number])) {
      throw new ApiError(400, code, "brandSettings may only contain voice, colors, and notes.");
    }
  }
  return {
    voice: readOptionalText(value.voice, "brandSettings.voice", PRODUCT_LIMITS.brandSettingChars, code),
    colors: readOptionalText(value.colors, "brandSettings.colors", PRODUCT_LIMITS.brandSettingChars, code),
    notes: readOptionalText(value.notes, "brandSettings.notes", PRODUCT_LIMITS.brandSettingChars, code),
  };
}

function parseClaims(value: unknown): ProductClaim[] {
  const code = "INVALID_PRODUCT";
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > PRODUCT_LIMITS.claims) {
    throw new ApiError(400, code, `approvedClaims must be an array of at most ${PRODUCT_LIMITS.claims} items.`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new ApiError(400, code, `approvedClaims[${index}] must be an object.`);
    }
    for (const key of Object.keys(item)) {
      if (key !== "text" && key !== "evidence") {
        throw new ApiError(400, code, `approvedClaims[${index}] may only contain text and evidence.`);
      }
    }
    const text = readText(item.text, `approvedClaims[${index}].text`, PRODUCT_LIMITS.claimChars, code);
    const key = text.toLowerCase();
    if (seen.has(key)) {
      throw new ApiError(400, code, `approvedClaims must not repeat "${text}".`);
    }
    seen.add(key);
    return {
      id: randomUUID(),
      text,
      evidence: readOptionalText(
        item.evidence,
        `approvedClaims[${index}].evidence`,
        PRODUCT_LIMITS.evidenceChars,
        code,
      ),
    };
  });
}

function parseAssetIds(value: unknown): string[] {
  const code = "INVALID_PRODUCT";
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > PRODUCT_LIMITS.assets) {
    throw new ApiError(400, code, `assetMediaIds must be an array of at most ${PRODUCT_LIMITS.assets} ids.`);
  }
  const ids = value.map((item, index) => readUuid(item, `assetMediaIds[${index}]`, code));
  if (new Set(ids).size !== ids.length) {
    throw new ApiError(400, code, "assetMediaIds must not repeat an id.");
  }
  return ids;
}

export function parseProductWrite(input: unknown): ProductWriteWithClaims {
  const body = readBody(input, PRODUCT_FIELDS, "INVALID_PRODUCT");
  const logo = body.logoMediaId;
  if (logo !== undefined && logo !== null && logo !== "") {
    readUuid(logo, "logoMediaId", "INVALID_PRODUCT");
  }
  return {
    name: readText(body.name, "name", PRODUCT_LIMITS.nameChars, "INVALID_PRODUCT"),
    variant: readOptionalText(body.variant, "variant", PRODUCT_LIMITS.variantChars, "INVALID_PRODUCT"),
    brandSettings: parseBrandSettings(body.brandSettings),
    approvedClaims: parseClaims(body.approvedClaims),
    prohibitedWording: readStringArray(
      body.prohibitedWording,
      "prohibitedWording",
      PRODUCT_LIMITS.prohibited,
      PRODUCT_LIMITS.prohibitedChars,
      "INVALID_PRODUCT",
    ),
    assetMediaIds: parseAssetIds(body.assetMediaIds),
    logoMediaId: typeof logo === "string" && logo.length > 0 ? logo : null,
  };
}

/**
 * A PATCH keeps every omitted field and accepts a partial `brandSettings`
 * object. Claim text, not the client, decides whether a claim keeps its id.
 */
export function parseProductUpdate(input: unknown, existing: ProductRecord): ProductWriteWithClaims {
  const patch = readBody(input, PRODUCT_FIELDS, "INVALID_PRODUCT");
  const brandSettings = hasOwn(patch, "brandSettings")
    ? isRecord(patch.brandSettings)
      ? { ...existing.brandSettings, ...patch.brandSettings }
      : patch.brandSettings
    : existing.brandSettings;
  const merged = {
    name: hasOwn(patch, "name") ? patch.name : existing.name,
    variant: hasOwn(patch, "variant") ? patch.variant : existing.variant,
    brandSettings,
    approvedClaims: hasOwn(patch, "approvedClaims")
      ? patch.approvedClaims
      : existing.approvedClaims.map((claim) => ({ text: claim.text, evidence: claim.evidence })),
    prohibitedWording: hasOwn(patch, "prohibitedWording")
      ? patch.prohibitedWording
      : existing.prohibitedWording,
    assetMediaIds: hasOwn(patch, "assetMediaIds") ? patch.assetMediaIds : existing.assetMediaIds,
    logoMediaId: hasOwn(patch, "logoMediaId") ? patch.logoMediaId : existing.logoMediaId,
  };
  const parsed = parseProductWrite(merged);
  const idsByText = new Map(
    existing.approvedClaims.map((claim) => [claim.text.trim().toLowerCase(), claim.id]),
  );
  return {
    ...parsed,
    approvedClaims: parsed.approvedClaims.map((claim) => ({
      ...claim,
      id: idsByText.get(claim.text.trim().toLowerCase()) ?? claim.id,
    })),
  };
}

function parseTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_CAMPAIGN", `${label} must be an ISO date string or null.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "INVALID_CAMPAIGN", `${label} must be a valid ISO date.`);
  }
  return date.toISOString();
}

function parseTimezone(value: unknown): string {
  const code = "INVALID_CAMPAIGN";
  const timezone = readText(value, "timezone", PRODUCT_LIMITS.timezoneChars, code);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ApiError(400, code, "timezone must be a valid IANA time zone.");
  }
  return timezone;
}

export function parseCampaignWrite(input: unknown): CampaignWrite {
  const code = "INVALID_CAMPAIGN";
  const body = readBody(input, CAMPAIGN_FIELDS, code);

  if (typeof body.price !== "number" || !Number.isFinite(body.price)) {
    throw new ApiError(400, code, "price must be a number.");
  }
  if (body.price < 0 || body.price > PRODUCT_LIMITS.priceMax) {
    throw new ApiError(400, code, `price must be between 0 and ${PRODUCT_LIMITS.priceMax}.`);
  }
  if (typeof body.currency !== "string" || !CURRENCY_PATTERN.test(body.currency)) {
    throw new ApiError(400, code, "currency must be a three-letter uppercase code such as USD.");
  }
  if (
    typeof body.durationSeconds !== "number" ||
    !Number.isInteger(body.durationSeconds) ||
    body.durationSeconds < PRODUCT_LIMITS.minDurationSeconds ||
    body.durationSeconds > PRODUCT_LIMITS.maxDurationSeconds
  ) {
    throw new ApiError(
      400,
      code,
      `durationSeconds must be an integer from ${PRODUCT_LIMITS.minDurationSeconds} to ${PRODUCT_LIMITS.maxDurationSeconds}.`,
    );
  }
  if (typeof body.aspectRatio !== "string" || !ASPECT_RATIOS.includes(body.aspectRatio as CampaignAspectRatio)) {
    throw new ApiError(400, code, `aspectRatio must be one of ${ASPECT_RATIOS.join(", ")}.`);
  }

  const destination = readText(body.destination, "destination", PRODUCT_LIMITS.destinationChars, code);
  let parsedDestination: URL;
  try {
    parsedDestination = new URL(destination);
  } catch {
    throw new ApiError(400, code, "destination must be an absolute http(s) URL.");
  }
  if (parsedDestination.protocol !== "http:" && parsedDestination.protocol !== "https:") {
    throw new ApiError(400, code, "destination must be an absolute http(s) URL.");
  }

  const promotionStart = parseTimestamp(body.promotionStart, "promotionStart");
  const promotionEnd = parseTimestamp(body.promotionEnd, "promotionEnd");
  if (promotionStart && promotionEnd && promotionEnd <= promotionStart) {
    throw new ApiError(400, code, "promotionEnd must be after promotionStart.");
  }

  const projectId =
    body.projectId === undefined || body.projectId === null || body.projectId === ""
      ? null
      : readUuid(body.projectId, "projectId", code);

  return {
    productId: readUuid(body.productId, "productId", code),
    projectId,
    audience: readText(body.audience, "audience", PRODUCT_LIMITS.audienceChars, code),
    offer: readText(body.offer, "offer", PRODUCT_LIMITS.offerChars, code),
    price: Math.round(body.price * 100) / 100,
    currency: body.currency,
    promotionStart,
    promotionEnd,
    timezone: parseTimezone(body.timezone),
    cta: readText(body.cta, "cta", PRODUCT_LIMITS.ctaChars, code),
    destination,
    durationSeconds: body.durationSeconds,
    aspectRatio: body.aspectRatio as CampaignAspectRatio,
    disclaimer: readOptionalText(body.disclaimer, "disclaimer", PRODUCT_LIMITS.disclaimerChars, code),
  };
}

/** A campaign correction; the owning product is immutable. */
export function parseCampaignUpdate(input: unknown, existing: CampaignRecord): CampaignWrite {
  const patch = readBody(input, CAMPAIGN_FIELDS, "INVALID_CAMPAIGN");
  if (hasOwn(patch, "productId") && patch.productId !== existing.productId) {
    throw new ApiError(
      400,
      "INVALID_CAMPAIGN",
      "productId cannot be changed; create a campaign for the other product.",
    );
  }
  return parseCampaignWrite({
    productId: existing.productId,
    projectId: hasOwn(patch, "projectId") ? patch.projectId : existing.projectId,
    audience: hasOwn(patch, "audience") ? patch.audience : existing.audience,
    offer: hasOwn(patch, "offer") ? patch.offer : existing.offer,
    price: hasOwn(patch, "price") ? patch.price : existing.price,
    currency: hasOwn(patch, "currency") ? patch.currency : existing.currency,
    promotionStart: hasOwn(patch, "promotionStart") ? patch.promotionStart : existing.promotionStart,
    promotionEnd: hasOwn(patch, "promotionEnd") ? patch.promotionEnd : existing.promotionEnd,
    timezone: hasOwn(patch, "timezone") ? patch.timezone : existing.timezone,
    cta: hasOwn(patch, "cta") ? patch.cta : existing.cta,
    destination: hasOwn(patch, "destination") ? patch.destination : existing.destination,
    durationSeconds: hasOwn(patch, "durationSeconds") ? patch.durationSeconds : existing.durationSeconds,
    aspectRatio: hasOwn(patch, "aspectRatio") ? patch.aspectRatio : existing.aspectRatio,
    disclaimer: hasOwn(patch, "disclaimer") ? patch.disclaimer : existing.disclaimer,
  });
}

// ---- Store ------------------------------------------------------------------

export interface ProductStore {
  /** The caller supplies the id so media retention references can name it first. */
  createProduct(ownerId: string, input: ProductWrite, productId?: string): Promise<ProductRecord>;
  updateProduct(
    ownerId: string,
    productId: string,
    input: ProductWriteWithClaims,
  ): Promise<ProductRecord | null>;
  listProducts(ownerId: string): Promise<ProductRecord[]>;
  getProduct(ownerId: string, productId: string): Promise<ProductRecord | null>;
  /** Deletes the product and, by database cascade, its campaigns and concept sets. */
  deleteProduct(ownerId: string, productId: string): Promise<boolean>;
  createCampaign(ownerId: string, input: CampaignWrite): Promise<CampaignRecord>;
  updateCampaign(
    ownerId: string,
    campaignId: string,
    input: CampaignWrite,
  ): Promise<CampaignRecord | null>;
  listCampaigns(ownerId: string, productId?: string): Promise<CampaignRecord[]>;
  getCampaign(ownerId: string, campaignId: string): Promise<CampaignRecord | null>;
  /** The database cascades this campaign's concept sets. */
  deleteCampaign(ownerId: string, campaignId: string): Promise<boolean>;
}

export interface SupabaseProductStoreOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

const PRODUCT_COLUMNS =
  "id,name,variant,brand_settings,approved_claims,prohibited_wording,asset_media_ids,logo_media_id,created_at,updated_at";
const CAMPAIGN_COLUMNS =
  "id,product_id,project_id,audience,offer,price,currency,promotion_start,promotion_end,timezone,cta,destination,duration_seconds,aspect_ratio,disclaimer,created_at,updated_at";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asClaims(value: unknown): ProductClaim[] {
  if (!Array.isArray(value)) return [];
  const claims: ProductClaim[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.text !== "string" || row.text.length === 0) continue;
    claims.push({
      id: asString(row.id) || randomUUID(),
      text: row.text,
      evidence: asString(row.evidence),
    });
  }
  return claims;
}

function asBrandSettings(value: unknown): ProductBrandSettings {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    voice: asString(row.voice),
    colors: asString(row.colors),
    notes: asString(row.notes),
  };
}

function toProduct(row: Record<string, unknown>): ProductRecord {
  return {
    id: asString(row.id),
    name: asString(row.name),
    variant: asString(row.variant),
    brandSettings: asBrandSettings(row.brand_settings),
    approvedClaims: asClaims(row.approved_claims),
    prohibitedWording: asStringArray(row.prohibited_wording),
    assetMediaIds: asStringArray(row.asset_media_ids),
    logoMediaId: asNullableString(row.logo_media_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function toCampaign(row: Record<string, unknown>): CampaignRecord {
  const ratio = asString(row.aspect_ratio);
  return {
    id: asString(row.id),
    productId: asString(row.product_id),
    projectId: asNullableString(row.project_id),
    audience: asString(row.audience),
    offer: asString(row.offer),
    price: typeof row.price === "number" ? row.price : Number(row.price ?? 0),
    currency: asString(row.currency),
    promotionStart: asNullableString(row.promotion_start),
    promotionEnd: asNullableString(row.promotion_end),
    timezone: asString(row.timezone),
    cta: asString(row.cta),
    destination: asString(row.destination),
    durationSeconds: typeof row.duration_seconds === "number" ? row.duration_seconds : Number(row.duration_seconds ?? 0),
    aspectRatio: (ASPECT_RATIOS.includes(ratio as CampaignAspectRatio) ? ratio : "16:9") as CampaignAspectRatio,
    disclaimer: asString(row.disclaimer),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function createSupabaseProductStore(options: SupabaseProductStoreOptions): ProductStore {
  const restBase = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const productsEndpoint = `${restBase}/products`;
  const campaignsEndpoint = `${restBase}/campaigns`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(path, {
        ...init,
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new ApiError(503, "CATALOG_STORE_UNAVAILABLE", "The product catalog is unavailable right now.");
    }
    const body = await response.text();
    if (!response.ok) {
      throw new ApiError(503, "CATALOG_STORE_UNAVAILABLE", "The product catalog is unavailable right now.");
    }
    if (body.length === 0) return null;
    try {
      return JSON.parse(body);
    } catch {
      throw new ApiError(503, "CATALOG_STORE_UNAVAILABLE", "The product catalog sent an unreadable reply.");
    }
  }

  function rows(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : [];
  }

  function productQuery(params: Record<string, string>): string {
    const query = new URLSearchParams({ select: PRODUCT_COLUMNS, order: "updated_at.desc", limit: String(PRODUCT_LIMITS.listLimit), ...params });
    return `${productsEndpoint}?${query.toString()}`;
  }

  function campaignQuery(params: Record<string, string>): string {
    const query = new URLSearchParams({ select: CAMPAIGN_COLUMNS, order: "updated_at.desc", limit: String(PRODUCT_LIMITS.listLimit), ...params });
    return `${campaignsEndpoint}?${query.toString()}`;
  }

  return {
    async createProduct(ownerId, input, productId) {
      const now = new Date().toISOString();
      const created = rows(
        await request(productsEndpoint, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            ...(productId ? { id: productId } : {}),
            owner_id: ownerId,
            name: input.name,
            variant: input.variant ?? "",
            brand_settings: input.brandSettings ?? { voice: "", colors: "", notes: "" },
            approved_claims: input.approvedClaims ?? [],
            prohibited_wording: input.prohibitedWording ?? [],
            asset_media_ids: input.assetMediaIds ?? [],
            logo_media_id: input.logoMediaId ?? null,
            created_at: now,
            updated_at: now,
          }),
        }),
      )[0];
      if (!created) throw new ApiError(503, "CATALOG_STORE_UNAVAILABLE", "The product was not stored.");
      return toProduct(created);
    },

    async updateProduct(ownerId, productId, input) {
      const updated = rows(
        await request(
          `${productsEndpoint}?${new URLSearchParams({
            id: `eq.${productId}`,
            owner_id: `eq.${ownerId}`,
          }).toString()}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              name: input.name,
              variant: input.variant ?? "",
              brand_settings: input.brandSettings ?? { voice: "", colors: "", notes: "" },
              approved_claims: input.approvedClaims,
              prohibited_wording: input.prohibitedWording,
              asset_media_ids: input.assetMediaIds,
              logo_media_id: input.logoMediaId,
              updated_at: new Date().toISOString(),
            }),
          },
        ),
      )[0];
      return updated ? toProduct(updated) : null;
    },

    async listProducts(ownerId) {
      const found = rows(await request(productQuery({ owner_id: `eq.${ownerId}` })));
      return found.map(toProduct);
    },

    async getProduct(ownerId, productId) {
      const found = rows(
        await request(productQuery({ id: `eq.${productId}`, owner_id: `eq.${ownerId}`, limit: "1" })),
      )[0];
      return found ? toProduct(found) : null;
    },

    async deleteProduct(ownerId, productId) {
      const removed = rows(
        await request(
          `${productsEndpoint}?${new URLSearchParams({ id: `eq.${productId}`, owner_id: `eq.${ownerId}` }).toString()}`,
          { method: "DELETE", headers: { Prefer: "return=representation" } },
        ),
      );
      return removed.length > 0;
    },

    async createCampaign(ownerId, input) {
      const now = new Date().toISOString();
      const created = rows(
        await request(campaignsEndpoint, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            owner_id: ownerId,
            product_id: input.productId,
            project_id: input.projectId ?? null,
            audience: input.audience,
            offer: input.offer,
            price: input.price,
            currency: input.currency,
            promotion_start: input.promotionStart ?? null,
            promotion_end: input.promotionEnd ?? null,
            timezone: input.timezone,
            cta: input.cta,
            destination: input.destination,
            duration_seconds: input.durationSeconds,
            aspect_ratio: input.aspectRatio,
            disclaimer: input.disclaimer ?? "",
            created_at: now,
            updated_at: now,
          }),
        }),
      )[0];
      if (!created) throw new ApiError(503, "CATALOG_STORE_UNAVAILABLE", "The campaign was not stored.");
      return toCampaign(created);
    },

    async updateCampaign(ownerId, campaignId, input) {
      const updated = rows(
        await request(
          `${campaignsEndpoint}?${new URLSearchParams({
            id: `eq.${campaignId}`,
            owner_id: `eq.${ownerId}`,
          }).toString()}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              product_id: input.productId,
              project_id: input.projectId ?? null,
              audience: input.audience,
              offer: input.offer,
              price: input.price,
              currency: input.currency,
              promotion_start: input.promotionStart ?? null,
              promotion_end: input.promotionEnd ?? null,
              timezone: input.timezone,
              cta: input.cta,
              destination: input.destination,
              duration_seconds: input.durationSeconds,
              aspect_ratio: input.aspectRatio,
              disclaimer: input.disclaimer ?? "",
              updated_at: new Date().toISOString(),
            }),
          },
        ),
      )[0];
      return updated ? toCampaign(updated) : null;
    },

    async listCampaigns(ownerId, productId) {
      const found = rows(
        await request(
          campaignQuery({
            owner_id: `eq.${ownerId}`,
            ...(productId ? { product_id: `eq.${productId}` } : {}),
          }),
        ),
      );
      return found.map(toCampaign);
    },

    async getCampaign(ownerId, campaignId) {
      const found = rows(
        await request(campaignQuery({ id: `eq.${campaignId}`, owner_id: `eq.${ownerId}`, limit: "1" })),
      )[0];
      return found ? toCampaign(found) : null;
    },

    async deleteCampaign(ownerId, campaignId) {
      const removed = rows(
        await request(
          `${campaignsEndpoint}?${new URLSearchParams({
            id: `eq.${campaignId}`,
            owner_id: `eq.${ownerId}`,
          }).toString()}`,
          { method: "DELETE", headers: { Prefer: "return=representation" } },
        ),
      );
      return removed.length > 0;
    },
  };
}
