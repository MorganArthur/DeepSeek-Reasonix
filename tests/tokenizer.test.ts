import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOUNDED_TOKENIZE_CHARS,
  countTokens,
  countTokensBounded,
  encode,
  estimateConversationTokens,
  estimateRequestTokens,
  formatDeepSeekPrompt,
} from "../src/tokenizer.js";

// Token IDs are sourced from Qwen3 tokenizer (Qwen/Qwen3-0.6B), which is the
// same base tokenizer Xiaomi MiMo uses. Numeric goldens were captured against
// data/mimo-tokenizer.json.gz on 2026-05-28 — bump if the bundled data file
// is regenerated against a newer source.
describe("Xiaomi MiMo tokenizer (Qwen3-base) — golden cases", () => {
  it("empty string is zero tokens", () => {
    expect(encode("")).toEqual([]);
    expect(countTokens("")).toBe(0);
  });

  it("ASCII words tokenize compactly", () => {
    const helloOnly = encode("Hello!");
    const helloWorld = encode("Hello, world!");
    expect(helloOnly.length).toBeGreaterThanOrEqual(2);
    expect(helloOnly.length).toBeLessThanOrEqual(3);
    expect(helloWorld.length).toBeGreaterThanOrEqual(3);
    expect(helloWorld.length).toBeLessThanOrEqual(5);
  });

  it("common CJK collocation is at most a small number of tokens", () => {
    // Qwen3 (and the Xiaomi MiMo derivative) gives Chinese strong vocab
    // coverage — short common collocations like 你好 fit in 1-2 tokens.
    const ids = encode("你好");
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.length).toBeLessThanOrEqual(3);
  });

  it("CJK sentence splits cleanly without explosion", () => {
    const ids = encode("你好，世界！");
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids.length).toBeLessThanOrEqual(8);
  });

  it("digit run is isolated by the pre-tokenizer rule", () => {
    // The Qwen3 pre-tokenizer alternation isolates digit groups, so each
    // numeric token in "1 + 1 = 2" comes out as its own id. The exact ids
    // for ASCII digits in Qwen vocab are stable; assert structural shape.
    const ids = encode("1 + 1 = 2");
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(ids.length).toBeLessThanOrEqual(10);
  });

  it("recognizes <think>/</think> as atomic added tokens (Qwen3 special tokens 151667/151668)", () => {
    const ids = encode("<think>reasoning here</think>");
    expect(ids[0]).toBe(151667);
    expect(ids[ids.length - 1]).toBe(151668);
    // 1 open tag + 1 close tag + a few inner tokens for "reasoning here".
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(ids.length).toBeLessThanOrEqual(8);
  });

  it("recognizes <tool_call>/</tool_call> as atomic added tokens (151657/151658)", () => {
    const ids = encode("<tool_call>x</tool_call>");
    expect(ids[0]).toBe(151657);
    expect(ids[ids.length - 1]).toBe(151658);
  });

  it("mixed English+CJK doesn't explode the token count", () => {
    const ids = encode("mixed 中文 and english 混合");
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(ids.length).toBeLessThanOrEqual(15);
  });

  it("round-trips a code snippet at a reasonable compression ratio", () => {
    const src = "function add(a, b) { return a + b; }";
    const n = countTokens(src);
    expect(n).toBeGreaterThanOrEqual(8);
    expect(n).toBeLessThanOrEqual(20);
  });

  it("Chinese prose gets the expected ~0.6 tokens/char rate", () => {
    const text = "深度求索是一家专注于人工智能基础技术研究的公司";
    const n = countTokens(text);
    expect(n).toBeGreaterThanOrEqual(8);
    expect(n).toBeLessThanOrEqual(20);
  });
});

// formatDeepSeekPrompt renders the legacy DeepSeek V4 chat template (DSML
// tool_calls, `<｜begin▁of▁sentence｜>` markers). It's no longer used to
// drive Xiaomi MiMo API requests — the client sends the raw OpenAI-shaped
// messages array directly. The function is retained as a deprecated helper
// for any external caller that imported it from `src/index.ts`; these tests
// pin its output shape so we don't silently break that contract.
describe("formatDeepSeekPrompt (legacy DS template — retained for back-compat)", () => {
  it("renders system + user with BOS and generation suffix", () => {
    const out = formatDeepSeekPrompt([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hi" },
    ]);
    expect(out).toBe("<｜begin▁of▁sentence｜>Be concise.<｜User｜>Hi<｜Assistant｜></think>");
  });

  it("renders multi-turn with role prefixes and EOS on assistant", () => {
    const out = formatDeepSeekPrompt([
      { role: "system", content: "Helpful." },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]);
    expect(out).toBe(
      "<｜begin▁of▁sentence｜>Helpful.<｜User｜>Q1<｜Assistant｜></think>A1<｜end▁of▁sentence｜><｜User｜>Q2<｜Assistant｜></think>",
    );
  });

  it("renders DSML tool_calls when assistant has no content", () => {
    const out = formatDeepSeekPrompt([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
      },
    ]);
    expect(out).toContain("<｜DSML｜tool_calls>");
    expect(out).toContain('<｜DSML｜invoke name="read_file">');
    expect(out).toContain("a.ts");
    expect(out).toContain("<｜DSML｜parameter");
    expect(out).toMatch(/<｜end▁of▁sentence｜>$/);
  });

  it("merges tool results into user messages with <tool_result> blocks", () => {
    const out = formatDeepSeekPrompt([
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", content: "file contents" },
      { role: "user", content: "thanks" },
    ]);
    expect(out).toContain("<tool_result>file contents</tool_result>");
    expect(out).toMatch(/<｜Assistant｜><\/think>$/);
  });

  it("handles missing role as user default", () => {
    const out = formatDeepSeekPrompt([{ content: "hello" }]);
    expect(out).toBe("<｜begin▁of▁sentence｜><｜User｜>hello<｜Assistant｜></think>");
  });

  it("empty messages array returns just the generation prompt", () => {
    expect(formatDeepSeekPrompt([])).toBe("<｜Assistant｜></think>");
  });

  it("wraps reasoning_content in <think>...</think> before content", () => {
    const out = formatDeepSeekPrompt([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "Hi there!",
        reasoning_content: "User greeted me, I should respond.",
      },
    ]);
    expect(out).toContain("<think>User greeted me, I should respond.</think>Hi there!");
  });

  it("renders reasoning_content without content", () => {
    const out = formatDeepSeekPrompt([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Thinking step only.",
      },
    ]);
    expect(out).toContain("<think>Thinking step only.</think>");
    expect(out).toMatch(/<｜end▁of▁sentence｜>$/);
  });

  it("renders reasoning_content alongside tool_calls", () => {
    const out = formatDeepSeekPrompt([
      { role: "user", content: "read file" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "I need to use read_file tool.",
        tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
      },
    ]);
    expect(out).toContain("<think>I need to use read_file tool.</think>");
    expect(out).toContain("<｜DSML｜tool_calls>");
  });

  it("handles drop_thinking by stripping early reasoning_content", () => {
    const out = formatDeepSeekPrompt(
      [
        { role: "user", content: "Q1" },
        {
          role: "assistant",
          content: "A1",
          reasoning_content: "Early reasoning - should be dropped.",
        },
        { role: "user", content: "Q2" },
        {
          role: "assistant",
          content: "A2",
          reasoning_content: "Late reasoning - should be kept.",
        },
      ],
      true,
    );
    expect(out).not.toContain("Early reasoning");
    expect(out).toContain("<think>Late reasoning");
  });

  it("default drop_thinking=false preserves all reasoning_content", () => {
    const out = formatDeepSeekPrompt([
      { role: "user", content: "Q1" },
      {
        role: "assistant",
        content: "A1",
        reasoning_content: "Early reasoning.",
      },
      { role: "user", content: "Q2" },
    ]);
    expect(out).toContain("Early reasoning");
  });
});

describe("estimateConversationTokens", () => {
  it("counts templated tokens including framing overhead", () => {
    const n = estimateConversationTokens([
      { role: "user", content: "you are helpful" },
      { role: "user", content: "你好" },
      { role: "user", content: "Hello!" },
    ]);
    const rawContent = countTokens("you are helpful") + countTokens("你好") + countTokens("Hello!");
    expect(n).toBeGreaterThan(rawContent);
  });

  it("counts DSML tool_calls via template when present on assistant", () => {
    const withCalls = estimateConversationTokens([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
      },
    ]);
    expect(withCalls).toBeGreaterThan(0);
  });

  it("counts framing tokens even for null/empty content messages", () => {
    const n = estimateConversationTokens([
      { role: "user", content: null },
      { role: "user", content: "" },
      { role: "user", content: undefined },
    ]);
    expect(n).toBeGreaterThan(0);
  });
});

describe("estimateRequestTokens", () => {
  it("includes TOOLS_TEMPLATE overhead when toolSpecs are provided", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const withTools = estimateRequestTokens(msgs, [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ]);
    const rawSchema = countTokens(
      JSON.stringify({
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      }),
    );
    expect(withTools).toBeGreaterThan(estimateConversationTokens(msgs) + rawSchema);
  });

  it("returns conversation tokens when no tools", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(estimateRequestTokens(msgs, null)).toBe(estimateConversationTokens(msgs));
  });

  it("returns conversation tokens when empty tools array", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(estimateRequestTokens(msgs, [])).toBe(estimateConversationTokens(msgs));
  });

  it("counts tools with function extraction", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const withFn = estimateRequestTokens(msgs, [
      { function: { name: "foo", parameters: { type: "object", properties: {} } } },
    ]);
    const bare = estimateConversationTokens(msgs);
    expect(withFn).toBeGreaterThan(bare);
  });

  it("drop_thinking=true reduces tokens when early reasoning exists", () => {
    const msgs = [
      { role: "user", content: "Q1" },
      {
        role: "assistant",
        content: "A1",
        reasoning_content: "Some lengthy early reasoning that should be dropped...",
      },
      { role: "user", content: "Q2" },
    ];
    const withDrop = estimateConversationTokens(msgs, true);
    const withoutDrop = estimateConversationTokens(msgs, false);
    expect(withDrop).toBeLessThan(withoutDrop);
  });
});

describe("countTokensBounded", () => {
  it("keeps the default sample cap conservative for pathological BPE input", () => {
    expect(DEFAULT_BOUNDED_TOKENIZE_CHARS).toBeLessThanOrEqual(2048);
  });

  it("returns the exact token count when input is within the char cap", () => {
    const text = "Hello world! 你好 mimo.";
    expect(countTokensBounded(text, text.length)).toBe(countTokens(text));
  });

  it("estimates oversized input from a bounded head/tail sample", () => {
    const head = "Hello world! ".repeat(40);
    const middle = "A".repeat(100_000);
    const tail = "你好 mimo ".repeat(40);
    const text = head + middle + tail;

    const estimate = countTokensBounded(text, 512);

    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(text.length);
    expect(estimate).toBeGreaterThan(Math.floor(text.length * 0.05));
  });

  it("bounds pathological repetitive input without multi-second BPE work", () => {
    const text = "A".repeat(100_000);
    const t0 = performance.now();
    const estimate = countTokensBounded(text);
    const t1 = performance.now();

    expect(estimate).toBeGreaterThan(0);
    expect(t1 - t0).toBeLessThan(1000);
  });
});

describe("performance sanity", () => {
  it("tokenizes 10k chars of typical mixed content in under 200 ms", () => {
    const block = "Hello world! 你好 mimo ".repeat(400);
    const t0 = performance.now();
    const n = countTokens(block);
    const t1 = performance.now();
    expect(n).toBeGreaterThan(1000);
    expect(t1 - t0).toBeLessThan(200);
  });
});
