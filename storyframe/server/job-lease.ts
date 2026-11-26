import { randomUUID } from "node:crypto";
import { ApiError } from "./api-error";

/**
 * A durable lease on one sweep, stored in Postgres.
 *
 * The holder is a per-process token, so a release can only remove the row its
 * own instance claimed: if this process stalled past its TTL and another
 * instance took over, the stale holder's release is a no-op instead of
 * deleting the new owner's lease. `ttlMs` is the crash-recovery bound, not a
 * pass limit — the scheduler renews while a pass runs.
 */
export interface JobLease {
  readonly ttlMs: number;
  claim(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * Claims one row for one sweep step, named by its family and row id, e.g.
 * `video-row:<id>`. Resolves to the release call, or null when another holder
 * has the row, so a sweep can skip that row instead of advancing it twice.
 */
export type RowClaim = (rowId: string) => Promise<(() => Promise<void>) | null>;

export interface SupabaseJobLeaseOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
  name: string;
  ttlMs: number;
  /** Tests inject a fixed token; production gets a fresh one per scheduler. */
  holder?: string;
}

export function createSupabaseJobLease(options: SupabaseJobLeaseOptions): JobLease {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const holder = options.holder ?? randomUUID();
  const ttlSeconds = Math.max(1, Math.ceil(options.ttlMs / 1000));
  const headers = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  async function call(target: string, init: RequestInit, action: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "JOB_LEASE_UNAVAILABLE", `The ${action} could not reach the lease store.`);
    }
    if (!response.ok) {
      // The body can echo the request (and the key); only the status is reported.
      throw new ApiError(503, "JOB_LEASE_UNAVAILABLE", `The ${action} was rejected (HTTP ${response.status}).`);
    }
    return response.json().catch(() => null);
  }

  async function claimOrRenew(rpc: "claim_job_lease" | "renew_job_lease", action: string): Promise<boolean> {
    const result = await call(
      `${base}/rpc/${rpc}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ p_name: options.name, p_holder: holder, p_ttl_seconds: ttlSeconds }),
      },
      action,
    );
    return result === true;
  }

  return {
    ttlMs: options.ttlMs,
    claim: () => claimOrRenew("claim_job_lease", "job lease claim"),
    renew: () => claimOrRenew("renew_job_lease", "job lease renewal"),
    async release() {
      const query = new URLSearchParams({ name: `eq.${options.name}`, holder: `eq.${holder}` });
      await call(`${base}/job_leases?${query}`, { method: "DELETE", headers }, "job lease release");
    },
  };
}
