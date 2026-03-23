/**
 * 测试 Image Agent：根据 plan/script 生成每步图片提示词，并通过 imageTool 产出图片 URL
 */
import "dotenv/config";
import type { AgentState, VideoPlan } from "../types/state.js";
import { runImageAgent } from "../agents/imageAgent.js";

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
        "一只可爱的小兔子坐在草地上，手里拿着一根胡萝卜，表情有点得意。",
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
  const script =
    "步骤1：小兔子手里的胡萝卜真好吃，它一个人偷偷吃，不跟朋友分享哦。\n" +
    "步骤2：小兔子遇到小松鼠，把胡萝卜分一半给它，两个好朋友一起吃，真开心！\n" +
    "步骤3：分享让朋友更开心，小兔子和小松鼠一起玩，阳光下笑眯眯的。";

  console.log("🖼️  测试 Image Agent - 主题:", topic);
  console.log("📑 计划:", plan.title, `(${plan.steps.length} 步)`);
  console.log("---");

  const initialState: AgentState = {
    topic,
    userParams: null,
    plan,
    script,
    images: [],
    audio: "",
    video: "",
    videoParams: [],
    videos: [],
    artifacts: [],
    memory: [],
  };

  const state = await runImageAgent(initialState);

  if (!state.images || state.images.length === 0) {
    console.error("❌ Image Agent 未能生成有效图片列表");
    process.exit(1);
  }

  // 期望至少与步骤数一致（占位实现会严格相等）
  if (state.images.length < plan.steps.length) {
    console.error(
      `❌ 图片数量不足：期望 >= ${plan.steps.length}，实际 ${state.images.length}`,
    );
    process.exit(1);
  }

  console.log("✅ 图片生成成功\n");
  console.log("🧩 图片 URLs:");
  state.images.forEach((url, i) => {
    console.log(`  ${i + 1}. ${url}`);
  });
  console.log("\n---");
}

main().catch((err) => {
  console.error("test-image 运行错误:", err);
  process.exit(1);
});
