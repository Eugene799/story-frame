import type { ProductAdManifest } from "../shared/ad-concept-contract";
import type { ProjectDocumentV2, ProjectScene, SceneLocks } from "../shared/project-contract";
import { sceneFingerprint } from "../shared/scene-fingerprint";
import { ApiError } from "./api-error";
import { PROJECT_LIMITS } from "./projects";

/**
 * Phase 11: applying a frozen manifest to the campaign's project.
 *
 * A manifest is the approved ad, not a suggestion: each beat becomes an
 * already-approved scene, so the existing video export can render the saved
 * revision without a second approval pass. Scene ids are derived from the
 * concept, so applying the same manifest twice replaces its own scenes instead
 * of duplicating them, and scenes the user built for other ads are untouched.
 */

const NO_LOCKS: SceneLocks = {
  narration: false,
  visualDirection: false,
  onScreenText: false,
  duration: false,
};

export function adConceptSceneId(manifest: Pick<ProductAdManifest, "conceptId">, beatIndex: number): string {
  return `ad-${manifest.conceptId}-${beatIndex + 1}`;
}

/** The manifest's beats as approved project scenes, in order. */
export function buildAdConceptScenes(manifest: ProductAdManifest): ProjectScene[] {
  return manifest.beats.map((beat, index) => {
    const content = {
      id: adConceptSceneId(manifest, index),
      heading: beat.heading,
      body: beat.narration,
      visualDirection: beat.visualDirection,
      assetIds: beat.assetMediaId ? [beat.assetMediaId] : [],
      onScreenText: beat.onScreenText,
      durationSeconds: beat.durationSeconds,
    };
    return {
      ...content,
      approved: true,
      approvedFingerprint: sceneFingerprint(content),
      locks: NO_LOCKS,
    };
  });
}

/**
 * Adds the manifest's scenes to a copy of the document, replacing scenes with
 * the same ids. A project cannot hold more scenes than an editor save accepts,
 * so a full project is refused rather than silently dropping scenes.
 */
export function mergeAdConceptScenes(
  document: ProjectDocumentV2,
  manifest: ProductAdManifest,
): ProjectDocumentV2 {
  const scenes = [...document.scenes];
  for (const scene of buildAdConceptScenes(manifest)) {
    const existing = scenes.findIndex((candidate) => candidate.id === scene.id);
    if (existing === -1) scenes.push(scene);
    else scenes[existing] = scene;
  }
  if (scenes.length > PROJECT_LIMITS.scenes) {
    throw new ApiError(
      409,
      "AD_CONCEPT_PROJECT_FULL",
      `This project already holds ${document.scenes.length} scenes, and the ad needs ${manifest.beats.length} more. Delete unused scenes before applying the manifest.`,
    );
  }
  return { ...document, scenes };
}

/** Beat assets plus the logo: every image that must exist in the render project. */
export function manifestMediaIds(manifest: ProductAdManifest): string[] {
  const ids = manifest.beats
    .map((beat) => beat.assetMediaId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (manifest.logoMediaId) ids.push(manifest.logoMediaId);
  return [...new Set(ids)];
}
