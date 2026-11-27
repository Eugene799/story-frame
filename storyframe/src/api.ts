import type { AiErrorResponse, AiStatusResponse, AiTestSuccess } from "../shared/ai-contract";
import type { LipsyncExportInput, LipsyncExportRecord, LipsyncUsageSummary } from "../shared/lipsync-contract";
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
import type {
  PlanningAcceptedResponse,
  PlanningAttemptStatusResponse,
  PlanningStartRequest,
} from "../shared/planning-contract";
import type { ProjectExportPayload } from "../shared/project-export";
import type {
  VideoExportResponse,
  VideoExportUrlResponse,
  VideoExportsResponse,
} from "../shared/video-contract";
import type {
  StockImportRequest,
  StockImportResponse,
  StockProvider,
  StockSearchResponse,
  StockType,
} from "../shared/stock-contract";
import type {
  AudioSettingsInput,
  NarrationKind,
  NarrationStateResponse,
  NarrationTrackResponse,
  NarrationVoiceCatalogResponse,
} from "../shared/narration-contract";
import type {
  ImageEstimate,
  ImageEstimateResponse,
  ImageGenerationInput,
  ImageGenerationListResponse,
  ImageGenerationRecord,
  ImageGenerationResponse,
  ImageModelView,
  ImageModelsResponse,
  ImageUsageResponse,
  ImageUsageSummary,
} from "../shared/image-generation-contract";
import type {
  ProjectDeletedResponse,
  ProjectDocumentV2,
  ProjectListResponse,
  ProjectRecord,
  ProjectResponse,
  ProjectRevisionListResponse,
  ProjectRevisionRestoreResponse,
  ProjectRevisionSummary,
  ProjectSummary,
  ProjectType,
} from "../shared/project-contract";

export class AiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly upstreamStatus?: number;
  /** Structured recovery data, such as the job blocking a new generation. */
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    status: number,
    upstreamStatus?: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "AiRequestError";
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.details = details;
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
      parsed?.error?.details,
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

export async function restoreProjectRevision(
  accessToken: string,
  projectId: string,
  revision: number,
  version: number,
): Promise<ProjectRecord> {
  const body = await authorizedJson<ProjectRevisionRestoreResponse>(
    `/api/projects/${projectId}/revisions/${revision}/restore`,
    accessToken,
    { method: "POST", body: { version } },
  );
  return body.project;
}

export async function listProjectMedia(accessToken: string, projectId: string): Promise<MediaRecord[]> {
  return (await authorizedJson<{ ok: true; media: MediaRecord[] }>(`/api/projects/${projectId}/media`, accessToken))
    .media;
}

export interface MediaInitiation {
  media: MediaRecord;
  upload: MediaUploadTicket;
}

export async function listLipsyncExports(
  accessToken: string,
  projectId: string,
): Promise<{ exports: LipsyncExportRecord[]; usage: LipsyncUsageSummary }> {
  const body = await authorizedJson<{ ok: true; exports: LipsyncExportRecord[]; usage: LipsyncUsageSummary }>(
    `/api/projects/${projectId}/exports/lipsync`,
    accessToken,
  );
  return { exports: body.exports, usage: body.usage };
}

export async function submitLipsyncExport(
  accessToken: string,
  projectId: string,
  input: LipsyncExportInput,
): Promise<{ export: LipsyncExportRecord; media: MediaRecord | null; usage: LipsyncUsageSummary }> {
  return authorizedJson<{ ok: true; export: LipsyncExportRecord; media: MediaRecord | null; usage: LipsyncUsageSummary }>(
    `/api/projects/${projectId}/exports/lipsync`,
    accessToken,
    { method: "POST", body: input },
  );
}

export async function getLipsyncPlayback(
  accessToken: string,
  projectId: string,
  exportId: string,
): Promise<{ url: string; expiresAt: string; contentType: string; byteSize: number }> {
  const body = await authorizedJson<{
    ok: true;
    url: string;
    expiresAt: string;
    contentType: string;
    byteSize: number;
  }>(`/api/projects/${projectId}/exports/lipsync/${exportId}/url`, accessToken);
  return { url: body.url, expiresAt: body.expiresAt, contentType: body.contentType, byteSize: body.byteSize };
}

export async function deleteLipsyncExport(
  accessToken: string,
  projectId: string,
  exportId: string,
): Promise<string> {
  const body = await authorizedJson<{ ok: true; deletedId: string }>(
    `/api/projects/${projectId}/exports/lipsync/${exportId}`,
    accessToken,
    { method: "DELETE" },
  );
  return body.deletedId;
}

export async function listNarrationVoices(accessToken: string): Promise<NarrationVoiceCatalogResponse> {
  return authorizedJson<NarrationVoiceCatalogResponse>("/api/narration/voices", accessToken);
}

export async function getNarrationState(
  accessToken: string,
  projectId: string,
): Promise<NarrationStateResponse> {
  return authorizedJson<NarrationStateResponse>(`/api/projects/${projectId}/narration`, accessToken);
}

export async function generateNarration(
  accessToken: string,
  projectId: string,
  voiceModel: string,
): Promise<NarrationTrackResponse> {
  return authorizedJson<NarrationTrackResponse>(`/api/projects/${projectId}/narration`, accessToken, {
    method: "POST",
    body: { voiceModel },
  });
}

export async function attachAudioTrack(
  accessToken: string,
  projectId: string,
  kind: NarrationKind,
  mediaId: string,
): Promise<NarrationTrackResponse> {
  const path =
    kind === "music"
      ? `/api/projects/${projectId}/music`
      : `/api/projects/${projectId}/narration/upload`;
  return authorizedJson<NarrationTrackResponse>(path, accessToken, {
    method: "POST",
    body: { mediaId },
  });
}

export async function updateAudioSettings(
  accessToken: string,
  projectId: string,
  kind: NarrationKind,
  patch: AudioSettingsInput,
): Promise<NarrationTrackResponse> {
  return authorizedJson<NarrationTrackResponse>(`/api/projects/${projectId}/${kind}`, accessToken, {
    method: "PATCH",
    body: patch,
  });
}

export async function removeAudioTrack(
  accessToken: string,
  projectId: string,
  kind: NarrationKind,
): Promise<{ ok: true; track: NarrationTrackResponse["track"] }> {
  return authorizedJson(`/api/projects/${projectId}/${kind}`, accessToken, { method: "DELETE" });
}

/** Fetches preview audio bytes; a provider error is still JSON and becomes AiRequestError. */
export async function previewNarrationVoice(
  accessToken: string,
  projectId: string,
  voiceModel: string,
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`/api/projects/${projectId}/narration/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ voiceModel }),
    });
  } catch {
    throw new AiRequestError("NETWORK_ERROR", "The StoryFrame development server could not be reached.", 0);
  }
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as AiErrorResponse | null;
    throw new AiRequestError(
      parsed?.error?.code ?? "HTTP_ERROR",
      parsed?.error?.message ?? `The server returned HTTP ${response.status}.`,
      response.status,
    );
  }
  return response.blob();
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

export async function listImageModels(accessToken: string): Promise<ImageModelView[]> {
  return (await authorizedJson<ImageModelsResponse>("/api/image-models", accessToken)).models;
}

export async function getImageUsage(accessToken: string): Promise<ImageUsageResponse> {
  return authorizedJson<ImageUsageResponse>("/api/image-usage", accessToken);
}

export async function estimateImageGeneration(
  accessToken: string,
  projectId: string,
  input: ImageGenerationInput,
): Promise<ImageEstimate> {
  return (
    await authorizedJson<ImageEstimateResponse>(
      `/api/projects/${projectId}/image-generations/estimate`,
      accessToken,
      { method: "POST", body: input },
    )
  ).estimate;
}

export async function createImageGeneration(
  accessToken: string,
  projectId: string,
  input: ImageGenerationInput,
): Promise<ImageGenerationResponse> {
  return authorizedJson<ImageGenerationResponse>(`/api/projects/${projectId}/image-generations`, accessToken, {
    method: "POST",
    body: input,
  });
}

export async function settleImageGeneration(
  accessToken: string,
  projectId: string,
  generationId: string,
): Promise<ImageGenerationResponse> {
  return authorizedJson<ImageGenerationResponse>(
    `/api/projects/${projectId}/image-generations/${generationId}/settle`,
    accessToken,
    { method: "POST", body: {} },
  );
}

export async function refreshImageGeneration(
  accessToken: string,
  projectId: string,
  generationId: string,
): Promise<ImageGenerationResponse> {
  return authorizedJson<ImageGenerationResponse>(
    `/api/projects/${projectId}/image-generations/${generationId}/refresh`,
    accessToken,
    { method: "POST", body: {} },
  );
}

export async function listImageGenerations(
  accessToken: string,
  projectId: string,
): Promise<ImageGenerationRecord[]> {
  return (
    await authorizedJson<ImageGenerationListResponse>(
      `/api/projects/${projectId}/image-generations`,
      accessToken,
    )
  ).generations;
}

export interface StockSearchQuery {
  query: string;
  type: StockType;
  sources: StockProvider[];
  page?: number;
}

export async function searchStock(
  accessToken: string,
  query: StockSearchQuery,
): Promise<StockSearchResponse> {
  const params = new URLSearchParams({
    q: query.query,
    type: query.type,
    sources: query.sources.join(","),
  });
  if (query.page !== undefined && query.page > 1) params.set("page", String(query.page));
  return authorizedJson<StockSearchResponse>(`/api/stock/search?${params.toString()}`, accessToken);
}

export async function importStockAsset(
  accessToken: string,
  projectId: string,
  request: StockImportRequest,
): Promise<StockImportResponse> {
  return authorizedJson<StockImportResponse>(`/api/projects/${projectId}/stock/import`, accessToken, {
    method: "POST",
    body: request,
  });
}

export async function exportProject(
  accessToken: string,
  projectId: string,
  title: string,
  document: ProjectDocumentV2,
): Promise<ProjectExportPayload> {
  const body = await authorizedJson<{ ok: true; export: ProjectExportPayload }>(
    `/api/projects/${projectId}/export`,
    accessToken,
    { method: "POST", body: { title, document } },
  );
  return body.export;
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

export async function getPlanningAttemptStatus(
  accessToken: string,
  projectId: string,
): Promise<PlanningAttemptStatusResponse> {
  return authorizedJson<PlanningAttemptStatusResponse>(
    `/api/projects/${projectId}/planning/status`,
    accessToken,
  );
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

export async function listVideoExports(
  accessToken: string,
  projectId: string,
): Promise<VideoExportsResponse> {
  return authorizedJson<VideoExportsResponse>(`/api/projects/${projectId}/exports/video`, accessToken);
}

/** The key makes a double click or a retried submit return the same paid export. */
export async function submitVideoExport(
  accessToken: string,
  projectId: string,
  projectRevision: number,
  idempotencyKey: string,
): Promise<VideoExportResponse> {
  return authorizedJson<VideoExportResponse>(`/api/projects/${projectId}/exports/video`, accessToken, {
    method: "POST",
    body: { projectRevision },
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export async function deleteVideoExport(
  accessToken: string,
  projectId: string,
  exportId: string,
): Promise<string> {
  const body = await authorizedJson<{ ok: true; deletedId: string }>(
    `/api/projects/${projectId}/exports/video/${exportId}`,
    accessToken,
    { method: "DELETE" },
  );
  return body.deletedId;
}

/** A short-lived URL for our own stored MP4, never the provider's copy. */
export async function getVideoExportPlayback(
  accessToken: string,
  projectId: string,
  exportId: string,
): Promise<VideoExportUrlResponse> {
  return authorizedJson<VideoExportUrlResponse>(
    `/api/projects/${projectId}/exports/video/${exportId}/url`,
    accessToken,
  );
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
