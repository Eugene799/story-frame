import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/smoke-live.ts", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface FakeUser {
  id: string;
  email: string;
}

interface MockOptions {
  /** The password grant fails, so the run must clean up before doing anything else. */
  signInFails?: boolean;
  /** The admin delete fails and the account remains. */
  deleteFails?: boolean;
  /** The delete succeeds but the follow-up read cannot confirm it. */
  probeFails?: boolean;
  /** Rows the ledger still reports after the account was deleted. */
  survivingLedgerRows?: number;
}

interface MockSupabase {
  url: string;
  users: Map<string, FakeUser>;
  deleted: string[];
  ledgerChecks: string[];
  createCount: () => number;
  signInCount: () => number;
  close: () => Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function startMockSupabase(options: MockOptions = {}): Promise<MockSupabase> {
  const users = new Map<string, FakeUser>();
  const deleted: string[] = [];
  const ledgerChecks: string[] = [];
  let creates = 0;
  let signIns = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (path === "/auth/v1/admin/users" && request.method === "POST") {
      const body = JSON.parse(await readBody(request)) as { email: string };
      creates += 1;
      const user: FakeUser = { id: `user-${creates}`, email: body.email };
      users.set(user.id, user);
      send(response, 200, { id: user.id, email: user.email, email_confirmed_at: new Date().toISOString() });
      return;
    }

    if (path === "/auth/v1/token" && request.method === "POST") {
      signIns += 1;
      if (options.signInFails) {
        send(response, 500, { error: "server_error", error_description: "sign-in unavailable" });
        return;
      }
      send(response, 200, { access_token: "test-session-token", token_type: "bearer" });
      return;
    }

    if (request.method === "DELETE" && path.startsWith("/auth/v1/admin/users/")) {
      const id = path.split("/").pop() ?? "";
      deleted.push(id);
      if (options.deleteFails) {
        send(response, 500, { msg: "delete unavailable" });
        return;
      }
      users.delete(id);
      send(response, 200, {});
      return;
    }

    if (request.method === "GET" && path.startsWith("/auth/v1/admin/users/")) {
      if (options.probeFails) {
        // The delete may have happened, but the run cannot prove it.
        send(response, 500, { msg: "user probe unavailable" });
        return;
      }
      const id = path.split("/").pop() ?? "";
      const user = users.get(id);
      send(response, user ? 200 : 404, user ?? { msg: "not found" });
      return;
    }

    if (path === "/rest/v1/ai_usage" && request.method === "GET") {
      // `smoke:live` reads the ledger with limit=0 before spending anything.
      // The mock reports it unready so the run stops before any provider call
      // and still exercises the cleanup path in its finally block.
      if (url.searchParams.get("limit") === "0") {
        send(response, 500, { message: "ai_usage is not migrated" });
        return;
      }
      const owner = (url.searchParams.get("user_id") ?? "").replace(/^eq\./, "");
      ledgerChecks.push(owner);
      const remaining = options.survivingLedgerRows ?? 0;
      send(
        response,
        200,
        Array.from({ length: remaining }, (_, index) => ({ id: `usage-${index}` })),
      );
      return;
    }

    if (path === "/rest/v1/model_health" && request.method === "GET") {
      send(response, 200, []);
      return;
    }

    send(response, 404, { msg: `unexpected ${request.method} ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    users,
    deleted,
    ledgerChecks,
    createCount: () => creates,
    signInCount: () => signIns,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function runScript(env: NodeJS.ProcessEnv): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
    });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`live smoke did not finish within 30s:\n${text}`));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, text });
    });
  });
}

function scriptEnv(mock: MockSupabase): NodeJS.ProcessEnv {
  return {
    SUPABASE_URL: mock.url,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    SUPABASE_PUBLISHABLE_KEY: "test-publishable",
    OLLAMA_API_KEY: "TEST_ONLY_FAKE_OLLAMA_KEY",
    SUPABASE_ANON_KEY: "test-anon",
    // Disable every sweep: the mock only implements the auth and ledger routes
    // this lifecycle needs, so a timer must not send unrelated requests.
    MEDIA_SWEEP_INTERVAL_MS: "0",
    IMAGE_PENDING_SWEEP_INTERVAL_MS: "0",
    VIDEO_SWEEP_INTERVAL_MS: "0",
    LIPSYNC_SWEEP_INTERVAL_MS: "0",
  };
}

describe("live smoke disposable-user lifecycle", () => {
  it(
    "creates, signs in, and deletes the user, leaving no ledger rows",
    async () => {
      const mock = await startMockSupabase();
      try {
        const result = await runScript(scriptEnv(mock));

        expect(result.code).toBe(1);
        expect(result.text).toMatch(/Disposable Supabase user .* created for this run\./);
        expect(result.text).toMatch(/Supabase auth: configured \| ledger: NOT READY/);
        expect(result.text).toMatch(/Cleanup: .* delete 200, probe 404, ai_usage rows left 0/);
        expect(result.text).not.toMatch(/FAIL cleanup/);
        // The run stopped at the ledger readiness gate, before spending credit.
        expect(result.text).not.toMatch(/enabled families verified/);

        expect(mock.createCount()).toBe(1);
        expect(mock.signInCount()).toBe(1);
        expect(mock.deleted).toHaveLength(1);
        expect(mock.ledgerChecks).toEqual(mock.deleted);
        expect(mock.users.size).toBe(0);
      } finally {
        await mock.close();
      }
    },
    60_000,
  );

  it(
    "still deletes the account when sign-in fails",
    async () => {
      const mock = await startMockSupabase({ signInFails: true });
      try {
        const result = await runScript(scriptEnv(mock));

        expect(result.code).toBe(1);
        expect(result.text).toMatch(/Live smoke failed: could not sign in the disposable Supabase user \(HTTP 500\)/);
        expect(result.text).toMatch(/Cleanup: .* delete 200, probe 404, ai_usage rows left 0/);
        expect(result.text).not.toMatch(/FAIL cleanup/);

        expect(mock.createCount()).toBe(1);
        expect(mock.signInCount()).toBe(1);
        expect(mock.deleted).toHaveLength(1);
        expect(mock.users.size).toBe(0);
      } finally {
        await mock.close();
      }
    },
    60_000,
  );

  it(
    "fails the run when the account survives deletion",
    async () => {
      const mock = await startMockSupabase({ deleteFails: true });
      try {
        const result = await runScript(scriptEnv(mock));

        expect(result.code).toBe(1);
        expect(result.text).toMatch(/Cleanup: .* delete 500, probe 200, ai_usage rows left 0/);
        expect(result.text).toMatch(/FAIL cleanup: the disposable user or its ledger rows may remain\./);

        expect(mock.deleted).toHaveLength(1);
        expect(mock.users.size).toBe(1);
      } finally {
        await mock.close();
      }
    },
    60_000,
  );

  it(
    "fails the run when ledger rows survive the account deletion",
    async () => {
      const mock = await startMockSupabase({ survivingLedgerRows: 2 });
      try {
        const result = await runScript(scriptEnv(mock));

        expect(result.code).toBe(1);
        expect(result.text).toMatch(/Cleanup: .* delete 200, probe 404, ai_usage rows left 2/);
        expect(result.text).toMatch(/FAIL cleanup: the disposable user or its ledger rows may remain\./);

        expect(mock.deleted).toHaveLength(1);
        expect(mock.users.size).toBe(0);
      } finally {
        await mock.close();
      }
    },
    60_000,
  );

  it(
    "fails the run when the deletion probe is unavailable",
    async () => {
      const mock = await startMockSupabase({ probeFails: true });
      try {
        const result = await runScript(scriptEnv(mock));

        expect(result.code).toBe(1);
        expect(result.text).toMatch(/Cleanup: .* delete 200, probe 500, ai_usage rows left 0/);
        expect(result.text).toMatch(/FAIL cleanup: the disposable user or its ledger rows may remain\./);

        expect(mock.deleted).toHaveLength(1);
        expect(mock.users.size).toBe(0);
      } finally {
        await mock.close();
      }
    },
    60_000,
  );
});
