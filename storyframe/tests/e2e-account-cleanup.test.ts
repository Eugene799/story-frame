import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/e2e-account.mjs", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface FakeUser {
  id: string;
  email: string;
  created_at: string;
  email_confirmed_at: string | null;
}

interface MockSupabase {
  url: string;
  users: Map<string, FakeUser>;
  deleted: string[];
  createCount: () => number;
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

async function startMockSupabase({ failListing = false }: { failListing?: boolean } = {}): Promise<MockSupabase> {
  const users = new Map<string, FakeUser>();
  const deleted: string[] = [];
  let creates = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/auth/v1/settings") {
      send(response, 200, { mailer_autoconfirm: false });
      return;
    }
    if (url.pathname === "/auth/v1/admin/users" && request.method === "GET") {
      if (failListing) {
        // The cleanup lookup is the only listing this run reaches, so a 500 here
        // exercises the "could not verify deletion" path.
        send(response, 500, { msg: "user listing unavailable" });
        return;
      }
      const filter = url.searchParams.get("filter") ?? "";
      send(response, 200, {
        users: [...users.values()].filter((user) => user.email.includes(filter)),
      });
      return;
    }
    if (url.pathname === "/auth/v1/admin/users" && request.method === "POST") {
      const body = JSON.parse(await readBody(request)) as { email: string };
      creates += 1;
      const user: FakeUser = {
        id: `user-${creates}`,
        email: body.email,
        created_at: new Date().toISOString(),
        email_confirmed_at: null,
      };
      users.set(body.email, user);
      send(response, 200, user);
      return;
    }
    if (url.pathname === "/auth/v1/admin/generate_link" && request.method === "POST") {
      const body = JSON.parse(await readBody(request)) as { redirect_to?: string };
      send(response, 200, { redirect_to: body.redirect_to ?? null, action_link: "" });
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/auth/v1/admin/users/")) {
      const id = url.pathname.split("/").pop() ?? "";
      deleted.push(id);
      for (const [email, user] of users) {
        if (user.id === id) users.delete(email);
      }
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/auth/v1/admin/users/")) {
      const id = url.pathname.split("/").pop() ?? "";
      const user = [...users.values()].find((candidate) => candidate.id === id) ?? null;
      send(response, user ? 200 : 404, user ?? { msg: "not found" });
      return;
    }

    send(response, 404, { msg: `unexpected ${request.method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    users,
    deleted,
    createCount: () => creates,
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
    const child = spawn(process.execPath, [SCRIPT], {
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
      reject(new Error(`account E2E did not finish within 30s:\n${text}`));
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
    SUPABASE_ANON_KEY: "test-anon",
    SUPABASE_PUBLISHABLE_KEY: "",
    // The browser is deliberately unavailable. Every run must still reach its
    // finally block and handle the users it created.
    CHROME_BIN: "/nonexistent/chromium-for-e2e-cleanup-test",
    E2E_FAILURE_SCREENSHOT: "e2e-cleanup-test-failure.png",
  };
}

describe("account E2E lifecycle", () => {
  it(
    "deletes the users it created when the browser cannot start",
    async () => {
      const mock = await startMockSupabase();
      try {
        const result = await runScript(scriptEnv(mock));

        expect(result.code).toBe(1);
        expect(result.text).toMatch(/FAIL account flow script completed/);
        expect(result.text).toMatch(/PASS disposable users removed/);
        expect(result.text).not.toMatch(/lookup failed|=error/);
        expect(mock.createCount()).toBe(2);
        expect(mock.deleted).toHaveLength(2);
        expect(mock.users.size).toBe(0);
      } finally {
        await mock.close();
      }
    },
    60_000,
  );

  it(
    "reports a failed cleanup lookup instead of claiming the users are absent",
    async () => {
      const mock = await startMockSupabase({ failListing: true });
      try {
        const result = await runScript(scriptEnv(mock));

        expect(result.code).toBe(1);
        expect(result.text).toMatch(/FAIL account flow script completed/);
        expect(result.text).toMatch(/FAIL disposable users removed/);
        expect(result.text).toMatch(/lookup failed \(500\)/);
        expect(result.text).not.toMatch(/PASS disposable users removed/);
        expect(result.text).not.toMatch(/=absent/);
        expect(result.text).toMatch(/SUMMARY 0\/2 passed/);
        expect(mock.createCount()).toBe(2);
        expect(mock.deleted).toHaveLength(0);
        expect(mock.users.size).toBe(2);
      } finally {
        await mock.close();
      }
    },
    60_000,
  );
});
