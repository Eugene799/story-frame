export type MediaKind = "image" | "audio" | "video";
export type MediaStatus = "pending" | "ready" | "deleted";
export type MediaRefKind = "scene" | "render" | "document" | "other";

export interface MediaRecord {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  sceneKey: string | null;
  contentType: string;
  byteSize: number;
  uploadExpiresAt: string | null;
  readyAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  referenceCount: number;
}

export interface MediaReferenceRecord {
  id: string;
  refKind: MediaRefKind;
  refId: string;
  createdAt: string;
}

export interface MediaUploadTicket {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface MediaPlayback {
  url: string;
  expiresAt: string;
  contentType: string;
  byteSize: number;
}
