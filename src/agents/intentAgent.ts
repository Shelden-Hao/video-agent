import "dotenv/config";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import type { AgentState, IntentSpec, TargetKind } from "../types/state.js";
import {
  INTENT_SYSTEM_PROMPT,
  buildIntentUserMessage,
  type IntentPromptResult,
} from "../prompts/intentPrompt.js";
import { getLLM } from "../tools/common.js";

function parseIntentJson(raw: string): IntentPromptResult | null {
  let text = raw?.trim() ?? "";
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();
  try {
    const obj = JSON.parse(text) as any;
    if (!obj || typeof obj !== "object") return null;
    const targetsRaw = Array.isArray(obj.targets) ? obj.targets : [];
    const targets = targetsRaw
      .map((x: any) => String(x).trim().toLowerCase())
      .filter((x: string) =>
        ["text", "image", "video", "audio"].includes(x),
      ) as TargetKind[];
    const confidence =
      typeof obj.confidence === "number"
        ? Math.min(Math.max(obj.confidence, 0), 1)
        : 0.4;
    const missingSlots = Array.isArray(obj.missingSlots)
      ? obj.missingSlots.map((x: any) => String(x)).filter(Boolean)
      : [];
    const primaryTarget = obj.primaryTarget
      ? (String(obj.primaryTarget).trim().toLowerCase() as TargetKind)
      : undefined;
    const publicRationale =
      typeof obj.publicRationale === "string" ? obj.publicRationale : "";
    return {
      targets: targets.length ? targets : (["text"] as TargetKind[]),
      primaryTarget,
      confidence,
      missingSlots,
      publicRationale,
    };
  } catch {
    return null;
  }
}

/**
 * 根据确实字段生成追问问题列表
 * @param intent 意图分析结果
 * @returns 需要追问的问题列表
 * @example
 * buildClarifyQuestions({
 *   targets: ["text", "image"],
 *   confidence: 0.5,
 *   missingSlots: ["topic", "duration"],
 *   publicRationale: "用户意图不明确，需要澄清主题和时长。",
 * })
 * // 返回:
 * {
 *   questions: [
 *     { key: "topic", prompt: "内容主题/要表达的核心是什么？（一句话）" },
 *     { key: "duration", prompt: "大概需要多长？（例如：10秒/30秒/1分钟）" },
 *   ],
 * }
 */
function buildClarifyQuestions(intent: IntentPromptResult): {
  questions: Array<{ key: string; prompt: string; options?: string[] }>;
} {
  const questions: Array<{ key: string; prompt: string; options?: string[] }> =
    [];

  if (intent.missingSlots.includes("target")) {
    questions.push({
      key: "targets",
      prompt: "你希望生成哪类产物？可多选（用逗号分隔）",
      options: ["text", "image", "video", "audio"],
    });
  }
  if (intent.missingSlots.includes("topic")) {
    questions.push({
      key: "topic",
      prompt: "内容主题/要表达的核心是什么？（一句话）",
    });
  }
  if (intent.missingSlots.includes("duration")) {
    questions.push({
      key: "duration",
      prompt: "大概需要多长？（例如：10秒/30秒/1分钟）",
    });
  }
  if (intent.missingSlots.includes("style")) {
    questions.push({
      key: "style",
      prompt: "希望的风格/语气是什么？（例如：专业/幽默/温馨/赛博朋克）",
    });
  }
  if (intent.missingSlots.includes("audience")) {
    questions.push({
      key: "audience",
      prompt:
        "受众/使用场景是什么？（例如：情侣/亲子/商务；或：朋友圈/公众号/短视频平台）",
    });
  }
  return { questions };
}

/**
 * 合并用户补充信息
 * @param intent 意图分析结果
 * @param resume 追问结果
 * @returns 合并后的意图分析结果
 * @example
 * applyClarifyResume({
 *   targets: ["text"],
 *   confidence: 0.3,
 *   missingSlots: ["target", "topic"],
 *   publicRationale: "输入信息不足，先按文本方向处理并需要你补充目标与主题。",
 * }, {
 *   targets: "text,image",
 *   topic: "用户意图不明确，需要澄清主题和时长。",
 *   style: "专业",
 *   duration: "10秒",
 * })
 * // 返回:
 * {
 *   targets: ["text", "image"],
 *   confidence: 0.7,
 *   missingSlots: ["topic", "duration"],
 *   publicRationale: "用户意图不明确，需要澄清主题和时长。",
 * }
 */
function applyClarifyResume(
  intent: IntentPromptResult,
  resume: any,
): IntentPromptResult {
  if (!resume || typeof resume !== "object") return intent;
  const out = { ...intent };
  if (resume.targets) {
    const t = String(resume.targets)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .filter((x) =>
        ["text", "image", "video", "audio"].includes(x),
      ) as TargetKind[];
    if (t.length) out.targets = t;
  }
  // 将 topic/style/duration 等作为“已澄清”标记，后续 refine 再真正解析为参数
  const newMissing = new Set(out.missingSlots);
  for (const k of ["targets", "topic", "style", "duration", "audience"]) {
    if (resume[k]) newMissing.delete(k === "targets" ? "target" : k);
  }
  out.missingSlots = [...newMissing];
  out.confidence = Math.max(out.confidence, 0.7);
  return out;
}

/**
 * 意图分析
 */
export async function runIntentAgent(state: AgentState): Promise<AgentState> {
  const rawPrompt = (state.topic ?? "").trim();
  if (!rawPrompt) return state;

  console.log("[IntentAgent] 开始意图分析（粗粒度路由）...");
  const messages = [
    new SystemMessage(INTENT_SYSTEM_PROMPT),
    new HumanMessage(buildIntentUserMessage(rawPrompt)),
  ];
  const res = await getLLM().invoke(messages);
  const raw = res.content?.toString?.() ?? "";
  const parsed = parseIntentJson(raw);

  const intent: IntentPromptResult = parsed ?? {
    targets: ["text"],
    confidence: 0.3,
    missingSlots: ["target", "topic"],
    publicRationale: "输入信息不足，先按文本方向处理并需要你补充目标与主题。",
  };

  const shouldClarify =
    intent.confidence < 0.6 || (intent.missingSlots?.length ?? 0) > 0;

  let finalIntent = intent;
  let updatedTopic: string | undefined = undefined;
  let memoryUpdates: AgentState["memory"] = [];
  if (shouldClarify) {
    const payload = {
      type: "clarify_intent",
      intent: {
        targets: intent.targets,
        confidence: intent.confidence,
        missingSlots: intent.missingSlots,
        publicRationale: intent.publicRationale,
      },
      ...buildClarifyQuestions(intent),
    };
    // Agent流程暂停，等待用户输入，再恢复
    const resume = interrupt(payload) as any;
    if (
      resume &&
      typeof resume === "object" &&
      typeof resume.topic === "string"
    ) {
      const t = resume.topic.trim();
      if (t) updatedTopic = t;
    }
    if (resume && typeof resume === "object") {
      for (const k of ["targets", "topic", "style", "duration", "audience"]) {
        if (typeof resume[k] === "string" && resume[k].trim()) {
          memoryUpdates.push({
            key: `clarify.${k}`,
            value: resume[k].trim(),
            at: new Date().toISOString(),
          });
        }
      }
    }
    finalIntent = applyClarifyResume(intent, resume);
  }

  const intentSpec: IntentSpec = {
    targets: finalIntent.targets,
    primaryTarget: finalIntent.primaryTarget,
    confidence: finalIntent.confidence,
    missingSlots: finalIntent.missingSlots,
    publicRationale: finalIntent.publicRationale,
  };

  console.log(
    `[IntentAgent] 意图结果: targets=${intentSpec.targets.join(",")} confidence=${intentSpec.confidence.toFixed(2)} rationale=${intentSpec.publicRationale ?? ""}`,
  );

  return {
    ...state,
    intent: intentSpec,
    topic: updatedTopic ?? state.topic,
    memory: [...(state.memory ?? []), ...memoryUpdates],
  };
}
