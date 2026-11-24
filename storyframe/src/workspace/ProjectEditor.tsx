import { useEffect, useState } from "react";
import type { ProjectDocumentV2, ProjectRecord } from "../../shared/project-contract";
import { AiRequestError, getProject, updateProject } from "../api";
import { BriefPanel } from "./BriefPanel";
import { MediaPanel } from "./MediaPanel";
import { PreviewPanel } from "./PreviewPanel";
import { ScriptPanel } from "./ScriptPanel";
import { SettingsPanel } from "./SettingsPanel";
import { StoryboardPanel } from "./StoryboardPanel";

type EditorTab = "brief" | "script" | "storyboard" | "media" | "preview" | "settings";

const TABS: { id: EditorTab; label: string }[] = [
  { id: "brief", label: "Brief" },
  { id: "script", label: "Script" },
  { id: "storyboard", label: "Storyboard" },
  { id: "media", label: "Media" },
  { id: "preview", label: "Preview" },
  { id: "settings", label: "Settings" },
];

interface ProjectEditorProps {
  project: ProjectRecord;
  getAccessToken: () => Promise<string>;
  onBack: () => void;
  onDeleted: () => void;
  onSaved?: (project: ProjectRecord) => void;
  onBusyChange?: (busy: boolean) => void;
}

function toRequestError(cause: unknown): AiRequestError {
  if (cause instanceof AiRequestError) return cause;
  return new AiRequestError(
    "NETWORK_ERROR",
    cause instanceof Error ? cause.message : "The request could not be completed.",
    0,
  );
}

export function ProjectEditor({
  project,
  getAccessToken,
  onBack,
  onDeleted,
  onSaved,
  onBusyChange,
}: ProjectEditorProps) {
  const [saved, setSaved] = useState(project);
  const [title, setTitle] = useState(project.title);
  const [draft, setDraft] = useState<ProjectDocumentV2>(project.document);
  const [tab, setTab] = useState<EditorTab>("brief");
  const [saving, setSaving] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const busy = saving || mediaBusy;
  const dirty = title !== saved.title || JSON.stringify(draft) !== JSON.stringify(saved.document);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  async function saveDocument(nextDocument: ProjectDocumentV2, nextTitle = title): Promise<boolean> {
    if (saving) return false;
    const trimmed = nextTitle.trim();
    if (!trimmed) {
      setError(new AiRequestError("INVALID_PROJECT", "A project title is required before saving.", 400));
      return false;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateProject(await getAccessToken(), saved.id, {
        title: trimmed,
        document: nextDocument,
        version: saved.version,
      });
      setSaved(updated);
      setDraft(updated.document);
      setTitle(updated.title);
      setConflict(false);
      setNotice(`Saved version ${updated.version}.`);
      onSaved?.(updated);
      return true;
    } catch (cause) {
      const requestError = toRequestError(cause);
      setError(requestError);
      if (requestError.code === "PROJECT_VERSION_CONFLICT") setConflict(true);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    setError(null);
    try {
      const latest = await getProject(await getAccessToken(), saved.id);
      setSaved(latest);
      setDraft(latest.document);
      setTitle(latest.title);
      setConflict(false);
      setNotice(`Loaded version ${latest.version} from the server.`);
    } catch (cause) {
      setError(toRequestError(cause));
    }
  }

  async function attachAsset(sceneId: string, mediaId: string): Promise<boolean> {
    const next: ProjectDocumentV2 = {
      ...draft,
      scenes: draft.scenes.map((scene) =>
        scene.id === sceneId && !scene.assetIds.includes(mediaId)
          ? { ...scene, assetIds: [...scene.assetIds, mediaId] }
          : scene,
      ),
    };
    setDraft(next);
    const ok = await saveDocument(next);
    if (ok) setNotice(`Media ${mediaId.slice(0, 8)} attached to the scene and saved.`);
    return ok;
  }

  return (
    <div className="workspace editor">
      <section className="panel editor-header" aria-labelledby="editor-heading">
        <div className="editor-header-top">
          <button type="button" className="button-secondary button-small" onClick={onBack} disabled={saving}>
            Back to dashboard
          </button>
          <span className="status">{saved.projectType}</span>
        </div>

        <div className="editor-title-row">
          <div className="editor-title">
            <label className="field-label" htmlFor="project-title">
              Project title
            </label>
            <h2 className="sr-only" id="editor-heading">
              Editing project
            </h2>
            <input
              id="project-title"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Project title"
            />
          </div>
          <div className="editor-save">
            <span className="hint" role="status">
              {saving ? "Saving..." : dirty ? "Unsaved changes" : "Saved"}
            </span>
            <button
              type="button"
              onClick={() => void saveDocument(draft)}
              disabled={!dirty || saving || !title.trim()}
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
        <p className="hint">
          Version {saved.version} · document schema {saved.schemaVersion} · scene ids stay stable, and saving is
          explicit so one change is one revision.
        </p>
      </section>

      {conflict && (
        <div className="alert" role="alert">
          <strong>PROJECT_VERSION_CONFLICT</strong>
          <p>Another save changed this project after it was opened. Your draft is still here.</p>
          <div className="button-row">
            <button type="button" className="button-secondary button-small" onClick={() => void reloadLatest()}>
              Load latest version
            </button>
          </div>
        </div>
      )}

      {error && !conflict && (
        <div className="alert" role="alert">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
        </div>
      )}

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="tab-bar" role="tablist" aria-label="Project sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "tab tab-active" : "tab"}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={TABS.find((item) => item.id === tab)?.label}>
        {tab === "brief" && (
          <BriefPanel brief={draft.brief} onChange={(brief) => setDraft({ ...draft, brief })} />
        )}
        {tab === "script" && (
          <ScriptPanel
            scenes={draft.scenes}
            targetDurationSeconds={draft.brief.targetDurationSeconds}
            onChange={(scenes) => setDraft({ ...draft, scenes })}
          />
        )}
        {tab === "storyboard" && (
          <StoryboardPanel
            scenes={draft.scenes}
            targetDurationSeconds={draft.brief.targetDurationSeconds}
            onChange={(scenes) => setDraft({ ...draft, scenes })}
          />
        )}
        {tab === "media" && (
          <MediaPanel
            projectId={saved.id}
            scenes={draft.scenes}
            getAccessToken={getAccessToken}
            onAttachAsset={attachAsset}
            onBusyChange={setMediaBusy}
          />
        )}
        {tab === "preview" && <PreviewPanel title={title} projectDocument={draft} />}
        {tab === "settings" && (
          <SettingsPanel project={saved} getAccessToken={getAccessToken} onDeleted={onDeleted} />
        )}
      </div>
    </div>
  );
}
