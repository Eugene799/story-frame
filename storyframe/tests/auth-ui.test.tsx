// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import type { AiStatusResponse } from "../shared/ai-contract";
import App from "../src/App";

const STATUS: AiStatusResponse = {
  service: "storyframe-ai",
  mode: "development",
  configured: true,
  keyConfigured: true,
  auth: { mode: "supabase", configured: true, publishableKeyConfigured: true },
  ledger: { configured: true, ready: true, serviceRoleConfigured: true, table: "ai_usage" },
  provider: { name: "ollama-cloud", baseUrl: "https://ollama.com" },
  catalog: { source: "ollama.com/api/tags", checkedOn: "2026-11-24" },
  limits: {
    promptMaxChars: 500,
    bodyMaxBytes: 4096,
    providerTimeoutMs: 30000,
    maxOutputTokens: 120,
    maxConcurrentRequests: 1,
    requestsPerMinute: 6,
    abandonAfterMs: 90000,
  },
  models: [
    {
      id: "gemma",
      label: "Gemma 4 31B",
      family: "gemma4",
      requestId: "gemma4:31b",
      available: true,
      reason: null,
      catalogStatus: "listed",
    },
  ],
  planning: { routes: [], registry: [] },
};

const SUCCESS = {
  ok: true,
  modelId: "gemma",
  configuredModel: "gemma4:31b",
  returnedModel: "gemma4:31b",
  reply: "Welcome to StoryFrame, where rough ideas become finished scenes.",
  latencyMs: 812,
  usage: { promptEvalCount: 19, evalCount: 12 },
  doneReason: "stop",
};

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => payload,
  } as unknown as Response;
}

function installStatusFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/ai/status")) return jsonResponse(STATUS);
      if (String(input).endsWith("/api/projects")) return jsonResponse({ ok: true, projects: [] });
      throw new Error(`Unexpected request: ${String(input)}`);
    }),
  );
}

function makeSession(email: string): Session {
  const user = {
    id: "user-1",
    email,
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-11-24T00:00:00.000Z",
  } as User;

  return {
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
  } as Session;
}

interface ClientOptions {
  initialSession?: Session | null;
  getSessionError?: string | null;
  signInError?: string | null;
  signInWithoutSession?: boolean;
  signUpError?: string | null;
  signUpSession?: Session | null;
  signUpIdentities?: { id: string; provider: string }[];
  resetError?: string | null;
  updateError?: string | null;
}

function makeClient(options: ClientOptions = {}) {
  const {
    initialSession = null,
    getSessionError = null,
    signInError = null,
    signInWithoutSession = false,
    signUpError = null,
    signUpSession = null,
    signUpIdentities = [{ id: "identity-1", provider: "email" }],
    resetError = null,
    updateError = null,
  } = options;

  let current = initialSession;
  let startupError = getSessionError;
  let listener: ((event: string, session: Session | null) => void) | null = null;

  const signInWithPassword = vi.fn(async ({ email }: { email: string; password: string }) => {
    if (signInError) {
      return { data: { session: null, user: null }, error: { message: signInError } };
    }
    if (signInWithoutSession) {
      return { data: { session: null, user: null }, error: null };
    }

    const session = makeSession(email);
    current = session;
    listener?.("SIGNED_IN", session);
    return { data: { session, user: session.user }, error: null };
  });

  const signUp = vi.fn(async ({ email }: { email: string; password: string }) => {
    if (signUpError) {
      return { data: { session: null, user: null }, error: { message: signUpError } };
    }
    const user = { ...makeSession(email).user, identities: signUpIdentities };
    if (signUpSession) {
      current = signUpSession;
      listener?.("SIGNED_IN", signUpSession);
    }
    return { data: { session: signUpSession, user }, error: null };
  });

  const resetPasswordForEmail = vi.fn(async (_email: string, _options?: { redirectTo?: string }) =>
    resetError ? { data: null, error: { message: resetError } } : { data: {}, error: null },
  );

  const updateUser = vi.fn(async (_attributes: { password?: string }) =>
    updateError
      ? { data: { user: null }, error: { message: updateError } }
      : { data: { user: current?.user ?? null }, error: null },
  );

  const signOut = vi.fn(async (_options?: { scope?: string }) => {
    current = null;
    listener?.("SIGNED_OUT", null);
    return { error: null };
  });

  const client = {
    auth: {
      getSession: vi.fn(async () => {
        // A startup read can fail once and still recover when an auth event
        // delivers a session; a persistent error would contradict that event.
        if (startupError) {
          const message = startupError;
          startupError = null;
          return { data: { session: null }, error: { message } };
        }
        return { data: { session: current }, error: null };
      }),
      onAuthStateChange: vi.fn((callback: (event: string, session: Session | null) => void) => {
        listener = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signInWithPassword,
      signUp,
      resetPasswordForEmail,
      updateUser,
      signOut,
      refreshSession: vi.fn(async () => ({
        data: { session: current, user: current?.user ?? null },
        error: null,
      })),
    },
  } as unknown as SupabaseClient;

  return {
    client,
    signInWithPassword,
    signUp,
    resetPasswordForEmail,
    updateUser,
    signOut,
    /** Change what getSession returns without telling the UI, like an expiry would. */
    setStoredSession(next: Session | null) {
      current = next;
    },
    /** Deliver an auth event, e.g. PASSWORD_RECOVERY from a recovery link. */
    emit(event: string, session: Session | null) {
      current = session;
      listener?.(event, session);
    },
  };
}

function fillCredentials(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

async function openSignUp() {
  await screen.findByRole("heading", { name: "Sign in" });
  fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
  await screen.findByRole("heading", { name: "Create account" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App authentication", () => {
  it("signs in with email and password, shows the signed-in user, and signs out", async () => {
    installStatusFetch();
    const { client, signInWithPassword, signOut } = makeClient();
    render(<App client={client} />);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    fillCredentials("ada@example.com", "correct horse battery staple");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/ada@example.com/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Server configuration" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Supabase access token/i)).toBeNull();
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct horse battery staple",
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("restores an existing Supabase session on load", async () => {
    installStatusFetch();
    const { client } = makeClient({ initialSession: makeSession("persisted@example.com") });
    render(<App client={client} />);

    expect(await screen.findByText(/persisted@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows a sign-in error without leaving the form", async () => {
    const { client } = makeClient({ signInError: "Invalid login credentials" });
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Sign in" });
    fillCredentials("ada@example.com", "wrong");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("explains a missing session after sign-in instead of silently staying signed out", async () => {
    const { client } = makeClient({ signInWithoutSession: true });
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Sign in" });
    fillCredentials("unconfirmed@example.com", "correct horse battery staple");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Confirm your email address/i);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("explains the missing browser configuration instead of accepting a pasted token", () => {
    render(<App client={null} />);

    expect(screen.getByText(/Browser-side Supabase Auth is not configured/i)).toBeInTheDocument();
    expect(screen.getByText("VITE_SUPABASE_URL")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Supabase access token/i)).toBeNull();
  });

  it("reports an invalid browser configuration instead of calling it missing", () => {
    render(<App client={null} configError="VITE_SUPABASE_URL is not a valid URL." />);

    expect(screen.getByRole("alert")).toHaveTextContent(/VITE_SUPABASE_URL is not a valid URL/i);
    expect(screen.queryByText(/Browser-side Supabase Auth is not configured/i)).toBeNull();
  });

  it("keeps sign-out from discarding a request that is still running", async () => {
    let release: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/ai/status")) return jsonResponse(STATUS);
        if (url.endsWith("/api/projects")) return jsonResponse({ ok: true, projects: [] });
        if (url.endsWith("/api/ai/test")) return pending;
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const { client, signOut } = makeClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Sign in" });
    fillCredentials("ada@example.com", "correct horse battery staple");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("option", { name: /Gemma 4 31B/ });
    fireEvent.click(screen.getByRole("button", { name: /Send test request/i }));

    expect(await screen.findByText(/Sign-out is paused until the current request finishes/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).not.toHaveBeenCalled();

    release?.(jsonResponse(SUCCESS));
    expect(await screen.findByTestId("ai-reply")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("Auth request safety", () => {
  it("clears a startup error once a session is actually restored", async () => {
    installStatusFetch();
    const { client, emit } = makeClient({ getSessionError: "JWT expired" });
    render(<App client={client} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("JWT expired");

    act(() => emit("SIGNED_IN", makeSession("restored@example.com")));

    expect(await screen.findByText(/restored@example.com/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not start a second sign-in request while one is pending", async () => {
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const { client, signInWithPassword } = makeClient();
    signInWithPassword.mockImplementationOnce(async () => {
      await pending;
      return { data: { session: null, user: null }, error: { message: "Invalid login credentials" } };
    });

    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Sign in" });
    fillCredentials("ada@example.com", "correct horse battery staple");

    const button = screen.getByRole("button", { name: "Sign in" });
    act(() => {
      button.click();
      button.click();
    });

    expect(signInWithPassword).toHaveBeenCalledTimes(1);

    release?.(null);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
  });

  it("stops forwarding sign-in attempts after repeated failures", async () => {
    installStatusFetch();
    const { client, signInWithPassword } = makeClient({ signInError: "Invalid login credentials" });
    render(<App client={client} />);
    await screen.findByRole("heading", { name: "Sign in" });
    fillCredentials("ada@example.com", "correct horse battery staple");
    const button = screen.getByRole("button", { name: "Sign in" });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await act(async () => {
        fireEvent.click(button);
      });
      expect(signInWithPassword).toHaveBeenCalledTimes(attempt);
    }

    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Too many sign-in attempts for this address. Try again in 5 minutes.",
    );
    expect(signInWithPassword).toHaveBeenCalledTimes(5);
  });
});

describe("Account flows", () => {
  it("creates an account and explains the confirmation email", async () => {
    const { client, signUp } = makeClient();
    render(<App client={client} />);
    await openSignUp();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText(/Check new@example.com for a confirmation link/i)).toBeInTheDocument();
    expect(signUp).toHaveBeenCalledWith({
      email: "new@example.com",
      password: "correct horse battery staple",
      options: { emailRedirectTo: window.location.origin },
    });
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("reports an existing account instead of promising an email that will not arrive", async () => {
    const { client } = makeClient({ signUpIdentities: [] });
    render(<App client={client} />);
    await openSignUp();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText(/An account already exists for ada@example.com/i)).toBeInTheDocument();
    expect(screen.queryByText(/confirmation link/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("signs in directly when the project returns a session from sign-up", async () => {
    installStatusFetch();
    const { client } = makeClient({ signUpSession: makeSession("fresh@example.com") });
    render(<App client={client} />);
    await openSignUp();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "fresh@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText(/fresh@example.com/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Server configuration" })).toBeInTheDocument();
    expect(screen.queryByText(/confirmation link/i)).toBeNull();
  });

  it("sends a password-reset link without revealing whether the account exists", async () => {
    const { client, resetPasswordForEmail } = makeClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Sign in" });
    fireEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
    expect(await screen.findByRole("heading", { name: "Reset your password" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText(/If an account exists for that address/i)).toBeInTheDocument();
    expect(resetPasswordForEmail).toHaveBeenCalledWith("ada@example.com", {
      redirectTo: window.location.origin,
    });
  });

  it("shows a password-reset error", async () => {
    const { client } = makeClient({ resetError: "Email rate limit exceeded" });
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Sign in" });
    fireEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
    await screen.findByRole("heading", { name: "Reset your password" });

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Email rate limit exceeded");
  });

  it("shows the new-password screen for a recovery link, guards the mismatch, and saves the password", async () => {
    installStatusFetch();
    const { client, emit, updateUser } = makeClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Sign in" });
    act(() => emit("PASSWORD_RECOVERY", makeSession("recover@example.com")));

    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
    expect(screen.getByText("Password recovery")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-pass-1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-pass-2" } });

    expect(screen.getByText(/do not match/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update password" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-pass-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(updateUser).toHaveBeenCalledWith({ password: "new-pass-1" });
    expect(await screen.findByRole("heading", { name: "Server configuration" })).toBeInTheDocument();
    expect(screen.getByText("Password updated.")).toBeInTheDocument();
  });

  it("returns to the sign-in form when a request finds the session expired", async () => {
    installStatusFetch();
    const { client, signOut, setStoredSession } = makeClient();
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Sign in" });
    fillCredentials("ada@example.com", "correct horse battery staple");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("option", { name: /Gemma 4 31B/ });
    setStoredSession(null);
    fireEvent.click(screen.getByRole("button", { name: /Send test request/i }));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/session expired/i);
    expect(screen.queryByRole("heading", { name: "Send a test request" })).toBeNull();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
