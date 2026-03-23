import { z } from "zod";
import type { UniversalState, IntentSpec } from "../types.js";
import { initChatModelFromSpec } from "../model.js";
import { redactPIIHeuristic } from "../guardrails.js";

const IntentSchema = z.object({
  targets: z.array(z.enum(["text", "image", "video", "audio"])).min(1),
  primaryTarget: z.enum(["text", "image", "video", "audio"]),
  confidence: z.number().min(0).max(1),
  missingSlots: z.array(z.string()).default([]),
  publicRationale: z.string(),
});

export async function runUniversalIntent(state: UniversalState): Promise<UniversalState> {
  const llm = initChatModelFromSpec(state.spec.models.intent);
  const runnable = (llm as any).withStructuredOutput(IntentSchema);
  const res = await runnable.invoke([
    { role: "system", content: "你是通用智能体的意图分析器。只做意图分类与缺失槽位判断，不生成最终内容。" },
    { role: "user", content: redactPIIHeuristic(state.input) },
  ]);
  const structured = res as IntentSpec;
  return { ...state, intent: structured };
}

