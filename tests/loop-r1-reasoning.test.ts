/** R1 thinking-mode contract — tool-call reasoning_content must round-trip; stale plain reasoning must age out. */

import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import {
  CacheFirstLoop,
  isThinkingModeModel,
  stampMissingReasoningForThinkingMode,
  thinkingModeForModel,
} from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";

describe("isThinkingModeModel", () => {
  it("mimo-v2.5 → true (both target models support thinking, Day 1 curl-verified)", () => {
    expect(isThinkingModeModel("mimo-v2.5")).toBe(true);
  });
  it("mimo-v2.5-pro → true", () => {
    expect(isThinkingModeModel("mimo-v2.5-pro")).toBe(true);
  });
  it("unknown / unsupported models → false (safe default; we don't send `thinking` for them)", () => {
    expect(isThinkingModeModel("gpt-4")).toBe(false);
    expect(isThinkingModeModel("mimo-v2-flash")).toBe(false);
    expect(isThinkingModeModel("")).toBe(false);
  });
});

describe("thinkingModeForModel", () => {
  it("both Xiaomi MiMo target models → enabled", () => {
    expect(thinkingModeForModel("mimo-v2.5")).toBe("enabled");
    expect(thinkingModeForModel("mimo-v2.5-pro")).toBe("enabled");
  });
  it("unknown models → undefined (let server decide; don't pin the field)", () => {
    expect(thinkingModeForModel("gpt-4")).toBeUndefined();
    expect(thinkingModeForModel("anthropic-claude")).toBeUndefined();
    expect(thinkingModeForModel("mimo-v2-flash")).toBeUndefined();
  });
});

interface FakeResponseShape {
  content?: string;
  reasoning_content?: string;
  tool_calls?: any[];
  usage?: Record<string, number>;
}

function capturingFetch(responses: FakeResponseShape[]): {
  fetch: typeof fetch;
  bodies: Array<{
    messages: ChatMessage[];
    thinking?: { type?: string };
    reasoning_effort?: string;
  }>;
} {
  const bodies: Array<{
    messages: ChatMessage[];
    thinking?: { type?: string };
    reasoning_effort?: string;
  }> = [];
  let i = 0;
  const fn = vi.fn(async (_url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    bodies.push({
      messages: body.messages,
      thinking: body.thinking,
      reasoning_effort: body.reasoning_effort,
    });
    const resp = responses[i++] ?? responses[responses.length - 1]!;
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: resp.content ?? "",
              reasoning_content: resp.reasoning_content ?? null,
              tool_calls: resp.tool_calls ?? undefined,
            },
            finish_reason: resp.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: resp.usage ?? {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 100,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fn, bodies };
}

describe("stampMissingReasoningForThinkingMode (session-load heal)", () => {
  it("stamps empty reasoning_content on assistant turns missing the field for thinking-mode sessions", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      // Pre-fix session: no reasoning_content attached.
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
      { role: "assistant", content: "b", reasoning_content: "kept" },
    ];
    const { messages, stampedCount } = stampMissingReasoningForThinkingMode(msgs, "mimo-v2.5");
    expect(stampedCount).toBe(1);
    expect(messages[1]!.reasoning_content).toBe("");
    expect(messages[3]!.reasoning_content).toBe("kept");
  });

  it("no-ops on non-thinking-mode sessions (unsupported / third-party models stay clean)", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    // gpt-4 is not in our supported list — isThinkingModeModel returns false,
    // so stamping is skipped.
    const { messages, stampedCount } = stampMissingReasoningForThinkingMode(msgs, "gpt-4");
    expect(stampedCount).toBe(0);
    expect(Object.hasOwn(messages[1]!, "reasoning_content")).toBe(false);
  });

  it("preserves existing empty-string reasoning_content without double-stamping", () => {
    const msgs: ChatMessage[] = [{ role: "assistant", content: "hi", reasoning_content: "" }];
    const { stampedCount } = stampMissingReasoningForThinkingMode(msgs, "mimo-v2.5-pro");
    expect(stampedCount).toBe(0);
  });
});

describe("R1 reasoning_content round-trip", () => {
  it("preserves reasoning_content on the assistant message when the turn has tool_calls", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "noop",
      readOnly: true,
      fn: () => "ok",
    });

    const { fetch: fakeFetch, bodies } = capturingFetch([
      {
        // Turn 1: model emits reasoning + tool call.
        content: "",
        reasoning_content: "I should call noop to check something.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "noop", arguments: "{}" },
          },
        ],
      },
      {
        // Turn 2: plain text wrap-up after the tool result comes back.
        content: "done",
      },
    ]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      model: "mimo-v2.5",
      stream: false,
    });

    for await (const _ev of loop.step("please noop")) {
      /* drain */
    }

    expect(bodies.length).toBe(2);
    // Turn 2's request messages include the turn-1 assistant message;
    // find it and verify reasoning_content landed.
    const turn2Messages = bodies[1]!.messages;
    const assistantWithCalls = turn2Messages.find(
      (m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0,
    );
    expect(assistantWithCalls).toBeDefined();
    expect(assistantWithCalls?.reasoning_content).toBe("I should call noop to check something.");
  });

  it("omits stale reasoning_content from plain-text turns on the next user request", async () => {
    // DeepSeek V4 ignores reasoning_content from prior no-tool turns.
    // Carrying it forward only bloats long-session request bodies.
    const { fetch: fakeFetch, bodies } = capturingFetch([
      {
        content: "a plain answer",
        reasoning_content: "reasoning attached to a plain-text turn".repeat(200),
      },
      { content: "follow-up" },
    ]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "mimo-v2.5",
      stream: false,
    });

    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    for await (const _ev of loop.step("next")) {
      /* drain */
    }

    const turn2Messages = bodies[1]!.messages;
    const assistant = turn2Messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(Object.hasOwn(assistant!, "reasoning_content")).toBe(false);
    expect(JSON.stringify(turn2Messages)).not.toContain("reasoning attached to a plain-text turn");
  });

  it("preserves tool-call reasoning_content across later user turns", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "noop",
      readOnly: true,
      fn: () => "ok",
    });
    const { fetch: fakeFetch, bodies } = capturingFetch([
      {
        content: "",
        reasoning_content: "tool-call reasoning must stay available",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "noop", arguments: "{}" },
          },
        ],
      },
      { content: "done", reasoning_content: "plain final reasoning can age out" },
      { content: "follow-up" },
    ]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      model: "mimo-v2.5-pro",
      stream: false,
    });

    for await (const _ev of loop.step("please noop")) {
      /* drain */
    }
    for await (const _ev of loop.step("next")) {
      /* drain */
    }

    const turn2Messages = bodies[2]!.messages;
    const assistantWithCalls = turn2Messages.find(
      (m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0,
    );
    const finalAssistant = turn2Messages
      .filter((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) === 0)
      .at(-1);
    expect(assistantWithCalls?.reasoning_content).toBe("tool-call reasoning must stay available");
    expect(Object.hasOwn(finalAssistant!, "reasoning_content")).toBe(false);
  });

  it("stamps empty reasoning_content on a thinking-mode turn that returned null reasoning", async () => {
    // 0.5.18 covered "reasoner turn with reasoning present." This is
    // the inverse: thinking-mode model returns `reasoning_content:
    // null` (legitimate edge case — zero reasoning deltas on a flash
    // turn, or forced-summary paths that don't emit reasoning). Prior
    // behavior was `if (reasoning.length > 0)` which silently dropped
    // the field, and the NEXT API call 400'd. Invariant is now keyed
    // to the producing model, not to whether reasoning arrived.
    const { fetch: fakeFetch, bodies } = capturingFetch([
      { content: "straight answer", reasoning_content: undefined },
      { content: "follow-up" },
    ]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "mimo-v2.5",
      stream: false,
    });
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    for await (const _ev of loop.step("next")) {
      /* drain */
    }
    const turn2Messages = bodies[1]!.messages;
    const assistant = turn2Messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    // Plain assistant turns do not need stale reasoning in later user requests.
    expect(Object.hasOwn(assistant!, "reasoning_content")).toBe(false);
  });

  it("does NOT stamp reasoning_content on a non-thinking-model turn that returned null", async () => {
    // Mirror image: non-thinking-mode sessions must stay clean — sending an
    // empty string for a model that doesn't use thinking would needlessly
    // churn the prefix cache. `gpt-4` is not in the Xiaomi MiMo target set so
    // `isThinkingModeModel` returns false and the stamping pass skips it.
    const { fetch: fakeFetch, bodies } = capturingFetch([
      { content: "hi", reasoning_content: undefined },
      { content: "bye" },
    ]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "gpt-4",
      stream: false,
    });
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    for await (const _ev of loop.step("next")) {
      /* drain */
    }
    const turn2Messages = bodies[1]!.messages;
    const assistant = turn2Messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(Object.hasOwn(assistant!, "reasoning_content")).toBe(false);
  });

  it("omits stale plain mimo-v2.5 reasoning_content on the next user request", async () => {
    // Some legacy transcripts can surface reasoning_content even with thinking disabled.
    // Once the turn is a plain historical assistant message,
    // carrying that body forward just grows the next request.
    const { fetch: fakeFetch, bodies } = capturingFetch([
      { content: "ok", reasoning_content: "v4-chat reasoning leaked" },
      { content: "bye" },
    ]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "mimo-v2.5",
      stream: false,
    });
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    for await (const _ev of loop.step("next")) {
      /* drain */
    }
    const turn2Messages = bodies[1]!.messages;
    const assistant = turn2Messages.find((m) => m.role === "assistant");
    expect(Object.hasOwn(assistant!, "reasoning_content")).toBe(false);
  });

  it("pins thinking=enabled on the wire for mimo-v2.5-pro and sends the configured reasoning_effort", async () => {
    const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "mimo-v2.5-pro",
      stream: false,
      reasoningEffort: "high",
    });
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    // Xiaomi MiMo wants `thinking` at the top level, not nested under extra_body.
    expect(bodies[0]!.thinking?.type).toBe("enabled");
    expect(bodies[0]!.reasoning_effort).toBe("high");
  });

  it("pins thinking=enabled on the wire for mimo-v2.5 (flash tier still supports thinking)", async () => {
    const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "mimo-v2.5",
      stream: false,
    });
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    expect(bodies[0]!.thinking?.type).toBe("enabled");
    expect(bodies[0]!.reasoning_effort).toBe("high");
  });

  it("omits `thinking` entirely for unknown / non-target models (let the server decide)", async () => {
    const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "some-third-party-model",
      stream: false,
    });
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    expect(bodies[0]!.thinking).toBeUndefined();
    expect(bodies[0]!.reasoning_effort).toBe("high");
  });

  it("skips extra_body for Azure endpoints (issue #1299)", async () => {
    const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      baseUrl: "https://my-project.services.ai.azure.com/openai/v1",
      fetch: fakeFetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "mimo-v2.5-pro",
      stream: false,
    });
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    expect(bodies[0]!.extra_body).toBeUndefined();
    expect(bodies[0]!.reasoning_effort).toBe("high");
  });
});
