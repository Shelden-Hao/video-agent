import "dotenv/config";
import type { AgentState } from "../types/state.js";
import {
  SCRIPT_SYSTEM_PROMPT,
  buildScriptUserMessage,
} from "../prompts/scriptPrompt.js";
import { ChatAlibabaTongyi } from "@langchain/community/chat_models/alibaba_tongyi";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

const model = new ChatAlibabaTongyi({
  alibabaApiKey: process.env.ALIBABA_API_KEY,
  temperature: 0.7,
});

/** 清理模型返回的脚本文本：去除 markdown 代码块、多余空白等，内容结构化兜底 */
function cleanScriptOutput(raw: string): string {
  let text = raw?.trim() ?? "";
  // 去除可能的 markdown 代码块包裹
  const codeBlockMatch = text.match(/```(?:[\w]*)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }
  // 去除首尾多余空行，保留步骤间换行
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 根据计划生成「教培向、儿童适宜」的旁白脚本，
 * 产出与分步计划一一对应的旁白文本，供后续 TTS 与视频合成使用。
 */
export async function runScriptAgent(state: AgentState): Promise<AgentState> {
  if (!state.topic || !state.plan) return state;

  try {
    const userContent = buildScriptUserMessage(state);
    const res = await model.invoke([
      new SystemMessage(SCRIPT_SYSTEM_PROMPT),
      new HumanMessage(userContent),
    ]);

    const raw = res.content?.toString?.() ?? "";
    const script = cleanScriptOutput(raw);

    return {
      ...state,
      script: script || state.script,
    };
  } catch (err) {
    console.error("[ScriptAgent] 模型调用失败:", err);
    return { ...state };
  }
}
