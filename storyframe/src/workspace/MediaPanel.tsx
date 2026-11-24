import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  MediaKind,
  MediaPlayback,
  MediaRecord,
} from "../../shared/media-contract";
import type { ProjectScene } from "../../shared/project-contract";
import {
  AiRequestError,
  attachMediaReference,
  completeMediaUpload,
  deleteMediaRecord,
  getMediaPlaybackUrl,
  initiateMediaUpload,
  listProjectMedia,
  uploadMediaObject,
} from "../api";
import { formatBytes } from "./model";

const KIND_BY_MIME: { prefix: string; kind: MediaKind }[] = [
  { prefix: "image/", kind: "image" },
  { prefix: "audio/", kind: "audio" },
  { prefix: "video/", kind: "video" },
];

const MAX_BYTES: Record<MediaKind, number> = {
  image: 10 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  video: 200 * 1024 * 1024,
};

function kindFor(contentType: string): MediaKind | null {
  return KIND_BY_MIME.find((entry) => contentType.startsWith(entry.prefix))?.kind ?? null;
}

function toRequestError(cause: unknown): AiRequestError {
  if (cause instanceof AiRequestError) return cause;
  return new AiRequestError(
    "NETWORK_ERROR",
    cause instanceof Error ? cause.message : "The request could not be completed.",
    0,
  );
}

function MediaPlaybackView({
  media,
  projectId,
  getAccessToken,
}: {
  media: MediaRecord;
  projectId: string;
  getAccessToken: () => Promise<string>;
}) {
  const [playback, setPlayback] = useState<MediaPlayback | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (media.status !== "ready") return;
    setLoading(true);
    setError(null);
    try {
      setPlayback(await getMediaPlaybackUrl(await getAccessToken(), projectId, media.id));
    } catch (cause) {
      setError(toRequestError(cause).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (media.status !== "ready") return;
    let active = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const next = await getMediaPlaybackUrl(await getAccessToken(), projectId, media.id);
        if (active) setPlayback(next);
      } catch (cause) {
        if (active) setError(toRequestError(cause).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // The media id and status decide whether a private playback link is needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.id, media.status, projectId]);

  if (media.status !== "ready") {
    return (
      <p className="hint">
        {media.status === "pending"
          ? "Upload is not complete, so there is nothing to play yet."
          : "This asset was deleted."}
      </p>
    );
  }

  return (
    <div className="media-playback">
      {loading && <p className="hint">Requesting a private playback link...</p>}
      {error && <p className="alert">{error}</p>}
      {playback && (
        <>
          {media.kind === "image" && (
            <img className="media-image" src={playback.url} alt={`Uploaded image ${media.id.slice(0, 8)}`} />
          )}
          {media.kind === "audio" && <audio controls src={playback.url} className="media-audio" />}
          {media.kind === "video" && <video controls src={playback.url} className="media-video" />}
          <p className="hint">
            Private link expires {new Date(playback.expiresAt).toLocaleTimeString()}.
          </p>
        </>
      )}
      <button
        type="button"
        className="button-secondary button-small"
        onClick={load}
        disabled={loading}
      >
        Refresh playback link
      </button>
    </div>
  );
}

interface MediaPanelProps {
  projectId: string;
  scenes: ProjectScene[];
  getAccessToken: () => Promise<string>;
  onAttachAsset: (sceneId: string, mediaId: string) => Promise<boolean>;
  onBusyChange?: (busy: boolean) => void;
}

export function MediaPanel({
  projectId,
  scenes,
  getAccessToken,
  onAttachAsset,
  onBusyChange,
}: MediaPanelProps) {
  const [media, setMedia] = useState<MediaRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState(scenes[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!scenes.some((scene) => scene.id === sceneId)) {
      setSceneId(scenes[0]?.id ?? "");
    }
  }, [scenes, sceneId]);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    (async () => {
      try {
        const list = await listProjectMedia(await getAccessToken(), projectId);
        if (active) setMedia(list);
      } catch (cause) {
        if (active) setLoadError(toRequestError(cause).message);
      }
    })();
    return () => {
      active = false;
    };
    // Loading is tied to the project; the token helper reads the live session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || uploading) return;

    const kind = kindFor(file.type);
    setError(null);
    setNotice(null);
    if (!kind) {
      setError(
        new AiRequestError(
          "INVALID_MEDIA_TYPE",
          "Choose an image, audio, or video file. Other file types are refused.",
          400,
        ),
      );
      return;
    }
    if (file.size > MAX_BYTES[kind]) {
      setError(
        new AiRequestError(
          "MEDIA_TOO_LARGE",
          `${kind} files may be at most ${formatBytes(MAX_BYTES[kind])}.`,
          400,
        ),
      );
      return;
    }

    setUploading(true);
    onBusyChange?.(true);
    try {
      const accessToken = await getAccessToken();
      // The scene link is the explicit reference below. Sending `sceneKey` too
      // would make the media store count the same scene twice and refuse deletion.
      const initiation = await initiateMediaUpload(accessToken, projectId, {
        kind,
        contentType: file.type,
        byteSize: file.size,
      });
      setMedia((current) => [initiation.media, ...(current ?? [])]);

      // The browser sends the bytes straight to private storage. It never sees a
      // storage credential, only this short-lived presigned ticket.
      await uploadMediaObject(initiation.upload, file);
      const completed = await completeMediaUpload(accessToken, projectId, initiation.media.id);
      setMedia((current) =>
        (current ?? []).map((item) => (item.id === completed.id ? completed : item)),
      );

      if (sceneId) {
        const reference = await attachMediaReference(accessToken, projectId, completed.id, {
          refKind: "scene",
          refId: sceneId,
        });
        setMedia((current) =>
          (current ?? []).map((item) =>
            item.id === completed.id
              ? { ...item, referenceCount: item.referenceCount + 1 }
              : item,
          ),
        );
        const saved = await onAttachAsset(sceneId, completed.id);
        const scene = scenes.find((candidate) => candidate.id === sceneId);
        setNotice(
          saved
            ? `Uploaded, completed, and attached to ${scene ? `"${scene.heading}"` : "the selected scene"}. The saved scene now lists this asset.`
            : `Uploaded and referenced (reference ${reference.id.slice(0, 8)}), but the project save did not complete. The draft still lists the asset; resolve the save error and retry.`,
        );
      } else {
        setNotice("Uploaded and completed. It is not attached to a scene yet.");
      }

      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setUploading(false);
      onBusyChange?.(false);
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="media-heading">
      <div className="panel-heading">
        <h2 id="media-heading">Media</h2>
        <span className="status status-dev">Private R2</span>
      </div>
      <p className="muted editor-intro">
        Files upload directly to private storage with a presigned ticket, then the server verifies and records them.
        Playback links are fetched fresh and expire quickly; nothing here is public.
      </p>

      <form className="upload-form" onSubmit={handleUpload}>
        <label className="field" htmlFor="media-file">
          <span className="field-label">Media file</span>
          <input
            id="media-file"
            ref={fileInput}
            type="file"
            accept="image/*,audio/*,video/*"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            disabled={uploading}
          />
          <span className="hint">Image up to 10 MiB, audio 25 MiB, video 200 MiB.</span>
        </label>

        <label className="field" htmlFor="media-scene">
          <span className="field-label">Attach to scene</span>
          <select
            id="media-scene"
            value={sceneId}
            onChange={(event) => setSceneId(event.target.value)}
            disabled={uploading}
          >
            <option value="">Unattached</option>
            {scenes.map((scene, index) => (
              <option key={scene.id} value={scene.id}>
                Scene {index + 1}: {scene.heading}
              </option>
            ))}
          </select>
        </label>

        <div className="editor-actions">
          <button type="submit" disabled={!file || uploading}>
            {uploading ? "Uploading..." : "Upload media"}
          </button>
          <p className="hint">
            Upload, completion, scene reference, and the saved asset id all happen in one action.
          </p>
        </div>
      </form>

      {error && (
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

      <div className="panel-heading media-heading">
        <h3>Project media</h3>
        {media && <span className="status">{media.length}</span>}
      </div>

      {!media && !loadError && <p className="muted">Loading media records...</p>}
      {loadError && <p className="alert">{loadError}</p>}
      {media && media.length === 0 && (
        <p className="empty-state">No media yet. Upload an image, audio clip, or video for a scene.</p>
      )}

      <div className="media-list">
        {media?.map((item) => (
          <MediaItem
            key={item.id}
            media={item}
            projectId={projectId}
            getAccessToken={getAccessToken}
            onDeleted={(id) => setMedia((current) => (current ?? []).filter((record) => record.id !== id))}
          />
        ))}
      </div>
    </section>
  );
}

function MediaItem({
  media,
  projectId,
  getAccessToken,
  onDeleted,
}: {
  media: MediaRecord;
  projectId: string;
  getAccessToken: () => Promise<string>;
  onDeleted: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await deleteMediaRecord(await getAccessToken(), projectId, media.id);
      onDeleted(media.id);
    } catch (cause) {
      setError(toRequestError(cause).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className="media-item" aria-label={`Media ${media.id}`}>
      <div className="media-item-header">
        <div>
          <span className="status">{media.kind}</span>{" "}
          <span className="status">{media.status}</span>
          <p className="hint">
            {media.contentType} · {formatBytes(media.byteSize)} · {media.referenceCount} reference
            {media.referenceCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="button-row">
          {!confirming ? (
            <button
              type="button"
              className="button-secondary button-small button-danger"
              onClick={() => setConfirming(true)}
              disabled={deleting}
            >
              Delete asset
            </button>
          ) : (
            <>
              <button
                type="button"
                className="button-secondary button-small button-danger"
                onClick={remove}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Confirm delete"}
              </button>
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      <MediaPlaybackView media={media} projectId={projectId} getAccessToken={getAccessToken} />
      {error && <p className="alert">{error}</p>}
    </article>
  );
}
