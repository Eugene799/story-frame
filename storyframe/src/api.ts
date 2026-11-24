import type { AiErrorResponse, AiStatusResponse, AiTestSuccess } from "../shared/ai-contract";

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
