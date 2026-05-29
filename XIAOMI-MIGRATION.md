# Reasonix → 小米 MiMo 单一供应商改造方案

> 目标：把当前只支持 DeepSeek 的终端 AI 编程代理 (Reasonix) 改造为只支持小米 MiMo 开放平台（`api.xiaomimimo.com`）。本文档列出所有需修改的位置、改造分组及落地步骤。
>
> **配套文档**：API 能力实测结论与字段细节见同目录 [`XIAOMI-API-CONFIRMATION.md`](./XIAOMI-API-CONFIRMATION.md)（已用真实 API key 跑 7 条 curl 实测验证）。
>
> **决策摘要**（已锁定，2026-05-27）：
> - **支持模型**：仅 `mimo-v2.5`（轻量档，对位 `deepseek-v4-flash`）+ `mimo-v2.5-pro`（重型档，对位 `deepseek-v4-pro`）
> - **协议层**：完全走 OpenAI 兼容端点（`https://api.xiaomimimo.com/v1`），不使用 Anthropic 兼容端点
> - **分词器**：从 Qwen2.5 借 `tokenizer.json`（小米 MiMo 基于 Qwen2Tokenizer，vocab ~151k）
> - **货币默认值**：CNY（目标用户在国内）
> - **项目名**：保留 `reasonix`，仅替换"DeepSeek-native" → "Xiaomi MiMo-native"

---

## 0. 背景调研结论（小米 MiMo 开放平台）

通过查阅官方文档 + 真实 API 实测：

| 项目 | 小米 MiMo | 与 DeepSeek 对比 |
|---|---|---|
| OpenAI 兼容 base URL | `https://api.xiaomimimo.com/v1` | DS: `https://api.deepseek.com` |
| 鉴权方式 | `Authorization: Bearer $KEY`（也接受 `api-key: $KEY`） | DS: 仅 Bearer |
| chat completions 路径 | `/v1/chat/completions` | 同 |
| SSE 流式 | ✅ 支持，需主动开 `stream_options.include_usage` 才能拿到 usage 末帧 | DS 也是 include_usage |
| 工具调用 | ✅ 支持 `tools` / `tool_calls`（OpenAI 标准格式） | 同 |
| 思考模式 | **顶层** `thinking: { type: "enabled"\|"disabled" }`（**不是** DS 的 `extra_body.thinking`） | DS 用 `extra_body.thinking` |
| 推理内容字段 | ✅ `reasoning_content`（message 字段 + delta 字段），思考 token 计入 `completion_tokens_details.reasoning_tokens` | 同 |
| usage 缓存字段 | **`usage.prompt_tokens_details.cached_tokens`**（OpenAI 标准嵌套）；无 cache_miss 字段，需用 `prompt_tokens - cached_tokens` 算 | DS 是扁平 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| max tokens 字段 | `max_completion_tokens`（推荐）；旧名 `max_tokens` 也兼容 | DS 仅 `max_tokens` |
| `reasoning_effort` | **严格 `low` / `medium` / `high`**，传 `max` 返 400 Pydantic 校验错 | DS 接受 4 档（含 `max`） |
| 模型 ID 列表 | `/v1/models` ✅ 完全可用，返回 9 个模型（仅其中 2 个进入支持列表） | DS 同 |
| 余额查询 | ❌ 无 API，仅 console dashboard | DS 有 `/user/balance` |
| 速率限制 | **RPM=100、TPM=10M**（全平台所有模型统一） | DS V4: 并发 500/2500 |
| 错误响应 | `{"error": {"code":"400","message":"...","param":"","type":"Bad Request"}}` (Pydantic raw msg) | DS: OpenAI 标准 |

**预估工作量**：**6 天**（基于 7 条 curl 实测全部确认完毕，无未知变量）。
- Day 1：核心层（A 组 client.ts + config.ts + .env.example）
- Day 2：DS 专属适配裁剪（B 组 errors / proxy / doctor / thinking / pricing / context）
- Day 3：模型管控（C 组 — 14 处硬编码改常量 + 价目表）
- Day 4：分词器 + tokenizer.json 替换 + tests 基线
- Day 5：i18n 4 语言 + UI 品牌文案
- Day 6：tests 全过 + 端到端冒烟

---

## 1. 实测确认清单（已全部完成）

13 项已全部用真实 API key 跑 curl 验证。**详细字段示例、错误体原文、SSE 帧序列见 [`XIAOMI-API-CONFIRMATION.md`](./XIAOMI-API-CONFIRMATION.md)**。这里只给最终结论：

| # | 项目 | 结论 |
|---|---|---|
| Q1 | `/v1/models` 端点 | ✅ 可用，返回标准 OpenAI ModelList |
| Q2 | 余额 API | ❌ 不存在，仅 console dashboard |
| Q3 | usage 缓存字段 | ✅ `prompt_tokens_details.cached_tokens`（嵌套），无 miss 字段需用差值 |
| Q4 | `thinking` 字段位置 | ✅ **顶层** `thinking: { type: "enabled" }` |
| Q5 | `thinking.type` 取值 | ✅ `"enabled"` / `"disabled"`，两个目标模型都支持 |
| Q6 | `reasoning_effort` 取值 | ✅ **严格 `low` / `medium` / `high`**（`max` 返 400） |
| Q7 | max tokens 字段 | ✅ 两个字段名都接受，推荐用 `max_completion_tokens` |
| Q8 | SSE delta 字段 | ✅ 标准 OpenAI，需 `stream_options.include_usage` 才有 usage 末帧 |
| Q9 | 错误响应体 | ✅ `{"error": {"code","message","param","type"}}`，message 是 Pydantic raw |
| Q10 | 速率限制 | ✅ RPM=100、TPM=10M |
| Q11 | 上下文窗口 | ✅ mimo-v2.5 / mimo-v2.5-pro 均为 1M tokens |
| Q12 | 价目表 | ✅ 已知（CNY/USD 双币种，全程单一单价） |
| Q13 | 分词器 | ✅ Qwen2Tokenizer（vocab 151668）；从 `Qwen/Qwen2.5-0.5B-Instruct` 借 `tokenizer.json` 即可 |

---

## 2. 改造分组总览

```
A. 必须改 — 核心连通层（API endpoint / auth / model id / env var）
B. 必须改 — DeepSeek 专属特性的适配或裁剪（thinking / cache / balance / tokenizer）
C. 必须改 — 错误处理 & 代理白名单（DS 特有的兜底逻辑）
D. 品牌/文案 — 包名、命令名、README、UI 字符串、i18n、docs、dashboard、desktop
E. 测试改造 — fixture / mock / 网络打桩
F. 可选清理 — Reasonix → 维持原名 vs 重命名
```

---

## 3. 文件级修改清单

### A. 核心连通层（必须改）

#### A1. `src/client.ts` — API 客户端

| 行号 | 当前 | 改为 |
|---|---|---|
| 101 行 | `interface DeepSeekClientOptions` | `interface XiaomiClientOptions`（保留 `DeepSeekClientOptions` 作为 deprecated type alias） |
| 154 行 | `class DeepSeekClient` | `class XiaomiClient`（保留 `DeepSeekClient = XiaomiClient` 作为 deprecated export） |
| 164 行 | `process.env.DEEPSEEK_API_KEY` | `process.env.XIAOMI_API_KEY ?? process.env.MIMO_API_KEY` |
| 165-169 行 | 错误文案 `DEEPSEEK_API_KEY is not set...` | `XIAOMI_API_KEY is not set...` |
| 171 行 | `"https://api.deepseek.com"` 默认 baseUrl | `"https://api.xiaomimimo.com/v1"` |
| 33-48 行 | `Usage.fromApi` 解析 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | **新增分支**优先读 `prompt_tokens_details.cached_tokens`，cacheMiss 用 `promptTokens - cachedTokens` 算出 |
| 211-233 行 | `buildPayload` 主体（含 `extra_body.thinking`） | ① `thinking` 移到 payload **顶层**：`payload.thinking = { type: opts.thinking }`；② `max_tokens` 改名 `max_completion_tokens`；③ **流式开启 `stream_options.include_usage = true`**（否则拿不到 usage 末帧） |
| 230-232 行 | `payload.reasoning_effort = opts.reasoningEffort` | 保留；但 `ReasoningEffort` 类型收窄为 `"low"\|"medium"\|"high"`（在 config.ts 改） |
| 236-246 行 | `_isAzureEndpoint()` 方法 | **整段删除**（小米无 Azure 分支需求） |
| 249-263 行 | `getBalance()` | **整段删除**（小米无余额 API）；上层 UI 状态栏改读 null |
| 266-280 行 | `listModels()` | 仅改 base URL；OpenAI 标准 ModelList 解析直接复用 |
| 282-309/328/363 行 | `chat()` 与 `stream()` 抛错前缀 `DeepSeek ${status}` | 改为 `Xiaomi ${status}`，`src/loop/errors.ts` 正则同步改 |
| 311-319 行 | response 解析 `reasoning_content` / `tool_calls` / `usage` | **0 改动**（OpenAI 兼容） |
| 366-403 行 | SSE delta 解析 | **0 改动**，字段名 `reasoning_content` / `tool_calls` 与 DS 完全相同 |
| 110-148 行（`replaceLoneSurrogates` 等）| DS 严格 JSON 解析的 surrogate 净化 | **保留**（无副作用且能防一类边角 bug），仅注释 "DeepSeek" → "Xiaomi" |

**新增类型扩展**（`src/types.ts: RawUsage`）：
```ts
export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  // 兼容旧 transcripts 回放：
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}
```

#### A2. `src/config.ts` — 配置加载

| 行号 | 当前 | 改为 |
|---|---|---|
| 1 行 注释 | `Library reads only DEEPSEEK_API_KEY` | `Library reads only XIAOMI_API_KEY` |
| 27 行 | `DEFAULT_MODEL = "deepseek-v4-flash"` | `DEFAULT_MODEL = DEFAULT_MODEL_FLASH = "mimo-v2.5"` |
| 31-34 行 | `SUPPORTED_OFFICIAL_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"]` | `SUPPORTED_OFFICIAL_MODELS = [DEFAULT_MODEL_FLASH, DEFAULT_MODEL_PRO] = ["mimo-v2.5", "mimo-v2.5-pro"]` |
| 36-42 行 | `REASONING_EFFORT_VALUES = ["low", "medium", "high", "max"]` | **删除 `"max"`**：`["low", "medium", "high"]`；`isReasoningEffort` 同步改 |
| 134 行 注释 | `rateLimit` 提到 DS 并发 500/2500 | 改为小米实际值：`RPM=100、TPM=10M（全平台统一）`；默认 `rateLimit.rpm` 设为 **90**（留 10% buffer） |
| 138-147 行 | `ProxyConfig.bypassDeepSeekDirect` | 改名 `bypassXiaomiDirect`，注释更新；保留旧字段名读取 1 个版本做迁移 |
| 153 行 注释 | `Persisted DeepSeek model id` | `Persisted Xiaomi MiMo model id` |
| 271 行 注释 | `Per-app proxy override...DeepSeek-bypass whitelist` | 替换为小米 |
| 662-665 行 | `resolveBaseUrlEnv` 读 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_BASE_URL` | 读 `XIAOMI_BASE_URL` / `XIAOMI_API_BASE_URL` / `MIMO_BASE_URL`（三个 env 名都支持） |
| 669-694 行 | `effectiveBaseUrlAndKey` / `applyEndpointEnv` 中所有 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | 改为 `XIAOMI_*` / `MIMO_*`；**保留旧名双读** 1 个版本周期防老 .env 失效 |

**新增 — 老配置自动迁移**（`readConfig()` 启动时执行）：
```ts
// 1. 旧 model id 映射
if (cfg.model === "deepseek-v4-flash") cfg.model = "mimo-v2.5";
if (cfg.model === "deepseek-v4-pro")   cfg.model = "mimo-v2.5-pro";
if (cfg.model === "deepseek-chat" || cfg.model === "deepseek-reasoner") cfg.model = "mimo-v2.5";

// 2. reasoningEffort=max 降级
if ((cfg.reasoningEffort as string) === "max") cfg.reasoningEffort = "high";

// 3. 老 env DEEPSEEK_API_KEY 启动时 warning（保留读取 1 个版本）
if (process.env.DEEPSEEK_API_KEY && !process.env.XIAOMI_API_KEY) {
  console.warn("[reasonix] DEEPSEEK_API_KEY is deprecated; set XIAOMI_API_KEY instead.");
}
```

#### A3. `src/ports/model-client.ts` — 接口端口（如有适配层）

- 该文件 1 处 `deepseek`/`DeepSeek` 命中，多半是注释或类型名，按品牌替换即可。

#### A4. `.env.example` — 用户配置模板

```diff
- DEEPSEEK_API_KEY=sk-your-key-here
- DEEPSEEK_BASE_URL=https://api.deepseek.com
- # DEEPSEEK_API_BASE_URL is accepted as an alias of DEEPSEEK_BASE_URL.
+ XIAOMI_API_KEY=your-mimo-key-here
+ XIAOMI_BASE_URL=https://api.xiaomimimo.com/v1
+ # MIMO_API_KEY / MIMO_BASE_URL are accepted as aliases.
  REASONIX_LOG_LEVEL=INFO
  REASONIX_TRANSCRIPT_DIR=./transcripts
```

---

### B. DeepSeek 专属特性适配（必须改）

#### B1. `src/loop/thinking.ts` — 思考模式判定

```diff
- export function isThinkingModeModel(model: string): boolean {
-   if (model.includes("reasoner")) return true;
-   if (model === "deepseek-v4-flash" || model === "deepseek-v4-pro") return true;
-   return false;
- }
+ export function isThinkingModeModel(model: string): boolean {
+   return model === "mimo-v2.5" || model === "mimo-v2.5-pro";
+ }

- export function thinkingModeForModel(model: string): "enabled" | "disabled" | undefined {
-   if (model === "deepseek-chat") return "disabled";
-   if (model.includes("reasoner")) return "enabled";
-   if (model === "deepseek-v4-flash" || model === "deepseek-v4-pro") return "enabled";
-   return undefined;
- }
+ export function thinkingModeForModel(model: string): "enabled" | "disabled" | undefined {
+   if (isThinkingModeModel(model)) return "enabled";
+   return undefined;
+ }
```

- **`stripHallucinatedToolMarkup()` 整段删除**（第 17-26 行）—— DS R1 才输出 `<｜DSML｜function_calls>`，小米 MiMo 用 Qwen 风格 `<tool_call>` token 且服务端已解析为 `tool_calls` 字段，客户端不需要再剥。同步清理所有调用点。

#### B2. `src/loop/messages.ts` 第 13 行注释 `V4-era deepseek-chat returns reasoning_content...`

- 改注释，确认小米是否也存在思考模式下仍返回 `reasoning_content` 的情况。

#### B3. `src/telemetry/stats.ts` — 计价 / 上下文窗口表

**价目表替换**（USD 主表 + CNY 备表，按 `costCurrency` 切换；**全程单一单价，无 256K-1M 分段**）：

```ts
// USD per 1M tokens
export const XIAOMI_PRICING: Record<string, ModelPricing> = {
  "mimo-v2.5":     { inputCacheHit: 0.008, inputCacheMiss: 0.08, output: 2.0 },
  "mimo-v2.5-pro": { inputCacheHit: 0.020, inputCacheMiss: 0.20, output: 3.0 },
};

// CNY per 1M tokens — 当 costCurrency: "CNY" 时使用
export const XIAOMI_PRICING_CNY: Record<string, ModelPricing> = {
  "mimo-v2.5":     { inputCacheHit: 0.056, inputCacheMiss: 0.56, output: 14.0 },
  "mimo-v2.5-pro": { inputCacheHit: 0.14,  inputCacheMiss: 1.40, output: 21.0 },
};

export const XIAOMI_CONTEXT_TOKENS: Record<string, number> = {
  "mimo-v2.5":     1_048_576,
  "mimo-v2.5-pro": 1_048_576,
};
```

**`costUsd()` 函数无需扩展**——保留 DS 现有线性单价逻辑，仅改 PRICING 引用：

```ts
export function costUsd(model: string, usage: Usage, path?: string): number {
  const p = pricingFor(model, path);
  if (!p) return 0;
  return (
    usage.promptCacheHitTokens  * p.inputCacheHit  +
    usage.promptCacheMissTokens * p.inputCacheMiss +
    usage.completionTokens      * p.output
  ) / 1_000_000;
}
```

**注意事项**：
- 缓存命中折扣率（小米官方未明示），上表暂按 input 价的 1/10 估算，与社区实测值（80aj.com）吻合；待官方公布后修正。
- `claudeEquivalentCost`（参考"如果用 Sonnet 多少钱"）留着无害，不动。
- `src/telemetry/usage.ts` 第 22 行 `DEEPSEEK_PRICING` 导入符号同步改名 `XIAOMI_PRICING`。
- `cli/ui/StatusRow` 等展示位置：货币默认值从 USD 改为 **CNY**（目标用户在国内）。

#### B4. 分词器：`src/tokenizer.ts` + `data/*.json.gz` + `scripts/prepare-tokenizer.ts`

**已确认**：小米 MiMo 大概率基于 **Qwen3 系列继续训练**（继续预训练必然沿用 base tokenizer）。HF 仓库 `XiaomiMiMo/MiMo-V2-Flash` 未提供完整 `tokenizer.json`，但从 `Qwen/Qwen3-0.6B` 借 `tokenizer.json` 应与小米使用的 tokenizer 高度一致（vocab + merges + 包括 `<think>` 在内的全部 special tokens）。

> **关于"Qwen2 是否过时"**：Qwen 1/1.5/2/2.5/3/3.7 全部沿用同一个基础 tokenizer（vocab 151,643 + 各代加 special tokens）。`tokenizer_class: Qwen2Tokenizer` 是 Python 实现类名，不代表是 Qwen2 那代模型独有。类比 OpenAI cl100k_base 从 GPT-3.5 用到 GPT-4.5。

**改造方案（借 `Qwen/Qwen3-0.6B` 的 tokenizer.json）**：

1. 下载 `Qwen/Qwen3-0.6B` 的 `tokenizer.json`（HuggingFace，约 11 MB）—— **必须用 Qwen3 而非 Qwen2.5**，因为小米思考模式输出 `<think>` `</think>` 是 Qwen3 才引入的特殊 token
2. gzip 压缩 → `data/mimo-tokenizer.json.gz`
3. 删除 `data/deepseek-tokenizer.json.gz`
4. `scripts/prepare-tokenizer.ts` 改拉取 URL 指向 `Qwen/Qwen3-0.6B`
5. `package.json` 第 21 行 `"data/deepseek-tokenizer.json.gz"` → `"data/mimo-tokenizer.json.gz"`
6. `src/tokenizer.ts` 第 80 行附近的文件名常量 `deepseek-tokenizer.json.gz` 改名（共 4 处：第 86/87/94/104 行）
7. **代码逻辑 0 改动** — 现有 `src/tokenizer.ts` 的 HF tokenizers 格式解析器（遍历 `pre_tokenizer.pretokenizers` 数组）兼容 Qwen 的 1×Split+1×ByteLevel 结构

**与 DS 的差异**：Qwen 的 chat template 用 `<|im_start|>role\ncontent<|im_end|>`，DS 用 `<｜begin▁of▁sentence｜>`。**token 计数只看文本不看模板**，编码器层面可直接复用。

**预期偏差 ≤1%**——Qwen3 tokenizer 与小米实际使用的同源，微小偏差仅来自 JS 解析器与官方 Rust 实现的细节差异；API 返回的 `prompt_tokens` 是计费权威值，本地估算仅用于上下文使用率 UI / 压缩触发判定，<1% 偏差完全可接受。

**测试基线重算**（`tests/tokenizer.test.ts` 17 处断言会失败）：用真实 mimo-v2.5 tokenize 几句典型文本（中文 / 英文 / 代码 / JSON / markdown）拿到 ground truth，更新断言。落地第一天跑对齐验证脚本，详见 `XIAOMI-API-CONFIRMATION.md` §Q13。

#### B5. `src/loop/errors.ts` — 错误处理

| 位置 | 改造 |
|---|---|
| 第 27 行 `^DeepSeek (\d{3})` 正则 | 改为 `^Xiaomi (\d{3})`（与 `src/client.ts` 改 `throw new Error("Xiaomi ${status}: ...")` 同步） |
| `is5xxError` / `is4xxError` 第 44/50 行 | 同上正则替换 |
| 第 61 行 `probeDeepSeekReachable` | **改用 `/v1/models` 探活**（小米无 balance API）：`probeXiaomiReachable(client) { return (await client.listModels({signal})) !== null }` |
| 第 69-78 行 `isDeepSeekHost` | 改名 `isXiaomiHost`，匹配 `api.xiaomimimo.com` |
| 第 95-108 行 `formatDeepSeek5xx` + 文案 | 改名 `formatXiaomi5xx`；i18n key 同步 (`errors.deepseek5xxHead` → `errors.xiaomi5xxHead`) |
| 第 134-148 行 `extractDeepSeekErrorMessage` | 改名 `extractXiaomiErrorMessage`；**新增 Pydantic raw 提取**：从 `error.message` 中正则取 `'msg':"..."` 字段（小米错误体含原 Python repr，对用户不友好） |
| **402 文案** | i18n `errors.balance402` 改为 "Credits 不足，请前往 console 充值"（小米是 Credits/套餐模式，不是"余额"概念） |

#### B6. `src/net/proxy.ts` — 代理白名单

| 行号 | 当前 | 改为 |
|---|---|---|
| 24-29 行 注释和 `DEEPSEEK_NO_PROXY` 常量 | 改名 `XIAOMI_NO_PROXY = ["api.xiaomimimo.com", "*.xiaomimimo.com"]`；注释更新（DS 的 US-exit-IP 403 故事换成小米侧实际现象，**或保留为通用直连白名单**） |
| 172-173 行 `bypassDeepSeekDirect` 参数 | 改名 `bypassXiaomiDirect`（保留向后兼容读法可选） |
| 194-200 行 `resolveBypassDeepSeekDirect` + 环境变量 `REASONIX_PROXY_DEEPSEEK_DIRECT` | 改名 `REASONIX_PROXY_XIAOMI_DIRECT` |

#### B7. `src/cli/commands/doctor.ts` — 健康检查

| 行号 | 改造 |
|---|---|
| 58 行 `PROXY_PROBE_HOSTS = ["api.deepseek.com", ...]` | 改为 `api.xiaomimimo.com` |
| 148-175 行 `DEEPSEEK_API_KEY` 读取 + "Get a key at https://platform.deepseek.com/api_keys" 文案 | 改为 `XIAOMI_API_KEY` + `https://platform.xiaomimimo.com` |
| 213 行 同 | 同 |

---

### C. 上层模型管控（模型选择、subagent、命令默认值）

> **目标模型（已定）**：仅 `mimo-v2.5`（轻量，对位原 flash）+ `mimo-v2.5-pro`（重型，对位原 pro）。
>
> **强制重构**：先在 `src/config.ts` 暴露两个常量，**所有 14 处硬编码全部改为引用常量**，避免下次更名再次散弹修改：
> ```ts
> export const DEFAULT_MODEL_FLASH = "mimo-v2.5";       // 轻量档（曾叫 v4-flash）
> export const DEFAULT_MODEL_PRO   = "mimo-v2.5-pro";   // 重型档（曾叫 v4-pro）
> export const DEFAULT_MODEL = DEFAULT_MODEL_FLASH;
> export const SUPPORTED_OFFICIAL_MODELS: readonly string[] = [
>   DEFAULT_MODEL_FLASH,
>   DEFAULT_MODEL_PRO,
> ];
> ```
> 命名上**保留 `FLASH`/`PRO` 后缀**（不重命名为 `V25`/`V25_PRO`）—— 这是产品语义概念（"轻量"/"重型"），跟具体 model id 解耦，将来再升 v3.0 时无需再次散弹改。

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `src/context-manager.ts` | 278 | `summaryModel = "deepseek-v4-flash"` | `DEFAULT_MODEL_FLASH` |
| `src/code/prompt.ts` | 6 | `DEFAULT_CODE_MODEL = "deepseek-v4-flash"` | `DEFAULT_MODEL_FLASH` |
| `src/code/setup.ts` | 99（注释） | "DEEPSEEK_API_KEY" | "XIAOMI_API_KEY" |
| `src/loop/force-summary.ts` | 43 | `summaryModel = "deepseek-v4-flash"` | `DEFAULT_MODEL_FLASH` |
| `src/loop.ts` | 109（注释）、204 | `"deepseek-v4-flash"` | `DEFAULT_MODEL_FLASH` |
| `src/skills.ts` | 98 | `"pro" ? "deepseek-v4-pro" : "deepseek-v4-flash"` | `"pro" ? DEFAULT_MODEL_PRO : DEFAULT_MODEL_FLASH` |
| `src/tools/subagent.ts` | 118, 120, 498, 500 | `DEFAULT_SUBAGENT_MODEL = "deepseek-v4-flash"`<br>enum: `["deepseek-v4-flash", "deepseek-v4-pro"]`<br>desc: "Which DeepSeek model..." | 改为常量 + `SUPPORTED_OFFICIAL_MODELS` + "Which Xiaomi MiMo model..." |
| `src/tools/scaffold.ts` | 67 | enum: `["deepseek-v4-flash", "deepseek-v4-pro"]` | `SUPPORTED_OFFICIAL_MODELS` |
| `src/prompt-fragments.ts` | 13-28 | escalation 提示语含 `deepseek-v4-pro` 字面量 | 模板化为 `${DEFAULT_MODEL_PRO}` |
| `src/cli/commands/commit.ts` | 14, 20, 247 | `DEFAULT_MODEL = "deepseek-v4-flash"` + `DEEPSEEK_API_KEY` 报错 | `DEFAULT_MODEL_FLASH` + `XIAOMI_API_KEY` |
| `src/cli/ui/ModelPicker.tsx` | 20-21（注释）、196 | `FALLBACK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"]` | `SUPPORTED_OFFICIAL_MODELS` |
| `src/cli/ui/Wizard.tsx` | 478-510 | `validateDeepSeekApiKey` 函数名 + DS URL 默认值 | `validateXiaomiApiKey` + `https://api.xiaomimimo.com/v1` |
| `src/qq/use-qq-channel.ts` | 782 | `["deepseek-v4-flash", "deepseek-v4-pro"]` | `SUPPORTED_OFFICIAL_MODELS` |
| `src/server/api/models.ts` | 2 处 | 返回给 dashboard 的 model 列表来源 | 直接走 `listModels()` + 按 `SUPPORTED_OFFICIAL_MODELS` 过滤 |
| `src/cli/ui/effort-choices.ts` | 3 处 | "max" effort 仅在 DS 主机启用的分支逻辑 | **整段删除**——小米严格三档（low/medium/high），不再需要按 host 分支 |
| `src/telemetry/stats.ts` | 38-42 | `DEEPSEEK_CONTEXT_TOKENS` 4 条 | `XIAOMI_CONTEXT_TOKENS`：仅 `mimo-v2.5: 1_048_576` + `mimo-v2.5-pro: 1_048_576` |
| `src/telemetry/stats.ts` | 5-14 | `DEEPSEEK_PRICING` 4 条 | `XIAOMI_PRICING`：仅两条，并新增长上下文分段乘数（见 §Q12） |

**关于 `/pro` 装备机制**（`src/skills.ts` + i18n）：
- 当前提示语："⇧ /pro 已装备 — 本轮使用 deepseek-v4-pro（一次性 · 本轮后自动解除）"
- 改为："⇧ /pro 已装备 — 本轮使用 mimo-v2.5-pro（一次性 · 本轮后自动解除）"
- 同步改 4 语言 i18n（EN/zh-CN/de/ru）的 `proArmed` key

**老配置迁移**（首次启动时）：
- 如果 `~/.reasonix/config.json` 的 `model` 字段是旧的 `deepseek-v4-flash` / `deepseek-v4-pro`，启动时自动映射为 `mimo-v2.5` / `mimo-v2.5-pro` 并保存
- 如果 `reasoningEffort` 是 `"max"`，自动降级为 `"high"`

---

### D. 品牌 / 文案 / i18n（必须改 — 用户可见处）

#### D1. `package.json`（项目根）

| 字段 | 当前 | 改为 |
|---|---|---|
| `description` | `"DeepSeek-native coding agent..."` | `"Xiaomi MiMo-native coding agent..."` |
| `bin.dsnix` | 沿用 `dsnix` 别名 | 建议改为 `mimonix` 或 `xnix`（与 `packages/dsnix` 同步） |
| `files` | `"data/deepseek-tokenizer.json.gz"` | `"data/mimo-tokenizer.json.gz"` |
| `keywords` | 含 `"deepseek"`, `"r1"` | 替换 `"xiaomi"`, `"mimo"` |
| `repository.url` | `git+https://github.com/esengine/DeepSeek-Reasonix.git` | 仓库改名后更新 |
| `homepage` / `bugs.url` | 同上 | 同上 |

#### D2. `packages/dsnix/` — CLI 短别名包

整个目录建议 `git mv packages/dsnix packages/mimonix`（或保留 dsnix 兼容）：
- `packages/dsnix/package.json`：name、description、keywords、homepage、repository 全部更新；`dependencies.reasonix` 保留。
- `packages/dsnix/bin.cjs`：内部 `require("reasonix")` 逻辑不需改。
- `packages/dsnix/README.md`：内容重写。

#### D3. `src/i18n/{EN,zh-CN,de,ru}.ts` — UI 字符串

逐文件命中行（共 ~86 处）。重点：

- API key 提示：`DEEPSEEK_API_KEY is not set` 类
- Wizard 文案：`DeepSeek model id (e.g. deepseek-v4-flash)`
- ModelPicker：`try deepseek-v4-flash or deepseek-v4-pro`
- /pro 装备提示：`⇧ /pro 已装备 — 本轮使用 deepseek-v4-pro`
- 错误文案：401/402/5xx 中所有 "DeepSeek" 字样
- 余额相关 i18n key（`statusBar.balanceLabel` 等）：删除整批 — 小米无 balance API

i18n 文件未提供 `errors.xiaomi5xxHead` 等新 key 时，TS 编译会报错；要在 `src/i18n/types.ts` 同步更新接口签名。**强烈建议先改 types.ts，让 tsc 把所有缺翻译的位置全部点亮**。

#### D4. README / docs / dashboard / desktop / benchmarks

下面这些目录**全部含**大量品牌字样，但不影响功能；按发布优先级分批处理：

| 路径 | 命中数 | 紧迫程度 |
|---|---|---|
| `README.md` | 34 | 高（首次见用户） |
| `README.zh-CN.md` | 31 | 高 |
| `REASONIX.md` | 2 | 中 |
| `CHANGELOG.md` | 55 | 低（保留历史） |
| `dashboard/src/**` | ~20 | 高（dashboard UI 用户可见） |
| `desktop/src/**` | ~30 | 高（桌面 UI 用户可见） |
| `docs/**`（站点） | ~150+ | 中（独立网站，可后续推） |
| `benchmarks/**` | ~500+ | 低（历史评测，保留原数据真实性） |
| `examples/*.ts` | 3 处 | 中（demo 代码可跑） |
| `tools/probe-deepseek-body-limit.mjs` | 1 处 | 低（内部工具，可改名或删） |
| `.github/ISSUE_TEMPLATE/bug_report.md` | 1 | 低 |
| `SECURITY.md` | 2 | 低 |

> 建议：第一阶段**只改用户运行时可见的**（README/UI/i18n/dashboard/desktop/examples），benchmarks / docs 站点 / CHANGELOG **不动**或单独 issue 跟进。CHANGELOG 历史条目改了反而失真。

---

### E. 测试改造

`tests/` 目录命中关键文件：

| 文件 | 命中 | 备注 |
|---|---|---|
| `tests/config.test.ts` | 44 | env var 名、默认 baseUrl、默认 model — 必须改 |
| `tests/client-stream-error.test.ts` / `client-stream-timeout.test.ts` / `client-models.test.ts` | 34 合计 | mock 的 URL / 错误前缀字符串 — 必须改 |
| `tests/loop.test.ts` / `loop-error.test.ts` / `loop-r1-reasoning.test.ts` | 105 合计 | model id、错误前缀 — 必须改 |
| `tests/usage.test.ts` / `telemetry.test.ts` | 65 合计 | 计价表换 `XIAOMI_PRICING`、cache field 改 `prompt_tokens_details.cached_tokens` |
| `tests/proxy.test.ts` | 47 | NO_PROXY 白名单 host — 必须改 |
| `tests/tokenizer.test.ts` | 17 | 用真实 mimo-v2.5 tokenize 输出重算基线（断言中具体 token 数会全部失败） |
| `tests/ui-model-picker.test.tsx` | 26 | fallback 模型列表断言 |
| `tests/wizard.test.tsx` | 7 | env var / 默认 URL |
| 其余 | 各 1-10 | 逐个跑测试再针对失败修 |

**测试策略建议**：
1. 先改 `tests/config.test.ts`（基线），跑通后再向外扩散。
2. `client-*.test.ts` 用 `vi.fn()` mock `fetch`，URL 断言换成 `api.xiaomimimo.com/v1`。
3. 若 Q3 缓存字段映射不同，新增一组测试覆盖"小米格式 usage → Usage 对象"的转换。

---

### F. 可选清理

#### F1. 项目名 `reasonix` 是否改名？

- **建议保留 `reasonix`**：它是产品名（非品牌捆绑名），改名会失去所有历史 issue / star / npm 下载量 / SEO。
- 仅把"DeepSeek-native" → "Xiaomi MiMo-native" 即可。
- `~/.reasonix/config.json` 路径同理保留——老用户配置不迁移。

#### F2. Anthropic 兼容端点 `https://api.xiaomimimo.com/anthropic`

- 当前架构是 OpenAI 兼容栈（`/chat/completions` + `tools`），不建议切到 Anthropic 格式——会引入大量字段重映射工作。仅在 OpenAI 兼容端点能力**显著差于** Anthropic 端点时再考虑。

#### F3. DeepSeek 历史包袱

- `stripHallucinatedToolMarkup` 的 DSML 正则（`src/loop/thinking.ts: 19-25`）：DS R1 模型才会输出 `<｜DSML｜function_calls>`，小米模型如无此问题可删除。
- `src/client.ts: replaceLoneSurrogates`（111-148 行）：DS 的严格 JSON 解析拒绝孤立 surrogate，小米若用标准解析器可保留（无害且解决一类边角 bug）。
- `src/loop/errors.ts` 中"R1 truncates mid-call"相关注释——清理掉。

---

## 4. 改造执行顺序（6 天，已扣除调研阶段）

```
Day 1：核心连通层 + 类型签名
  ├─ src/i18n/types.ts 先改接口签名 — tsc 报错点亮所有缺翻译位置
  ├─ A1 client.ts：env var、baseUrl、Usage.fromApi 嵌套字段、buildPayload(thinking 顶层 / max_completion_tokens / stream_options.include_usage / _isAzureEndpoint 删除 / getBalance 删除)
  ├─ A2 config.ts：DEFAULT_MODEL_FLASH/PRO 常量、SUPPORTED_OFFICIAL_MODELS、REASONING_EFFORT_VALUES 去 max、env 双读、老配置迁移
  ├─ A4 .env.example
  ├─ A3 ports/model-client.ts 注释
  └─ `npm run typecheck` — i18n 之外应全过

Day 2：DS 专属适配裁剪
  ├─ B1 loop/thinking.ts — 精确到两个模型，删 stripHallucinatedToolMarkup
  ├─ B2 loop/messages.ts 注释
  ├─ B5 loop/errors.ts — 正则、isXiaomiHost、Pydantic msg 提取、402→Credits 文案
  ├─ B6 net/proxy.ts — XIAOMI_NO_PROXY、bypassXiaomiDirect、REASONIX_PROXY_XIAOMI_DIRECT
  ├─ B7 cli/commands/doctor.ts — PROXY_PROBE_HOSTS、KEY 读取与提示文案
  └─ 跑 tests: config / client-stream-error / proxy / errors —— 全过

Day 3：模型管控（C 组）
  ├─ 14 处硬编码模型 ID → DEFAULT_MODEL_FLASH/PRO 常量
  ├─ ModelPicker 过滤 listModels() 结果，仅展示 SUPPORTED_OFFICIAL_MODELS
  ├─ effort-choices.ts 删 max 分支
  ├─ telemetry/stats.ts：XIAOMI_PRICING + XIAOMI_PRICING_CNY + XIAOMI_CONTEXT_TOKENS（线性单价，无分段）
  └─ telemetry/usage.ts 导入符号同步

Day 4：分词器替换
  ├─ 下载 Qwen2.5 tokenizer.json → data/mimo-tokenizer.json.gz
  ├─ 改 src/tokenizer.ts、scripts/prepare-tokenizer.ts、package.json files 字段
  ├─ tests/tokenizer.test.ts 用真实小米输出重算断言基线
  └─ 跑 npm run build + tokenizer 相关测试

Day 5：i18n + 品牌文案
  ├─ EN.ts → zh-CN.ts → de.ts → ru.ts
  │   重点：DEEPSEEK_API_KEY 提示、Wizard 文案、ModelPicker 提示、proArmed 文案、errors.balance402 → Credits、所有 deepseek-v4-* 字面量
  ├─ README.md / README.zh-CN.md / REASONIX.md 重写
  ├─ dashboard/src/ + desktop/src/（用户可见的 UI 文案）
  ├─ examples/*.ts demo 代码
  ├─ package.json description/keywords/repository
  └─ packages/dsnix → keywords + description 更新

Day 6：测试全面修 + 端到端冒烟
  ├─ npm test — 所有失败项修到全绿
  ├─ npm run dev 真实账号过：登录向导 → /models → 普通对话 → tools 调用 → 流式 + 思考 → /pro 装备 → ctx 接近上限触发 summary
  ├─ /doctor 输出验证（api.xiaomimimo.com 探活、env 读取、proxy 配置）
  └─ 状态栏：cache hit% 显示正常、cost 用 CNY 展示、ctx 用量条 working

可选后续：CHANGELOG（保留历史不动）/ docs 站点 / benchmarks transcripts（保留原 DS 数据真实性）
```

---

## 5. 残留风险

调研阶段 13 项已 100% 验证，原 "Q1-Q13 不确定性" 风险全部消除。残留的实际风险：

| 风险 | 严重度 | 缓解方案 |
|---|---|---|
| 小米**缓存命中折扣率**未公开（仅说"discount pricing"） | 中 — 影响 cost 估算精度 | PRICING 表暂按 1/10 估算（社区实测吻合），UI 加 "estimate" 标注；待官方公布后修正 |
| Qwen2 vs MiMo 微小 vocab 差异 | 低 — 影响 ±1-2% token 估算 | API 返回的 `prompt_tokens` 是权威值，会自动回填校正；UI 上下文使用率仅是预估指标 |
| mimo-v2.5-pro 简单 ASCII 输入误判乱码 | 低 — 模型 bug，非协议 | 与协议层无关，不影响代码改造；用户层面避免直接 `"hi"` 这种过短输入即可 |
| 老用户配置 `model: deepseek-v4-*` / `reasoningEffort: max` | 低 — 一次性迁移 | `readConfig()` 启动时静默迁移（详见 A2） |

---

## 6. 一句话总结

**6 天稳定收尾，0 个未知变量**。最大单点工作量在 C 组（14 处硬编码模型 ID 改常量）和 D 组（4 语言 i18n + 用户可见品牌文案），核心连通层（A 组）一天能搞定。

---

## 附录 A：参考资料

- **配套实测文档**：[`XIAOMI-API-CONFIRMATION.md`](./XIAOMI-API-CONFIRMATION.md) — 13 项实测原始结论、字段示例、SSE 帧序列、错误体原文
- 小米 MiMo 开放平台：https://platform.xiaomimimo.com
- 快速开始（含 curl 示例）：https://platform.xiaomimimo.com/docs/zh-CN/quick-start/first-api-call
- OpenAI 兼容 API 文档：https://platform.xiaomimimo.com/docs/en-US/api/chat/openai-api
- LiteLLM 适配文档（参考字段映射）：https://docs.litellm.ai/docs/providers/xiaomi_mimo
- OpenClaw Xiaomi Provider 文档：https://docs.openclaw.ai/providers/xiaomi
- HuggingFace XiaomiMiMo/MiMo-V2-Flash：https://huggingface.co/XiaomiMiMo/MiMo-V2-Flash
- Qwen2.5 tokenizer.json 来源：https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct
- 社区计费分析：https://www.80aj.com/2026/05/02/mimo-token-bottleneck/
