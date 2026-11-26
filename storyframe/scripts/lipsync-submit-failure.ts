/**
 * The lip-sync route answers a failed submission with the project's usual
 * `{ ok: false, error: { code, message } }` body. The live script used to print
 * only the HTTP status, which made a provider rejection (a 502 from Everypixel)
 * indistinguishable from a local validation failure. Keep the formatting here
 * so it can be tested without starting the script's server.
 */
export function formatSubmitFailure(status: number, body: unknown): string {
  const record = body !== null && typeof body === "object" ? (body as { error?: unknown; message?: unknown }) : null;
  const nested =
    record?.error !== null && typeof record?.error === "object"
      ? (record.error as { code?: unknown; message?: unknown; upstreamStatus?: unknown })
      : null;
  const code = typeof nested?.code === "string" ? nested.code : "";
  const message =
    typeof nested?.message === "string"
      ? nested.message
      : typeof record?.message === "string"
        ? record.message
        : typeof record?.error === "string"
          ? record.error
          : "";
  const upstream = typeof nested?.upstreamStatus === "number" ? `(upstream ${nested.upstreamStatus})` : "";
  return [`HTTP ${status}`, code, message, upstream].filter((part) => part.length > 0).join(" ");
}
