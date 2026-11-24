import { createHash } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  AiErrorResponse,
  AiStatusResponse,
  AiTestSuccess,
  AiUsageListResponse,
  AiUsageRecord,
} from "../shared/ai-contract";
import { loadConfig, type AppConfig } from "./config";
import { CATALOG_CHECKED_ON, findModel } from "./models";
import { OLLAMA_BASE_URL, ProviderError, requestChat } from "./ollama";
import {
  SupabaseAuthError,
  createSupabaseAuth,
  type AuthenticatedUser,
  type SupabaseAuth,
} from "./supabase-auth";
import {
  UsageLedgerError,
  createSupabaseUsageLedger,
  type ExistingUsage,
  type ReservationResult,
  type UsageCompletion,
  type UsageLedger,
} from "./usage-ledger";
import {
  PROJECT_LIMITS,
  PROJECT_LIST_LIMIT,
  PROJECT_NOT_FOUND_MESSAGE,
  createSupabaseProjectStore,
  isProjectId,
  parseProjectUpdate,
  parseProjectWrite,
  type ProjectStore,
} from "./projects";
import { ApiError } from "./api-error";
import {
  PROFILE_LIMITS,
  createSupabaseProfileStore,
  parseProfileUpdate,
  type ProfileStore,
} from "./profiles";
import {
  CHILD_LIMITS,
  createSupabaseChildStore,
  isChildId,
  parseClaimUpdate,
  parseClaimWrite,
  parseJobUpdate,
  parseJobWrite,
  parseProposalUpdate,
  parseProposalWrite,
  parseRenderWrite,
  parseSceneList,
  parseSourceWrite,
  type ChildStore,
} from "./project-children";

const MAX_CONCURRENT = 1;
const CHILD_RESOURCES = new Set(["scenes", "sources", "claims", "proposals", "jobs", "renders"]);
const USAGE_PAGE_SIZE = 20;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const ABANDONED_MESSAGE =
  "This attempt did not finish, so its outcome is unknown and it was not retried. Ollama may have charged for it. Use a new Idempotency-Key only if you accept a possible duplicate charge.";

export interface ServerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: { error(message: string): void };
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function readBearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function readIdempotencyKey(request: IncomingMessage): string {
  const header = request.headers["idempotency-key"];
  if (typeof header !== "string" || header.trim().length === 0) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required.");
  }
  const key = header.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new HttpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 8-128 characters from A-Z, a-z, 0-9, dot, underscore, colon, or hyphen.",
    );
  }
  return key;
}

function hashRequest(modelId: string, prompt: string): string {
  return createHash("sha256").update(modelId).update("\n").update(prompt).digest("hex");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function buildStatus(config: AppConfig, ledgerReady: boolean): AiStatusResponse {
  const authConfigured = config.supabaseUrl !== null && config.supabasePublishableKey !== null;
  const ledgerConfigured = config.supabaseUrl !== null && config.supabaseServiceRoleKey !== null;

  return {
    service: "storyframe-ai",
    mode: "development",
    keyConfigured: config.apiKey !== null,
    configured: config.apiKey !== null && authConfigured && ledgerConfigured && ledgerReady,
    auth: {
      mode: "supabase",
      configured: authConfigured,
      publishableKeyConfigured: config.supabasePublishableKey !== null,
    },
    ledger: {
      configured: ledgerConfigured,
      ready: ledgerReady,
      serviceRoleConfigured: config.supabaseServiceRoleKey !== null,
      table: "ai_usage",
    },
    provider: { name: "ollama-cloud", baseUrl: OLLAMA_BASE_URL },
    catalog: { source: "ollama.com/api/tags", checkedOn: CATALOG_CHECKED_ON },
    limits: {
      promptMaxChars: config.promptMaxChars,
      bodyMaxBytes: config.bodyMaxBytes,
      providerTimeoutMs: config.providerTimeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      maxConcurrentRequests: MAX_CONCURRENT,
      requestsPerMinute: config.requestsPerMinute,
      abandonAfterMs: config.abandonAfterMs,
    },
    models: config.models,
  };
}

function failure(code: string, message: string, upstreamStatus?: number): AiErrorResponse {
  return {
    ok: false,
    error: { code, message, ...(upstreamStatus !== undefined ? { upstreamStatus } : {}) },
  };
}

function toErrorResponse(error: unknown): { status: number; body: AiErrorResponse } {
  if (error instanceof HttpError) {
    return { status: error.status, body: failure(error.code, error.message) };
  }
  // Provider errors are already sanitized; route them through the same path.
  if (error instanceof ProviderError) {
    return { status: error.status, body: failure(error.code, error.message, error.upstreamStatus) };
  }
  if (error instanceof ApiError) {
    return { status: error.status, body: failure(error.code, error.message) };
  }
  return { status: 500, body: failure("INTERNAL_ERROR", "Unexpected server error.") };
}

function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }

  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", `Request body must be at most ${maxBytes} bytes.`);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        settled = true;
        reject(new HttpError(413, "BODY_TOO_LARGE", `Request body must be at most ${maxBytes} bytes.`));
        request.resume();
        return;
      }
      chunks.push(buffer);
    });

    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (total === 0) {
        reject(new HttpError(400, "INVALID_BODY", "A JSON request body is required."));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "Request body must be valid JSON."));
      }
    });

    request.on("error", () => {
      if (settled) return;
      settled = true;
      reject(new HttpError(400, "INVALID_BODY", "Could not read the request body."));
    });
  });
}

function validateTestBody(body: unknown, config: AppConfig): { modelId: string; prompt: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }

  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "model" && key !== "prompt") {
      throw new HttpError(400, "UNEXPECTED_FIELD", "Request body may only contain 'model' and 'prompt'.");
    }
  }

  const model = record.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new HttpError(400, "INVALID_MODEL", "A model selection is required.");
  }

  const promptValue = record.prompt;
  if (typeof promptValue !== "string") {
    throw new HttpError(400, "INVALID_PROMPT", "A prompt string is required.");
  }

  const prompt = promptValue.trim();
  if (prompt.length === 0) {
    throw new HttpError(400, "INVALID_PROMPT", "Prompt must not be empty.");
  }
  if (prompt.length > config.promptMaxChars) {
    throw new HttpError(400, "PROMPT_TOO_LONG", `Prompt must be at most ${config.promptMaxChars} characters.`);
  }

  return { modelId: model.trim(), prompt };
}

export function createStoryframeServer(options: ServerOptions = {}): Server {
  const config = loadConfig(options.env ?? process.env);
  const log = options.logger ?? console;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl;
  const recentRequests: number[] = [];
  let inFlight = 0;

  const auth: SupabaseAuth | null =
    config.supabaseUrl && config.supabasePublishableKey
      ? createSupabaseAuth({
          url: config.supabaseUrl,
          publishableKey: config.supabasePublishableKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const ledger: UsageLedger | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseUsageLedger({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const projectStore: ProjectStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseProjectStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const profileStore: ProfileStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseProfileStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const childStore: ChildStore | null =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseChildStore({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          timeoutMs: config.authTimeoutMs,
        })
      : null;

  const server = createHttpServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      const { status, body } = toErrorResponse(error);
      if (status >= 500) log.error(`[ai] ${body.error.code} status=${status}`);
      if (!response.headersSent) sendJson(response, status, body);
      else response.end();
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (path === "/api/ai/status") {
      if (method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.");
      const ledgerReady = ledger ? await ledger.check().then(() => true).catch(() => false) : false;
      sendJson(response, 200, buildStatus(config, ledgerReady));
      return;
    }

    if (path === "/api/ai/usage") {
      if (method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.");
      await handleUsage(request, response);
      return;
    }

    if (path === "/api/ai/test") {
      if (method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.");
      await handleTest(request, response);
      return;
    }

    if (path === "/api/profile") {
      await handleProfile(request, response);
      return;
    }

    if (path === "/api/projects" || path.startsWith("/api/projects/")) {
      await handleProjects(request, response, path);
      return;
    }

    throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
  }

  function checkOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (config.allowedOrigin && origin && origin !== config.allowedOrigin) {
      throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "This origin may not call this endpoint.");
    }
  }

  async function authenticate(request: IncomingMessage): Promise<AuthenticatedUser> {
    if (!auth) {
      throw new HttpError(
        503,
        "AUTH_NOT_CONFIGURED",
        "Supabase authentication is not configured on the server. Set SUPABASE_URL and a publishable key.",
      );
    }

    const token = readBearer(request);
    if (!token) throw new HttpError(401, "UNAUTHORIZED", "A valid Supabase access token is required.");

    try {
      return await auth.verify(token);
    } catch (error) {
      if (error instanceof SupabaseAuthError) {
        throw new HttpError(error.status, error.code, error.message);
      }
      throw error;
    }
  }

  function requireLedger(): UsageLedger {
    if (!ledger) {
      throw new HttpError(
        503,
        "LEDGER_NOT_CONFIGURED",
        "The usage ledger is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return ledger;
  }

  function requireProjects(): ProjectStore {
    if (!projectStore) {
      throw new HttpError(
        503,
        "PROJECTS_NOT_CONFIGURED",
        "The project store is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return projectStore;
  }

  function requireChildren(): ChildStore {
    if (!childStore) {
      throw new HttpError(
        503,
        "PROJECTS_NOT_CONFIGURED",
        "The project store is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return childStore;
  }

  function requireProfile(): ProfileStore {
    if (!profileStore) {
      throw new HttpError(
        503,
        "PROFILE_NOT_CONFIGURED",
        "The profile store is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return profileStore;
  }

  async function handleUsage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkOrigin(request);
    const user = await authenticate(request);
    const usageLedger = requireLedger();

    let usage: AiUsageRecord[];
    try {
      usage = await usageLedger.listForUser(user.id, USAGE_PAGE_SIZE);
    } catch (error) {
      if (error instanceof UsageLedgerError) {
        throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
      }
      throw error;
    }

    const body: AiUsageListResponse = { ok: true, usage };
    sendJson(response, 200, body);
  }

  async function handleProfile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkOrigin(request);
    const user = await authenticate(request);
    const store = requireProfile();
    const method = request.method ?? "GET";

    if (method === "GET") {
      sendJson(response, 200, { ok: true, profile: await store.get(user.id) });
      return;
    }
    if (method === "PUT") {
      const body = await readJsonBody(request, PROFILE_LIMITS.bodyBytes);
      sendJson(response, 200, { ok: true, profile: await store.save(user.id, parseProfileUpdate(body)) });
      return;
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or PUT for this endpoint.");
  }

  async function handleProjects(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    checkOrigin(request);
    const user = await authenticate(request);
    const store = requireProjects();
    const method = request.method ?? "GET";

    if (path === "/api/projects") {
      if (method === "GET") {
        const projects = await store.list(user.id, PROJECT_LIST_LIMIT);
        sendJson(response, 200, { ok: true, projects });
        return;
      }
      if (method === "POST") {
        const body = await readJsonBody(request, PROJECT_LIMITS.bodyBytes);
        const project = await store.create(user.id, parseProjectWrite(body));
        sendJson(response, 201, { ok: true, project });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for this endpoint.");
    }

    const segments = path.slice("/api/projects/".length).split("/");
    const projectId = segments[0];
    if (!isProjectId(projectId)) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_MESSAGE);
    }

    if (segments.length > 1) {
      const [, resource, childId, ...rest] = segments;
      if (rest.length > 0 || !CHILD_RESOURCES.has(resource)) {
        throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
      }
      await handleChild(request, response, user, projectId, resource, childId);
      return;
    }

    if (method === "GET") {
      sendJson(response, 200, { ok: true, project: await store.get(user.id, projectId) });
      return;
    }
    if (method === "PUT") {
      const body = await readJsonBody(request, PROJECT_LIMITS.bodyBytes);
      const project = await store.update(user.id, projectId, parseProjectUpdate(body));
      sendJson(response, 200, { ok: true, project });
      return;
    }
    if (method === "DELETE") {
      await store.remove(user.id, projectId);
      sendJson(response, 200, { ok: true, deletedId: projectId });
      return;
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET, PUT, or DELETE for this endpoint.");
  }

  async function handleChild(
    request: IncomingMessage,
    response: ServerResponse,
    user: AuthenticatedUser,
    projectId: string,
    resource: string,
    childId: string | undefined,
  ): Promise<void> {
    const children = requireChildren();
    const method = request.method ?? "GET";

    // Explicit ownership check before any child query: a foreign project id is
    // answered exactly like a missing one, and no child row is read from it.
    await requireProjects().get(user.id, projectId);

    if (childId !== undefined && !isChildId(childId)) {
      throw new HttpError(404, "CHILD_RECORD_NOT_FOUND", "No record with that id is owned by this account.");
    }

    if (resource === "scenes") {
      if (childId !== undefined) throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
      if (method === "GET") {
        sendJson(response, 200, { ok: true, scenes: await children.listScenes(user.id, projectId) });
        return;
      }
      if (method === "PUT") {
        const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
        const scenes = await children.replaceScenes(user.id, projectId, parseSceneList(body));
        sendJson(response, 200, { ok: true, scenes });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or PUT for the scenes of a project.");
    }

    if (resource === "sources") {
      if (childId === undefined) {
        if (method === "GET") {
          sendJson(response, 200, { ok: true, sources: await children.listSources(user.id, projectId) });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
          const source = await children.createSource(user.id, projectId, parseSourceWrite(body));
          sendJson(response, 201, { ok: true, source });
          return;
        }
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the sources of a project.");
      }
      if (method === "DELETE") {
        await children.removeSource(user.id, projectId, childId);
        sendJson(response, 200, { ok: true, deletedId: childId });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use DELETE for one source.");
    }

    if (resource === "claims") {
      if (childId === undefined) {
        if (method === "GET") {
          sendJson(response, 200, { ok: true, claims: await children.listClaims(user.id, projectId) });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
          const claim = await children.createClaim(user.id, projectId, parseClaimWrite(body));
          sendJson(response, 201, { ok: true, claim });
          return;
        }
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the claims of a project.");
      }
      if (method === "PATCH") {
        const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
        const claim = await children.updateClaim(user.id, projectId, childId, parseClaimUpdate(body));
        sendJson(response, 200, { ok: true, claim });
        return;
      }
      if (method === "DELETE") {
        await children.removeClaim(user.id, projectId, childId);
        sendJson(response, 200, { ok: true, deletedId: childId });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use PATCH or DELETE for one claim.");
    }

    if (resource === "proposals") {
      if (childId === undefined) {
        if (method === "GET") {
          sendJson(response, 200, { ok: true, proposals: await children.listProposals(user.id, projectId) });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
          const proposal = await children.createProposal(user.id, projectId, parseProposalWrite(body));
          sendJson(response, 201, { ok: true, proposal });
          return;
        }
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the proposals of a project.");
      }
      if (method === "PATCH") {
        const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
        const proposal = await children.updateProposal(user.id, projectId, childId, parseProposalUpdate(body));
        sendJson(response, 200, { ok: true, proposal });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use PATCH for one generation proposal.");
    }

    if (resource === "jobs") {
      if (childId === undefined) {
        if (method === "GET") {
          sendJson(response, 200, { ok: true, jobs: await children.listJobs(user.id, projectId) });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
          const job = await children.createJob(user.id, projectId, parseJobWrite(body));
          sendJson(response, 201, { ok: true, job });
          return;
        }
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the provider jobs of a project.");
      }
      if (method === "PATCH") {
        const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
        const job = await children.updateJob(user.id, projectId, childId, parseJobUpdate(body));
        sendJson(response, 200, { ok: true, job });
        return;
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use PATCH for one provider job.");
    }

    // Renders are created, listed, and never rewritten: a snapshot records an output.
    if (childId !== undefined) throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
    if (method === "GET") {
      sendJson(response, 200, { ok: true, renders: await children.listRenders(user.id, projectId) });
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody(request, CHILD_LIMITS.bodyBytes);
      const render = await children.createRender(user.id, projectId, parseRenderWrite(body));
      sendJson(response, 201, { ok: true, render });
      return;
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for the render snapshots of a project.");
  }

  async function handleTest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkOrigin(request);
    const user = await authenticate(request);
    const usageLedger = requireLedger();
    const idempotencyKey = readIdempotencyKey(request);

    const nowMs = now();
    while (recentRequests.length > 0 && recentRequests[0] <= nowMs - 60_000) recentRequests.shift();
    if (recentRequests.length >= config.requestsPerMinute) {
      throw new HttpError(429, "TOO_MANY_REQUESTS", "Development request limit reached. Wait a minute before retrying.");
    }
    if (inFlight >= MAX_CONCURRENT) {
      throw new HttpError(429, "REQUEST_IN_PROGRESS", "A test request is already running. Wait for it to finish.");
    }

    recentRequests.push(nowMs);
    inFlight += 1;

    try {
      const body = await readJsonBody(request, config.bodyMaxBytes);
      const { modelId, prompt } = validateTestBody(body, config);
      const model = findModel(config.models, modelId);
      if (!model) throw new HttpError(400, "UNKNOWN_MODEL", "Unknown model selection.");
      if (!model.available || !model.requestId) {
        throw new HttpError(400, "MODEL_UNAVAILABLE", model.reason ?? "This model is not available.");
      }
      if (!config.apiKey) {
        throw new HttpError(
          503,
          "PROVIDER_NOT_CONFIGURED",
          "OLLAMA_API_KEY is not configured on the server. Add it to the server environment and restart.",
        );
      }

      const requestHash = hashRequest(model.id, prompt);
      let reservation: ReservationResult;
      try {
        reservation = await usageLedger.reserve({
          userId: user.id,
          idempotencyKey,
          requestHash,
          modelId: model.id,
          configuredModel: model.requestId,
        });
      } catch (error) {
        if (error instanceof UsageLedgerError) {
          throw new HttpError(
            503,
            "LEDGER_UNAVAILABLE",
            "The usage ledger is not ready. Apply the ai_usage migrations and check SUPABASE_SERVICE_ROLE_KEY.",
          );
        }
        throw error;
      }

      if (reservation.state === "existing") {
        try {
          await respondForExisting(reservation.usage);
        } catch (error) {
          if (error instanceof UsageLedgerError) {
            throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
          }
          throw error;
        }
        return;
      }

      async function respondForExisting(initial: ExistingUsage): Promise<void> {
        if (initial.requestHash !== requestHash) {
          throw new HttpError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used for a different request.",
          );
        }

        let existing = initial;
        if (existing.status === "pending") {
          const startedAtMs = Date.parse(existing.createdAt);
          const isStale =
            Number.isFinite(startedAtMs) && now() - startedAtMs >= config.abandonAfterMs;
          if (!isStale) {
            throw new HttpError(
              409,
              "IDEMPOTENCY_IN_PROGRESS",
              "A request with this idempotency key is still in progress.",
            );
          }

          // Older than any request could still be running. Settle the reservation
          // without contacting the provider, so recovery can never bill twice.
          const body = failure("REQUEST_ABANDONED", ABANDONED_MESSAGE);
          const settled = await usageLedger.abandon({
            id: existing.id,
            userId: user.id,
            startedBefore: new Date(now() - config.abandonAfterMs).toISOString(),
            completion: {
              status: "error",
              returnedModel: null,
              promptEvalCount: null,
              evalCount: null,
              latencyMs: 0,
              errorCode: "REQUEST_ABANDONED",
              upstreamStatus: null,
              responseStatus: 409,
              responseBody: body,
            },
          });
          if (settled) {
            sendJson(response, 409, body);
            return;
          }

          // Another request settled it first; its write is committed by now.
          const reread = await usageLedger.lookup(user.id, idempotencyKey);
          if (!reread) {
            throw new HttpError(503, "LEDGER_UNAVAILABLE", "The usage ledger is temporarily unavailable.");
          }
          existing = reread;
          if (existing.status === "pending") {
            throw new HttpError(
              409,
              "IDEMPOTENCY_IN_PROGRESS",
              "A request with this idempotency key is still in progress.",
            );
          }
        }

        if (!existing.responseBody || typeof existing.responseBody !== "object") {
          throw new HttpError(
            503,
            "IDEMPOTENCY_REPLAY_UNAVAILABLE",
            "The original response for this idempotency key is unavailable.",
          );
        }
        sendJson(
          response,
          existing.responseStatus ?? (existing.status === "success" ? 200 : 502),
          existing.responseBody,
        );
      }

      const startedAt = now();
      let output;
      try {
        output = await requestChat({
          requestId: model.requestId,
          prompt,
          apiKey: config.apiKey,
          timeoutMs: config.providerTimeoutMs,
          maxOutputTokens: config.maxOutputTokens,
          fetchImpl,
        });
      } catch (error) {
        const providerError = error instanceof ProviderError ? error : null;
        await recordOutcome(usageLedger, reservation.id, {
          status: "error",
            returnedModel: null,
            promptEvalCount: null,
            evalCount: null,
            latencyMs: Math.max(0, now() - startedAt),
            errorCode: providerError?.code ?? "INTERNAL_ERROR",
            upstreamStatus: providerError?.upstreamStatus ?? null,
          responseStatus: providerError?.status ?? 500,
          responseBody: failure(
            providerError?.code ?? "INTERNAL_ERROR",
            providerError?.message ?? "Unexpected server error.",
            providerError?.upstreamStatus,
          ),
        });
        throw error;
      }

      const latencyMs = Math.max(0, now() - startedAt);
      const successBody: AiTestSuccess = {
        ok: true,
        modelId: model.id,
        configuredModel: model.requestId,
        returnedModel: output.returnedModel,
        reply: output.reply,
        latencyMs,
        usage: output.usage,
        doneReason: output.doneReason,
      };
      const recorded = await recordOutcome(usageLedger, reservation.id, {
        status: "success",
        returnedModel: output.returnedModel,
        promptEvalCount: output.usage.promptEvalCount,
        evalCount: output.usage.evalCount,
        latencyMs,
        responseStatus: 200,
        responseBody: successBody,
      });
      // The provider already answered and charged for this call, so the reply is
      // returned even when it could not be recorded.
      sendJson(
        response,
        200,
        successBody,
        recorded ? undefined : { "X-Storyframe-Usage": "unrecorded" },
      );
    } finally {
      inFlight -= 1;
    }
  }

  /**
   * Records a finished attempt. The write is conditional on the reservation still
   * being `pending`, so one immediate retry is safe and absorbs a transient ledger
   * blip, which should not discard an answer the provider has already charged for.
   * A write that matches no pending row lost to a concurrent abandonment; retrying
   * cannot record it, and the caller must be told the reply is unrecorded.
   */
  async function recordOutcome(
    target: UsageLedger,
    id: string,
    completion: UsageCompletion,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (await target.complete(id, completion)) return true;
        break;
      } catch {
        // Retry once; the second failure reports an unrecorded outcome below.
      }
    }
    log.error(`[ai] LEDGER_WRITE_FAILED status=${completion.status}`);
    return false;
  }

  return server;
}
