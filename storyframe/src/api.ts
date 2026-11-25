import type { AiErrorResponse, AiStatusResponse, AiTestSuccess } from "../shared/ai-contract";
import type {
  MediaPlayback,
  MediaRecord,
  MediaReferenceRecord,
  MediaUploadTicket,
} from "../shared/media-contract";
import type {
  GenerationProposalRecord,
  SourceKind,
  SourceRecord,
  SourceResponse,
  SourcesResponse,
} from "../shared/child-contract";
import type { PlanningAcceptedResponse, PlanningStartRequest } from "../shared/planning-contract";
import type {
  ProjectDeletedResponse,
  ProjectDocumentV2,
  ProjectListResponse,
  ProjectRecord,
  ProjectResponse,
  ProjectRevisionListResponse,
  ProjectRevisionSummary,
  ProjectSummary,
  ProjectType,
} from "../shared/project-contract";

export class AiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly upstreamStatus?: number;

  constructor(code: string, message: string, status: number, upstreamStatus?: number) {
    super(message);
    this.name = "AiRequestError";
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ body: T; headers: Headers }> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new AiRequestError("NETWORK_ERROR", "The StoryFrame development server could not be reached.", 0);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const parsed = body as AiErrorResponse | null;
    throw new AiRequestError(
      parsed?.error?.code ?? "HTTP_ERROR",
      parsed?.error?.message ?? `The server returned HTTP ${response.status}.`,
      response.status,
      parsed?.error?.upstreamStatus,
    );
  }

  return { body: body as T, headers: response.headers };
}

export function fetchStatus(): Promise<AiStatusResponse> {
  return requestJson<AiStatusResponse>("/api/ai/status").then(({ body }) => body);
}

async function authorizedJson<T>(
  path: string,
  accessToken: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: { Authorization: `Bearer ${accessToken}`, ...options.headers },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;
  return (await requestJson<T>(path, init)).body;
}

export async function listProjects(accessToken: string): Promise<ProjectSummary[]> {
  return (await authorizedJson<ProjectListResponse>("/api/projects", accessToken)).projects;
}

export async function createProject(
  accessToken: string,
  projectType: ProjectType,
  title: string,
  document: ProjectDocumentV2,
): Promise<ProjectRecord> {
  const body = await authorizedJson<ProjectResponse>("/api/projects", accessToken, {
    method: "POST",
    body: { projectType, title, document },
  });
  return body.project;
}

export async function getProject(accessToken: string, projectId: string): Promise<ProjectRecord> {
  return (await authorizedJson<ProjectResponse>(`/api/projects/${projectId}`, accessToken)).project;
}

export async function updateProject(
  accessToken: string,
  projectId: string,
  update: { title: string; document: ProjectDocumentV2; version: number },
): Promise<ProjectRecord> {
  const body = await authorizedJson<ProjectResponse>(`/api/projects/${projectId}`, accessToken, {
    method: "PUT",
    body: update,
  });
  return body.project;
}

export async function deleteProject(accessToken: string, projectId: string): Promise<string> {
  const body = await authorizedJson<ProjectDeletedResponse>(`/api/projects/${projectId}`, accessToken, {
    method: "DELETE",
  });
  return body.deletedId;
}

export async function listProjectRevisions(
  accessToken: string,
  projectId: string,
): Promise<ProjectRevisionSummary[]> {
  return (
    await authorizedJson<ProjectRevisionListResponse>(`/api/projects/${projectId}/revisions`, accessToken)
  ).revisions;
}

export async function listProjectMedia(accessToken: string, projectId: string): Promise<MediaRecord[]> {
  return (await authorizedJson<{ ok: true; media: MediaRecord[] }>(`/api/projects/${projectId}/media`, accessToken))
    .media;
}

export interface MediaInitiation {
  media: MediaRecord;
  upload: MediaUploadTicket;
}

export async function initiateMediaUpload(
  accessToken: string,
  projectId: string,
  write: { kind: MediaRecord["kind"]; contentType: string; byteSize: number; sceneKey?: string },
): Promise<MediaInitiation> {
  const body = await authorizedJson<{ ok: true; media: MediaRecord; upload: MediaUploadTicket }>(
    `/api/projects/${projectId}/media`,
    accessToken,
    { method: "POST", body: write },
  );
  return { media: body.media, upload: body.upload };
}

export async function uploadMediaObject(ticket: MediaUploadTicket, file: File): Promise<void> {
  let response: Response;
  try {
    response = await fetch(ticket.url, {
      method: ticket.method,
      headers: ticket.headers,
      body: file,
    });
  } catch {
    throw new AiRequestError("NETWORK_ERROR", "The private upload endpoint could not be reached.", 0);
  }
  if (!response.ok) {
    throw new AiRequestError(
      "UPLOAD_FAILED",
      `The private upload failed with HTTP ${response.status}.`,
      response.status,
    );
  }
}

export async function completeMediaUpload(
  accessToken: string,
  projectId: string,
  mediaId: string,
): Promise<MediaRecord> {
  return (
    await authorizedJson<{ ok: true; media: MediaRecord }>(
      `/api/projects/${projectId}/media/${mediaId}/complete`,
      accessToken,
      { method: "POST", body: {} },
    )
  ).media;
}

export async function getMediaPlaybackUrl(
  accessToken: string,
  projectId: string,
  mediaId: string,
): Promise<MediaPlayback> {
  return authorizedJson<MediaPlayback & { ok: true }>(
    `/api/projects/${projectId}/media/${mediaId}/url`,
    accessToken,
  );
}

export async function attachMediaReference(
  accessToken: string,
  projectId: string,
  mediaId: string,
  reference: { refKind: "scene"; refId: string },
): Promise<MediaReferenceRecord> {
  return (
    await authorizedJson<{ ok: true; reference: MediaReferenceRecord }>(
      `/api/projects/${projectId}/media/${mediaId}/references`,
      accessToken,
      { method: "POST", body: reference },
    )
  ).reference;
}

export async function listMediaReferences(
  accessToken: string,
  projectId: string,
  mediaId: string,
): Promise<MediaReferenceRecord[]> {
  return (
    await authorizedJson<{ ok: true; references: MediaReferenceRecord[] }>(
      `/api/projects/${projectId}/media/${mediaId}/references`,
      accessToken,
    )
  ).references;
}

export async function deleteMediaReference(
  accessToken: string,
  projectId: string,
  mediaId: string,
  referenceId: string,
): Promise<string> {
  const body = await authorizedJson<{ ok: true; deletedId: string }>(
    `/api/projects/${projectId}/media/${mediaId}/references/${referenceId}`,
    accessToken,
    { method: "DELETE" },
  );
  return body.deletedId;
}

export async function deleteMediaRecord(
  accessToken: string,
  projectId: string,
  mediaId: string,
): Promise<string> {
  const body = await authorizedJson<{ ok: true; deletedId: string }>(
    `/api/projects/${projectId}/media/${mediaId}`,
    accessToken,
    { method: "DELETE" },
  );
  return body.deletedId;
}

export async function listProjectSources(
  accessToken: string,
  projectId: string,
): Promise<SourceRecord[]> {
  return (
    await authorizedJson<SourcesResponse>(`/api/projects/${projectId}/sources`, accessToken)
  ).sources;
}

export async function createProjectSource(
  accessToken: string,
  projectId: string,
  write: { kind: SourceKind; title: string; url: string | null; excerpt: string | null },
): Promise<SourceRecord> {
  return (
    await authorizedJson<SourceResponse>(`/api/projects/${projectId}/sources`, accessToken, {
      method: "POST",
      body: write,
    })
  ).source;
}

export async function deleteProjectSource(
  accessToken: string,
  projectId: string,
  sourceId: string,
): Promise<string> {
  return (
    await authorizedJson<{ ok: true; deletedId: string }>(
      `/api/projects/${projectId}/sources/${sourceId}`,
      accessToken,
      { method: "DELETE" },
    )
  ).deletedId;
}

export async function listProjectProposals(
  accessToken: string,
  projectId: string,
): Promise<GenerationProposalRecord[]> {
  return (
    await authorizedJson<{ ok: true; proposals: GenerationProposalRecord[] }>(
      `/api/projects/${projectId}/proposals`,
      accessToken,
    )
  ).proposals;
}

export async function generatePlanningProposal(
  accessToken: string,
  projectId: string,
  request: PlanningStartRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<GenerationProposalRecord> {
  return (
    await authorizedJson<{ ok: true; proposal: GenerationProposalRecord }>(
      `/api/projects/${projectId}/planning`,
      accessToken,
      { method: "POST", body: request, headers: { "Idempotency-Key": idempotencyKey }, signal },
    )
  ).proposal;
}

export async function deletePlanningProposal(
  accessToken: string,
  projectId: string,
  proposalId: string,
): Promise<string> {
  return (
    await authorizedJson<{ ok: true; deletedId: string }>(
      `/api/projects/${projectId}/proposals/${proposalId}`,
      accessToken,
      { method: "DELETE" },
    )
  ).deletedId;
}

export async function acceptPlanningProposal(
  accessToken: string,
  projectId: string,
  proposalId: string,
): Promise<PlanningAcceptedResponse> {
  return authorizedJson<PlanningAcceptedResponse>(
    `/api/projects/${projectId}/proposals/${proposalId}/accept`,
    accessToken,
    { method: "POST", body: {} },
  );
}

export async function rejectPlanningProposal(
  accessToken: string,
  projectId: string,
  proposalId: string,
): Promise<GenerationProposalRecord> {
  return (
    await authorizedJson<{ ok: true; proposal: GenerationProposalRecord }>(
      `/api/projects/${projectId}/proposals/${proposalId}`,
      accessToken,
      { method: "PATCH", body: { status: "rejected" } },
    )
  ).proposal;
}

export interface AiTestOutcome {
  result: AiTestSuccess;
  /** False when the server returned the reply but could not record its usage. */
  usageRecorded: boolean;
}

export async function runModelTest(
  accessToken: string,
  model: string,
  prompt: string,
  idempotencyKey: string,
): Promise<AiTestOutcome> {
  const { body, headers } = await requestJson<AiTestSuccess>("/api/ai/test", {
    method: "POST",
    headers: {
      ...(accessToken.trim() ? { Authorization: `Bearer ${accessToken.trim()}` } : {}),
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ model, prompt }),
  });

  return { result: body, usageRecorded: headers.get("X-Storyframe-Usage") !== "unrecorded" };
}
