import type { CampaignAspectRatio, CampaignRecord, ProductClaim, ProductRecord } from "./product-contract";
import type { ProjectRecord } from "./project-contract";

/**
 * Phase 11: grounded ad concepts.
 *
 * A concept is generated from a frozen snapshot of one product and one
 * campaign, never from the live rows. Every concept carries two bounded
 * alternate hooks (three hooks total), may cite only approved claim ids, and
 * may reference only the product's own ready image ids. Selecting a concept
 * freezes a manifest that a later render can consume without re-reading the
 * catalog, so editing a product cannot silently rewrite an approved ad.
 */

export const AD_CONCEPT_LIMITS = {
  bodyBytes: 8 * 1024,
  instructionChars: 500,
  summaryChars: 600,
  noteChars: 200,
  notes: 4,
  concepts: 3,
  titleChars: 100,
  hookChars: 200,
  /** Two alternates beside the primary hook. */
  hookVariants: 2,
  minBeats: 2,
  maxBeats: 6,
  headingChars: 100,
  narrationChars: 280,
  visualChars: 180,
  onScreenChars: 200,
  beatDurationMax: 600,
  /** Beats may miss the campaign duration by this many seconds, not more. */
  durationToleranceSeconds: 2,
  claimIds: 5,
  assetIds: 6,
  listLimit: 50,
  promptChars: 16_000,
} as const;

/** The product and campaign facts captured when a concept set is generated. */
export interface ProductAdSnapshot {
  version: 1;
  capturedAt: string;
  product: {
    id: string;
    name: string;
    variant: string;
    brandSettings: ProductRecord["brandSettings"];
    approvedClaims: ProductClaim[];
    prohibitedWording: string[];
    assetMediaIds: string[];
    logoMediaId: string | null;
  };
  campaign: {
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
  };
}

export interface ProductAdBeat {
  heading: string;
  narration: string;
  visualDirection: string;
  onScreenText: string;
  durationSeconds: number;
  /** A ready product image the beat may show, or null for no product asset. */
  assetMediaId: string | null;
}

export interface ProductAdConcept {
  id: string;
  title: string;
  hook: string;
  /** Exactly two alternates, distinct from the primary hook and each other. */
  hookVariants: string[];
  beats: ProductAdBeat[];
  /** Approved claims this concept relies on, by snapshot claim id. */
  claimIds: string[];
  totalSeconds: number;
}

/** The validated model reply, before the server assigns concept ids. */
export interface ProductAdConceptPayload {
  summary: string;
  notes: string[];
  concepts: Omit<ProductAdConcept, "id" | "totalSeconds">[];
}

/**
 * The selected concept frozen for a render. The snapshot hash names the facts
 * the manifest was built from; `hooks` is primary plus the two alternates.
 */
export interface ProductAdManifest {
  version: 1;
  snapshotHash: string;
  productId: string;
  campaignId: string;
  /** The campaign's project, where the manifest is applied and rendered. */
  projectId: string | null;
  productName: string;
  productVariant: string;
  /** The product's logo, carried so a render can draw the real mark. */
  logoMediaId: string | null;
  conceptId: string;
  title: string;
  hook: string;
  hooks: string[];
  beats: ProductAdBeat[];
  totalSeconds: number;
  aspectRatio: CampaignAspectRatio;
  durationSeconds: number;
  callToAction: string;
  destination: string;
  disclaimer: string;
  claims: ProductClaim[];
  prohibitedWording: string[];
  createdAt: string;
}

export type ProductAdConceptStatus = "proposed" | "selected";

export interface ProductAdConceptRecord {
  id: string;
  productId: string;
  campaignId: string;
  status: ProductAdConceptStatus;
  snapshot: ProductAdSnapshot;
  snapshotHash: string;
  modelId: string;
  repairAttempted: boolean;
  /** The model's one-paragraph rationale for the set. */
  summary: string;
  notes: string[];
  concepts: ProductAdConcept[];
  selectedIndex: number | null;
  manifest: ProductAdManifest | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdConceptListResponse {
  ok: true;
  conceptSets: ProductAdConceptRecord[];
}

export interface AdConceptResponse {
  ok: true;
  conceptSet: ProductAdConceptRecord;
}

/** The body of `POST /api/products/:id/ad-concepts`. */
export interface AdConceptGenerateRequest {
  campaignId: string;
  instruction?: string;
}

/** The body of `POST /api/ad-concepts/:id/select`. */
export interface AdConceptSelectRequest {
  index: number;
}

/** The reply to `POST /api/ad-concepts/:id/project`. */
export interface AdConceptProjectResponse {
  ok: true;
  /** The campaign's project after the manifest's scenes were saved. */
  project: ProjectRecord;
  /** The revision that now holds the ad; submit it to a video export. */
  projectRevision: number;
}
