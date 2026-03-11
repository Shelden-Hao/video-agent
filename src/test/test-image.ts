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
  const script =
    "步骤1：小兔子有一个红红的苹果，它想和小熊一起分享，真棒呀！\n" +
    "步骤2：小兔子把苹果分给小熊，两个好朋友一起坐在树下，开心地吃苹果！\n" +
    "步骤3：你看，分享会让朋友更开心，也会让我们更快乐！";

  console.log("🖼️  测试 Image Agent - 主题:", topic);
  console.log("📑 计划:", plan.title, `(${plan.steps.length} 步)`);
  console.log("---");

  const initialState: AgentState = {
    topic,
    plan,
    script,
    images: [],
    audio: "",
    video: "",
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

