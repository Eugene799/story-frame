import { describe, expect, it } from "vitest";
import { createAuthThrottle, describeWait } from "../src/authThrottle";

function clock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("auth throttle", () => {
  it("allows attempts up to the limit", () => {
    const throttle = createAuthThrottle({ maxAttempts: 3, windowMs: 60_000, now: clock().now });

    expect(throttle.waitFor("sign-in:a@example.com")).toBe(0);
    throttle.record("sign-in:a@example.com");
    throttle.record("sign-in:a@example.com");
    expect(throttle.waitFor("sign-in:a@example.com")).toBe(0);
  });

  it("blocks the attempt after the limit and reports the time left", () => {
    const time = clock();
    const throttle = createAuthThrottle({ maxAttempts: 2, windowMs: 60_000, now: time.now });

    throttle.record("sign-in:a@example.com");
    time.advance(10_000);
    throttle.record("sign-in:a@example.com");

    expect(throttle.waitFor("sign-in:a@example.com")).toBe(50_000);
  });

  it("allows again once the oldest attempt leaves the window", () => {
    const time = clock();
    const throttle = createAuthThrottle({ maxAttempts: 2, windowMs: 60_000, now: time.now });

    throttle.record("sign-in:a@example.com");
    time.advance(30_000);
    throttle.record("sign-in:a@example.com");
    expect(throttle.waitFor("sign-in:a@example.com")).toBeGreaterThan(0);

    time.advance(30_000);
    expect(throttle.waitFor("sign-in:a@example.com")).toBe(0);
  });

  it("counts addresses and actions separately", () => {
    const throttle = createAuthThrottle({ maxAttempts: 1, windowMs: 60_000, now: clock().now });

    throttle.record("sign-in:a@example.com");

    expect(throttle.waitFor("sign-in:b@example.com")).toBe(0);
    expect(throttle.waitFor("sign-up:a@example.com")).toBe(0);
    expect(throttle.waitFor("sign-in:a@example.com")).toBeGreaterThan(0);
  });

  it("clears a key after a successful attempt", () => {
    const throttle = createAuthThrottle({ maxAttempts: 1, windowMs: 60_000, now: clock().now });

    throttle.record("sign-in:a@example.com");
    throttle.clear("sign-in:a@example.com");

    expect(throttle.waitFor("sign-in:a@example.com")).toBe(0);
  });

  it("describes the wait in seconds under a minute and in minutes above it", () => {
    expect(describeWait(1_000)).toBe("1 second");
    expect(describeWait(45_000)).toBe("45 seconds");
    expect(describeWait(60_000)).toBe("1 minute");
    expect(describeWait(300_000)).toBe("5 minutes");
  });
});
