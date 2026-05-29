import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "../../config.js";

/** Xiaomi MiMo strictly accepts only `low` / `medium` / `high` (Pydantic-validated;
 *  sending `max` returns HTTP 400). Single-tenant single-provider, so there's no
 *  longer a host-dependent branch — all callers get the same three choices. */
export function effortChoicesForBaseUrl(
  _baseUrl: string | undefined | null,
): readonly ReasoningEffort[] {
  return REASONING_EFFORT_VALUES;
}

export function effortArgsHintFor(choices: readonly ReasoningEffort[]): string {
  return `<${choices.join("|")}>`;
}
