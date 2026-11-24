/** Version of the stored project document shape. Bump this when the shape changes. */
export const PROJECT_SCHEMA_VERSION = 1;

export type ProjectType = "story" | "product-ad" | "repurpose";

export interface ProjectScene {
  id: string;
  heading: string;
  body: string;
}

/** Document v1: the editable project content, versioned independently of its row. */
export interface ProjectDocumentV1 {
  schemaVersion: 1;
  summary: string;
  scenes: ProjectScene[];
}

/** List view: everything except the document. */
export interface ProjectSummary {
  id: string;
  projectType: ProjectType;
  title: string;
  schemaVersion: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord extends ProjectSummary {
  document: ProjectDocumentV1;
}

export interface ProjectListResponse {
  ok: true;
  projects: ProjectSummary[];
}

export interface ProjectResponse {
  ok: true;
  project: ProjectRecord;
}

export interface ProjectDeletedResponse {
  ok: true;
  deletedId: string;
}
