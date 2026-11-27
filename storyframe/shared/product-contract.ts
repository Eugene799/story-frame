/** Phase 11: the facts and offer a product ad may use. */

/** A claim the operator approved, with the evidence that justifies it. */
export interface ProductClaim {
  id: string;
  text: string;
  /** Why the claim is allowed; shown beside the concept, never invented. */
  evidence: string;
}

/** Text-only brand settings so the first slice needs no palette parser. */
export interface ProductBrandSettings {
  voice: string;
  colors: string;
  notes: string;
}

export interface ProductRecord {
  id: string;
  name: string;
  variant: string;
  brandSettings: ProductBrandSettings;
  approvedClaims: ProductClaim[];
  prohibitedWording: string[];
  /** Ready media rows that show the actual product packaging. */
  assetMediaIds: string[];
  logoMediaId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductWrite {
  name: string;
  variant?: string;
  brandSettings?: Partial<ProductBrandSettings>;
  approvedClaims?: { text: string; evidence?: string }[];
  prohibitedWording?: string[];
  assetMediaIds?: string[];
  logoMediaId?: string | null;
}

export interface ProductListResponse {
  ok: true;
  products: ProductRecord[];
}

export interface ProductResponse {
  ok: true;
  product: ProductRecord;
}

export type CampaignAspectRatio = "16:9" | "9:16" | "1:1" | "4:5";

export interface CampaignRecord {
  id: string;
  productId: string;
  projectId: string | null;
  audience: string;
  offer: string;
  price: number;
  currency: string;
  promotionStart: string | null;
  promotionEnd: string | null;
  timezone: string;
  cta: string;
  destination: string;
  durationSeconds: number;
  aspectRatio: CampaignAspectRatio;
  disclaimer: string;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignWrite {
  productId: string;
  projectId?: string | null;
  audience: string;
  offer: string;
  price: number;
  currency: string;
  promotionStart?: string | null;
  promotionEnd?: string | null;
  timezone: string;
  cta: string;
  destination: string;
  durationSeconds: number;
  aspectRatio: CampaignAspectRatio;
  disclaimer?: string;
}

export interface CampaignListResponse {
  ok: true;
  campaigns: CampaignRecord[];
}

export interface CampaignResponse {
  ok: true;
  campaign: CampaignRecord;
}

/** A partial catalog correction; omitted fields keep their stored values. */
export type ProductPatch = Partial<ProductWrite>;

/** A campaign correction; its owning product cannot be changed. */
export type CampaignPatch = Partial<Omit<CampaignWrite, "productId">>;
