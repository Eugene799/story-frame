import type { JobLease } from "./job-lease";

export interface JobSchedulerOptions {
  /** Log prefix, e.g. `media`. */
  label: string;
  /** Log event prefix, e.g. `MEDIA_SWEEP`, so messages stay greppable. */
  code: string;
  /** Cadence of the background pass. Zero or less schedules no timer. */
  intervalMs: number;
  run: () => Promise<void>;
  /**
   * Stored lease for this pass. Without one the process advances its own work,
   * which is what a single-instance deployment and the tests use.
   */
  lease?: JobLease | null;
  logger?: { error(message: string): void };
}

export interface JobScheduler {
  stop(): void;
  /**
   * One guarded pass now, used by the media routes so a disabled timer still
   * opportunistically cleans up. A pass already running is shared, not stacked.
   */
  runNow(): Promise<void>;
}

/**
 * Runs one bounded sweep pass on a timer.
 *
 * The rows a pass advances live in Postgres, so a restart finds them again;
 * the stored lease is what makes that safe when more than one instance runs:
 * only its holder advances, it renews while the pass runs, and a dead holder's
 * lease expires so the next instance takes over. A pass that is still running
 * is never overlapped by the next tick, and a failed pass is logged and retried
 * on the following tick.
 */
export function startJobScheduler(options: JobSchedulerOptions): JobScheduler {
  const log = options.logger ?? console;
  const prefix = `[${options.label}] ${options.code}`;
  const lease = options.lease ?? null;
  // A third of the TTL leaves room for a slow round trip before the lease lapses.
  const heartbeatMs = lease ? Math.max(1_000, Math.floor(lease.ttlMs / 3)) : 0;
  let running: Promise<void> | null = null;

  async function pass(): Promise<void> {
    if (lease) {
      let claimed: boolean;
      try {
        claimed = await lease.claim();
      } catch {
        // Another instance may hold it, or the lease store is briefly down.
        // The work is still in Postgres; the next tick tries again.
        log.error(`${prefix}_LEASE_UNAVAILABLE`);
        return;
      }
      if (!claimed) return;
    }

    // Renewal keeps a long pass exclusive. A renewal that fails is ignored:
    // the lease simply runs out, and the next claim takes over.
    const heartbeat = lease
      ? setInterval(() => {
          void lease.renew().catch(() => undefined);
        }, heartbeatMs)
      : null;
    heartbeat?.unref?.();

    try {
      await options.run();
    } catch {
      log.error(`${prefix}_FAILED`);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (lease) {
        // Releasing frees the next tick immediately instead of waiting for the
        // TTL. A release that fails only costs that wait.
        await lease.release().catch(() => log.error(`${prefix}_LEASE_RELEASE_FAILED`));
      }
    }
  }

  function runNow(): Promise<void> {
    if (running) return running;
    running = pass().finally(() => {
      running = null;
    });
    return running;
  }

  const timer =
    options.intervalMs > 0 ? setInterval(() => void runNow(), options.intervalMs) : null;
  // Never keep the process alive only for cleanup.
  timer?.unref?.();

  return {
    stop() {
      if (timer) clearInterval(timer);
    },
    runNow,
  };
}
