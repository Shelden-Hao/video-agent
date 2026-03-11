import "dotenv/config";
import { ChatAlibabaTongyi } from "@langchain/community/chat_models/alibaba_tongyi";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { AgentState, VideoPlan, PlanStep } from "../types/state.js";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerUserMessage,
} from "../prompts/plannerPrompt.js";

const model = new ChatAlibabaTongyi({
  alibabaApiKey: process.env.ALIBABA_API_KEY,
});

/** 从模型返回文本中提取并解析 JSON，主要是结构化兜底 */
function extractAndParsePlanJson(raw: string): VideoPlan | null {
  let text = raw?.trim() ?? "";
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title : "儿童短视频";
    const targetAge = typeof o.targetAge === "string" ? o.targetAge : "3-6岁";
    const totalDurationSeconds =
      typeof o.totalDurationSeconds === "number" && o.totalDurationSeconds > 0
        ? o.totalDurationSeconds
        : 60;
    const summary = typeof o.summary === "string" ? o.summary : "";
    const rawSteps = Array.isArray(o.steps) ? o.steps : [];
    const steps: PlanStep[] = rawSteps
      .filter((s): s is Record<string, unknown> => s && typeof s === "object")
      .map((s, i) => ({
        step: typeof s.step === "number" ? s.step : i + 1,
        teachingPoint:
          typeof s.teachingPoint === "string" ? s.teachingPoint : "",
        sceneDescription:
          typeof s.sceneDescription === "string" ? s.sceneDescription : "",
        durationSeconds:
          typeof s.durationSeconds === "number" && s.durationSeconds > 0
            ? s.durationSeconds
            : 10,
      }))
      .filter((s) => s.teachingPoint || s.sceneDescription);
    if (steps.length === 0) return null;
    return {
      title,
      targetAge,
      totalDurationSeconds,
      summary,
      steps,
    };
  } catch {
    return null;
  }
}

/**
 * 根据用户 topic 生成「教培向、儿童适宜」的短视频制作计划，
 * 产出结构化 VideoPlan 供后续脚本、分镜、旁白、合成使用。
 */
export async function runPlanAgent(state: AgentState): Promise<AgentState> {
  const userContent = buildPlannerUserMessage(state.topic || "");
  const messages = [
    new SystemMessage(PLANNER_SYSTEM_PROMPT),
    new HumanMessage(userContent),
  ];

  const res = (await model.invoke(messages)) as AIMessage;
  const raw = res.content?.toString?.() ?? "";
  const plan = extractAndParsePlanJson(raw);

  return {
    ...state,
    plan: plan ?? state.plan ?? null,
  };
}
