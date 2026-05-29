import { describe, expect, it } from "vitest";
import { effortArgsHintFor, effortChoicesForBaseUrl } from "../src/cli/ui/effort-choices.js";

describe("effortChoicesForBaseUrl", () => {
  // Single-provider build (Xiaomi MiMo). The server accepts only
  // low/medium/high; the host-dependent branch was removed when we dropped
  // the "max" tier, so every input now returns the same three choices.
  it("returns Xiaomi's three accepted values for the official endpoint", () => {
    expect(effortChoicesForBaseUrl("https://api.xiaomimimo.com/v1")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("returns the same three values for self-hosted / OpenAI-compat endpoints", () => {
    expect(effortChoicesForBaseUrl("http://localhost:8080/v1")).toEqual(["low", "medium", "high"]);
    expect(effortChoicesForBaseUrl("https://api.openai.com/v1")).toEqual(["low", "medium", "high"]);
    expect(effortChoicesForBaseUrl("https://my-azure.openai.azure.com")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("treats null / undefined / empty baseUrl as the default set", () => {
    expect(effortChoicesForBaseUrl(undefined)).toEqual(["low", "medium", "high"]);
    expect(effortChoicesForBaseUrl(null)).toEqual(["low", "medium", "high"]);
    expect(effortChoicesForBaseUrl("")).toEqual(["low", "medium", "high"]);
  });

  it("formats argsHint with the supplied choices", () => {
    expect(effortArgsHintFor(["low", "medium", "high"])).toBe("<low|medium|high>");
  });
});
