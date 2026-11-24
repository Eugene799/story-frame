import type { SupabaseClient } from "@supabase/supabase-js";

/** Refresh a little before expiry so a request cannot race the access-token lifetime. */
const REFRESH_SKEW_MS = 30_000;

export class AuthSessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthSessionError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Return the current Supabase access token, refreshing it first when it is
 * close to expiring. The server verifies the token on every request; this
 * function only makes sure the browser does not send a stale one.
 */
export async function getAccessToken(client: SupabaseClient, now = Date.now()): Promise<string> {
  let sessionResult: Awaited<ReturnType<SupabaseClient["auth"]["getSession"]>>;
  try {
    sessionResult = await client.auth.getSession();
  } catch {
    throw new AuthSessionError(
      "AUTH_SESSION_UNAVAILABLE",
      "Could not read the Supabase session. Try signing in again.",
      503,
    );
  }

  if (sessionResult.error) {
    throw new AuthSessionError(
      "AUTH_SESSION_UNAVAILABLE",
      "Could not read the Supabase session. Try signing in again.",
      503,
    );
  }

  const session = sessionResult.data.session;
  if (!session) {
    throw new AuthSessionError("AUTH_REQUIRED", "Sign in to StoryFrame before sending a request.", 401);
  }

  if (typeof session.expires_at === "number" && session.expires_at * 1000 <= now + REFRESH_SKEW_MS) {
    let refreshResult: Awaited<ReturnType<SupabaseClient["auth"]["refreshSession"]>>;
    try {
      refreshResult = await client.auth.refreshSession();
    } catch {
      throw new AuthSessionError("AUTH_REFRESH_FAILED", "Could not refresh the Supabase session. Sign in again.", 503);
    }

    if (refreshResult.error || !refreshResult.data.session) {
      throw new AuthSessionError("SESSION_EXPIRED", "Your Supabase session expired. Sign in again.", 401);
    }

    return refreshResult.data.session.access_token;
  }

  return session.access_token;
}
