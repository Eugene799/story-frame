import { useState, type FormEvent } from "react";

interface NewPasswordScreenProps {
  busy: boolean;
  error: string | null;
  onSubmit: (password: string) => Promise<void>;
  onCancel: () => void;
}

export function NewPasswordScreen({ busy, error, onSubmit, onCancel }: NewPasswordScreenProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const mismatch = confirmation.length > 0 && confirmation !== password;
  const canSubmit = password.length > 0 && confirmation === password && !busy;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    await onSubmit(password);
  }

  return (
    <section className="panel auth-panel" aria-labelledby="new-password-heading">
      <div className="panel-heading">
        <h2 id="new-password-heading">Choose a new password</h2>
        <span className="status status-warn">Recovery</span>
      </div>

      <p className="muted">
        This browser is signed in with the recovery link's short-lived session. Setting a password keeps the account
        usable without another email.
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <label className="field" htmlFor="new-password">
          <span className="field-label">New password</span>
          <input
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            placeholder="New password"
          />
        </label>

        <label className="field" htmlFor="new-password-confirmation">
          <span className="field-label">Confirm new password</span>
          <input
            id="new-password-confirmation"
            name="new-password-confirmation"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
            placeholder="Repeat the new password"
          />
        </label>

        {mismatch && (
          <p className="hint" role="alert">
            The two passwords do not match.
          </p>
        )}

        <button type="submit" disabled={!canSubmit} aria-busy={busy}>
          {busy ? "Saving..." : "Update password"}
        </button>
      </form>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <div className="auth-links">
        <button type="button" className="link-button" onClick={onCancel} disabled={busy}>
          Cancel recovery
        </button>
      </div>
    </section>
  );
}
