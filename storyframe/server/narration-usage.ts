import { ApiError } from "./api-error";

/**
 * Phase 8 spending ledger for Deepgram.
 *
 * Deepgram bills text-to-speech by input characters, not by returned seconds,
 * and it does not return a per-request price. Every preview and generation is
 * therefore recorded before the billable call at the catalog's verified
 * per-character rate. A failed call remains a failed row and still counts,
 * because the provider may have processed the request before failing.
 */

export type NarrationUsageKind = "preview" | "generation";
export type NarrationUsageStatus = "pending" | "succeeded" | "failed";

export interface NarrationUsageTotals {
  previews: number;
  generations: number;
  characters: number;
  spentUsd: number;
  oldestAt: string | null;
}

export interface NarrationUsageStore {
  create(
    ownerId: string,
    projectId: string,
    write: {
      kind: NarrationUsageKind;
      characters: number;
      costUsd: number;
      rateVersion: string;
    },
  ): Promise<string>;
  settle(ownerId: string, id: string, status: Exclude<NarrationUsageStatus, "pending">): Promise<void>;
  totalsSince(ownerId: string, sinceIso: string): Promise<NarrationUsageTotals>;
}

interface SupabaseNarrationUsageOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

const COLUMNS = "kind,characters,cost_usd,created_at";

export function createSupabaseNarrationUsageStore(
  options: SupabaseNarrationUsageOptions,
): NarrationUsageStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };
  const readHeaders = { ...authHeaders, Accept: "application/json" };
  const writeHeaders = {
    ...authHeaders,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "return=representation",
  };

  async function request(target: string, init: RequestInit, action: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "NARRATION_USAGE_UNAVAILABLE", "The narration usage ledger is unreachable.");
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "NARRATION_USAGE_UNAVAILABLE",
        `The narration usage ledger rejected ${action} (HTTP ${response.status}).`,
      );
    }
    return response.json().catch(() => null);
  }

  function rows(payload: unknown): Record<string, unknown>[] {
    if (!Array.isArray(payload)) {
      throw new ApiError(
        503,
        "NARRATION_USAGE_UNAVAILABLE",
        "The narration usage ledger returned an unreadable response.",
      );
    }
    return payload.map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : {}));
  }

  return {
    async create(ownerId, projectId, write) {
      const created = rows(
        await request(
          `${base}/narration_usage`,
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              owner_id: ownerId,
              project_id: projectId,
              kind: write.kind,
              status: "pending",
              characters: write.characters,
              cost_usd: write.costUsd,
              rate_version: write.rateVersion,
            }),
          },
          "the narration usage reservation",
        ),
      );
      const id = created[0]?.id;
      if (typeof id !== "string") {
        throw new ApiError(
          503,
          "NARRATION_USAGE_UNAVAILABLE",
          "The narration usage ledger did not confirm the reservation.",
        );
      }
      return id;
    },

    async settle(ownerId, id, status) {
      await request(
        `${base}/narration_usage?${new URLSearchParams({
          id: `eq.${id}`,
          owner_id: `eq.${ownerId}`,
        })}`,
        {
          method: "PATCH",
          headers: writeHeaders,
          body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
        },
        "the narration usage completion",
      );
    },

    async totalsSince(ownerId, sinceIso) {
      const found = rows(
        await request(
          `${base}/narration_usage?${new URLSearchParams({
            select: COLUMNS,
            owner_id: `eq.${ownerId}`,
            created_at: `gte.${sinceIso}`,
            order: "created_at.asc",
            limit: "5000",
          })}`,
          { headers: readHeaders },
          "the narration usage total",
        ),
      );
      let previews = 0;
      let generations = 0;
      let characters = 0;
      let spentUsd = 0;
      let oldestAt: string | null = null;
      for (const row of found) {
        if (row.kind === "preview") previews += 1;
        else if (row.kind === "generation") generations += 1;
        if (typeof row.characters === "number" && Number.isFinite(row.characters)) {
          characters += row.characters;
        }
        if (typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd)) {
          spentUsd += row.cost_usd;
        }
        if (oldestAt === null && typeof row.created_at === "string") oldestAt = row.created_at;
      }
      return {
        previews,
        generations,
        characters,
        spentUsd: Number(spentUsd.toFixed(6)),
        oldestAt,
      };
    },
  };
}
