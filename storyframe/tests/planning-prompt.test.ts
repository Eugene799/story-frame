import { describe, expect, it } from "vitest";
import { buildPlanningPrompt, PLANNING_LIMITS } from "../server/planning";
import type { PlanningRoute } from "../shared/planning-contract";
import { documentFixture } from "./project-fixture";

// The validator rejects unknown root keys and wrong counts, so each built-in
// instruction must state those exactly. These tests are the contract between
// the prompt and the validator; a repair call in production is expensive.

const document = documentFixture();

function promptFor(route: PlanningRoute): string {
  return buildPlanningPrompt({
    route,
    instruction: "",
    projectType: "story",
    document,
    sources: [],
    inputLimitChars: PLANNING_LIMITS.promptChars,
  });
}

const ROOT_KEYS = '"summary" (non-empty string), "notes" (array of strings, may be empty)';
const FACTUAL_CLAIMS =
  '"claims" (only when the brief mode is factual and source excerpts were supplied; each claim then has only "sourceId", "statement", and "quote")';

describe("planning route instructions", () => {
  it("names only the contract keys and the exact angle count", () => {
    const prompt = promptFor("angles");
    expect(prompt).toContain(`with only these keys: ${ROOT_KEYS}, and "angles"`);
    expect(prompt).toContain("exactly 3 objects");
    expect(prompt).toContain('"title", "hook", and "rationale"');
    expect(prompt).not.toContain('"claims" (only when');
  });

  it("names every script scene field, the 1-12 count, and the duration range", () => {
    const prompt = promptFor("script");
    expect(prompt).toContain(`with these keys and no others: ${ROOT_KEYS}, "scenes" (1-12 objects`);
    for (const field of ["heading", "narration", "visualDirection", "onScreenText", "durationSeconds"]) {
      expect(prompt).toContain(`"${field}"`);
    }
    expect(prompt).toContain("an integer from 1 to 600");
    expect(prompt).toContain("Write the script from the brief; locked narration must be echoed unchanged.");
  });

  it("lets factual scripts report claims, but not fiction scripts", () => {
    const prompt = promptFor("script");
    expect(prompt).toContain(FACTUAL_CLAIMS);
    expect(prompt).toContain("brief mode is factual");
    expect(prompt).toContain("source excerpts were supplied");
  });

  it("keeps storyboard wording and requires one draft per existing scene", () => {
    const prompt = promptFor("storyboard");
    expect(prompt).toContain("exactly one object per existing scene, in the same order");
    expect(prompt).toContain("Copy each existing scene's heading and narration word for word");
    expect(prompt).not.toContain('"claims" (only when');
  });

  it("describes ad-concept beats and restricts claims to supplied factual sources", () => {
    const prompt = promptFor("ad-concept");
    expect(prompt).toContain("1-12 beats");
    expect(prompt).toContain("Put a call to action in the onScreenText of the final scene.");
    expect(prompt).toContain(FACTUAL_CLAIMS);
  });

  it("describes transcript clips with exact fields, counts, ordering, and conditional claims", () => {
    const prompt = promptFor("transcript-analysis");
    expect(prompt).toContain(`with these keys and no others: ${ROOT_KEYS}, "clips" (1-12 objects`);
    for (const field of ["startSeconds", "endSeconds", "quote", "heading", "rationale"]) {
      expect(prompt).toContain(`"${field}"`);
    }
    expect(prompt).toContain("end after start");
    expect(prompt).toContain("Every quote must be copied word for word from a supplied transcript excerpt");
    expect(prompt).toContain(FACTUAL_CLAIMS);
  });
});
