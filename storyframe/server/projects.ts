import { ApiError } from "./api-error";
import {
  PROJECT_SCHEMA_VERSION,
  type ProjectDocumentV1,
  type ProjectRecord,
  type ProjectScene,
  type ProjectSummary,
  type ProjectType,
} from "../shared/project-contract";

const PROJECTS_TABLE = "projects";

export const PROJECT_LIST_LIMIT = 50;

/** Upper bounds for one project write. Larger requests are refused, never truncated. */
export const PROJECT_LIMITS = {
  bodyBytes: 128 * 1024,
  titleChars: 200,
  summaryChars: 2000,
  scenes: 50,
  sceneIdChars: 64,
  sceneHeadingChars: 200,
  sceneBodyChars: 20000,
} as const;

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

/** One message for "missing" and "not yours", so a foreign id discloses nothing. */
export const PROJECT_NOT_FOUND_MESSAGE = "No project with that id is owned by this account.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, "UNEXPECTED_FIELD", `${label} may only contain ${allowed.join(", ")}.`);
    }
  }
}

function readBoundedText(value: unknown, label: string, maxChars: number, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must be a string.`);
  }
  const text = value.trim();
  if (!allowEmpty && text.length === 0) {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must not be empty.`);
  }
  if (text.length > maxChars) {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must be at most ${maxChars} characters.`);
  }
  return text;
}

function parseScene(value: unknown, index: number): ProjectScene {
  const label = `document.scenes[${index}]`;
  if (!isRecord(value)) {
    throw new ApiError(400, "INVALID_PROJECT", `${label} must be an object.`);
  }
  requireExactKeys(value, ["id", "heading", "body"], label);

  const id = readBoundedText(value.id, `${label}.id`, PROJECT_LIMITS.sceneIdChars);
  const heading = readBoundedText(value.heading, `${label}.heading`, PROJECT_LIMITS.sceneHeadingChars);
  const body = value.body;
  if (typeof body !== "string" || body.length > PROJECT_LIMITS.sceneBodyChars) {
    throw new ApiError(
      400,
      "INVALID_PROJECT",
      `${label}.body must be a string of at most ${PROJECT_LIMITS.sceneBodyChars} characters.`,
    );
  }

  return { id, heading, body };
}

/**
 * Validates one document at the current schema version. Stored rows are read
 * through `migrateDocument`, which is where a future v2 is introduced.
 */
export function parseDocument(value: unknown): ProjectDocumentV1 {
  if (!isRecord(value)) {
    throw new ApiError(400, "INVALID_PROJECT", "document must be an object.");
  }
  requireExactKeys(value, ["schemaVersion", "summary", "scenes"], "document");

  if (value.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new ApiError(
      400,
      "UNSUPPORTED_PROJECT_SCHEMA",
      `document.schemaVersion must be ${PROJECT_SCHEMA_VERSION}.`,
    );
  }

  const summary = readBoundedText(value.summary, "document.summary", PROJECT_LIMITS.summaryChars, true);
  const scenes = value.scenes;
  if (!Array.isArray(scenes)) {
    throw new ApiError(400, "INVALID_PROJECT", "document.scenes must be an array.");
  }
  if (scenes.length > PROJECT_LIMITS.scenes) {
    throw new ApiError(
      400,
      "INVALID_PROJECT",
      `document.scenes must hold at most ${PROJECT_LIMITS.scenes} scenes.`,
    );
  }

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    summary,
    scenes: scenes.map(parseScene),
  };
}

/**
 * Reads a stored document at any version this server knows. Adding document v2
 * means adding a case here; rows already stored keep their own version.
 */
export function migrateDocument(schemaVersion: number, document: unknown): ProjectDocumentV1 {
  if (schemaVersion === PROJECT_SCHEMA_VERSION) return parseDocument(document);

  throw new ApiError(
    409,
    "UNSUPPORTED_PROJECT_SCHEMA",
    `This project stores document schema ${schemaVersion}, which this server cannot read.`,
  );
}

export interface ProjectWrite {
  projectType: ProjectType;
  title: string;
  document: ProjectDocumentV1;
}

export interface ProjectUpdate {
  title: string;
  document: ProjectDocumentV1;
  version: number;
}

const PROJECT_TYPES: readonly ProjectType[] = ["story", "product-ad", "repurpose"];

function readBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  requireExactKeys(body, allowed, "Request body");
  return body;
}

export function parseProjectWrite(input: unknown): ProjectWrite {
  const body = readBody(input, ["projectType", "title", "document"]);

  const projectType = body.projectType;
  if (typeof projectType !== "string" || !PROJECT_TYPES.includes(projectType as ProjectType)) {
    throw new ApiError(400, "INVALID_PROJECT_TYPE", "projectType must be story, product-ad, or repurpose.");
  }

  return {
    projectType: projectType as ProjectType,
    title: readBoundedText(body.title, "title", PROJECT_LIMITS.titleChars),
    document: parseDocument(body.document),
  };
}

export function parseProjectUpdate(input: unknown): ProjectUpdate {
  const body = readBody(input, ["title", "document", "version"]);

  const version = body.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ApiError(400, "INVALID_PROJECT_VERSION", "version must be the integer version you last read.");
  }

  return {
    title: readBoundedText(body.title, "title", PROJECT_LIMITS.titleChars),
    document: parseDocument(body.document),
    version,
  };
}

export interface ProjectStore {
  list(ownerId: string, limit: number): Promise<ProjectSummary[]>;
  get(ownerId: string, projectId: string): Promise<ProjectRecord>;
  create(ownerId: string, write: ProjectWrite): Promise<ProjectRecord>;
  update(ownerId: string, projectId: string, update: ProjectUpdate): Promise<ProjectRecord>;
  remove(ownerId: string, projectId: string): Promise<void>;
}

interface SupabaseProjectStoreOptions {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

const SUMMARY_COLUMNS = [
  "id",
  "project_type",
  "title",
  "schema_version",
  "version",
  "created_at",
  "updated_at",
].join(",");
const PROJECT_COLUMNS = `${SUMMARY_COLUMNS},document`;

function toSummary(row: Record<string, unknown>): ProjectSummary {
  const id = row.id;
  const projectType = row.project_type;
  const title = row.title;
  const schemaVersion = row.schema_version;
  const version = row.version;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;

  if (
    typeof id !== "string" ||
    (projectType !== "story" && projectType !== "product-ad" && projectType !== "repurpose") ||
    typeof title !== "string" ||
    typeof schemaVersion !== "number" ||
    typeof version !== "number" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new ApiError(503, "PROJECT_STORE_CORRUPT", "The project store returned a malformed row.");
  }

  return { id, projectType, title, schemaVersion, version, createdAt, updatedAt };
}

function toProject(row: Record<string, unknown>): ProjectRecord {
  const summary = toSummary(row);
  try {
    return { ...summary, document: migrateDocument(summary.schemaVersion, row.document) };
  } catch (error) {
    if (error instanceof ApiError && error.code === "UNSUPPORTED_PROJECT_SCHEMA") throw error;
    throw new ApiError(503, "PROJECT_STORE_CORRUPT", "A stored project document could not be read.");
  }
}

/**
 * Durable project store backed by the Supabase PostgREST endpoint. Every query
 * carries the verified owner id, so the service role can never reach another
 * account's row. Revision history is written by the database trigger, in the
 * same transaction as the project row.
 */
export function createSupabaseProjectStore(options: SupabaseProjectStoreOptions): ProjectStore {
  const endpoint = `${options.url.replace(/\/+$/, "")}/rest/v1/${PROJECTS_TABLE}`;
  const authHeaders = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };

  async function request(target: string, init: RequestInit, action: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch {
      throw new ApiError(503, "PROJECTS_UNAVAILABLE", "The project store is unreachable.");
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "PROJECTS_UNAVAILABLE",
        `The project store rejected ${action} (HTTP ${response.status}).`,
      );
    }
    return response.json().catch(() => null);
  }

  function rows(payload: unknown): Record<string, unknown>[] {
    if (!Array.isArray(payload)) {
      throw new ApiError(503, "PROJECTS_UNAVAILABLE", "The project store returned an unreadable response.");
    }
    return payload.map((row) => (isRecord(row) ? row : {}));
  }

  async function get(ownerId: string, projectId: string): Promise<ProjectRecord> {
    const query = new URLSearchParams({
      select: PROJECT_COLUMNS,
      id: `eq.${projectId}`,
      owner_id: `eq.${ownerId}`,
      limit: "1",
    });
    const found = rows(
      await request(`${endpoint}?${query}`, { headers: { ...authHeaders, Accept: "application/json" } }, "the read"),
    );
    if (found.length === 0) throw new ApiError(404, "PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_MESSAGE);
    return toProject(found[0]);
  }

  return {
    async list(ownerId: string, limit: number): Promise<ProjectSummary[]> {
      const query = new URLSearchParams({
        select: SUMMARY_COLUMNS,
        owner_id: `eq.${ownerId}`,
        order: "updated_at.desc",
        limit: String(limit),
      });
      const found = rows(
        await request(`${endpoint}?${query}`, { headers: { ...authHeaders, Accept: "application/json" } }, "the list"),
      );
      return found.map(toSummary);
    },

    get,

    async create(ownerId: string, write: ProjectWrite): Promise<ProjectRecord> {
      const created = rows(
        await request(
          endpoint,
          {
            method: "POST",
            headers: {
              ...authHeaders,
              "Content-Type": "application/json",
              Accept: "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({
              // The owner always comes from the verified session, never from the request body.
              owner_id: ownerId,
              project_type: write.projectType,
              title: write.title,
              schema_version: write.document.schemaVersion,
              document: write.document,
              version: 1,
            }),
          },
          "the create",
        ),
      );
      if (created.length === 0) {
        throw new ApiError(503, "PROJECTS_UNAVAILABLE", "The project store did not confirm the new project.");
      }
      return toProject(created[0]);
    },

    async update(ownerId: string, projectId: string, update: ProjectUpdate): Promise<ProjectRecord> {
      const query = new URLSearchParams({
        id: `eq.${projectId}`,
        owner_id: `eq.${ownerId}`,
        version: `eq.${update.version}`,
      });
      const updated = rows(
        await request(
          `${endpoint}?${query}`,
          {
            method: "PATCH",
            headers: {
              ...authHeaders,
              "Content-Type": "application/json",
              Accept: "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({
              title: update.title,
              document: update.document,
              schema_version: update.document.schemaVersion,
              version: update.version + 1,
              updated_at: new Date().toISOString(),
            }),
          },
          "the update",
        ),
      );
      if (updated.length > 0) return toProject(updated[0]);

      // Nothing matched: either this account does not own the project, or the
      // version moved on. The read distinguishes the two without guessing.
      await get(ownerId, projectId);
      throw new ApiError(
        409,
        "PROJECT_VERSION_CONFLICT",
        "This project changed since you read it. Reload it before saving again.",
      );
    },

    async remove(ownerId: string, projectId: string): Promise<void> {
      const query = new URLSearchParams({ id: `eq.${projectId}`, owner_id: `eq.${ownerId}` });
      const deleted = rows(
        await request(
          `${endpoint}?${query}`,
          {
            method: "DELETE",
            headers: { ...authHeaders, Accept: "application/json", Prefer: "return=representation" },
          },
          "the delete",
        ),
      );
      if (deleted.length === 0) throw new ApiError(404, "PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_MESSAGE);
    },
  };
}
