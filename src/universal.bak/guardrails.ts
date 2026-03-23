import { createMiddleware } from "langchain";
import { AIMessage } from "langchain";
import type { GuardrailsConfig } from "./types.js";

export function contentFilterMiddleware(cfg?: GuardrailsConfig) {
  const banned = (cfg?.bannedKeywords ?? []).map((x) => x.toLowerCase()).filter(Boolean);

  return createMiddleware({
    name: "ContentFilterMiddleware",
    beforeAgent: {
      hook: (state: any) => {
        if (!banned.length) return;
        const messages = state?.messages ?? [];
        const last = messages[messages.length - 1];
        const content = String(last?.content ?? "").toLowerCase();
        for (const kw of banned) {
          if (content.includes(kw)) {
            return {
              messages: [new AIMessage(`输入包含受限关键词（${kw}），请换个说法。`)],
              jumpTo: "end",
            };
          }
        }
      },
      canJumpTo: ["end"],
    },
  });
}

export function defaultInputGuardrails(cfg?: GuardrailsConfig) {
  // 说明：ChatAlibabaTongyi 对 message.content 只支持 string。
  // 为避免 middleware 在消息层引入复杂 content 类型，这里先用轻量输入过滤；PII 处理先在文本层做启发式脱敏。
  return [contentFilterMiddleware(cfg)];
}

export function minTextLengthGuardrail(minChars: number) {
  return createMiddleware({
    name: "MinTextLengthGuardrail",
    afterAgent: {
      hook: (state: any) => {
        const sr = state?.structuredResponse;
        const text = typeof sr?.text === "string" ? sr.text.trim() : "";
        if (text && text.length >= minChars) return;
        return {
          messages: [new AIMessage(`输出文本过短（<${minChars}字），请补充细节并重新输出。`)],
          jumpTo: "model",
        };
      },
      canJumpTo: ["model"],
    },
  });
}

export function redactPIIHeuristic(input: string) {
  return input
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[REDACTED_PHONE]");
}

