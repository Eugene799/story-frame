export interface AuthThrottleOptions {
  /** Attempts allowed per key inside the window. */
  maxAttempts: number;
  windowMs: number;
  /** Injectable clock so tests do not have to wait. */
  now?: () => number;
}

export interface AuthThrottle {
  /** Milliseconds left before this key may try again; 0 means it may. */
  waitFor(key: string): number;
  record(key: string): void;
  clear(key: string): void;
}

/**
 * Counts recent attempts per key (for example `sign-in:<email>`) so a form can
 * refuse a burst instead of forwarding every attempt to Supabase. This is a
 * usability guard inside one tab, not the security boundary: Supabase still
 * enforces its own limits, and a reload starts a fresh count.
 */
export function createAuthThrottle({ maxAttempts, windowMs, now = Date.now }: AuthThrottleOptions): AuthThrottle {
  const attempts = new Map<string, number[]>();

  function recent(key: string): number[] {
    const current = now();
    const kept = (attempts.get(key) ?? []).filter((at) => current - at < windowMs);
    if (kept.length === 0) attempts.delete(key);
    else attempts.set(key, kept);
    return kept;
  }

  return {
    waitFor(key) {
      const kept = recent(key);
      if (kept.length < maxAttempts) return 0;
      const oldest = kept[0] ?? now();
      return Math.max(0, windowMs - (now() - oldest));
    },
    record(key) {
      const kept = recent(key);
      kept.push(now());
      attempts.set(key, kept);
    },
    clear(key) {
      attempts.delete(key);
    },
  };
}

export function describeWait(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
