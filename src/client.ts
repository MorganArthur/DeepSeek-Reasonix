import { type EventSourceMessage, createParser } from "eventsource-parser";
import { loadRateLimit, resolveBaseUrlEnv } from "./config.js";
import { type RetryOptions, fetchWithRetry } from "./retry.js";
import type { ChatMessage, ChatRequestOptions, RawUsage, ToolCall, ToolSpec } from "./types.js";

export class Usage {
  constructor(
    public promptTokens = 0,
    public completionTokens = 0,
    public totalTokens = 0,
    public promptCacheHitTokens = 0,
    public promptCacheMissTokens = 0,
  ) {}

  get cacheHitRatio(): number {
    const denom = this.promptCacheHitTokens + this.promptCacheMissTokens;
    return denom > 0 ? this.promptCacheHitTokens / denom : 0;
  }

  static hasApiUsage(raw: unknown): raw is RawUsage {
    if (!raw || typeof raw !== "object") return false;
    const u = raw as RawUsage;
    return (
      typeof u.prompt_tokens === "number" ||
      typeof u.completion_tokens === "number" ||
      typeof u.total_tokens === "number" ||
      u.prompt_tokens_details !== undefined ||
      u.completion_tokens_details !== undefined ||
      typeof u.prompt_cache_hit_tokens === "number" ||
      typeof u.prompt_cache_miss_tokens === "number" ||
      typeof u.prompt_eval_count === "number" ||
      typeof u.eval_count === "number"
    );
  }

  static fromApi(raw: RawUsage | undefined | null): Usage {
    const u = raw ?? {};
    const promptTokens = u.prompt_tokens ?? u.prompt_eval_count ?? 0;
    const completionTokens = u.completion_tokens ?? u.eval_count ?? 0;
    // Xiaomi MiMo and other OpenAI-compatible providers return cache hits as
    // `prompt_tokens_details.cached_tokens`; legacy DeepSeek transcripts use
    // the flat `prompt_cache_hit_tokens`. Read nested first, fall back to flat.
    const cacheHitTokens = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
    const cacheMissTokens =
      u.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens);
    return new Usage(
      promptTokens,
      completionTokens,
      u.total_tokens ?? promptTokens + completionTokens,
      cacheHitTokens,
      cacheMissTokens,
    );
  }
}

export interface ChatResponse {
  content: string;
  reasoningContent: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  raw: unknown;
}

export interface StreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: { index: number; id?: string; name?: string; argumentsDelta?: string };
  usage?: Usage;
  finishReason?: string;
  raw: any;
}

export interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

export interface UserBalance {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

/** Largest `total_balance` wins — the wallet the user actually paid for and expects to see ticking down. */
export function pickPrimaryBalance(infos: ReadonlyArray<BalanceInfo>): BalanceInfo | null {
  if (infos.length === 0) return null;
  let best = infos[0]!;
  for (let i = 1; i < infos.length; i++) {
    if (Number(infos[i]!.total_balance) > Number(best.total_balance)) best = infos[i]!;
  }
  return best;
}

export interface ModelInfo {
  id: string;
  object: "model";
  owned_by: string;
}

export interface ModelList {
  object: "list";
  data: ModelInfo[];
}

/** Options for the Xiaomi MiMo chat client; legacy type name kept to avoid a broad caller rename. */
export interface DeepSeekClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  rateLimit?: { rpm?: number };
  /** Retry configuration. Pass `{ maxAttempts: 1 }` to disable retries. */
  retry?: RetryOptions;
}

// Strict JSON parsers (both DeepSeek and Xiaomi MiMo) reject lone UTF-16
// surrogate escapes (`\ud800`, `\udc00`) even though JavaScript can carry them
// in strings. Keep the sanitizer regardless of provider — it's harmless and
// covers an edge-case input class for any strict-JSON upstream.
function replaceLoneSurrogates(value: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      } else {
        out += value.slice(last, i);
        out += "\uFFFD";
        last = i + 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += value.slice(last, i);
      out += "\uFFFD";
      last = i + 1;
    }
  }
  if (last === 0) return value;
  return out + value.slice(last);
}

function sanitizeJsonTransportValue(value: unknown): unknown {
  if (typeof value === "string") return replaceLoneSurrogates(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonTransportValue(item));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = sanitizeJsonTransportValue(item);
  }
  return out;
}

function stringifyJsonTransport(value: unknown): string {
  return JSON.stringify(sanitizeJsonTransportValue(value));
}

export class DeepSeekClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retry: RetryOptions;
  private readonly _fetch: typeof fetch;
  private readonly minChatIntervalMs: number;
  private nextChatRequestAt = 0;

  constructor(opts: DeepSeekClientOptions = {}) {
    // env priority: XIAOMI_API_KEY > MIMO_API_KEY > DEEPSEEK_API_KEY (legacy
    // fallback so existing user environments keep working through the
    // migration window — drop after one release).
    const apiKey =
      opts.apiKey ??
      process.env.XIAOMI_API_KEY ??
      process.env.MIMO_API_KEY ??
      process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "XIAOMI_API_KEY is not set. Put it in .env (or set MIMO_API_KEY) or pass apiKey to the client.",
      );
    }
    this.apiKey = apiKey;
    let url = opts.baseUrl ?? resolveBaseUrlEnv() ?? "https://api.xiaomimimo.com/v1";
    // Manual trim — `/\/+$/` is O(n²) on slash-heavy non-matches per CodeQL js/polynomial-redos.
    while (url.endsWith("/")) url = url.slice(0, -1);
    this.baseUrl = url;
    // 11 min upstream timeout. Inherited from DeepSeek's queue behavior (LB
    // could hold a connection open up to 10 min while queued — keep-alive
    // frames are invisible to our parsers, so neither surfaces until the
    // real response starts). The 11-min cap lets the server's own 10-min
    // ceiling close the socket first (clean EOF → natural retry), and our
    // timer is a safety net for genuinely hung sockets. Xiaomi MiMo's queue
    // behavior is similar enough that we retain the same headroom.
    this.timeoutMs = opts.timeoutMs ?? 660_000;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.retry = opts.retry ?? {};
    const rpm = opts.rateLimit?.rpm ?? loadRateLimit()?.rpm;
    this.minChatIntervalMs = rpm ? Math.ceil(60_000 / rpm) : 0;
  }

  private async waitForChatRateLimit(signal?: AbortSignal): Promise<void> {
    if (this.minChatIntervalMs <= 0) return;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextChatRequestAt - now);
    this.nextChatRequestAt = Math.max(now, this.nextChatRequestAt) + this.minChatIntervalMs;
    if (waitMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  private buildPayload(opts: ChatRequestOptions, stream: boolean) {
    const payload: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream,
    };
    // Streaming requires include_usage to receive the final-frame usage
    // (Xiaomi MiMo emits usage in a trailing `choices: []` chunk only when
    // this is set — without it the session loses prompt_tokens visibility,
    // breaking cost / context-usage UI).
    if (stream) payload.stream_options = { include_usage: true };
    if (opts.tools?.length) payload.tools = opts.tools;
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    // Xiaomi MiMo accepts both `max_tokens` (legacy) and `max_completion_tokens`
    // (OpenAI o-series naming, documented preferred). Use the new name.
    if (opts.maxTokens !== undefined) payload.max_completion_tokens = opts.maxTokens;
    if (opts.responseFormat) payload.response_format = opts.responseFormat;
    // Xiaomi MiMo thinking-mode toggle: top-level `thinking.type` (not nested
    // under `extra_body` like DeepSeek V4). In thinking mode the server
    // silently ignores `temperature` / `top_p` / `presence_penalty` /
    // `frequency_penalty` — we don't strip them here because leaving them in
    // is safe and keeps the request payload diffable against OpenAI tooling.
    if (opts.thinking) {
      payload.thinking = { type: opts.thinking };
    }
    if (opts.reasoningEffort) {
      payload.reasoning_effort = opts.reasoningEffort;
    }
    return payload;
  }

  /** Xiaomi MiMo has no balance API; return null so balance/status probes degrade gracefully. */
  async getBalance(_opts: { signal?: AbortSignal } = {}): Promise<UserBalance | null> {
    return null;
  }

  /** Returns null on failure — callers fall back to a hardcoded model hint. */
  async listModels(opts: { signal?: AbortSignal } = {}): Promise<ModelList | null> {
    try {
      const resp = await this._fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: opts.signal,
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as ModelList;
      if (!data || !Array.isArray(data.data)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async chat(opts: ChatRequestOptions): Promise<ChatResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error(`Xiaomi request timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    // Combine — `opts.signal ?? ctrl.signal` orphans the timer when the
    // caller passes a signal, so timeoutMs never reaches fetch.
    const signal = opts.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;

    try {
      await this.waitForChatRateLimit(signal);
      const resp = await fetchWithRetry(
        this._fetch,
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: stringifyJsonTransport(this.buildPayload(opts, false)),
          signal,
        },
        { ...this.retry, signal },
      );
      if (!resp.ok) {
        throw new Error(`Xiaomi ${resp.status}: ${await resp.text()}`);
      }
      const data: any = await resp.json();
      const choice = data.choices?.[0]?.message ?? {};
      return {
        content: choice.content ?? "",
        reasoningContent: choice.reasoning_content ?? null,
        toolCalls: choice.tool_calls ?? [],
        usage: Usage.fromApi(data.usage ?? data),
        raw: data,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(opts: ChatRequestOptions): AsyncGenerator<StreamChunk> {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error(`Xiaomi stream timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    // Combine — `opts.signal ?? ctrl.signal` orphans the timer when the
    // caller passes a signal, leaving a stalled SSE body to hang forever
    // on reader.read() (issue #1535).
    const signal = opts.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;

    let resp: Response;
    try {
      await this.waitForChatRateLimit(signal);
      // Only the initial fetch is retried. Once the server has started sending
      // the stream body we do NOT retry — a mid-stream retry would re-bill and
      // desync the session context.
      resp = await fetchWithRetry(
        this._fetch,
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: stringifyJsonTransport(this.buildPayload(opts, true)),
          signal,
        },
        { ...this.retry, signal },
      );
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    if (!resp.ok || !resp.body) {
      clearTimeout(timer);
      throw new Error(`Xiaomi ${resp.status}: ${await resp.text().catch(() => "")}`);
    }

    const queue: StreamChunk[] = [];
    let done = false;
    const parser = createParser({
      onEvent: (ev: EventSourceMessage) => {
        if (!ev.data || ev.data === "[DONE]") {
          done = true;
          return;
        }
        try {
          const json = JSON.parse(ev.data);
          const delta = json.choices?.[0]?.delta ?? {};
          const finishReason = json.choices?.[0]?.finish_reason ?? undefined;
          const chunk: StreamChunk = { raw: json, finishReason };
          if (typeof delta.content === "string" && delta.content.length > 0) {
            chunk.contentDelta = delta.content;
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            chunk.reasoningDelta = delta.reasoning_content;
          }
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            const tc = delta.tool_calls[0];
            chunk.toolCallDelta = {
              index: tc.index ?? 0,
              id: tc.id,
              name: tc.function?.name,
              argumentsDelta: tc.function?.arguments,
            };
          }
          const rawUsage = json.usage ?? (Usage.hasApiUsage(json) ? json : undefined);
          if (rawUsage) {
            chunk.usage = Usage.fromApi(rawUsage);
          }
          queue.push(chunk);
        } catch {
          /* skip malformed sse frame */
        }
      },
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        let value: Uint8Array | undefined;
        let streamDone: boolean;
        try {
          ({ value, done: streamDone } = await reader.read());
        } catch (readErr) {
          const cause = readErr instanceof Error ? readErr : new Error(String(readErr));
          const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
          throw Object.assign(new Error(`SSE body read failed: ${cause.message}`), {
            phase: "stream_body_read" as const,
            code,
          });
        }
        if (streamDone) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      while (queue.length > 0) yield queue.shift()!;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }
}

export type { ChatMessage, ToolCall, ToolSpec };
