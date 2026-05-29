import { DEFAULT_MODEL_FLASH, DEFAULT_MODEL_PRO } from "../config.js";

/** True when the model emits reasoning_content and requires round-tripping. */
export function isThinkingModeModel(model: string): boolean {
  return model === DEFAULT_MODEL_FLASH || model === DEFAULT_MODEL_PRO;
}

/** Pin `thinking.type` for known thinking-capable models; return undefined to
 *  let third-party / self-hosted endpoints skip the field entirely. */
export function thinkingModeForModel(model: string): "enabled" | "disabled" | undefined {
  if (isThinkingModeModel(model)) return "enabled";
  return undefined;
}

/** No-op for Xiaomi MiMo: upstream resolves tool-call markup into structured fields before streaming. */
export function stripHallucinatedToolMarkup(s: string): string {
  return s.trim();
}
