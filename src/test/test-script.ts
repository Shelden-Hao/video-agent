/**
 * 测试 Script Agent：根据 plan 生成教培向、儿童适宜的旁白脚本
 */
import "dotenv/config";
import type { AgentState, VideoPlan } from "../types/state.js";
import { runScriptAgent } from "../agents/scriptAgent.js";

const DEFAULT_PLAN: VideoPlan = {
  title: "小兔子学分享",
  targetAge: "3-6岁",
  totalDurationSeconds: 8,
  summary: "通过小兔子和朋友的互动，教孩子学会分享。",
  steps: [
    {
      step: 1,
      durationSeconds: 3,
      teachingPoint: "小兔子有一个苹果，它想和朋友一起分享。",
      sceneDescription:
        "一只可爱的小兔子拿着一个红色的苹果，坐在草地上，脸上带着微笑。",
    },
    {
      step: 2,
      durationSeconds: 3,
      teachingPoint: "小兔子把苹果分给朋友，大家开心地一起吃。",
      sceneDescription:
        "小兔子把苹果递给一只小熊，小熊接过苹果，两人一起坐在树下开心地吃苹果。",
    },
    {
      step: 3,
      durationSeconds: 2,
      teachingPoint: "分享让朋友更开心，也让自己更快乐。",
      sceneDescription:
        "小兔子和小熊手拉手，脸上洋溢着幸福的笑容，背景是阳光明媚的森林。",
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
