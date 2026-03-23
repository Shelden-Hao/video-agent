import "dotenv/config";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState, Artifact } from "../types/state.js";
import { randomUUID } from "node:crypto";
import { getLLM } from "../tools/common.js";

const TEXT_SYSTEM_PROMPT = `你是一个通用文本生成模块。

根据用户输入主题，生成一段可直接使用的文本内容。
要求：
- 用中文输出
- 结构清晰
- 不要输出 JSON
- 控制在 200~500 字之间（除非用户明确要求更长/更短）`;

function buildTextUserMessage(state: AgentState): string {
  const topic = state.topic?.trim() ?? "";
  const intent = state.intent;
  const hint = intent?.publicRationale ? `意图摘要：${intent.publicRationale}\n` : "";
  const mem = (state.memory ?? [])
    .slice(-8)
    .map((m) => `- ${m.key}: ${m.value}`)
    .join("\n");
  const memBlock = mem ? `\n近期记忆（供参考）：\n${mem}\n` : "";
  return `${hint}${memBlock}用户需求：${topic}\n\n请生成文本内容。`;
}

export async function runTextAgent(state: AgentState): Promise<AgentState> {
  if (state.route && state.route.needs.text === false) return state;

  const messages = [
    new SystemMessage(TEXT_SYSTEM_PROMPT),
    new HumanMessage(buildTextUserMessage(state)),
  ];
  const res = await getLLM().invoke(messages);
  const text = res.content?.toString?.().trim?.() ?? "";
  if (!text) return state;

  const artifact: Artifact = {
    id: randomUUID(),
    kind: "text",
    text,
    mimeType: "text/plain",
    metadata: { type: "text" },
    source: { agent: "textAgent" },
    createdAt: new Date().toISOString(),
  };

  // 复用 script 字段作为后续 audio 的输入（第一版）
  return {
    ...state,
    script: text,
    artifacts: [...(state.artifacts ?? []), artifact],
  };
}

