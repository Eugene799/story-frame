import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { AiErrorResponse, AiStatusResponse, AiTestSuccess, AiUsageListResponse } from "../shared/ai-contract";
import { createStoryframeServer } from "../server/app";

/**
 * Opt-in live smoke check. Makes five real, billable Ollama Cloud requests,
 * verifies the usage ledger, then repeats one request with its original
 * idempotency key to confirm the replay is free and unchanged. Not part of
 * `npm test`. No retries. Never prints the provider key or the session token.
 *
 * It creates a confirmed disposable Supabase user, signs in as that user, and
 * deletes it — and, through the ai_usage foreign key, its ledger rows — when
 * the run ends. No pre-existing session token is used.
 */
const PROMPT = "Write one short welcome sentence for StoryFrame.";
const ENABLED_FAMILIES = ["deepseek", "gemma", "glm", "gpt-oss", "minimax"] as const;

try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // .env is optional when the variables already exist in the environment.
}

const supabaseUrl = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
const publishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "").trim();

if (!process.env.OLLAMA_API_KEY?.trim()) {
  console.error("OLLAMA_API_KEY is not configured.");
  console.error("Set it in the server environment or storyframe/.env, then rerun `npm run smoke:live`.");
  process.exit(1);
}

if (!supabaseUrl || !serviceRoleKey || !publishableKey) {
  console.error(
    "smoke:live needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) to create and delete its disposable user.",
  );
  process.exit(1);
}

interface DisposableUser {
  id: string;
  email: string;
}

function adminHeaders(): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function createDisposableUser(): Promise<{ user: DisposableUser; password: string }> {
  const email = `smoke-live-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `S${randomUUID()}a1!`;
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = (await response.json().catch(() => null)) as { id?: string } | null;
  const id = body?.id;
  if (!response.ok || typeof id !== "string") {
    throw new Error(`could not create a disposable Supabase user (HTTP ${response.status})`);
  }
  return { user: { id, email }, password };
}

async function signInDisposableUser(email: string, password: string): Promise<string> {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await response.json().catch(() => null)) as { access_token?: string } | null;
  const token = body?.access_token;
  if (!response.ok || typeof token !== "string" || token.length === 0) {
    throw new Error(`could not sign in the disposable Supabase user (HTTP ${response.status})`);
  }
  return token;
}

/** Deletes the account and proves the account and its ledger rows are gone. */
async function removeDisposableUser(user: DisposableUser): Promise<boolean> {
  const headers = adminHeaders();
  const deletion = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers });
  const probe = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, { headers });
  // ai_usage.user_id references auth.users with on delete cascade, so deleting
  // the account must leave no ledger rows behind.
  const ledger = await fetch(`${supabaseUrl}/rest/v1/ai_usage?user_id=eq.${user.id}&select=id`, { headers });
  const remaining: unknown = ledger.ok ? await ledger.json().catch(() => null) : null;
  const remainingRows = Array.isArray(remaining) ? remaining.length : null;
  const cleaned = deletion.ok && probe.status === 404 && remainingRows === 0;
  console.log(
    `\nCleanup: ${user.email} delete ${deletion.status}, probe ${probe.status}, ai_usage rows left ${
      remainingRows ?? "unreadable"
    }`,
  );
  if (!cleaned) {
    console.error("FAIL cleanup: the disposable user or its ledger rows may remain.");
  }
  return cleaned;
}

async function main(): Promise<number> {
  let disposable: DisposableUser | null = null;
  let server: ReturnType<typeof createStoryframeServer> | null = null;
  let exitCode = 1;

  try {
    const created = await createDisposableUser();
    disposable = created.user;
    console.log(`Disposable Supabase user ${disposable.email} created for this run.`);
    const sessionToken = await signInDisposableUser(created.user.email, created.password);

    const instance = createStoryframeServer();
    server = instance;

    await new Promise<void>((resolve, reject) => {
      instance.once("error", reject);
      instance.listen(0, "127.0.0.1", resolve);
    });

    const baseUrl = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
    const failures: string[] = [];
    const runId = randomUUID();
    let replayAttempt: { family: string; key: string; body: unknown } | null = null;

    async function readUsage(): Promise<AiUsageListResponse | null> {
      const response = await fetch(`${baseUrl}/api/ai/usage`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) return null;
      return (await response.json()) as AiUsageListResponse;
    }

    const status = (await (await fetch(`${baseUrl}/api/ai/status`)).json()) as AiStatusResponse;
    console.log(`StoryFrame live smoke | catalog ${status.catalog.source} checked ${status.catalog.checkedOn}`);
    console.log(
      `Supabase auth: ${status.auth.configured ? "configured" : "MISSING"} | ledger: ${status.ledger.ready ? "ready" : "NOT READY"}`,
    );
    if (!status.auth.configured || !status.ledger.ready) {
      console.error("Supabase auth and a migrated usage ledger are required before running the smoke check.");
      return 1;
    }

    for (const model of status.models.filter((candidate) => !candidate.available)) {
      console.log(`${model.label}: disabled - ${model.reason ?? "no direct-request identifier"}`);
    }

    for (const family of ENABLED_FAMILIES) {
      const model = status.models.find((candidate) => candidate.id === family);
      if (!model?.available) {
        failures.push(family);
        console.error(`FAIL ${family}: not configured and available.`);
        continue;
      }

      const idempotencyKey = `smoke-${family}-${runId}`;
      const response = await fetch(`${baseUrl}/api/ai/test`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ model: family, prompt: PROMPT }),
        signal: AbortSignal.timeout(60_000),
      });
      const payload = (await response.json()) as AiTestSuccess | AiErrorResponse;

      if (!response.ok || !payload.ok) {
        failures.push(family);
        const error = payload.ok ? null : payload.error;
        console.error(
          `FAIL ${model.label} (${family}): ${error?.code ?? `HTTP ${response.status}`} - ${error?.message ?? "unknown error"}`,
        );
        continue;
      }

      console.log(`\n${model.label} (${family})`);
      console.log(`  configured: ${payload.configuredModel}`);
      console.log(`  returned:   ${payload.returnedModel ?? "not supplied"}`);
      console.log(`  latency:    ${payload.latencyMs} ms`);
      console.log(
        `  usage:      ${payload.usage.promptEvalCount ?? "n/a"} prompt / ${payload.usage.evalCount ?? "n/a"} output`,
      );
      console.log(`  reply:      ${payload.reply}`);
      if (!replayAttempt) replayAttempt = { family, key: idempotencyKey, body: payload };
    }

    const beforeReplay = await readUsage();

    // Replay one request with its original key. A replay must return the same
    // stored values and add no ledger row, proving no second provider call was
    // billed. JSONB returns the same keys in a different order.
    if (replayAttempt) {
      const { family, key, body: storedBody } = replayAttempt;
      const replayResponse = await fetch(`${baseUrl}/api/ai/test`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ model: family, prompt: PROMPT }),
        signal: AbortSignal.timeout(60_000),
      });
      const replayBody: unknown = await replayResponse.json();
      // JSONB does not preserve key order, so compare values rather than serializations.
      const identical = isDeepStrictEqual(replayBody, storedBody);
      console.log(
        `\nIdempotent replay (${family}): ${identical ? "identical stored response" : "MISMATCH"}`,
      );
      if (!identical) {
        failures.push("idempotency-replay");
        console.error("FAIL idempotent replay: the stored response was not returned unchanged.");
      }
    }

    const usage = await readUsage();
    const rows = usage?.usage ?? [];
    const latest = rows[0];
    console.log(
      `\nUsage ledger: ${rows.length} recent rows; latest ${latest?.configuredModel ?? "none"} (${latest?.status ?? "n/a"})`,
    );
    if (!usage || !latest) {
      failures.push("usage-ledger");
      console.error("FAIL usage ledger: no rows were returned after the smoke calls.");
    }
    if (replayAttempt && beforeReplay && usage && usage.usage.length !== beforeReplay.usage.length) {
      failures.push("idempotency-replay");
      console.error(
        `FAIL idempotent replay: the ledger went from ${beforeReplay.usage.length} to ${usage.usage.length} rows.`,
      );
    }

    const verified = ENABLED_FAMILIES.filter((family) => !failures.includes(family)).length;
    console.log(`\n${verified}/${ENABLED_FAMILIES.length} enabled families verified.`);
    exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    if (disposable) {
      const cleaned = await removeDisposableUser(disposable);
      if (!cleaned) exitCode = 1;
    }
  }

  return exitCode;
}

try {
  process.exitCode = await main();
} catch (error: unknown) {
  console.error(`Live smoke failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
