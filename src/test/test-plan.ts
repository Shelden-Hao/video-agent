/**
 * 测试 Planner：根据 topic 生成教培向、儿童适宜的视频计划
 *
 * 用法：
 *   pnpm run test:plan
 *   pnpm run test:plan 认识数字1到5
 *   pnpm run test:plan "小兔子学分享"
 */
import "dotenv/config";
import { runPlanAgent } from "../agents/planAgent.js";
import type { AgentState } from "../types/state.js";

async function main() {
  const topic = process.argv[2] ?? "";
  console.log("📋 测试 Planner - 主题:", topic);
  console.log("---");

  const initialState: AgentState = {
    topic,
    plan: null,
    script: "",
    images: [],
    audio: "",
    video: "",
  };

  const state = await runPlanAgent(initialState);

  if (!state.plan) {
    console.error(
      "❌ Planner 未能生成有效计划（可能是模型返回格式不符合 JSON）",
    );
    process.exit(1);
  }

  const p = state.plan;
  console.log("✅ 计划生成成功\n");
  console.log("📌 标题:", p.title);
  console.log("👶 目标年龄:", p.targetAge);
  console.log("⏱  总时长:", p.totalDurationSeconds, "秒");
  console.log("📝 概要:", p.summary);
  console.log("\n📑 分步计划:");
  p.steps.forEach((s) => {
    console.log(`  ${s.step}. [${s.durationSeconds}s] ${s.teachingPoint}`);
    console.log(`     画面: ${s.sceneDescription}`);
  });
}

main().catch((err) => {
  console.error("test-plan 运行错误:", err);
  process.exit(1);
});
