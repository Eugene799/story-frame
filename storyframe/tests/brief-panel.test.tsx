// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BriefPanel } from "../src/workspace/BriefPanel";
import { briefFixture } from "./project-fixture";

describe("BriefPanel fiction notes", () => {
  afterEach(cleanup);

  it("edits character, setting, and continuity notes without touching the brief", () => {
    const brief = briefFixture({ mode: "fiction" });
    const onChange = vi.fn();
    const onStoryNotesChange = vi.fn();
    const notes = { characters: "Mara", setting: "Night train", continuity: "Sealed envelope" };

    render(
      <BriefPanel
        brief={brief}
        storyNotes={notes}
        onChange={onChange}
        onStoryNotesChange={onStoryNotesChange}
      />,
    );

    expect(screen.getByLabelText("Characters")).toHaveValue("Mara");
    expect(screen.getByLabelText("Setting")).toHaveValue("Night train");
    expect(screen.getByLabelText("Continuity")).toHaveValue("Sealed envelope");

    fireEvent.change(screen.getByLabelText("Continuity"), {
      target: { value: "The envelope opens in scene three." },
    });
    expect(onStoryNotesChange).toHaveBeenCalledWith({
      ...notes,
      continuity: "The envelope opens in scene three.",
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the fiction-only notes out of a factual brief", () => {
    render(
      <BriefPanel
        brief={briefFixture({ mode: "factual" })}
        onChange={vi.fn()}
        onStoryNotesChange={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Characters")).toBeNull();
    expect(screen.queryByLabelText("Continuity")).toBeNull();
  });
});
