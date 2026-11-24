import { useState, type FormEvent } from "react";

interface SignUpScreenProps {
  busy: boolean;
  error: string | null;
  onSubmit: (email: string, password: string) => Promise<void>;
  onBack: () => void;
}

export function SignUpScreen({ busy, error, onSubmit, onBack }: SignUpScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    await onSubmit(email, password);
  }

  return (
    <section className="panel auth-panel" aria-labelledby="signup-heading">
      <div className="panel-heading">
        <h2 id="signup-heading">Create account</h2>
        <span className="status status-dev">Supabase Auth</span>
      </div>

      <p className="muted">
        Supabase sends a confirmation link before the first sign-in. The password policy is the project's, so a
        rejected password comes back with the reason Supabase gave.
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <label className="field" htmlFor="signup-email">
          <span className="field-label">Email</span>
          <input
            id="signup-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            placeholder="you@example.com"
          />
        </label>

        <label className="field" htmlFor="signup-password">
          <span className="field-label">Password</span>
          <input
            id="signup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            placeholder="Choose a password"
          />
        </label>

        <button type="submit" disabled={!canSubmit} aria-busy={busy}>
          {busy ? "Creating account..." : "Create account"}
        </button>
      </form>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <div className="auth-links">
        <button type="button" className="link-button" onClick={onBack} disabled={busy}>
          Back to sign in
        </button>
      </div>
    </section>
  );
}
