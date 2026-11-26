import { afterEach, describe, expect, it, vi } from "vitest";
import { startJobScheduler } from "../server/job-scheduler";
import type { JobLease } from "../server/job-lease";

const silent = { error: () => undefined };

afterEach(() => {
  vi.useRealTimers();
});

interface FakeLeaseOptions {
  ttlMs?: number;
  /** Shared between schedulers so two of them compete for one stored lease. */
  store?: { holder: string | null };
  holder?: string;
  claimFails?: boolean;
}

function fakeLease(options: FakeLeaseOptions = {}): JobLease & {
  claims: number;
  renewals: number;
  releases: number;
} {
  const store = options.store ?? { holder: null };
  const holder = options.holder ?? "holder-a";
  const lease = {
    name: "test-sweep",
    ttlMs: options.ttlMs ?? 3000,
    claims: 0,
    renewals: 0,
    releases: 0,
    async claim() {
      lease.claims += 1;
      if (options.claimFails) throw new Error("lease store down");
      if (store.holder !== null) return false;
      store.holder = holder;
      return true;
    },
    async renew() {
      lease.renewals += 1;
      return store.holder === holder;
    },
    async release() {
      lease.releases += 1;
      if (store.holder === holder) store.holder = null;
    },
  };
  return lease;
}

describe("scheduled job pass", () => {
  it("runs one pass per interval and stops cleanly", async () => {
    vi.useFakeTimers();
    let passes = 0;
    const scheduler = startJobScheduler({
      label: "media",
      code: "MEDIA_SWEEP",
      intervalMs: 1000,
      run: async () => {
        passes += 1;
      },
      logger: silent,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(passes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(passes).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(passes).toBe(3);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(passes).toBe(3);
  });

  it("does not overlap a pass that is still running", async () => {
    vi.useFakeTimers();
    const resolvers: (() => void)[] = [];
    let passes = 0;
    const scheduler = startJobScheduler({
      label: "media",
      code: "MEDIA_SWEEP",
      intervalMs: 100,
      run: () => {
        passes += 1;
        return new Promise<void>((resolve) => resolvers.push(resolve));
      },
      logger: silent,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(1);
    // Several ticks pass while the first pass is still working.
    await vi.advanceTimersByTimeAsync(500);
    expect(passes).toBe(1);

    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(2);

    scheduler.stop();
    for (const resolve of resolvers) resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(passes).toBe(2);
  });

  it("logs a failed pass and keeps scheduling", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let passes = 0;
    const scheduler = startJobScheduler({
      label: "media",
      code: "MEDIA_SWEEP",
      intervalMs: 100,
      run: async () => {
        passes += 1;
        if (passes === 1) throw new Error("store down");
      },
      logger: { error: (message) => errors.push(message) },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toEqual(["[media] MEDIA_SWEEP_FAILED"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(2);

    scheduler.stop();
  });

  it("treats a synchronous throw as a failed pass", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let passes = 0;
    const scheduler = startJobScheduler({
      label: "media",
      code: "MEDIA_SWEEP",
      intervalMs: 100,
      run: () => {
        passes += 1;
        if (passes === 1) throw new Error("synchronous failure");
        return Promise.resolve();
      },
      logger: { error: (message) => errors.push(message) },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toEqual(["[media] MEDIA_SWEEP_FAILED"]);
    // The guard was released, so the next tick still runs.
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(2);

    scheduler.stop();
  });

  it("schedules no timer at a zero interval but still runs on request", async () => {
    vi.useFakeTimers();
    let passes = 0;
    const scheduler = startJobScheduler({
      label: "media",
      code: "MEDIA_SWEEP",
      intervalMs: 0,
      run: async () => {
        passes += 1;
      },
      logger: silent,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(passes).toBe(0);

    // The media routes use runNow() when the timer is off.
    await scheduler.runNow();
    expect(passes).toBe(1);
    scheduler.stop();
  });

  it("skips a pass another instance owns and keeps the pass it holds exclusive", async () => {
    vi.useFakeTimers();
    // Two instances, one stored lease: the first pass of the tick holds it.
    const store = { holder: null as string | null };
    const leaseA = fakeLease({ store, holder: "instance-a" });
    const leaseB = fakeLease({ store, holder: "instance-b" });
    const resolvers: (() => void)[] = [];
    let passesA = 0;
    let passesB = 0;

    const instanceA = startJobScheduler({
      label: "video",
      code: "VIDEO_SWEEP",
      intervalMs: 100,
      run: () => {
        passesA += 1;
        return new Promise<void>((resolve) => resolvers.push(resolve));
      },
      lease: leaseA,
      logger: silent,
    });
    const instanceB = startJobScheduler({
      label: "video",
      code: "VIDEO_SWEEP",
      intervalMs: 100,
      run: async () => {
        passesB += 1;
      },
      lease: leaseB,
      logger: silent,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(passesA).toBe(1);
    expect(passesB).toBe(0);
    // The refused claim is not a release: the holder keeps its lease.
    expect(leaseB.releases).toBe(0);
    expect(store.holder).toBe("instance-a");

    // Once the pass finishes it releases, so the next tick can be claimed.
    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(leaseA.releases).toBe(1);
    expect(passesB + passesA).toBe(2);

    instanceA.stop();
    instanceB.stop();
    for (const resolve of resolvers) resolve();
  });

  it("renews its lease while a pass runs and always releases", async () => {
    vi.useFakeTimers();
    const lease = fakeLease({ ttlMs: 3000 });
    const resolvers: (() => void)[] = [];
    const scheduler = startJobScheduler({
      label: "lipsync",
      code: "LIPSYNC_SWEEP",
      intervalMs: 100,
      run: () => new Promise<void>((resolve) => resolvers.push(resolve)),
      lease,
      logger: silent,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(lease.claims).toBe(1);
    // A third of the TTL, so a pass longer than one TTL keeps its lease.
    await vi.advanceTimersByTimeAsync(3000);
    expect(lease.renewals).toBe(3);
    expect(lease.releases).toBe(0);

    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(lease.releases).toBe(1);
    scheduler.stop();
  });

  it("releases the lease after a failed pass", async () => {
    vi.useFakeTimers();
    const lease = fakeLease();
    const scheduler = startJobScheduler({
      label: "image",
      code: "IMAGE_SWEEP",
      intervalMs: 100,
      run: async () => {
        throw new Error("store down");
      },
      lease,
      logger: silent,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(lease.claims).toBe(1);
    expect(lease.releases).toBe(1);
    scheduler.stop();
  });

  it("skips the pass when the lease store rejects the claim", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const lease = fakeLease({ claimFails: true });
    let passes = 0;
    const scheduler = startJobScheduler({
      label: "video",
      code: "VIDEO_SWEEP",
      intervalMs: 100,
      run: async () => {
        passes += 1;
      },
      lease,
      logger: { error: (message) => errors.push(message) },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(0);
    expect(lease.releases).toBe(0);
    expect(errors).toEqual(["[video] VIDEO_SWEEP_LEASE_UNAVAILABLE"]);

    // The next tick tries again instead of giving up on the sweep.
    await vi.advanceTimersByTimeAsync(100);
    expect(lease.claims).toBe(2);
    scheduler.stop();
  });

  it("logs a release failure without failing the pass", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const store = { holder: null as string | null };
    const lease = fakeLease({ store });
    lease.release = async () => {
      throw new Error("lease store down");
    };
    let passes = 0;
    const scheduler = startJobScheduler({
      label: "media",
      code: "MEDIA_SWEEP",
      intervalMs: 100,
      run: async () => {
        passes += 1;
      },
      lease,
      logger: { error: (message) => errors.push(message) },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(1);
    expect(errors).toEqual(["[media] MEDIA_SWEEP_LEASE_RELEASE_FAILED"]);
    // A release that never reached the store leaves the row held, so this tick
    // is refused rather than running a second pass.
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(1);

    // Once the lease lapses (or its holder dies), the next tick advances again.
    store.holder = null;
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(2);
    scheduler.stop();
  });
});
