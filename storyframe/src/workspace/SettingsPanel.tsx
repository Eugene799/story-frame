import { useEffect, useState } from "react";
import type { ProjectRecord, ProjectRevisionSummary } from "../../shared/project-contract";
import {
  AiRequestError,
  deleteProject,
  listProjectRevisions,
  restoreProjectRevision,
} from "../api";
import { PROJECT_TYPE_LABELS } from "./model";

const REVISION_HISTORY_LIMIT = 20;

interface SettingsPanelProps {
  project: ProjectRecord;
  getAccessToken: () => Promise<string>;
  onDeleted: () => void;
  onRestored: (project: ProjectRecord) => void;
}

export function SettingsPanel({ project, getAccessToken, onDeleted, onRestored }: SettingsPanelProps) {
  const [revisions, setRevisions] = useState<ProjectRevisionSummary[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmingRevision, setConfirmingRevision] = useState<number | null>(null);
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setHistoryError(null);
    (async () => {
      try {
        const list = await listProjectRevisions(await getAccessToken(), project.id);
        if (active) setRevisions(list);
      } catch (cause) {
        if (active) {
          setHistoryError(
            cause instanceof AiRequestError ? cause.message : "Could not load the revision history.",
          );
        }
      }
    })();
    return () => {
      active = false;
    };
    // History is loaded once per opened project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function restoreRevision(revision: number) {
    if (restoringRevision !== null) return;
    setRestoringRevision(revision);
    setRestoreError(null);
    setRestoreNotice(null);
    try {
      const accessToken = await getAccessToken();
      const restored = await restoreProjectRevision(accessToken, project.id, revision, project.version);
      onRestored(restored);
      setConfirmingRevision(null);
      setRestoreNotice(`Restored revision ${revision} as a new saved version. Earlier history is unchanged.`);
      // The restore response is the revision it appended, so update the list locally.
      setRevisions((current) =>
        current === null
          ? current
          : [
              {
                revision: restored.version,
                title: restored.title,
                schemaVersion: restored.schemaVersion,
                createdAt: restored.updatedAt,
              },
              ...current.filter((item) => item.revision !== restored.version),
            ].slice(0, REVISION_HISTORY_LIMIT),
      );
    } catch (cause) {
      setRestoreError(
        cause instanceof AiRequestError ? cause.message : "The revision could not be restored.",
      );
      setConfirmingRevision(null);
    } finally {
      setRestoringRevision(null);
    }
  }

  async function removeProject() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(await getAccessToken(), project.id);
      onDeleted();
    } catch (cause) {
      setDeleteError(cause instanceof AiRequestError ? cause.message : "The project could not be deleted.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="settings-heading">
      <div className="panel-heading">
        <h2 id="settings-heading">Project settings</h2>
        <span className="status">v{project.version}</span>
      </div>

      <dl className="facts">
        <div>
          <dt>Project type</dt>
          <dd>{PROJECT_TYPE_LABELS[project.projectType]}</dd>
        </div>
        <div>
          <dt>Document schema</dt>
          <dd>{project.schemaVersion}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{new Date(project.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Last saved</dt>
          <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
        </div>
      </dl>

      <div className="revision-block">
        <div className="field-label-row">
          <h3>Recent saved versions</h3>
          <span className="status">Last {REVISION_HISTORY_LIMIT}</span>
        </div>
        <p className="hint">
          The database records one revision per save. Restoring an old version appends a new save; it never rewrites
          the history it came from. Unlock any protected component before restoring a version that would change it.
        </p>
        {historyError && <p className="alert">{historyError}</p>}
        {restoreError && <p className="alert">{restoreError}</p>}
        {restoreNotice && (
          <p className="notice" role="status">
            {restoreNotice}
          </p>
        )}
        {!revisions && !historyError && <p className="muted">Loading revision history...</p>}
        {revisions && revisions.length === 0 && <p className="empty-state">No saved versions yet.</p>}
        <ol className="revision-list">
          {revisions?.map((revision) => {
            const current = revision.revision === project.version;
            return (
              <li key={revision.revision}>
                <span className="revision-number">r{revision.revision}</span>
                <span>{revision.title}</span>
                <span className="hint">
                  {new Date(revision.createdAt).toLocaleString()} · schema {revision.schemaVersion}
                </span>
                {current ? (
                  <span className="status">Current</span>
                ) : confirmingRevision === revision.revision ? (
                  <span className="button-row">
                    <button
                      type="button"
                      className="button-secondary button-small button-danger"
                      onClick={() => void restoreRevision(revision.revision)}
                      disabled={restoringRevision !== null}
                    >
                      {restoringRevision === revision.revision ? "Restoring..." : "Confirm restore"}
                    </button>
                    <button
                      type="button"
                      className="button-secondary button-small"
                      onClick={() => setConfirmingRevision(null)}
                      disabled={restoringRevision !== null}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="button-secondary button-small"
                    onClick={() => {
                      setRestoreError(null);
                      setRestoreNotice(null);
                      setConfirmingRevision(revision.revision);
                    }}
                    disabled={restoringRevision !== null}
                    aria-label={`Restore revision ${revision.revision}`}
                  >
                    Restore
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="danger-block">
        <h3>Delete project</h3>
        <p className="muted">
          Deleting removes this project, its saved versions, its media references, and the media objects uploaded for
          it. Storage cleanup is best effort, so a bucket failure can leave an object without a record.
        </p>
        {deleteError && <p className="alert">{deleteError}</p>}
        {!confirming ? (
          <button
            type="button"
            className="button-secondary button-danger"
            onClick={() => setConfirming(true)}
            disabled={deleting}
          >
            Delete project
          </button>
        ) : (
          <div className="button-row">
            <button
              type="button"
              className="button-danger"
              onClick={removeProject}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Confirm delete project"}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setConfirming(false)}
              disabled={deleting}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
