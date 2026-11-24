import { useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken } from "./auth";
import { ConnectionTestScreen } from "./components/ConnectionTestScreen";
import { SignInScreen } from "./components/SignInScreen";
import { supabase, supabaseConfigError } from "./supabase";
import { Workspace } from "./workspace/Workspace";

export interface AppProps {
  client?: SupabaseClient | null;
  /** Why the browser client is unavailable, when the VITE_ variables are set but wrong. */
  configError?: string | null;
}

export default function App({ client = supabase, configError = supabaseConfigError }: AppProps = {}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(client));
  const [signingIn, setSigningIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const requestBusy = workspaceBusy || testBusy;

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
        else setSession(data.session);
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
    } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);

  async function handleSignIn(email: string, password: string) {
    if (!client) return;
    setSigningIn(true);
    setAuthError(null);

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
      setSigningIn(false);
    }
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
      setSession(null);
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Supabase sign-out could not be reached.");
    } finally {
      setSigningOut(false);
    }
  }

  const signedIn = Boolean(session);
  const accessToken = async (): Promise<string> => {
    if (!client) throw new Error("Supabase is not configured in this browser.");
    return getAccessToken(client);
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <div>
          <p className="eyebrow">StoryFrame / Phase 4</p>
          <h1>Dashboard, brief, script, and storyboard</h1>
          <p className="lede">
            Sign in to write a brief and script, arrange the storyboard, attach private media, and preview or export
            the editable plan. Generation and video rendering remain later phases.
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
              Sign-out is paused until the current test request finishes, so its reply is not lost.
            </p>
          )}
        </div>
        <span className="badge">{signedIn ? "Workspace" : "Auth required"}</span>
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
        ) : !session ? (
          <SignInScreen configured busy={signingIn} error={authError} onSignIn={handleSignIn} />
        ) : (
          <>
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
              <ConnectionTestScreen getAccessToken={accessToken} onBusyChange={setTestBusy} />
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
