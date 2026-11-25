import { describe, expect, it } from "vitest";
import { ApiError } from "../server/api-error";
import {
  assertMovieFits,
  assertNarrationFits,
  buildVideoMovie,
  estimateVideoExport,
  parseVideoExportInput,
  type BuildVideoMovieInput,
} from "../server/json2video";
import type { ProjectBrief, ProjectDocumentV2, ProjectScene } from "../shared/project-contract";
import { VIDEO_MOVIE_MAX_BYTES } from "../shared/video-contract";

const BRIEF: ProjectBrief = {
  topic: "",
  audience: "",
  goal: "",
  mode: "factual",
  targetDurationSeconds: 60,
  tone: "",
  preset: "",
  voicePreference: "neutral",
  planningBudgetUsd: 0,
};

function scene(overrides: Partial<ProjectScene> = {}): ProjectScene {
  return {
    id: "scene-1",
    heading: "INT. TRAIN CAR - NIGHT",
    body: "The letter waits under a seat.",
    visualDirection: "",
    assetIds: [],
    onScreenText: "",
    durationSeconds: 5,
    approved: true,
    approvedFingerprint: "fingerprint-1",
    locks: { narration: false, visualDirection: false, onScreenText: false, duration: false },
    ...overrides,
  };
}

function document(scenes: ProjectScene[]): ProjectDocumentV2 {
  return { schemaVersion: 2, summary: "", brief: BRIEF, scenes };
}

function build(overrides: Partial<BuildVideoMovieInput> = {}) {
  return buildVideoMovie({
    renderId: "render-1",
    projectRevision: 7,
    document: document([scene()]),
    resolution: "full-hd",
    maxSeconds: 600,
    visuals: { "scene-1": { kind: "image", url: "https://r2.example/media/a.jpg" } },
    narration: null,
    music: null,
    ...overrides,
  });
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof ApiError ? error.code : "NOT_AN_API_ERROR";
  }
}

describe("video movie builder", () => {
  it("maps an image scene to a covered visual plus on-screen text", () => {
    const result = build({ document: document([scene({ onScreenText: "A line" })]) });

    expect(result.movie.resolution).toBe("full-hd");
    expect(result.movie.quality).toBe("high");
    expect(result.movie["client-data"]).toEqual({ renderId: "render-1", projectRevision: 7 });
    expect(result.durationSeconds).toBe(5);
    expect(result.scenesWithoutVisual).toBe(0);
    expect(result.movie.scenes[0]).toEqual({
      duration: 5,
      elements: [
        {
          type: "image",
          src: "https://r2.example/media/a.jpg",
          duration: -2,
          resize: "cover",
          position: "center-center",
        },
        { type: "text", text: "A line", x: "center", y: "bottom" },
      ],
    });
    expect(result.movie.elements).toBeUndefined();
  });

  it("mutes a video clip so it cannot fight the narration", () => {
    const result = build({
      visuals: { "scene-1": { kind: "video", url: "https://r2.example/media/clip.mp4" } },
    });
    expect(result.movie.scenes[0].elements[0]).toEqual({
      type: "video",
      src: "https://r2.example/media/clip.mp4",
      duration: -2,
      resize: "cover",
      position: "center-center",
      muted: true,
    });
  });

  it("turns an asset-less scene into a text-only card, never an invented background", () => {
    const withText = build({ visuals: {}, document: document([scene({ onScreenText: "Card" })]) });
    expect(withText.scenesWithoutVisual).toBe(1);
    expect(withText.movie.scenes[0].elements).toEqual([
      { type: "text", text: "Card", x: "center", y: "bottom" },
    ]);

    const withoutText = build({ visuals: {} });
    expect(withoutText.movie.scenes[0].elements).toEqual([]);

    const serialized = JSON.stringify(withoutText.movie);
    expect(serialized).not.toContain("background-color");
    expect(serialized).not.toContain("fps");
  });

  it("places narration at natural length and loops music under it", () => {
    const result = build({
      narration: { url: "https://r2.example/media/voice.mp3", volume: 1, muted: false },
      music: { url: "https://r2.example/media/score.mp3", volume: 0.2, muted: true },
    });

    expect(result.movie.elements).toEqual([
      { type: "audio", src: "https://r2.example/media/voice.mp3", duration: -1, volume: 1 },
      {
        type: "audio",
        src: "https://r2.example/media/score.mp3",
        duration: -2,
        loop: -1,
        volume: 0.2,
        muted: true,
      },
    ]);
  });

  it("keeps scene order and rounds durations to milliseconds", () => {
    const result = build({
      document: document([
        scene({ id: "a", durationSeconds: 2.0004 }),
        scene({ id: "b", durationSeconds: 3.3336 }),
      ]),
      visuals: {
        a: { kind: "image", url: "https://r2.example/media/a.jpg" },
        b: { kind: "image", url: "https://r2.example/media/b.jpg" },
      },
    });
    expect(result.movie.scenes.map((entry) => entry.duration)).toEqual([2, 3.334]);
    expect(result.durationSeconds).toBe(5.334);
  });

  it("refuses an unapproved script before building anything", () => {
    expect(codeOf(() => build({ document: document([scene({ approved: false })]) }))).toBe(
      "VIDEO_SCRIPT_NOT_APPROVED",
    );
    expect(
      codeOf(() => build({ document: document([scene({ approvedFingerprint: null })]) })),
    ).toBe("VIDEO_SCRIPT_NOT_APPROVED");
  });

  it("refuses an unusable or oversized timeline", () => {
    expect(codeOf(() => build({ document: document([]) }))).toBe("VIDEO_TIMELINE_INVALID");
    expect(codeOf(() => build({ document: document([scene({ durationSeconds: 0 })]) }))).toBe(
      "VIDEO_TIMELINE_INVALID",
    );
    expect(codeOf(() => build({ document: document([scene({ durationSeconds: Number.NaN })]) }))).toBe(
      "VIDEO_TIMELINE_INVALID",
    );
    expect(codeOf(() => build({ maxSeconds: 4 }))).toBe("VIDEO_TIMELINE_INVALID");
    expect(
      codeOf(() =>
        build({ document: document(Array.from({ length: 51 }, (_, index) => scene({ id: `s${index}`, durationSeconds: 1 }))) }),
      ),
    ).toBe("VIDEO_TIMELINE_INVALID");
  });

  it("refuses over-long on-screen text and non-https inputs", () => {
    expect(codeOf(() => build({ document: document([scene({ onScreenText: "x".repeat(2001) })]) }))).toBe(
      "VIDEO_TEXT_TOO_LONG",
    );
    expect(
      codeOf(() => build({ visuals: { "scene-1": { kind: "image", url: "http://r2.example/a.jpg" } } })),
    ).toBe("VIDEO_INPUT_INVALID");
    expect(
      codeOf(() => build({ visuals: { "scene-1": { kind: "image", url: "not a url" } } })),
    ).toBe("VIDEO_INPUT_INVALID");
    expect(
      codeOf(() =>
        build({ narration: { url: "https://r2.example/voice.mp3", volume: 11, muted: false } }),
      ),
    ).toBe("VIDEO_AUDIO_INVALID");
  });

  it("refuses narration that does not fit, and allows a measured rounding margin", () => {
    expect(() => assertNarrationFits(10.4, 10, 0.5)).not.toThrow();
    expect(codeOf(() => assertNarrationFits(10.6, 10, 0.5))).toBe("VIDEO_NARRATION_OVERFLOW");
    expect(codeOf(() => assertNarrationFits(Number.NaN, 10))).toBe("VIDEO_TIMELINE_INVALID");
    try {
      assertNarrationFits(12.4, 10);
    } catch (error) {
      expect(String((error as Error).message)).toContain("12.4");
      expect(String((error as Error).message)).toContain("10");
    }
  });

  it("guards the provider's 2 MB movie body", () => {
    expect(() => assertMovieFits(VIDEO_MOVIE_MAX_BYTES)).not.toThrow();
    expect(codeOf(() => assertMovieFits(VIDEO_MOVIE_MAX_BYTES + 1))).toBe("VIDEO_MOVIE_TOO_LARGE");
  });
});

describe("video export estimate and input", () => {
  it("prices the timeline at one credit per second and reports the preset size", () => {
    const estimate = estimateVideoExport({
      projectRevision: 4,
      document: document([
        scene({ id: "a", durationSeconds: 4 }),
        scene({ id: "b", durationSeconds: 6.2 }),
      ]),
      resolution: "full-hd",
      maxSeconds: 600,
      visuals: { a: { kind: "image", url: "https://r2.example/media/a.jpg" } },
    });

    expect(estimate).toMatchObject({
      projectRevision: 4,
      scenes: 2,
      scenesWithoutVisual: 1,
      durationSeconds: 10.2,
      credits: 11,
      resolution: "full-hd",
      width: 1920,
      height: 1080,
      rateVersion: "json2video-2026-11-25",
    });
  });

  it("leaves the pixel size null for a preset it has not verified", () => {
    const estimate = estimateVideoExport({
      projectRevision: 1,
      document: document([scene()]),
      resolution: "instagram-story",
      maxSeconds: 600,
      visuals: {},
    });
    expect(estimate.width).toBeNull();
    expect(estimate.height).toBeNull();
  });

  it("accepts only a positive integer projectRevision", () => {
    expect(parseVideoExportInput({ projectRevision: 3 })).toEqual({ projectRevision: 3 });
    expect(codeOf(() => parseVideoExportInput({}))).toBe("INVALID_VIDEO_EXPORT");
    expect(codeOf(() => parseVideoExportInput({ projectRevision: "3" }))).toBe("INVALID_VIDEO_EXPORT");
    expect(codeOf(() => parseVideoExportInput({ projectRevision: 0 }))).toBe("INVALID_VIDEO_EXPORT");
    expect(codeOf(() => parseVideoExportInput({ projectRevision: 1.5 }))).toBe("INVALID_VIDEO_EXPORT");
    expect(codeOf(() => parseVideoExportInput({ projectRevision: 1, extra: true }))).toBe("UNEXPECTED_FIELD");
    expect(codeOf(() => parseVideoExportInput(null))).toBe("INVALID_VIDEO_EXPORT");
  });
});
