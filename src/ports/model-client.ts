/** Port: streaming chat model. Adapter: Xiaomi MiMo (OpenAI-compatible); pluggable later. */

import type { ChatRequestOptions, RawUsage } from "../types.js";

export interface ModelStreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  usage?: RawUsage;
  finishReason?: string;
}

export interface ModelClient {
  chatStream(opts: ChatRequestOptions, signal?: AbortSignal): AsyncIterable<ModelStreamChunk>;
}
