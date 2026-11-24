import { sceneFingerprint } from "../../shared/scene-fingerprint";
import type { ProjectDocumentV2 } from "../../shared/project-contract";
import { formatDuration, totalDurationSeconds } from "./model";

interface PreviewPanelProps {
  title: string;
  projectDocument: ProjectDocumentV2;
}

function downloadFile(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  globalThis.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function slugFor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "storyframe-project";
}

export function PreviewPanel({ title, projectDocument }: PreviewPanelProps) {
  const scenes = projectDocument.scenes;
  const total = totalDurationSeconds(scenes);

  function exportJson() {
    downloadFile(
      `${slugFor(title)}.json`,
      JSON.stringify({ title, document: projectDocument }, null, 2),
      "application/json",
    );
  }

  function exportScript() {
    const script = scenes
      .map((scene, index) => {
        const lines = [
          `SCENE ${index + 1} — ${scene.heading}`,
          "",
          scene.body || "(no narration)",
          "",
          `VISUAL: ${scene.visualDirection || "(none)"}`,
          `ON SCREEN: ${scene.onScreenText || "(none)"}`,
          `DURATION: ${scene.durationSeconds}s`,
        ];
        return lines.join("\n");
      })
      .join("\n\n---\n\n");

    downloadFile(
      `${slugFor(title)}-script.txt`,
      `${title}\n\n${script}\n`,
      "text/plain",
    );
  }

  return (
    <section className="panel editor-panel" aria-labelledby="preview-heading">
      <div className="panel-heading">
        <h2 id="preview-heading">Preview</h2>
        <span className="status">{formatDuration(total)} total</span>
      </div>

      <div className="callout" role="note">
        <strong>This is a storyboard preview, not a rendered movie.</strong>
        <p>
          It shows exactly the editable script, visual direction, on-screen text, media count, and timing stored in
          this project. No video is generated in Phase 4.
        </p>
      </div>

      <div className="preview-list">
        {scenes.map((scene, index) => {
          const approved =
            scene.approved && scene.approvedFingerprint === sceneFingerprint(scene);
          return (
            <article className="preview-card" key={scene.id}>
              <header>
                <span className="scene-number">{index + 1}</span>
                <h3>{scene.heading}</h3>
                <span className="duration-pill">{formatDuration(scene.durationSeconds)}</span>
              </header>
              <p className="preview-narration">{scene.body || <span className="muted">No narration yet.</span>}</p>
              <dl className="preview-facts">
                <div>
                  <dt>Visual direction</dt>
                  <dd>{scene.visualDirection || "Not set"}</dd>
                </div>
                <div>
                  <dt>On-screen text</dt>
                  <dd>{scene.onScreenText || "None"}</dd>
                </div>
                <div>
                  <dt>Media</dt>
                  <dd>{scene.assetIds.length === 0 ? "None attached" : `${scene.assetIds.length} attached`}</dd>
                </div>
                <div>
                  <dt>Approval</dt>
                  <dd>{approved ? "Approved" : "Not approved for this content"}</dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>

      <div className="export-block">
        <h3>Export</h3>
        <p className="muted">
          Export the editable project as JSON or the script as plain text. Video export is not available in Phase 4;
          rendering belongs to Phase 9.
        </p>
        <div className="button-row">
          <button type="button" onClick={exportJson} disabled={scenes.length === 0}>
            Download project JSON
          </button>
          <button type="button" className="button-secondary" onClick={exportScript} disabled={scenes.length === 0}>
            Download script text
          </button>
        </div>
        <p className="hint">Both exports include exactly what is open here. The JSON reopens as an editable project.</p>
      </div>
    </section>
  );
}
