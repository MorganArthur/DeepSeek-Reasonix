import { render } from "ink";
import React from "react";
import { describe, expect, it } from "vitest";
import { ModelPicker } from "../src/cli/ui/ModelPicker.js";
import type { ReasoningEffort } from "../src/config.js";
import { makeFakeStdin, makeFakeStdout } from "./helpers/ink-stdio.js";

function renderPicker(props: {
  models: ReadonlyArray<string> | null;
  current: string;
  currentEffort?: ReasoningEffort;
  effortChoices?: ReadonlyArray<ReasoningEffort>;
}): string {
  const stdout = makeFakeStdout();
  const { unmount } = render(
    React.createElement(ModelPicker, {
      models: props.models,
      current: props.current,
      currentEffort: props.currentEffort ?? "high",
      effortChoices: props.effortChoices ?? ["low", "medium", "high", "max"],
      onChoose: () => {},
    }),
    { stdout: stdout as never, stdin: makeFakeStdin() as never },
  );
  unmount();
  return stdout.text();
}

describe("ModelPicker (#371)", () => {
  it("lists API models when the catalog has loaded", () => {
    const text = renderPicker({
      models: ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.5"],
      current: "mimo-v2.5",
    });
    expect(text).toContain("mimo-v2.5");
    expect(text).toContain("mimo-v2.5-pro");
    expect(text).toContain("mimo-v2.5");
  });

  it("lists every reasoning_effort option in the EFFORT section", () => {
    const text = renderPicker({
      models: ["mimo-v2.5"],
      current: "mimo-v2.5",
    });
    expect(text).toContain("EFFORT");
    expect(text).toContain("low");
    expect(text).toContain("medium");
    expect(text).toContain("high");
    expect(text).toContain("max");
  });

  it("hides `max` when the active endpoint is non-DeepSeek (#1794)", () => {
    const text = renderPicker({
      models: ["mimo-v2.5"],
      current: "mimo-v2.5",
      effortChoices: ["low", "medium", "high"],
    });
    expect(text).toContain("EFFORT");
    expect(text).toContain("low");
    expect(text).toContain("medium");
    expect(text).toContain("high");
    expect(text).not.toMatch(/\bmax\b/);
  });

  it("marks the active effort with `current`", () => {
    const text = renderPicker({
      models: ["mimo-v2.5"],
      current: "mimo-v2.5",
      currentEffort: "max",
    });
    expect(text).toMatch(/max[\s\S]*current/);
  });

  it("marks the active model with `current`", () => {
    const text = renderPicker({
      models: ["mimo-v2.5", "mimo-v2.5-pro"],
      current: "mimo-v2.5-pro",
      currentEffort: "high",
    });
    expect(text).toMatch(/mimo-v2.5-pro[\s\S]*current/);
  });

  it("shows loading hint when catalog is null", () => {
    const text = renderPicker({ models: null, current: "mimo-v2.5" });
    expect(text).toContain("loading catalog");
  });

  it("falls back to the known DeepSeek ids when catalog is null so the picker isn't empty on first open", () => {
    const text = renderPicker({ models: null, current: "mimo-v2.5" });
    expect(text).toContain("mimo-v2.5");
    expect(text).toContain("mimo-v2.5-pro");
  });

  it("shows the explicit empty hint when catalog loaded but is empty", () => {
    const text = renderPicker({ models: [], current: "mimo-v2.5" });
    expect(text).toContain("catalog empty");
  });

  it("includes the current id in the list even when API didn't return it (handles stale catalog)", () => {
    const text = renderPicker({
      models: ["mimo-v2.5"],
      current: "deepseek-experimental-x",
    });
    expect(text).toContain("deepseek-experimental-x");
  });

  it("renders the keybind hint footer", () => {
    const text = renderPicker({
      models: ["mimo-v2.5"],
      current: "mimo-v2.5",
    });
    expect(text).toContain("↑↓");
    expect(text).toContain("⏎");
    expect(text).toContain("esc");
  });
});
