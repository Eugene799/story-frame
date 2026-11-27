// Browser end-to-end check for the account flows. Run with `npm run e2e:account`
// after starting the dev server; it creates and removes its own Supabase users.
// See the README section "Browser account end-to-end check".
import { randomBytes } from "node:crypto";

const baseURL = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
// The app asks Supabase to return to `window.location.origin`, which never has a
// trailing slash, so that is the value the allowlist has to contain.
const baseOrigin = new URL(baseURL).origin;
const supabaseUrl = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const results = [];
const created = [];
const stamp = Date.now().toString(36);
// Supabase rejects addresses on domains that cannot receive mail, so the default
// only exercises the failure path. Set E2E_SIGNUP_EMAIL to a throwaway inbox you
// control (the script deletes the account it creates) to run the confirmation branch.
// Set E2E_ACCOUNT_EMAIL to a second throwaway inbox so the reset-request branch
// also sends real recovery mail; both accounts are removed in the finally block.
const signupEmailOverride = process.env.E2E_SIGNUP_EMAIL?.trim() || null;
const accountEmailOverride = process.env.E2E_ACCOUNT_EMAIL?.trim() || null;
const liveSignUpEmail = signupEmailOverride ?? `sf-e2e-live-${stamp}@storyframe-e2e.dev`;
const reservedEmail = `sf-e2e-reserved-${stamp}@example.com`;
const accountEmail = accountEmailOverride ?? `sf-e2e-account-${stamp}@example.com`;
const unconfirmedEmail = `sf-e2e-unconfirmed-${stamp}@example.com`;
const initialPassword = `Sf!${randomBytes(18).toString("base64url")}`;
const newPassword = `Sf!${randomBytes(18).toString("base64url")}`;
const unconfirmedPassword = `Sf!${randomBytes(18).toString("base64url")}`;
const startedAt = new Date();

function record(name, ok, detail = "") {
  results.push({ name, ok, detail, blocked: false });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function recordBlocked(name, detail) {
  results.push({ name, ok: true, detail, blocked: true });
  console.log(`BLOCKED ${name} — ${detail}`);
}

async function admin(path, init = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function findUser(email) {
  const { status, body } = await admin(`/auth/v1/admin/users?filter=${encodeURIComponent(email)}&per_page=50`);
  // A failed lookup is not the same as "no such user": callers assert that an
  // account is absent, so an unreadable list must fail the run instead of
  // passing it.
  if (status !== 200) throw new Error(`could not list users for ${email}: status=${status}`);
  return (body?.users ?? []).find((user) => user.email === email) ?? null;
}

async function createUser(email, password, confirm) {
  const { status, body } = await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: confirm }),
  });
  if (status !== 200 || typeof body?.id !== "string") {
    throw new Error(`could not create ${email}: status=${status} ${body?.msg ?? ""}`);
  }
  created.push({ email, id: body.id });
  return body.id;
}

async function deleteUsers() {
  const report = [];
  // Include every address the run may have created even if its creation
  // response was lost, so a malformed reply cannot leave an account behind.
  const emails = [...new Set([...created.map((user) => user.email), accountEmail, unconfirmedEmail, liveSignUpEmail])];
  const operatorEmails = new Set([signupEmailOverride, accountEmailOverride].filter(Boolean));
  for (const email of emails) {
    const label = email.split("@")[0];
    try {
      // A failed lookup must not look like "absent": that would report a
      // leaked account as cleaned up.
      const listing = await admin(`/auth/v1/admin/users?filter=${encodeURIComponent(email)}&per_page=50`);
      if (listing.status !== 200) {
        report.push(`${label}=lookup failed (${listing.status})`);
        continue;
      }
      const user = (listing.body?.users ?? []).find((candidate) => candidate.email === email) ?? null;
      if (!user) {
        report.push(`${label}=absent`);
        continue;
      }
      // E2E_SIGNUP_EMAIL and E2E_ACCOUNT_EMAIL may point at inboxes the operator
      // already uses: never delete an account this run did not create.
      if (operatorEmails.has(email) && new Date(user.created_at) < startedAt) {
        report.push(`${label}=pre-existing (left alone)`);
        continue;
      }
      const { status } = await admin(`/auth/v1/admin/users/${user.id}`, { method: "DELETE" });
      const probe = await admin(`/auth/v1/admin/users/${user.id}`);
      report.push(`${label}=${status}/${probe.status}`);
    } catch (cause) {
      report.push(`${label}=error (${cause instanceof Error ? cause.message : String(cause)})`);
    }
  }
  return report.join(", ");
}

const settings = await fetch(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: anonKey } }).then((response) =>
  response.json(),
);

const consoleErrors = [];
const recoverStatuses = [];
const aiRequestUrls = [];
let browser = null;
let page = null;
let redirectAllowlisted = null;

try {
  // Everything that creates state runs inside this single try: the finally
  // below is the only cleanup path, so a missing Playwright install or a
  // browser that cannot launch still removes the accounts this run created.
  await createUser(accountEmail, initialPassword, true);
  await createUser(unconfirmedEmail, unconfirmedPassword, false);

  // Supabase rewrites `redirect_to` to the project's Site URL when the origin is
  // not allowlisted, so an emailed recovery link would never reach this app. Ask
  // first, so a hosted run says why instead of looking like a broken flow.
  async function preflightRedirect(origin) {
    // Use an account that is not the reset target: generate_link starts the same
    // per-address cooldown as a real /recover request, which would make the next
    // reset-request check fail with "only request this after 59 seconds".
    const { status, body } = await admin("/auth/v1/admin/generate_link", {
      method: "POST",
      body: JSON.stringify({ type: "recovery", email: unconfirmedEmail, redirect_to: origin }),
    });
    if (status !== 200) {
      console.log(`PREFLIGHT WARN generate_link failed with status=${status}; redirect target unknown`);
      return false;
    }
    const effective = typeof body?.redirect_to === "string" ? body.redirect_to : "(none)";
    if (effective === origin) {
      console.log(`PREFLIGHT redirect target ${effective} (allowlisted)`);
      return true;
    }
    console.log(`PREFLIGHT WARN redirect target ${effective} -- Supabase rewrote ${origin}`);
    console.log(
      `PREFLIGHT WARN recovery and confirmation emails for this origin would land on ${effective}. ` +
        `Allowlist ${origin} under Authentication -> URL Configuration -> Redirect URLs. ` +
        "This run still exercises the app by opening the session fragment directly.",
    );
    return false;
  }

  redirectAllowlisted = await preflightRedirect(baseOrigin);

  // Imported after the users exist so an unavailable browser reaches the same
  // cleanup instead of leaving them behind.
  const { chromium } = await import("playwright");
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.url().includes("/auth/v1/recover")) recoverStatuses.push(response.status());
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/ai/test")) aiRequestUrls.push(request.url());
  });

  async function signOutIfPossible() {
    const button = page.getByRole("button", { name: "Sign out" });
    if ((await button.count()) > 0) {
      await button.click();
      await page.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 20000 });
    }
  }

  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 20000 });
  record(
    "sign-in screen offers account creation and password reset",
    (await page.getByRole("button", { name: "Create an account" }).count()) === 1 &&
      (await page.getByRole("button", { name: "Forgot your password?" }).count()) === 1,
    "both links present",
  );

  // 1. Sign-up on a domain Supabase accepts. Email delivery is the project's job,
  //    so this either shows the confirmation notice or reports the send quota.
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByRole("heading", { name: "Create account" }).waitFor({ timeout: 10000 });
  await page.getByLabel("Email").fill(liveSignUpEmail);
  await page.getByLabel("Password").fill(initialPassword);
  await page.getByRole("button", { name: "Create account" }).click();

  // Plain text, not a RegExp: real inboxes use plus-addresses, and `+` is a
  // quantifier that would stop the pattern from matching the rendered address.
  const notice = page.getByText(`Check ${liveSignUpEmail} for a confirmation link`);
  const alert = page.getByRole("alert");
  await Promise.race([
    notice.waitFor({ timeout: 20000 }).catch(() => {}),
    alert.waitFor({ timeout: 20000 }).catch(() => {}),
  ]);

  if ((await notice.count()) > 0) {
    const liveUser = await findUser(liveSignUpEmail);
    record(
      "sign-up asks for the confirmation email instead of signing in",
      settings.mailer_autoconfirm === false &&
        (await page.getByRole("heading", { name: "Sign in" }).count()) === 1 &&
        Boolean(liveUser) &&
        !liveUser.email_confirmed_at,
      `account created unconfirmed (mailer_autoconfirm=${settings.mailer_autoconfirm})`,
    );
    await signOutIfPossible();
  } else {
    const alertText = (await alert.count()) > 0 ? (await alert.innerText()).trim() : "no notice and no alert";
    if (/rate limit|only request this after/i.test(alertText)) {
      recordBlocked(
        "sign-up confirmation branch",
        `Supabase refused to send the confirmation email: ${alertText}`,
      );
    } else if (/invalid/i.test(alertText) && !process.env.E2E_SIGNUP_EMAIL) {
      recordBlocked(
        "sign-up confirmation branch",
        `Supabase rejected the synthetic address (${alertText}); set E2E_SIGNUP_EMAIL to a throwaway inbox to run it`,
      );
    } else {
      record("sign-up asks for the confirmation email instead of signing in", false, alertText);
    }
    await page.getByRole("button", { name: "Back to sign in" }).click();
    await page.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 10000 });
  }

  // 2. A reserved address is rejected by Supabase; the app must surface it.
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByRole("heading", { name: "Create account" }).waitFor({ timeout: 10000 });
  await page.getByLabel("Email").fill(reservedEmail);
  await page.getByLabel("Password").fill(initialPassword);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("alert").waitFor({ timeout: 20000 });
  const reservedAlert = (await page.getByRole("alert").innerText()).trim();
  if (/rate limit/i.test(reservedAlert)) {
    // The mail quota is checked before address validation, so this proves nothing
    // about the invalid-address path beyond the app surfacing Supabase's message.
    recordBlocked("rejected sign-up error path", `Supabase rate-limited before validating: ${reservedAlert}`);
  } else {
    record(
      "a rejected sign-up shows Supabase's reason",
      /invalid/i.test(reservedAlert) && (await findUser(reservedEmail)) === null,
      reservedAlert,
    );
  }

  // 3. An unconfirmed account cannot sign in, and the form says why.
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 10000 });
  await page.getByLabel("Email").fill(unconfirmedEmail);
  await page.getByLabel("Password").fill(unconfirmedPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").waitFor({ timeout: 30000 });
  record(
    "an unconfirmed account cannot sign in",
    /confirm/i.test(await page.getByRole("alert").innerText()) &&
      (await page.getByRole("heading", { name: "Sign in" }).count()) === 1,
    (await page.getByRole("alert").innerText()).replace(/\s+/g, " ").trim(),
  );

  // 4. Password-reset request. Delivery is rate limited by the project; accept
  //    either the neutral message or an explicit quota refusal.
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await page.getByRole("heading", { name: "Reset your password" }).waitFor({ timeout: 10000 });
  await page.getByLabel("Email").fill(accountEmail);
  await page.getByRole("button", { name: "Send reset link" }).click();

  const neutral = page.getByText(/If an account exists for that address/i);
  const resetAlert = page.getByRole("alert");
  await Promise.race([
    neutral.waitFor({ timeout: 20000 }).catch(() => {}),
    resetAlert.waitFor({ timeout: 20000 }).catch(() => {}),
  ]);

  if ((await neutral.count()) > 0) {
    record(
      "reset request sends a neutral message",
      recoverStatuses.length > 0 && recoverStatuses.every((status) => status === 200),
      `POST /auth/v1/recover → ${recoverStatuses.join(",") || "no response"}`,
    );
  } else {
    const text = (await resetAlert.count()) > 0 ? (await resetAlert.innerText()).trim() : "no message";
    if (/rate limit|only request this after/i.test(text)) {
      // Supabase also applies a per-address/per-IP cooldown between sends, with
      // this wording; it says nothing about the request itself being wrong.
      recordBlocked("password-reset request", `Supabase refused to send the recovery email: ${text}`);
    } else {
      record("reset request sends a neutral message", false, text);
    }
  }

  // 5. Recovery link: minted with the admin API, so no inbox is involved.
  const linkResponse = await admin("/auth/v1/admin/generate_link", {
    method: "POST",
    body: JSON.stringify({ type: "recovery", email: accountEmail }),
  });
  const actionLink = linkResponse.body?.action_link ?? "";
  // The emailed link points at Supabase's verify endpoint, which answers with a
  // redirect to the app origin carrying the session in the fragment. Following
  // it once is what a click in the inbox does.
  const verify = actionLink ? await fetch(actionLink, { redirect: "manual" }) : null;
  const location = verify?.headers.get("location") ?? "";
  const fragment = location.includes("#") ? location.slice(location.indexOf("#") + 1) : "";
  const hasTokens = /(^|&)access_token=/.test(fragment) && /(^|&)refresh_token=/.test(fragment);

  if (!hasTokens) {
    recordBlocked(
      "recovery link flow",
      `generate_link status=${linkResponse.status}; verify redirect carried no session (${location.slice(0, 100) || "no location"})`,
    );
  } else {
    record("recovery link returns a session fragment", true, "access_token + refresh_token present");

    await page.goto(`${baseURL}/?recovery=1#${fragment}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Choose a new password" }).waitFor({ timeout: 30000 });
    record(
      "a recovery link opens the new-password screen, not the workspace",
      (await page.locator(".session-bar").count()) === 0,
      "workspace hidden while recovering",
    );

    const newPasswordField = page.getByRole("textbox", { name: "New password", exact: true });
    const confirmField = page.getByRole("textbox", { name: "Confirm new password", exact: true });
    await newPasswordField.fill(newPassword);
    await confirmField.fill(`${newPassword}-typo`);
    await page.getByText(/do not match/i).waitFor({ timeout: 5000 });
    record(
      "a mismatched confirmation blocks the update",
      await page.getByRole("button", { name: "Update password" }).isDisabled(),
      "submit disabled",
    );

    await confirmField.fill(newPassword);
    await page.getByRole("button", { name: "Update password" }).click();
    await page.locator(".session-bar").waitFor({ timeout: 30000 });
    record(
      "the new password is saved with the recovery session",
      (await page.getByText("Password updated.").count()) === 1,
      "Password updated.",
    );

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 20000 });
    await page.getByLabel("Email").fill(accountEmail);
    await page.getByLabel("Password").fill(initialPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("alert").waitFor({ timeout: 30000 });
    record(
      "the old password no longer signs in",
      /invalid login credentials/i.test(await page.getByRole("alert").innerText()),
      "rejected by Supabase",
    );

    await page.getByLabel("Password").fill(newPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Signed in as").waitFor({ timeout: 30000 });
    record(
      "the new password signs in",
      (await page.locator(".session-bar").innerText()).includes(accountEmail),
      "Signed in as sf-e2e-account-…",
    );

    // The Phase 1-2 configuration view lives in a collapsed <details> below the
    // workspace now, so open it before using the billable test button.
    await page.locator("details.dev-harness summary").click();

    // 6. Expired session: drop storage, then a request must send the user back.
    await page.waitForFunction(
      () => {
        const button = [...document.querySelectorAll("button")].find((candidate) =>
          /Send test request/i.test(candidate.textContent ?? ""),
        );
        return Boolean(button) && !button.disabled;
      },
      undefined,
      { timeout: 20000 },
    );
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("sb-")) localStorage.removeItem(key);
      }
    });
    await page.getByRole("button", { name: /Send test request/i }).click();
    await page.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 20000 });
    record(
      "an expired session returns to the sign-in form with an explanation",
      /session expired/i.test(await page.getByRole("alert").innerText()) &&
        (await page.locator(".session-bar").count()) === 0,
      "workspace closed, message shown",
    );
    record(
      "no billable request is sent once the session is gone",
      aiRequestUrls.length === 0,
      `${aiRequestUrls.length} /api/ai/test requests`,
    );
  }

  const unexpectedErrors = consoleErrors.filter((entry) => !/status of (400|401|429)/.test(entry));
  record(
    "no unexpected browser console errors",
    unexpectedErrors.length === 0,
    unexpectedErrors.join(" | ") || `only the ${consoleErrors.length} expected 400/401/429 responses`,
  );
} catch (error) {
  record("account flow script completed", false, error instanceof Error ? error.message : String(error));
  if (page) {
    await page
      .screenshot({ path: process.env.E2E_FAILURE_SCREENSHOT ?? "e2e-account-failure.png", fullPage: true })
      .catch(() => {});
  }
} finally {
  // A browser that never launched has nothing to close, and a close failure
  // must not skip the user cleanup below.
  if (browser) await browser.close().catch(() => {});

  let cleanup;
  try {
    cleanup = await deleteUsers();
  } catch (cause) {
    cleanup = `cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  const cleanupOk = cleanup.split(", ").every((entry) => {
    const value = entry.split("=")[1] ?? "";
    return value === "absent" || value === "pre-existing (left alone)" || /^(200|204)\/404$/.test(value);
  });
  record("disposable users removed", cleanupOk, cleanup);
}

const failed = results.filter((result) => !result.ok);
const blocked = results.filter((result) => result.blocked);
const passed = results.length - failed.length - blocked.length;
const warnings = redirectAllowlisted === false ? 1 : 0;
console.log(
  `\nSUMMARY ${passed}/${results.length - blocked.length} passed, ${blocked.length} blocked` +
    (warnings ? ", 1 warning (base origin is not allowlisted for redirects)" : ""),
);
process.exit(failed.length === 0 ? 0 : 1);
