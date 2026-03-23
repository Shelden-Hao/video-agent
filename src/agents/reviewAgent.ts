import { interrupt, Command } from "@langchain/langgraph";
import type { AgentState, Artifact } from "../types/state.js";

function summarizeArtifacts(artifacts: Artifact[]): string {
  if (!artifacts?.length) return "（无产物）";
  const byKind = artifacts.reduce<Record<string, number>>((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(byKind).map(([k, n]) => `${k}:${n}`);
  return parts.join(", ");
}

function buildPreviews(state: AgentState): Array<{ kind: string; preview: string }> {
  const previews: Array<{ kind: string; preview: string }> = [];
  const artifacts = state.artifacts ?? [];

  const lastText = [...artifacts].reverse().find((a) => a.kind === "text" && a.text);
  if (lastText?.text) {
    const t = lastText.text.replace(/\s+/g, " ").trim();
    previews.push({ kind: "text", preview: t.length > 240 ? `${t.slice(0, 240)}...` : t });
  }

  const images = artifacts.filter((a) => a.kind === "image" && a.uri).slice(-3);
  if (images.length) {
    previews.push({ kind: "image", preview: images.map((a) => a.uri).join("\n  ") });
  }

  const videos = artifacts.filter((a) => a.kind === "video" && a.uri).slice(-2);
  if (videos.length) {
    previews.push({ kind: "video", preview: videos.map((a) => a.uri).join("\n  ") });
  }

  const audio = artifacts.filter((a) => a.kind === "audio" && a.uri).slice(-1);
  if (audio.length) {
    previews.push({ kind: "audio", preview: audio.map((a) => a.uri).join("\n  ") });
  }

  return previews;
}

/**
 * 人工 review：询问用户是否满意；不满意则回到 intent 重新开始（可携带反馈）。
 */
export async function runReviewAgent(state: AgentState): Promise<any> {
  const payload = {
    type: "review",
    summary: summarizeArtifacts(state.artifacts ?? []),
    previews: buildPreviews(state),
    hint: "请回复：yes/no；若 no 可附带改进意见。",
  };
  const resume = interrupt(payload) as any;
  const txt = typeof resume === "string" ? resume.trim() : "";
  const ok = /^y(es)?$/i.test(txt);
  if (ok) return state;

  // 将反馈拼接到 topic，回到 intent 重新路由与生成
  const feedback = txt && !/^n(o)?$/i.test(txt) ? txt : "用户不满意，请优化后重新生成。";
  const newTopic = `${state.topic}\n\n[用户反馈：${feedback}]`;
  return new Command({
    goto: "intent_agent",
    update: {
      topic: newTopic,
      memory: [
        ...(state.memory ?? []),
        { key: "review.feedback", value: feedback, at: new Date().toISOString() },
      ],
      artifacts: [],
      images: [],
      videos: [],
      video: "",
      audio: "",
      script: "",
    },
  });
}

