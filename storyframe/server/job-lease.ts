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
 * `video-row:<id>`, and runs `work` under that claim. The claim is renewed while
 * the work runs, so an advance that outlives the TTL keeps its row. Resolves to
 * the work's result, or null when another holder has the row, so a sweep skips
 * that row instead of advancing it twice.
 */
export type RowClaim = <T>(rowId: string, work: () => Promise<T>) => Promise<T | null>;

/** Renewal cadence: a third of the TTL leaves room for a slow round trip. */
export function leaseHeartbeatMs(ttlMs: number): number {
  return Math.max(1_000, Math.floor(ttlMs / 3));
}

/**
 * Runs `work` while keeping `lease` alive, renewing every third of its TTL.
 * Without the renewal a claim taken once would lapse mid-advance, and the next
 * pass on another instance could take the same row. A failed renewal is ignored
 * here exactly as in a sweep pass: the lease runs out and the next claim takes
 * over. The lease is released when the work ends, however it ends.
 */
export async function withLeaseRenewal<T>(lease: JobLease, work: () => Promise<T>): Promise<T> {
  const heartbeat = setInterval(() => {
    void lease.renew().catch(() => undefined);
  }, leaseHeartbeatMs(lease.ttlMs));
  heartbeat.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await lease.release().catch(() => undefined);
  }
}

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
