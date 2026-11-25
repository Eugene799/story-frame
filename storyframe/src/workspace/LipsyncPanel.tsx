import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AiRequestError,
  deleteLipsyncExport,
  getLipsyncPlayback,
  listLipsyncExports,
  listProjectMedia,
  submitLipsyncExport,
} from "../api";
import type { MediaRecord } from "../../shared/media-contract";
import {
  LIPSYNC_RESOLUTIONS,
  LIPSYNC_MAX_SOURCE_SECONDS,
  LIPSYNC_RATE_VERSION,
  lipsyncEstimateUsd,
  type LipsyncExportRecord,
  type LipsyncResolution,
  type LipsyncUsageSummary,
} from "../../shared/lipsync-contract";

/**
 * Lip sync panel: picks one source (clip or portrait) and one audio track that
 * are already ready in this project, submits once, then shows the provider's
 * progress until the copy appears in private storage.
 */

interface LipsyncPanelProps {
  projectId: string;
  getAccessToken: () => Promise<string>;
  pollIntervalMs?: number;
}

function toRequestError(cause: unknown): AiRequestError {
  return cause instanceof AiRequestError
    ? cause
    : new AiRequestError("REQUEST_FAILED", cause instanceof Error ? cause.message : "The request failed.", 0);
}

function formatSeconds(value: number): string {
  return `${value.toFixed(0)} s`;
}

export function LipsyncPanel({ projectId, getAccessToken, pollIntervalMs = 4000 }: LipsyncPanelProps) {
  const [media, setMedia] = useState<MediaRecord[]>([]);
  const [exports, setExports] = useState<LipsyncExportRecord[]>([]);
  const [usage, setUsage] = useState<LipsyncUsageSummary | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [audioId, setAudioId] = useState("");
  const [resolution, setResolution] = useState<LipsyncResolution>("720p");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playback, setPlayback] = useState<{ exportId: string; url: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const token = await getAccessToken();
    const [listed, files] = await Promise.all([listLipsyncExports(token, projectId), listProjectMedia(token, projectId)]);
    if (!mounted.current) return;
    // A 200 with an unexpected body must not take the Preview tab down with it.
    setExports(Array.isArray(listed.exports) ? listed.exports : []);
    setUsage(listed.usage ?? null);
    setMedia(Array.isArray(files) ? files : []);
  }, [getAccessToken, projectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } catch (cause) {
        if (!cancelled) setError(toRequestError(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const latest = exports[0] ?? null;
  const pending = latest?.status === "pending";
  const ready = media.filter((file) => file.status === "ready");
  const sources = ready.filter((file) => file.kind === "video" || file.kind === "image");
  const audioFiles = ready.filter((file) => file.kind === "audio");

  // Poll only while a task is in flight, and stop as soon as it settles.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      void refresh().catch((cause: unknown) => {
        if (mounted.current) setError(toRequestError(cause));
      });
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [pending, pollIntervalMs, refresh]);

  // Load a playback link for a finished export, once per export.
  useEffect(() => {
    if (!latest || latest.status !== "ready" || playback?.exportId === latest.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = await getLipsyncPlayback(await getAccessToken(), projectId, latest.id);
        if (!cancelled) setPlayback({ exportId: latest.id, url: url.url });
      } catch {
        if (!cancelled) setPlayback(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [latest, playback, getAccessToken, projectId]);

  const estimate = useMemo(() => lipsyncEstimateUsd(LIPSYNC_MAX_SOURCE_SECONDS), []);

  async function submit(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await submitLipsyncExport(await getAccessToken(), projectId, {
        sourceMediaId: sourceId,
        audioMediaId: audioId,
        resolution,
      });
      setConfirmDelete(false);
      setNotice(`Lip sync queued at ${resolution}: up to ${LIPSYNC_MAX_SOURCE_SECONDS} s of Everypixel output.`);
      await refresh();
    } catch (cause) {
      setError(toRequestError(cause));
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(): Promise<void> {
    if (!latest || deleting) return;
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      await deleteLipsyncExport(await getAccessToken(), projectId, latest.id);
      setPlayback(null);
      setConfirmDelete(false);
      setNotice("The lip sync and its stored MP4 were deleted. Its seconds stay in the window above.");
      await refresh();
    } catch (cause) {
      setError(toRequestError(cause));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  const reason = pending
    ? "A lip sync is already running for this project. Wait for it to finish."
    : sources.length === 0
      ? "Add a ready clip or portrait to this project first."
      : audioFiles.length === 0
        ? "Add a ready audio track to this project first."
        : !sourceId || !audioId
          ? "Choose both a source and an audio track."
          : null;

  if (loading) {
    return (
      <section className="export-block">
        <h2>Lip sync</h2>
        <p className="hint">Checking lip sync state...</p>
      </section>
    );
  }

  return (
    <section className="export-block">
      <h2>Lip sync</h2>
      <p className="hint">
        Everypixel Labs re-animates the mouth of a talking clip or portrait to match an audio track. Both files are sent
        inline, so each may be at most 25 MB and the source may be at most {LIPSYNC_MAX_SOURCE_SECONDS} seconds.
      </p>

      {usage && (
        <p className="hint" aria-label="Lip sync usage">
          Last {usage.windowHours} hours: {formatSeconds(usage.secondsUsed)} of{" "}
          {usage.secondsLimit === null ? "unlimited" : formatSeconds(usage.secondsLimit)} lip sync time used
          {usage.usdLimit === null ? "" : ` · $${usage.usdUsed.toFixed(2)} of $${usage.usdLimit.toFixed(2)}`}
          {usage.resetAt === null ? "" : ` · resets ${new Date(usage.resetAt).toLocaleTimeString()}`}
        </p>
      )}

      <div className="button-row">
        <label>
          Source
          <select
            aria-label="Lip sync source"
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
            disabled={pending || submitting}
          >
            <option value="">Choose a clip or portrait</option>
            {sources.map((file) => (
              <option key={file.id} value={file.id}>
                {file.kind} · {file.contentType} · {(file.byteSize / 1024).toFixed(0)} KB
              </option>
            ))}
          </select>
        </label>

        <label>
          Audio
          <select
            aria-label="Lip sync audio"
            value={audioId}
            onChange={(event) => setAudioId(event.target.value)}
            disabled={pending || submitting}
          >
            <option value="">Choose an audio track</option>
            {audioFiles.map((file) => (
              <option key={file.id} value={file.id}>
                {file.contentType} · {(file.byteSize / 1024).toFixed(0)} KB
              </option>
            ))}
          </select>
        </label>

        <label>
          Resolution
          <select
            aria-label="Lip sync resolution"
            value={resolution}
            onChange={(event) => setResolution(event.target.value as LipsyncResolution)}
            disabled={pending || submitting}
          >
            {LIPSYNC_RESOLUTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="hint">
        This export: up to {LIPSYNC_MAX_SOURCE_SECONDS} s · about ${estimate.toFixed(2)} at the published 720p rate
        ({LIPSYNC_RATE_VERSION}). 360p and 480p are cheaper but not publicly priced.
      </p>

      <button type="button" className="button" onClick={() => void submit()} disabled={reason !== null || submitting}>
        {submitting ? "Submitting..." : "Run lip sync"}
      </button>
      {reason && !submitting && <p className="hint">{reason}</p>}

      {notice && <p className="hint" role="status">{notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error.code}: {error.message}
        </p>
      )}

      {latest && (
        <div className="export-block">
          <h3>Latest lip sync</h3>
          <p className="hint">
            {latest.status === "ready" ? "READY" : latest.status === "pending" ? "PENDING" : "FAILED"}
            {latest.providerStatus ? ` · ${latest.providerStatus}` : ""}
          </p>
          <p className="hint">
            {latest.resolution} · {formatSeconds(latest.secondsCounted ?? latest.secondsEstimate)}{" "}
            {latest.secondsCounted === null ? "reserved" : "used"} · about ${latest.usdEstimate.toFixed(2)}
            {latest.byteSize === null ? "" : ` · ${(latest.byteSize / 1024).toFixed(0)} KB`}
          </p>

          {latest.status === "pending" && (
            <p className="hint" role="status">
              Everypixel is processing this lip sync ({latest.providerStatus ?? "queued"}). It continues on the server
              even if you leave this tab, and it cannot be cancelled.
            </p>
          )}

          {latest.status === "failed" && (
            <p className="error" role="alert">
              {latest.failureCode}: {latest.failureMessage}
            </p>
          )}

          {latest.status === "ready" &&
            (playback && playback.exportId === latest.id ? (
              <video controls src={playback.url} aria-label="Lip sync playback" />
            ) : (
              <p className="hint">Requesting a private playback link...</p>
            ))}

          <div className="button-row">
            {!confirmDelete ? (
              <button
                type="button"
                className="button-secondary button-small button-danger"
                onClick={() => setConfirmDelete(true)}
                disabled={deleting || latest.status === "pending"}
              >
                Delete lip sync
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="button-secondary button-small button-danger"
                  onClick={() => void remove()}
                  disabled={deleting}
                >
                  {deleting ? "Deleting..." : "Confirm delete lip sync"}
                </button>
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
