import { ChatAlibabaTongyi } from "@langchain/community/chat_models/alibaba_tongyi";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ModelConfig } from "./types.js";

export function initChatModelFromSpec(cfg: ModelConfig): BaseChatModel {
  if (cfg.provider === "bailian") {
    return new ChatAlibabaTongyi({
      model: cfg.model,
      modelName: cfg.model,
      temperature: cfg.temperature,
      region: cfg.region ?? "china",
      alibabaApiKey: process.env.ALIBABA_API_KEY,
    });
  }
  // 预留：后续接入 openai/anthropic/google 时，在这里扩展
  throw new Error(`Unsupported provider: ${cfg.provider}`);
}

