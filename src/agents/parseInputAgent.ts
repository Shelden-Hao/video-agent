/**
 * ParseInput Agent —— 工作流第一步
 *
 * 将用户自然语言 prompt（state.topic）解析为结构化 UserParams JSON，
 * 作为整个工作流的数据入口。后续所有 Agent 均通过 UserParams 获取配置。
 */
import "dotenv/config";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState, UserParams } from "../types/state.js";
import {
  PARSE_INPUT_SYSTEM_PROMPT,
  buildParseInputUserMessage,
  getDefaultUserParams,
} from "../prompts/parseInputPrompt.js";
import { task, entrypoint } from "@langchain/langgraph";
import { getLLM } from "../tools/common.js";

/**
 * 从 LLM 输出中解析 UserParams。
 * 对每个字段做类型校验和范围约束，确保结构完整。
 */
function parseUserParamsJson(raw: string, rawPrompt: string): UserParams {
  const defaults = getDefaultUserParams(rawPrompt);

  let text = raw?.trim() ?? "";
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();

  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    return {
      rawPrompt,
      topic:
        typeof obj.topic === "string" && obj.topic.trim()
          ? obj.topic.trim()
          : defaults.topic,
      role:
        typeof obj.role === "string" && obj.role.trim()
          ? obj.role.trim()
          : defaults.role,
      style:
        typeof obj.style === "string" && obj.style.trim()
          ? obj.style.trim()
          : defaults.style,
      targetAudience:
        typeof obj.targetAudience === "string" && obj.targetAudience.trim()
          ? obj.targetAudience.trim()
          : defaults.targetAudience,
      mood:
        typeof obj.mood === "string" && obj.mood.trim()
          ? obj.mood.trim()
          : defaults.mood,
      videoDuration:
        typeof obj.videoDuration === "number" && obj.videoDuration > 0
          ? Math.round(obj.videoDuration)
          : defaults.videoDuration,
      videoSize:
        typeof obj.videoSize === "string" && obj.videoSize.includes("*")
          ? obj.videoSize
          : defaults.videoSize,
      imageSize:
        typeof obj.imageSize === "string" && obj.imageSize.includes("*")
          ? obj.imageSize
          : defaults.imageSize,
      sceneCount:
        typeof obj.sceneCount === "number" && obj.sceneCount >= 1
          ? Math.min(Math.max(Math.round(obj.sceneCount), 1), 5)
          : defaults.sceneCount,
      useImageAsFirstFrame:
        typeof obj.useImageAsFirstFrame === "boolean"
          ? obj.useImageAsFirstFrame
          : defaults.useImageAsFirstFrame,
      extraRequirements:
        typeof obj.extraRequirements === "string"
          ? obj.extraRequirements
          : defaults.extraRequirements,
      targetFormat:
        typeof obj.targetFormat === "string" && obj.targetFormat.trim()
          ? obj.targetFormat.trim()
          : defaults.targetFormat,
      targetType:
        typeof obj.targetType === "string" && obj.targetType.trim()
          ? obj.targetType.trim()
          : defaults.targetType,
    };
  } catch {
    console.warn("[ParseInputAgent] JSON 解析失败，使用默认参数");
    return defaults;
  }
}

/**
 * 运行 ParseInput Agent。
 * 读取 state.topic，调用 LLM 解析为 UserParams，更新 state.userParams 和 state.topic（使用提炼后的主题）。
 */
export const parseInputAgentWorkflow = entrypoint(
  "parseInputAgentWorkflow",
  async (state: AgentState): Promise<AgentState> => {
    const rawPrompt = state.topic?.trim() ?? "";

    if (!rawPrompt) {
      console.warn("[ParseInputAgent] 输入为空，跳过解析");
      return state;
    }

    console.log("[ParseInputAgent] 开始解析用户输入...");
    console.log(`[ParseInputAgent] 原始输入: ${rawPrompt}`);

    const messages = [
      new SystemMessage(PARSE_INPUT_SYSTEM_PROMPT),
      new HumanMessage(buildParseInputUserMessage(rawPrompt)),
    ];

    const res = await getLLM().invoke(messages);
    const raw = res.content?.toString?.() ?? "";
    // 结构化解析后得到 userParams，作为最初输入
    const userParams = parseUserParamsJson(raw, rawPrompt);

    console.log("[ParseInputAgent] 解析完成:");
    console.log(JSON.stringify(userParams, null, 2));

    return {
      ...state,
      topic: userParams.topic,
      userParams,
    };
  },
);

/**
 * 从输入开始处理的第一个端点，解析提示词
 */
export async function runParseInputAgent(
  state: AgentState,
): Promise<AgentState> {
  return parseInputAgentWorkflow.invoke(state);
}
