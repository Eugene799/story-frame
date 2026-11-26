import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../server/api-error";
import { createSupabaseJobLease, withLeaseRenewal } from "../server/job-lease";

const SERVICE_ROLE_KEY = "test-service-role-key";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  apikey: unknown;
  authorization: unknown;
  body: unknown;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** A minimal PostgREST stand-in: the RPC returns whatever the test decides. */
async function startLeaseServer(answer: (recorded: Recorded) => { status: number; body: unknown }) {
  const requests: Recorded[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const recorded: Recorded = {
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      apikey: request.headers.apikey,
      authorization: request.headers.authorization,
      body: await readBody(request),
    };
    requests.push(recorded);
    const result = answer(recorded);
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(result.body === undefined ? "" : JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The claim, renew, and release rules of `job_leases`, without a database. */
function leaseTable() {
  let held: { holder: string; expiresAt: number } | null = null;
  return {
    answer(recorded: Recorded): { status: number; body: unknown } {
      const body = (recorded.body ?? {}) as { p_holder?: string; p_ttl_seconds?: number };
      const now = Date.now();
      if (recorded.path === "/rest/v1/rpc/claim_job_lease") {
        if (held && held.expiresAt > now) return { status: 200, body: false };
        held = { holder: String(body.p_holder), expiresAt: now + Number(body.p_ttl_seconds) * 1000 };
        return { status: 200, body: true };
      }
      if (recorded.path === "/rest/v1/rpc/renew_job_lease") {
        if (!held || held.holder !== body.p_holder) return { status: 200, body: false };
        held.expiresAt = now + Number(body.p_ttl_seconds) * 1000;
        return { status: 200, body: true };
      }
      if (recorded.method === "DELETE") {
        const holder = recorded.query.get("holder")?.replace(/^eq\./, "");
        if (held && held.holder === holder) held = null;
        return { status: 204, body: undefined };
      }
      return { status: 404, body: null };
    },
  };
}

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (close) await close();
  close = null;
});

describe("stored job lease", () => {
  it("claims with the service role and reports the stored answer", async () => {
    const fake = await startLeaseServer(() => ({ status: 200, body: true }));
    close = fake.close;
    const lease = createSupabaseJobLease({
      url: fake.url,
      serviceRoleKey: SERVICE_ROLE_KEY,
      timeoutMs: 1000,
      name: "video-sweep",
      ttlMs: 90_000,
      holder: "11111111-1111-4111-8111-111111111111",
    });

    expect(await lease.claim()).toBe(true);
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/rest/v1/rpc/claim_job_lease");
    expect(request.apikey).toBe(SERVICE_ROLE_KEY);
    expect(request.authorization).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
    expect(request.body).toEqual({
      p_name: "video-sweep",
      p_holder: "11111111-1111-4111-8111-111111111111",
      // Milliseconds are rounded up, so a sub-second TTL still leases a second.
      p_ttl_seconds: 90,
    });
  });

  it("reports a refused claim as false, not as an error", async () => {
    const fake = await startLeaseServer(() => ({ status: 200, body: false }));
    close = fake.close;
    const lease = createSupabaseJobLease({
      url: fake.url,
      serviceRoleKey: SERVICE_ROLE_KEY,
      timeoutMs: 1000,
      name: "video-sweep",
      ttlMs: 1500,
    });

    expect(await lease.claim()).toBe(false);
    expect(fake.requests[0]?.body).toMatchObject({ p_ttl_seconds: 2 });
  });

  it("renews the same holder's lease", async () => {
    const fake = await startLeaseServer(() => ({ status: 200, body: true }));
    close = fake.close;
    const lease = createSupabaseJobLease({
      url: fake.url,
      serviceRoleKey: SERVICE_ROLE_KEY,
      timeoutMs: 1000,
      name: "lipsync-sweep",
      ttlMs: 30_000,
      holder: "22222222-2222-4222-8222-222222222222",
    });

    expect(await lease.renew()).toBe(true);
    expect(fake.requests[0]?.path).toBe("/rest/v1/rpc/renew_job_lease");
    expect(fake.requests[0]?.body).toMatchObject({
      p_name: "lipsync-sweep",
      p_holder: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("keeps a row claim alive past its TTL so a second instance cannot take it mid-advance", async () => {
    const table = leaseTable();
    const fake = await startLeaseServer(table.answer);
    close = fake.close;

    // A 3 s TTL renews every second: the advance below runs past the expiry the
    // claim was taken with, so only the renewal keeps the row.
    const row = { url: fake.url, serviceRoleKey: SERVICE_ROLE_KEY, timeoutMs: 1000, name: "lipsync-row:row-1", ttlMs: 3_000 };
    const first = createSupabaseJobLease({ ...row, holder: "11111111-1111-4111-8111-111111111111" });
    const second = createSupabaseJobLease({ ...row, holder: "22222222-2222-4222-8222-222222222222" });

    expect(await first.claim()).toBe(true);
    const advanced = await withLeaseRenewal(first, async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_600));
      // Past the expiry the claim was taken with: a lease nobody renews would be
      // free by now, and this claim is what a second pass would make.
      expect(await second.claim()).toBe(false);
      return "advanced";
    });

    expect(advanced).toBe("advanced");
    expect(fake.requests.some((request) => request.path.endsWith("/renew_job_lease"))).toBe(true);
    // Released when the advance ended, so the next pass takes the row at once.
    expect(await second.claim()).toBe(true);
  });

  it("releases a row claim when the advance throws", async () => {
    const table = leaseTable();
    const fake = await startLeaseServer(table.answer);
    close = fake.close;

    const row = { url: fake.url, serviceRoleKey: SERVICE_ROLE_KEY, timeoutMs: 1000, name: "video-row:row-1", ttlMs: 90_000 };
    const first = createSupabaseJobLease({ ...row, holder: "11111111-1111-4111-8111-111111111111" });
    const second = createSupabaseJobLease({ ...row, holder: "22222222-2222-4222-8222-222222222222" });

    expect(await first.claim()).toBe(true);
    await expect(
      withLeaseRenewal(first, async () => {
        throw new Error("copy failed");
      }),
    ).rejects.toThrow("copy failed");
    expect(await second.claim()).toBe(true);
  });

  it("aborts an advance past its deadline and frees the row for the next pass", async () => {
    const table = leaseTable();
    const fake = await startLeaseServer(table.answer);
    close = fake.close;

    const row = { url: fake.url, serviceRoleKey: SERVICE_ROLE_KEY, timeoutMs: 1000, name: "lipsync-row:row-1", ttlMs: 90_000 };
    const first = createSupabaseJobLease({ ...row, holder: "11111111-1111-4111-8111-111111111111" });
    const second = createSupabaseJobLease({ ...row, holder: "22222222-2222-4222-8222-222222222222" });

    expect(await first.claim()).toBe(true);
    let aborted = false;
    // An advance that would never finish on its own: only the deadline stops it.
    const advance = withLeaseRenewal(
      first,
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          });
        }),
      40,
    );

    await expect(advance).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toBe(true);
    // Released at the deadline, so the next pass takes the row at once instead
    // of waiting for a process that may never exit.
    expect(await second.claim()).toBe(true);
  });

  it("releases only its own row, so a stale holder cannot delete the new owner's lease", async () => {
    const fake = await startLeaseServer(() => ({ status: 204, body: undefined }));
    close = fake.close;
    const lease = createSupabaseJobLease({
      url: fake.url,
      serviceRoleKey: SERVICE_ROLE_KEY,
      timeoutMs: 1000,
      name: "media-sweep",
      ttlMs: 90_000,
      holder: "33333333-3333-4333-8333-333333333333",
    });

    await lease.release();
    const [request] = fake.requests;
    expect(request.method).toBe("DELETE");
    expect(request.path).toBe("/rest/v1/job_leases");
    expect(request.query.get("name")).toBe("eq.media-sweep");
    expect(request.query.get("holder")).toBe("eq.33333333-3333-4333-8333-333333333333");
  });

  it("reports a rejected claim as an unavailable store without echoing the key", async () => {
    const fake = await startLeaseServer(() => ({
      status: 500,
      body: { message: `boom ${SERVICE_ROLE_KEY}` },
    }));
    close = fake.close;
    const lease = createSupabaseJobLease({
      url: fake.url,
      serviceRoleKey: SERVICE_ROLE_KEY,
      timeoutMs: 1000,
      name: "image-sweep",
      ttlMs: 90_000,
    });

    const error = await lease.claim().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).code).toBe("JOB_LEASE_UNAVAILABLE");
    expect((error as ApiError).message).toContain("HTTP 500");
    expect((error as ApiError).message).not.toContain(SERVICE_ROLE_KEY);
  });

  it("reports an unreachable lease store as unavailable", async () => {
    const fake = await startLeaseServer(() => ({ status: 200, body: true }));
    const url = fake.url;
    await fake.close();

    const lease = createSupabaseJobLease({
      url,
      serviceRoleKey: SERVICE_ROLE_KEY,
      timeoutMs: 500,
      name: "image-sweep",
      ttlMs: 90_000,
    });
    const error = await lease.claim().catch((thrown: unknown) => thrown);
    expect((error as ApiError).code).toBe("JOB_LEASE_UNAVAILABLE");
  });
});
