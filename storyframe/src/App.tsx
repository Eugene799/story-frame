import { useEffect, useRef, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken } from "./auth";
import { ConnectionTestScreen } from "./components/ConnectionTestScreen";
import { NewPasswordScreen } from "./components/NewPasswordScreen";
import { PasswordResetScreen } from "./components/PasswordResetScreen";
import { SignInScreen } from "./components/SignInScreen";
import { SignUpScreen } from "./components/SignUpScreen";
import { supabase, supabaseConfigError } from "./supabase";
import { Workspace } from "./workspace/Workspace";

type AuthView = "sign-in" | "sign-up" | "reset-request";

export interface AppProps {
  client?: SupabaseClient | null;
  /** Why the browser client is unavailable, when the VITE_ variables are set but wrong. */
  configError?: string | null;
}

export default function App({ client = supabase, configError = supabaseConfigError }: AppProps = {}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(client));
  const [authView, setAuthView] = useState<AuthView>("sign-in");
  /** True between a password-recovery link and the new password being saved. */
  const [recovering, setRecovering] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const requestBusy = workspaceBusy || testBusy;
  const sessionRef = useRef<Session | null>(null);
  // A ref guard, because the busy state only reaches the buttons after a render:
  // two clicks in the same tick would otherwise start two auth requests.
  const authBusyRef = useRef(false);

  function beginAuth(): boolean {
    if (authBusyRef.current) return false;
    authBusyRef.current = true;
    setAuthBusy(true);
    return true;
  }

  function endAuth() {
    authBusyRef.current = false;
    setAuthBusy(false);
  }

  useEffect(() => {
    if (!client) {
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);

    client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setAuthError(error.message);
        else {
          sessionRef.current = data.session;
          setSession(data.session);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setAuthError(cause instanceof Error ? cause.message : "Could not read the Supabase session.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      const hadSession = sessionRef.current !== null;
      sessionRef.current = nextSession;
      // A recovery link signs the user in just to let them set a password, so
      // the workspace must stay hidden until that happens.
      if (event === "PASSWORD_RECOVERY") {
        setRecovering(true);
        setAuthView("sign-in");
        setAuthError(null);
        setAuthNotice(null);
      }
      setSession(nextSession);
      // A session arriving where there was none means the screen is no longer
      // in the state an earlier error described (a restored session after a
      // failed startup read, for example), so that error is stale.
      if (nextSession && !hadSession) setAuthError(null);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);

  function showView(view: AuthView) {
    setAuthView(view);
    setAuthError(null);
    setAuthNotice(null);
  }

  async function handleSignIn(email: string, password: string) {
    if (!client || !beginAuth()) return;
    setAuthError(null);
    setAuthNotice(null);

    try {
      const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        setAuthError(error.message);
        return;
      }
      // Supabase returns no session when the account still has to confirm its
      // email, so staying silent would look like a broken sign-in button.
      if (!data.session) {
        setAuthError("Supabase did not start a session. Confirm your email address, then sign in again.");
        return;
      }
      // onAuthStateChange delivers the signed-in session to the screen, so the
      // app does not keep a second copy of it here.
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Supabase sign-in could not be reached.");
    } finally {
      endAuth();
    }
  }

  async function handleSignUp(email: string, password: string) {
    if (!client || !beginAuth()) return;
    setAuthError(null);
    setAuthNotice(null);

    try {
      const { data, error } = await client.auth.signUp({
        email: email.trim(),
        password,
        // Send the confirmation link back to this origin instead of relying on
        // the project's Site URL, which is not necessarily the hosted app.
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) {
        setAuthError(error.message);
        return;
      }
      // Supabase reports an address that is already registered as a user with no
      // identities instead of failing, so a plain "check your email" would lie.
      if (Array.isArray(data.user?.identities) && data.user.identities.length === 0) {
        setAuthNotice(
          `An account already exists for ${email.trim()}. Sign in, or reset your password if you do not remember it.`,
        );
        setAuthView("sign-in");
        return;
      }
      // With email confirmation enabled there is no session until the link is
      // opened; without it, onAuthStateChange already has the session.
      if (!data.session) {
        setAuthNotice(`Check ${email.trim()} for a confirmation link, then sign in.`);
      }
      setAuthView("sign-in");
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Supabase sign-up could not be reached.");
    } finally {
      endAuth();
    }
  }

  async function handlePasswordReset(email: string) {
    if (!client || !beginAuth()) return;
    setAuthError(null);
    setAuthNotice(null);

    try {
      const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      });
      if (error) {
        setAuthError(error.message);
        return;
      }
      // The same answer whether or not the address has an account.
      setAuthNotice(
        "If an account exists for that address, a reset link is on its way. Open it in this browser to choose a new password.",
      );
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Supabase password reset could not be reached.");
    } finally {
      endAuth();
    }
  }

  async function handleNewPassword(password: string) {
    if (!client || !beginAuth()) return;
    setAuthError(null);
    setAuthNotice(null);

    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) {
        setAuthError(error.message);
        return;
      }
      setRecovering(false);
      setAuthView("sign-in");
      setAuthNotice("Password updated.");
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Supabase could not save the new password.");
    } finally {
      endAuth();
    }
  }

  async function handleCancelRecovery() {
    setRecovering(false);
    setAuthView("sign-in");
    setAuthError(null);
    setAuthNotice("Password recovery cancelled.");
    if (!client) return;
    // A recovery link leaves a session behind; drop it so a shared browser is
    // not silently signed in.
    await client.auth.signOut({ scope: "local" }).catch(() => {});
    sessionRef.current = null;
    setSession(null);
  }

  /**
   * The workspace found the session gone or expired. Return the user to the
   * sign-in form instead of leaving a screen where every request fails.
   */
  function handleSessionExpired() {
    setRecovering(false);
    setAuthView("sign-in");
    sessionRef.current = null;
    setSession(null);
    setAuthNotice(null);
    setAuthError("Your Supabase session expired. Sign in again.");
    void client?.auth.signOut({ scope: "local" }).catch(() => {});
  }

  async function handleSignOut() {
    if (!client || requestBusy) return;
    setSigningOut(true);
    setAuthError(null);

    try {
      // Local scope: signing out of this tab must not revoke the account's other sessions.
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) {
        setAuthError(error.message);
        return;
      }
      sessionRef.current = null;
      setSession(null);
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Supabase sign-out could not be reached.");
    } finally {
      setSigningOut(false);
    }
  }

  const signedIn = Boolean(session) && !recovering;
  const badgeText = recovering ? "Password recovery" : signedIn ? "Workspace" : "Auth required";
  const accessToken = async (): Promise<string> => {
    if (!client) throw new Error("Supabase is not configured in this browser.");
    return getAccessToken(client);
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <div>
          <p className="eyebrow">StoryFrame / Phase 9</p>
          <h1>Dashboard, brief, script, and storyboard</h1>
          <p className="lede">
            Sign in to write a brief and script, arrange the storyboard, attach private media, generate images and
            narration, and render the video from the Preview tab. Create an account or reset a password from the sign-in
            form.
          </p>
          {signedIn && session && (
            <div className="session-bar">
              <span>
                Signed in as <strong>{session.user.email ?? session.user.id}</strong>
              </span>
              <button
                type="button"
                className="button-secondary"
                onClick={handleSignOut}
                disabled={signingOut}
                aria-disabled={requestBusy}
                title={requestBusy ? "Wait for the current request to finish before signing out." : undefined}
              >
                {signingOut ? "Signing out..." : "Sign out"}
              </button>
            </div>
          )}
          {signedIn && requestBusy && (
            <p className="hint">
              Sign-out is paused until the current request finishes, so its reply is not lost.
            </p>
          )}
        </div>
        <span className="badge">{badgeText}</span>
      </header>

      <main>
        {loading ? (
          <section className="panel auth-panel" aria-live="polite">
            <p className="muted">Checking your Supabase session...</p>
          </section>
        ) : !client ? (
          <SignInScreen
            configured={false}
            configError={configError}
            busy={false}
            error={null}
            onSignIn={handleSignIn}
          />
        ) : recovering ? (
          <NewPasswordScreen busy={authBusy} error={authError} onSubmit={handleNewPassword} onCancel={handleCancelRecovery} />
        ) : !session ? (
          authView === "sign-up" ? (
            <SignUpScreen
              busy={authBusy}
              error={authError}
              onSubmit={handleSignUp}
              onBack={() => showView("sign-in")}
            />
          ) : authView === "reset-request" ? (
            <PasswordResetScreen
              busy={authBusy}
              error={authError}
              notice={authNotice}
              onSubmit={handlePasswordReset}
              onBack={() => showView("sign-in")}
            />
          ) : (
            <SignInScreen
              configured
              busy={authBusy}
              notice={authNotice}
              error={authError}
              onSignIn={handleSignIn}
              onShowSignUp={() => showView("sign-up")}
              onShowReset={() => showView("reset-request")}
            />
          )
        ) : (
          <>
            {authNotice && (
              <div className="callout" role="status">
                {authNotice}
              </div>
            )}
            {authError && (
              <div className="alert" role="alert">
                {authError}
              </div>
            )}
            <Workspace getAccessToken={accessToken} onBusyChange={setWorkspaceBusy} />
            <details className="dev-harness">
              <summary>Developer connection harness</summary>
              <p className="hint">
                The Phase 1–2 configuration view and billable test request stay available below the workspace.
              </p>
              <ConnectionTestScreen
                getAccessToken={accessToken}
                onBusyChange={setTestBusy}
                onSessionExpired={handleSessionExpired}
              />
            </details>
          </>
        )}
      </main>

      <footer className="site-footer">
        <p>
          Supabase Auth issues session tokens to the browser; the Node server verifies them on every project and media
          request. The Ollama key, Supabase service-role key, and storage credentials never reach the browser.
        </p>
      </footer>
    </div>
  );
}
