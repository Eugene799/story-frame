import { useEffect, useState } from "react";
import {
  VIDEO_CREDITS_PER_SECOND,
  type VideoExportsResponse,
} from "../../shared/video-contract";
import { AiRequestError, getVideoExportPlayback, listVideoExports, submitVideoExport } from "../api";
import { formatBytes, formatDuration } from "./model";

/** Seconds between status reads while the server is still rendering. */
const DEFAULT_POLL_MS = 4000;

function toRequestError(cause: unknown): AiRequestError {
  if (cause instanceof AiRequestError) return cause;
  return new AiRequestError(
    "NETWORK_ERROR",
    cause instanceof Error ? cause.message : "The request could not be completed.",
    0,
  );
}

/** One key per attempt, so a double click cannot start two paid renders. */
function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `video-export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface VideoExportSectionProps {
  projectId: string;
  /** The saved revision the render must match. */
  projectVersion: number;
  dirty: boolean;
  sceneCount: number;
  unapprovedScenes: number;
  estimateSeconds: number;
  getAccessToken: () => Promise<string>;
  /** The tests poll quickly; production waits seconds, not milliseconds. */
  pollIntervalMs?: number;
}

/**
 * Phase 9 export UI. The server owns the render: this shows the spend window,
 * the estimate, the live status of the newest export, its failure reason, and
 * playback of our own stored MP4. No provider URL ever reaches the browser.
 */
export function VideoExportSection({
  projectId,
  projectVersion,
  dirty,
  sceneCount,
  unapprovedScenes,
  estimateSeconds,
  getAccessToken,
  pollIntervalMs = DEFAULT_POLL_MS,
}: VideoExportSectionProps) {
  const [state, setState] = useState<VideoExportsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [playback, setPlayback] = useState<{ exportId: string; url: string } | null>(null);

  const usage = state?.usage ?? null;
  const records = state?.exports ?? [];
  const current = records[0] ?? null;
  const history = records.slice(1);
  const live = current?.status === "pending";
  const estimateCredits = Math.ceil(estimateSeconds * VIDEO_CREDITS_PER_SECOND);

  async function refresh(): Promise<void> {
    try {
      setState(await listVideoExports(await getAccessToken(), projectId));
      setLoadError(null);
    } catch (cause) {
      setLoadError(toRequestError(cause).message);
    }
  }

  useEffect(() => {
    let active = true;
    setLoadError(null);
    (async () => {
      try {
        const next = await listVideoExports(await getAccessToken(), projectId);
        if (active) setState(next);
      } catch (cause) {
        if (active) setLoadError(toRequestError(cause).message);
      }
    })();
    return () => {
      active = false;
    };
    // The token helper reads the live session; the project decides the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // The sweep on the server is the only clock; this only keeps the label fresh.
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, projectId, pollIntervalMs]);

  // A ready export gets one short-lived private URL for our own stored object.
  useEffect(() => {
    if (!current || current.status !== "ready" || current.mediaId === null) {
      setPlayback(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const next = await getVideoExportPlayback(await getAccessToken(), projectId, current.id);
        if (active) setPlayback({ exportId: current.id, url: next.url });
      } catch {
        if (active) setPlayback(null);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, current?.id, current?.status, current?.mediaId]);

  // Every gate that would be refused by the server is a disabled button here,
  // with the same reason, so nothing is submitted just to be told no.
  const blocked =
    sceneCount === 0
      ? "Add at least one scene before exporting video."
      : dirty
        ? "Save the project before exporting, so the render matches this preview."
        : unapprovedScenes > 0
          ? "Approve every scene before exporting video."
          : live
            ? "A video export is already running for this project. Wait for it to finish."
            : null;

  async function submit(): Promise<void> {
    if (blocked !== null || submitting) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await submitVideoExport(
        await getAccessToken(),
        projectId,
        projectVersion,
        newIdempotencyKey(),
      );
      setState((previous) => ({
        ok: true,
        exports: [result.export, ...(previous?.exports ?? []).filter((row) => row.id !== result.export.id)],
        usage: result.usage,
      }));
      setNotice(
        `Export queued for revision ${result.export.projectRevision}: about ${result.export.creditsEstimate} credits. ` +
          "It keeps rendering on the server.",
      );
    } catch (cause) {
      setError(toRequestError(cause));
      // A refusal or a failed submit still moves the spend window.
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="export-block" aria-labelledby="video-export-heading">
      <h3 id="video-export-heading">Video export</h3>
      <p className="muted">
        JSON2Video renders the saved revision into an MP4 that is copied into private storage. Billing is{" "}
        {VIDEO_CREDITS_PER_SECOND} credit per second of output; there is no dollar price, and a started render cannot be
        cancelled.
      </p>

      {loadError && <p className="alert">{loadError}</p>}

      {usage && (
        <p className="hint" aria-label="Video credit usage">
          Last {usage.windowHours} hours: {usage.creditsUsed}
          {usage.creditsLimit === null
            ? " video credits used (no limit set)"
            : ` of ${usage.creditsLimit} video credits used`}
          {usage.resetAt ? ` · resets ${new Date(usage.resetAt).toLocaleTimeString()}` : ""}
        </p>
      )}

      {!dirty && (
        <p className="hint">
          This render: {formatDuration(estimateSeconds)} of footage · about {estimateCredits} credit
          {estimateCredits === 1 ? "" : "s"} at {VIDEO_CREDITS_PER_SECOND} credit per second.
        </p>
      )}

      <div className="button-row">
        <button type="button" onClick={() => void submit()} disabled={blocked !== null || submitting}>
          {submitting ? "Starting export..." : "Export video"}
        </button>
      </div>
      {blocked && <p className="hint">{blocked}</p>}

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="alert" role="alert">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
        </div>
      )}

      {current && (
        <div className="video-export-current">
          <div className="panel-heading media-heading">
            <h3>Latest export</h3>
            <span className="status">
              {current.status}
              {current.providerStatus ? ` · ${current.providerStatus}` : ""}
            </span>
          </div>
          <p className="hint">
            Revision {current.projectRevision} · {current.creditsEstimate} credit
            {current.creditsEstimate === 1 ? "" : "s"} estimated ·{" "}
            {current.creditsConsumed === null
              ? "not settled yet"
              : `${current.creditsConsumed} credit${current.creditsConsumed === 1 ? "" : "s"} used`}
            {current.durationSeconds !== null ? ` · ${formatDuration(current.durationSeconds)}` : ""}
            {current.byteSize !== null ? ` · ${formatBytes(current.byteSize)}` : ""}
            {current.width !== null && current.height !== null
              ? ` · ${current.width}×${current.height}`
              : ""}
          </p>

          {current.status === "pending" && (
            <p className="hint" role="status">
              JSON2Video is rendering this export ({current.providerStatus ?? "queued"}). It advances on the server even
              if you leave this tab.
            </p>
          )}

          {current.status === "failed" && (
            <div className="alert" role="alert">
              <strong>{current.failureCode ?? "Failed"}</strong>
              <p>{current.failureMessage ?? "This export failed."}</p>
            </div>
          )}

          {current.status === "ready" &&
            (playback && playback.exportId === current.id ? (
              <video controls src={playback.url} aria-label="Video export playback" />
            ) : (
              <p className="hint">Requesting a private playback link...</p>
            ))}
        </div>
      )}

      {history.length > 0 && (
        <>
          <h4>Earlier exports</h4>
          <ul className="video-export-list">
            {history.map((record) => (
              <li key={record.id}>
                <span>{new Date(record.createdAt).toLocaleString()}</span>
                <span>
                  {record.status}
                  {record.failureCode ? ` · ${record.failureCode}` : ""}
                </span>
                <span>
                  {record.creditsConsumed ?? record.creditsEstimate} credit
                  {record.creditsConsumed === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
