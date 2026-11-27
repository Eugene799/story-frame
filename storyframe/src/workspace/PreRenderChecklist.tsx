import { useEffect, useState } from "react";
import type { MediaRecord } from "../../shared/media-contract";
import type { NarrationStateResponse } from "../../shared/narration-contract";
import type { ProjectScene } from "../../shared/project-contract";
import { getNarrationState, listProjectMedia } from "../api";
import { formatDuration, totalDurationSeconds } from "./model";

interface PreRenderChecklistProps {
  projectId: string;
  scenes: ProjectScene[];
  projectVersion: number;
  dirty: boolean;
  getAccessToken: () => Promise<string>;
}

interface AssetIssue {
  scene: ProjectScene;
  sceneIndex: number;
  assetId: string;
  state: "missing" | "pending" | "deleted";
}

/**
 * Phase 10 preflight. It reports what the editor already knows before a paid
 * render: every attached asset's stored state, which scenes will fall back to
 * a text card, and the narration duration measured from the stored audio.
 */
export function PreRenderChecklist({
  projectId,
  scenes,
  projectVersion,
  dirty,
  getAccessToken,
}: PreRenderChecklistProps) {
  const [media, setMedia] = useState<MediaRecord[] | null>(null);
  const [narration, setNarration] = useState<NarrationStateResponse | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [narrationError, setNarrationError] = useState(false);

  useEffect(() => {
    let active = true;
    setMedia(null);
    setNarration(null);
    setMediaError(false);
    setNarrationError(false);

    (async () => {
      let token: string;
      try {
        token = await getAccessToken();
      } catch {
        if (!active) return;
        setMediaError(true);
        setNarrationError(true);
        return;
      }

      const [mediaResult, narrationResult] = await Promise.allSettled([
        listProjectMedia(token, projectId),
        getNarrationState(token, projectId),
      ]);
      if (!active) return;
      if (mediaResult.status === "fulfilled") setMedia(mediaResult.value);
      else setMediaError(true);
      if (narrationResult.status === "fulfilled") setNarration(narrationResult.value);
      else setNarrationError(true);
    })();

    return () => {
      active = false;
    };
    // The token helper reads the live session; a saved version changes the stored media/narration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projectVersion]);

  const byId = new Map((media ?? []).map((item) => [item.id, item]));
  const issues: AssetIssue[] = [];
  const textOnlyScenes: { scene: ProjectScene; sceneIndex: number }[] = [];

  scenes.forEach((scene, sceneIndex) => {
    let hasVisual = false;
    for (const assetId of scene.assetIds) {
      const item = byId.get(assetId);
      if (item !== undefined && item.kind !== "audio") hasVisual = true;
      if (!item) {
        issues.push({ scene, sceneIndex, assetId, state: "missing" });
        continue;
      }
      if (item.status !== "ready") {
        issues.push({
          scene,
          sceneIndex,
          assetId,
          state: item.status === "deleted" ? "deleted" : "pending",
        });
      }
    }
    if (!hasVisual) textOnlyScenes.push({ scene, sceneIndex });
  });

  const timelineSeconds = totalDurationSeconds(scenes);
  const measuredNarrationSeconds = narration?.narration?.durationSeconds ?? null;
  const narrationDifference =
    measuredNarrationSeconds === null
      ? null
      : Number((measuredNarrationSeconds - timelineSeconds).toFixed(3));
  const loading = media === null && !mediaError;
  const narrationLoading = narration === null && !narrationError;
  const mediaStatus = loading
    ? "Checking"
    : mediaError
      ? "Media check unavailable"
      : issues.length === 0
        ? "No blocking media issues"
        : `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
  const mediaStatusClass =
    !loading && !mediaError && issues.length === 0 ? "status status-ok" : "status";

  return (
    <div className="preflight-block" aria-labelledby="preflight-heading">
      <div className="panel-heading media-heading">
        <h3 id="preflight-heading">Pre-render checklist</h3>
        <span className={mediaStatusClass}>{mediaStatus}</span>
      </div>

      <p className="hint" aria-label="Render snapshot">
        Exports pin revision v{projectVersion}.{" "}
        {dirty
          ? "Save the draft before exporting; unsaved changes are not in that revision."
          : "This saved revision is what the render will use."}
      </p>

      {loading && <p className="muted">Checking attached media and narration...</p>}

      {mediaError && (
        <p className="alert" role="alert">
          Media readiness could not be read. The server still refuses missing or pending assets at export time.
        </p>
      )}

      {issues.length > 0 && (
        <div className="alert" role="alert">
          <strong>Attached media needs attention</strong>
          <ul>
            {issues.map((issue) => (
              <li key={`${issue.scene.id}:${issue.assetId}`}>
                Scene {issue.sceneIndex + 1} “{issue.scene.heading}” lists {issue.assetId.slice(0, 8)}:{" "}
                {issue.state === "missing"
                  ? "not in this project"
                  : issue.state === "deleted"
                    ? "deleted"
                    : "upload not complete"}
                .
              </li>
            ))}
          </ul>
        </div>
      )}

      {media !== null && textOnlyScenes.length > 0 && (
        <div className="callout" role="note">
          <strong>
            {textOnlyScenes.length} scene{textOnlyScenes.length === 1 ? "" : "s"} without a visual
          </strong>
          <p>
            {textOnlyScenes
              .map(({ scene, sceneIndex }) => `Scene ${sceneIndex + 1}: ${scene.heading}`)
              .join(" · ")}
          </p>
          <p className="hint">These scenes render as on-screen-text cards; this is not a missing-file error.</p>
        </div>
      )}

      {narrationError ? (
        <p className="hint">Measured narration is unavailable for this project.</p>
      ) : narrationLoading ? (
        <p className="hint">Checking narration duration...</p>
      ) : (
        <p className="hint" aria-label="Measured narration duration">
          {measuredNarrationSeconds === null
            ? `No active narration is attached. The render uses the ${formatDuration(timelineSeconds)} scene timeline.`
            : `Measured narration: ${measuredNarrationSeconds.toFixed(1)}s. Scene timeline: ${formatDuration(timelineSeconds)}${
                narrationDifference === null
                  ? "."
                  : ` (${narrationDifference >= 0 ? "+" : ""}${narrationDifference}s).`
              }`}
        </p>
      )}
    </div>
  );
}
