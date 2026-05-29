import { describe, expect, it } from "vitest";
import { modelBadgeFor } from "../src/cli/ui/primitives/Pill.js";

describe("modelBadgeFor", () => {
  it("maps mimo-v2.5 to flash class", () => {
    expect(modelBadgeFor("mimo-v2.5")).toEqual({ label: "v2.5", kind: "flash" });
  });

  it("maps mimo-v2.5-pro to pro class", () => {
    expect(modelBadgeFor("mimo-v2.5-pro")).toEqual({ label: "v2.5-pro", kind: "pro" });
  });

  it("preserves legacy DeepSeek model id rendering for replayed transcripts", () => {
    expect(modelBadgeFor("deepseek-v4-flash")).toEqual({ label: "v4-flash", kind: "flash" });
    expect(modelBadgeFor("deepseek-v4-pro")).toEqual({ label: "v4-pro", kind: "pro" });
    expect(modelBadgeFor("deepseek-chat")).toEqual({ label: "v4-flash", kind: "flash" });
    expect(modelBadgeFor("deepseek-reasoner")).toEqual({ label: "r1", kind: "r1" });
    expect(modelBadgeFor("deepseek-r1")).toEqual({ label: "r1", kind: "r1" });
  });

  it("falls back to unknown class for anything else, stripping the deepseek- prefix", () => {
    expect(modelBadgeFor("deepseek-v5-experimental")).toEqual({
      label: "v5-experimental",
      kind: "unknown",
    });
    expect(modelBadgeFor(undefined)).toEqual({ label: "?", kind: "unknown" });
  });
});
