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

describe("account E2E lifecycle", () => {
  it(
    "deletes the users it created when the browser cannot start",
    async () => {
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

      try {
        const result = await runScript({
          SUPABASE_URL: `http://127.0.0.1:${address.port}`,
          SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
          SUPABASE_ANON_KEY: "test-anon",
          SUPABASE_PUBLISHABLE_KEY: "",
          // The browser is deliberately unavailable. The run must still reach
          // its finally block and remove both accounts it created.
          CHROME_BIN: "/nonexistent/chromium-for-e2e-cleanup-test",
          E2E_FAILURE_SCREENSHOT: "e2e-cleanup-test-failure.png",
        });

        expect(result.code).toBe(1);
        expect(result.text).toMatch(/FAIL account flow script completed/);
        expect(result.text).toMatch(/PASS disposable users removed/);
        expect(result.text).not.toMatch(/lookup failed|=error/);
        expect(creates).toBe(2);
        expect(deleted).toHaveLength(2);
        expect(users.size).toBe(0);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    60_000,
  );
});
