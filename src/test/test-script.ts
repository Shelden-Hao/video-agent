/**
 * 测试 Script Agent：根据 plan 生成教培向、儿童适宜的旁白脚本
 *
 * 用法：
 *   pnpm run test:script
 */
import "dotenv/config";
import type { AgentState, VideoPlan } from "../types/state.js";
import { runScriptAgent } from "../agents/scriptAgent.js";

const DEFAULT_PLAN: VideoPlan = {
  title: "小兔子学分享",
  targetAge: "3-6岁",
  totalDurationSeconds: 8,
  summary: "通过小兔子的故事，让儿童了解分享的快乐和重要性。",
  steps: [
    {
      step: 1,
      durationSeconds: 3,
      teachingPoint: "介绍小兔子有零食但不分享。",
      sceneDescription:
        "画面: 一只可爱的小兔子坐在草地上，手里拿着一根胡萝卜，表情有点得意。",
    },
    {
      step: 2,
      durationSeconds: 3,
      teachingPoint: "小兔子遇到其他小动物，学会分享。",
      sceneDescription:
        "小兔子遇到一只小松鼠，把胡萝卜分给它，两个小动物一起开心地吃东西。",
    },
    {
      step: 3,
      durationSeconds: 2,
      teachingPoint: "总结分享带来的快乐。",
      sceneDescription: "小兔子和小松鼠在阳光下玩耍，画面温馨，背景音乐轻快。",
    },
  ],
};

async function main() {
  const topic = "小兔子学分享";
  const plan = DEFAULT_PLAN;

  console.log("📋 测试 Script Agent - 主题:", topic);
  console.log("📑 计划:", plan.title, `(${plan.steps.length} 步)`);
  console.log("---");

  const initialState: AgentState = {
    topic,
    plan,
    script: "",
    images: [],
    audio: "",
    video: "",
  };

  const state = await runScriptAgent(initialState);

  if (!state.script) {
    console.error("❌ Script Agent 未能生成有效脚本");
    process.exit(1);
  }

  console.log("✅ 脚本生成成功\n");
  console.log("📝 旁白脚本:\n");
  console.log(state.script);
  console.log("\n---");
}

main().catch((err) => {
  console.error("test-script 运行错误:", err);
  process.exit(1);
});
