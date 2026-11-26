import { useState, type FormEvent } from "react";

interface PasswordResetScreenProps {
  busy: boolean;
  error: string | null;
  notice?: string | null;
  onSubmit: (email: string) => Promise<void>;
  onBack: () => void;
}

export function PasswordResetScreen({ busy, error, notice = null, onSubmit, onBack }: PasswordResetScreenProps) {
  const [email, setEmail] = useState("");
  const canSubmit = email.trim().length > 0 && !busy;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    await onSubmit(email);
  }

  return (
    <section className="panel auth-panel" aria-labelledby="reset-heading">
      <div className="panel-heading">
        <h2 id="reset-heading">Reset your password</h2>
        <span className="status status-dev">Supabase Auth</span>
      </div>

      <p className="muted">
        Supabase emails a recovery link. Open it in this browser: the link returns here with a short-lived session, and
        the next screen asks for the new password.
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <label className="field" htmlFor="reset-email">
          <span className="field-label">Email</span>
          <input
            id="reset-email"
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

        <button type="submit" disabled={!canSubmit} aria-busy={busy}>
          {busy ? "Sending..." : "Send reset link"}
        </button>
      </form>

      {notice && (
        <div className="callout" role="status">
          {notice}
        </div>
      )}

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
