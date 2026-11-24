import { describe, expect, it, vi } from "vitest";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken } from "../src/auth";

function makeSession(accessToken: string, expiresAt: number): Session {
  return {
    access_token: accessToken,
    refresh_token: "refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    user: {
      id: "user-1",
      email: "ada@example.com",
      app_metadata: {},
      user_metadata: {},
      aud: "authenticated",
      created_at: "2026-11-24T00:00:00.000Z",
    },
  } as Session;
}

function clientFor(
  session: Session | null,
  refreshSession: () => Promise<{
    data: { session: Session | null; user: Session["user"] | null };
    error: { message: string } | null;
  }>,
): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session }, error: null })),
      refreshSession: vi.fn(refreshSession),
    },
  } as unknown as SupabaseClient;
}

describe("getAccessToken", () => {
  it("returns the current access token without refreshing a session that is not near expiry", async () => {
    const now = 1_760_000_000_000;
    const session = makeSession("valid-token", Math.floor(now / 1000) + 3600);
    const refreshSession = vi.fn(async () => ({ data: { session, user: session.user }, error: null }));

    await expect(getAccessToken(clientFor(session, refreshSession), now)).resolves.toBe("valid-token");
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("refreshes a session that expires within the 30-second request window", async () => {
    const now = 1_760_000_000_000;
    const current = makeSession("old-token", Math.floor(now / 1000) + 5);
    const refreshed = makeSession("refreshed-token", Math.floor(now / 1000) + 3600);
    const refreshSession = vi.fn(async () => ({ data: { session: refreshed, user: refreshed.user }, error: null }));

    await expect(getAccessToken(clientFor(current, refreshSession), now)).resolves.toBe("refreshed-token");
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("refuses to send a request when there is no session", async () => {
    const refreshSession = vi.fn(async () => ({ data: { session: null, user: null }, error: null }));

    await expect(getAccessToken(clientFor(null, refreshSession), 1_760_000_000_000)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("reports an expired session when refresh fails", async () => {
    const now = 1_760_000_000_000;
    const current = makeSession("old-token", Math.floor(now / 1000) + 5);
    const refreshSession = vi.fn(async () => ({
      data: { session: null, user: null },
      error: { message: "Invalid Refresh Token" },
    }));

    await expect(getAccessToken(clientFor(current, refreshSession), now)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      status: 401,
    });
  });
});
