import { interrupt, Command } from "@langchain/langgraph";
import type { UniversalState } from "../types.js";

function preview(state: UniversalState) {
  const lastText = [...state.artifacts].reverse().find((a) => a.kind === "text" && a.text);
  if (lastText?.text) {
    const t = lastText.text.replace(/\s+/g, " ").trim();
    return t.length > 300 ? `${t.slice(0, 300)}...` : t;
  }
  return "（暂无可预览产物）";
}

export async function runUniversalReview(state: UniversalState): Promise<any> {
  const payload = {
    type: "review",
    targets: state.route?.targets ?? [],
    preview: preview(state),
  };
  const resume = interrupt(payload) as any;
  const txt = typeof resume === "string" ? resume.trim() : "";
  const ok = /^y(es)?$/i.test(txt);
  if (ok) return state;

  const feedback = txt && !/^n(o)?$/i.test(txt) ? txt : "用户不满意，请改写并优化。";
  return new Command({
    goto: "intent_node",
    update: {
      memory: [
        ...(state.memory ?? []),
        { key: "review.feedback", value: feedback, at: new Date().toISOString() },
      ],
      artifacts: [],
    },
  });
}

