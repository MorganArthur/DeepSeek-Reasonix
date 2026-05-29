import type { DeepSeekClient } from "../client.js";
import { t } from "../i18n/index.js";

export interface XiaomiProbeResult {
  reachable: boolean;
}

/** Backwards-compatible alias — older imports use the legacy DS name. */
export type DeepSeekProbeResult = XiaomiProbeResult;

export interface FormatLoopErrorOptions {
  /** baseUrl of the upstream that just failed — picks Xiaomi-specific vs generic wording. */
  upstreamHost?: string;
}

export function formatLoopError(
  err: Error,
  probe?: XiaomiProbeResult,
  opts?: FormatLoopErrorOptions,
): string {
  const msg = err.message ?? "";
  if (msg.includes("maximum context length")) {
    const reqMatch = msg.match(/requested\s+(\d+)\s+tokens/);
    const requested = reqMatch
      ? `${Number(reqMatch[1]).toLocaleString()} tokens`
      : t("errors.contextOverflowTooMany");
    return t("errors.contextOverflow", { requested });
  }

  // Match either the new Xiaomi prefix (current client.ts) or the legacy
  // DeepSeek prefix (kept for replayed transcripts and not-yet-migrated
  // callers). Both surface as HTTP status codes here.
  const m = /^(?:Xiaomi|DeepSeek) (\d{3}):\s*([\s\S]*)$/.exec(msg);
  if (!m) return msg;
  const status = m[1] ?? "";
  const body = m[2] ?? "";
  const inner = extractXiaomiErrorMessage(body);

  if (status === "401") return t("errors.auth401", { inner });
  if (status === "402") return t("errors.balance402", { inner });
  if (status === "422") return t("errors.badparam422", { inner });
  if (status === "400") return t("errors.badrequest400", { inner });
  if (status === "429") return t("errors.concurrency429", { inner });
  if (is5xxStatus(status)) return format5xx(status, probe, opts?.upstreamHost);
  return msg;
}

export function is5xxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /^(?:Xiaomi|DeepSeek) (5\d{2}):/.test(err.message ?? "");
}

export function is4xxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /^(?:Xiaomi|DeepSeek) (4\d{2}):/.test(err.message ?? "");
}

/** Read structured metadata off thrown errors without resorting to `as any`. */
export function errorMeta(err: unknown): { code?: string; phase?: string } {
  if (!(err instanceof Error)) return {};
  const code = "code" in err && typeof err.code === "string" ? err.code : undefined;
  const phase = "phase" in err && typeof err.phase === "string" ? err.phase : undefined;
  return { code, phase };
}

/** Probe upstream reachability using `/v1/models` for 5xx classification. */
export async function probeXiaomiReachable(
  client: DeepSeekClient,
  timeoutMs = 1500,
): Promise<XiaomiProbeResult> {
  const models = await client.listModels({ signal: AbortSignal.timeout(timeoutMs) });
  return { reachable: models !== null };
}

/** Legacy alias — older callers (and any not-yet-migrated tools) import
 *  `probeDeepSeekReachable`. Routes to the new Xiaomi probe. */
export const probeDeepSeekReachable = probeXiaomiReachable;

/** Allow-list — only api.xiaomimimo.com gets Xiaomi-specific 5xx wording + reachability probe. */
export function isXiaomiHost(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.xiaomimimo.com" || host.endsWith(".xiaomimimo.com");
  } catch {
    return false;
  }
}

/** Legacy alias — older callers (e.g. loop.ts) import `isDeepSeekHost`. */
export const isDeepSeekHost = isXiaomiHost;

function is5xxStatus(status: string): boolean {
  return status === "500" || status === "502" || status === "503" || status === "504";
}

function format5xx(
  status: string,
  probe: XiaomiProbeResult | undefined,
  upstreamHost: string | undefined,
): string {
  if (upstreamHost !== undefined && !isXiaomiHost(upstreamHost)) {
    return formatUpstream5xx(status, upstreamHost);
  }
  return formatXiaomi5xx(status, probe);
}

function formatXiaomi5xx(status: string, probe?: XiaomiProbeResult): string {
  // i18n keys still named `deepseek5xx*` for now — Day 5 renames the keys
  // across all 4 language files. The actual displayed text in those keys
  // can be updated independently of the key name.
  const head = t("errors.deepseek5xxHead", { status });
  const probeNote =
    probe === undefined
      ? ""
      : probe.reachable
        ? t("errors.deepseek5xxReachable")
        : t("errors.deepseek5xxUnreachable");
  const action =
    probe?.reachable === false
      ? t("errors.deepseek5xxActionNetwork")
      : t("errors.deepseek5xxActionRetry");
  return `${head}${probeNote}${action}`;
}

function formatUpstream5xx(status: string, baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host || baseUrl;
  } catch {
    /* keep raw baseUrl */
  }
  const head = t("errors.upstream5xxHead", { status, host });
  const action = t("errors.upstream5xxActionRetry");
  return `${head}${action}`;
}

export function reasonPrefixFor(reason: "aborted" | "context-guard" | "stuck"): string {
  if (reason === "aborted") return t("errors.reasonAborted");
  if (reason === "context-guard") return t("errors.reasonContextGuard");
  return t("errors.reasonStuck");
}

export function errorLabelFor(reason: "aborted" | "context-guard" | "stuck"): string {
  if (reason === "aborted") return t("errors.labelAborted");
  if (reason === "context-guard") return t("errors.labelContextGuard");
  return t("errors.labelStuck");
}

/** Extract a human-readable message from Xiaomi's OpenAI-shaped error body. */
function extractXiaomiErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return t("errors.innerNoMessage");
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { error?: { message?: unknown }; message?: unknown };
      let raw: string | undefined;
      if (obj.error && typeof obj.error.message === "string") {
        raw = obj.error.message;
      } else if (typeof obj.message === "string") {
        raw = obj.message;
      }
      if (raw !== undefined) {
        // Pydantic raw repr → try to lift just the human-readable `msg` field.
        // First match wins — most 400s contain a single validation failure.
        const pydantic = /'msg':\s*"([^"]+)"/.exec(raw);
        return pydantic ? pydantic[1]! : raw;
      }
    }
  } catch {
    /* not JSON — fall through */
  }
  return trimmed;
}

/** Legacy alias retained so any not-yet-migrated importer keeps working. */
export const extractDeepSeekErrorMessage = extractXiaomiErrorMessage;
