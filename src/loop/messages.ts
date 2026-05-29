import type { ChatMessage, ToolCall } from "../types.js";
import { isThinkingModeModel } from "./thinking.js";

/** Thinking-mode producer ⇒ reasoning_content MUST be set (even ""), or next call 400s. */
export function buildAssistantMessage(
  content: string,
  toolCalls: ToolCall[],
  producingModel: string,
  reasoningContent?: string | null,
): ChatMessage {
  const msg: ChatMessage = { role: "assistant", content };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  // Both Xiaomi MiMo target models return reasoning_content when thinking is
  // enabled and require it round-tripped on follow-ups (the API rejects
  // continuations that drop it). The model-name whitelist is too brittle —
  // preserve whenever the producer emitted any reasoning_content at all.
  if (isThinkingModeModel(producingModel) || (reasoningContent && reasoningContent.length > 0)) {
    msg.reasoning_content = reasoningContent ?? "";
  }
  return msg;
}

/** Abort notices etc — caller passes its current model as the thinking-mode stamp. */
export function buildSyntheticAssistantMessage(
  content: string,
  fallbackModel: string,
): ChatMessage {
  return buildAssistantMessage(content, [], fallbackModel, "");
}
