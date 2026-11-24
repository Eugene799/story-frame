// Browser end-to-end check for the account flows. Run with `npm run e2e:account`
// after starting the dev server; it creates and removes its own Supabase users.
// See the README section "Browser account end-to-end check".
import { chromium } from "playwright";
import { randomBytes } from "node:crypto";

const baseURL = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
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
const liveSignUpEmail = process.env.E2E_SIGNUP_EMAIL ?? `sf-e2e-live-${stamp}@storyframe-e2e.dev`;
const reservedEmail = `sf-e2e-reserved-${stamp}@example.com`;
const accountEmail = `sf-e2e-account-${stamp}@example.com`;
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
  if (status !== 200) return null;
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
  const emails = [...created.map((user) => user.email), liveSignUpEmail];
  for (const email of emails) {
    const user = await findUser(email);
    if (!user) {
      report.push(`${email.split("@")[0]}=absent`);
      continue;
    }
    // E2E_SIGNUP_EMAIL may point at an inbox the operator already uses: never
    // delete an account this run did not create.
    if (email === liveSignUpEmail && new Date(user.created_at) < startedAt) {
      report.push(`${email.split("@")[0]}=pre-existing (left alone)`);
      continue;
    }
    const { status } = await admin(`/auth/v1/admin/users/${user.id}`, { method: "DELETE" });
    const probe = await admin(`/auth/v1/admin/users/${user.id}`);
    report.push(`${email.split("@")[0]}=${status}/${probe.status}`);
  }
  return report.join(", ");
}

const settings = await fetch(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: anonKey } }).then((response) =>
  response.json(),
);

await createUser(accountEmail, initialPassword, true);
await createUser(unconfirmedEmail, unconfirmedPassword, false);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
const recoverStatuses = [];
const aiRequestUrls = [];

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

try {
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

  const notice = page.getByText(new RegExp(`Check ${liveSignUpEmail} for a confirmation link`));
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
    if (/rate limit/i.test(alertText)) {
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
    if (/rate limit/i.test(text)) {
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
      (await page.getByRole("heading", { name: "Server configuration" }).count()) === 0,
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
    await page.getByRole("heading", { name: "Server configuration" }).waitFor({ timeout: 30000 });
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
        (await page.getByRole("heading", { name: "Server configuration" }).count()) === 0,
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
  await page.screenshot({ path: process.env.E2E_FAILURE_SCREENSHOT ?? "e2e-account-failure.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  const cleanup = await deleteUsers();
  const cleanupOk = cleanup.split(", ").every((entry) => {
    const value = entry.split("=")[1] ?? "";
    return value === "absent" || value === "pre-existing (left alone)" || /^(200|204)\/404$/.test(value);
  });
  record("disposable users removed", cleanupOk, cleanup);
}

const failed = results.filter((result) => !result.ok);
const blocked = results.filter((result) => result.blocked);
const passed = results.length - failed.length - blocked.length;
console.log(`\nSUMMARY ${passed}/${results.length - blocked.length} passed, ${blocked.length} blocked`);
process.exit(failed.length === 0 ? 0 : 1);
