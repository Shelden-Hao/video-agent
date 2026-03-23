import { interrupt } from "@langchain/langgraph";
import type { UniversalState } from "../types.js";

export async function runUniversalClarify(state: UniversalState): Promise<UniversalState> {
  const intent = state.intent;
  if (!intent) return state;
  const needClarify = intent.confidence < 0.6 || (intent.missingSlots?.length ?? 0) > 0;
  if (!needClarify) return state;

  const questions: Array<{ key: string; prompt: string; options?: string[] }> = [];
  if (intent.missingSlots.includes("target")) {
    questions.push({
      key: "targets",
      prompt: "你希望生成哪类产物？可多选（用逗号分隔）",
      options: ["text", "image", "video", "audio"],
    });
  }
  if (intent.missingSlots.includes("topic")) {
    questions.push({ key: "input", prompt: "请用一句话说明主题/要生成的内容：" });
  }

  const payload = { type: "clarify", intent, questions };
  const resume = interrupt(payload) as any;

  const memory = [...(state.memory ?? [])];
  if (resume && typeof resume === "object") {
    for (const k of Object.keys(resume)) {
      const v = String(resume[k] ?? "").trim();
      if (!v) continue;
      memory.push({ key: `clarify.${k}`, value: v, at: new Date().toISOString() });
    }
  }

  const nextInput = typeof resume?.input === "string" && resume.input.trim() ? resume.input.trim() : state.input;
  const nextTargetsRaw = typeof resume?.targets === "string" ? resume.targets : "";
  const nextTargets = nextTargetsRaw
    .split(",")
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((x: string) => ["text", "image", "video", "audio"].includes(x)) as any[];

  const nextIntent = nextTargets.length
    ? { ...intent, targets: nextTargets, primaryTarget: nextTargets[0], confidence: Math.max(intent.confidence, 0.75), missingSlots: [] }
    : { ...intent, confidence: Math.max(intent.confidence, 0.75), missingSlots: intent.missingSlots.filter((s) => s !== "topic" && s !== "target") };

  return { ...state, input: nextInput, intent: nextIntent, memory };
}

