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
  buildPlannerUserMessageFromTopic,
} from "../prompts/plannerPrompt.js";

// 懒初始化：首次调用时创建，避免模块加载时 dotenv 尚未读取 .env 文件
let _model: ChatAlibabaTongyi | null = null;
function getModel(): ChatAlibabaTongyi {
  if (!_model) {
    _model = new ChatAlibabaTongyi({
      alibabaApiKey: process.env.ALIBABA_API_KEY,
    });
  }
  return _model;
}

/** 从模型返回文本中提取并解析 JSON，主要是结构化兜底 */
function extractAndParsePlanJson(
  raw: string,
  sceneCount?: number,
): VideoPlan | null {
  let text = raw?.trim() ?? "";
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title : "未命名视频";
    const targetAge =
      typeof o.targetAge === "string" ? o.targetAge : "成人通用";
    const totalDurationSeconds =
      typeof o.totalDurationSeconds === "number" && o.totalDurationSeconds > 0
        ? o.totalDurationSeconds
        : 10;
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
            : Math.floor(totalDurationSeconds / Math.max(rawSteps.length, 1)),
      }))
      .filter((s) => s.teachingPoint || s.sceneDescription);

    if (steps.length === 0) return null;

    // 若 LLM 生成的步骤数与期望 sceneCount 不一致，仅作 warning，不截断
    if (sceneCount && steps.length !== sceneCount) {
      console.warn(
        `[PlanAgent] 期望 ${sceneCount} 步，实际生成 ${steps.length} 步`,
      );
    }

    return { title, targetAge, totalDurationSeconds, summary, steps };
  } catch {
    return null;
  }
}

/**
 * 根据 UserParams 或 topic 生成结构化 VideoPlan。
 * 优先使用 state.userParams（由 parseInputAgent 设置），兜底用 state.topic。
 */
export async function runPlanAgent(state: AgentState): Promise<AgentState> {
  const userParams = state.userParams;

  const userContent = userParams
    ? buildPlannerUserMessage(userParams)
    : buildPlannerUserMessageFromTopic(state.topic || "");

  console.log("[PlanAgent] 开始生成视频计划...");

  const messages = [
    new SystemMessage(PLANNER_SYSTEM_PROMPT),
    new HumanMessage(userContent),
  ];

  const res = (await getModel().invoke(messages)) as AIMessage;
  const raw = res.content?.toString?.() ?? "";
  const plan = extractAndParsePlanJson(raw, userParams?.sceneCount);

  if (plan) {
    console.log(
      `[PlanAgent] 计划生成完成: "${plan.title}"，共 ${plan.steps.length} 步`,
    );
  } else {
    console.warn("[PlanAgent] 计划解析失败，保留原计划");
  }

  return {
    ...state,
    plan: plan ?? state.plan ?? null,
  };
}
