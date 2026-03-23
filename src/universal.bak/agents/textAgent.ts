import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { UniversalState } from "../types.js";
import { initChatModelFromSpec } from "../model.js";
import { redactPIIHeuristic } from "../guardrails.js";

const TextArtifactSchema = z.object({
  text: z.string().min(50).describe("最终生成的故事/文案正文"),
});

export async function runUniversalText(state: UniversalState): Promise<UniversalState> {
  const llm = initChatModelFromSpec(state.spec.models.text);
  const memoryBlock = (state.memory ?? [])
    .slice(-8)
    .map((m) => `- ${m.key}: ${m.value}`)
    .join("\n");

  const redactedInput = redactPIIHeuristic(state.input);
  const userContent = memoryBlock
    ? `用户输入：${redactedInput}\n\n近期记忆：\n${memoryBlock}\n\n请生成文本。`
    : `用户输入：${redactedInput}\n\n请生成文本。`;

  const runnable = (llm as any).withStructuredOutput(TextArtifactSchema);
  const structured = (await runnable.invoke([
    { role: "system", content: "你是通用智能体的文本生成模块。输出结构化字段 text（不少于200字）。" },
    { role: "user", content: userContent },
  ])) as { text: string };

  if (!structured?.text || structured.text.trim().length < 200) {
    throw new Error("Text output too short (<200 chars).");
  }
  const artifact = {
    id: randomUUID(),
    kind: "text" as const,
    text: structured.text,
    mimeType: "text/plain",
    createdAt: new Date().toISOString(),
    source: { agent: "universal.text", provider: state.spec.models.text.provider, model: state.spec.models.text.model },
  };

  return { ...state, artifacts: [...state.artifacts, artifact] };
}

