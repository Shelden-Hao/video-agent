/**
 * 测试 Video Agent 完整流程：
 *   1. 输入结构化（LLM 将 plan/script 转为精确视频参数）
 *   2. 视频生成（调用 wanx2.1-t2v-turbo 异步 API，轮询）
 *   3. 生成后校验（语义一致性 + 安全审核 + 质量检测）
 *   4. 自动修改（校验不通过时携带反馈重新生成）
 *
 * 注意：视频生成通常需要 1-5 分钟，请耐心等待。
 * 默认只处理第 1 步（VIDEO_MAX_STEPS=1）以节约免费额度。
 */
import "dotenv/config";
import type { AgentState, VideoPlan } from "../types/state.js";
import { runVideoAgent } from "../agents/videoAgent.js";

const DEFAULT_PLAN: VideoPlan = {
  title: "小兔子学分享",
  targetAge: "3-6岁",
  totalDurationSeconds: 15,
  summary: "通过小兔子的故事，让儿童了解分享的快乐和重要性。",
  steps: [
    {
      step: 1,
      durationSeconds: 5,
      teachingPoint: "小兔子在草地上欢快地跑来跑去，尾巴一摇一摇。",
      sceneDescription:
        "一只可爱的白色小兔子在绿色草地上蹦跳，周围有小花，阳光明媚，背景是蓝天白云。",
    },
    {
      step: 2,
      durationSeconds: 5,
      teachingPoint: "小兔子遇到小松鼠，把胡萝卜分享给它。",
      sceneDescription:
        "小兔子把一根胡萝卜递给小松鼠，两只小动物相视而笑，画面温馨。",
    },
    {
      step: 3,
      durationSeconds: 5,
      teachingPoint: "两个好朋友一起在草地上快乐玩耍。",
      sceneDescription:
        "小兔子和小松鼠手拉手在阳光下的草地上转圈玩耍，背景是彩虹和花朵。",
    },
  ],
};

async function main() {
  const topic = "小兔子学分享";
  const plan = DEFAULT_PLAN;
  const script =
    "步骤1：小白兔蹦蹦跳跳，好开心呀！它跑到草地上玩耍，尾巴一摇一摇真可爱。\n" +
    "步骤2：小兔子遇到了小松鼠，把胡萝卜分一半给好朋友，分享真快乐！\n" +
    "步骤3：两个好朋友手拉手在草地上转圈圈，笑声在阳光里飘扬。";

  console.log("🎬 测试 Video Agent");
  console.log("━".repeat(50));
  console.log(`📌 主题：${topic}`);
  console.log(`📑 计划：${plan.title}（${plan.steps.length} 步）`);
  console.log(
    `⚙️  模型：${process.env.BAILIAN_T2V_MODEL ?? "wanx2.1-t2v-turbo"}`,
  );
  console.log(
    `🔢 最大处理步数：${process.env.VIDEO_MAX_STEPS ?? "1"}（设置 VIDEO_MAX_STEPS 可调整）`,
  );
  console.log("━".repeat(50));
  console.log("⏳ 视频生成通常需要 1-5 分钟，请耐心等待...\n");

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

  const startTime = Date.now();
  let state: AgentState;

  try {
    state = await runVideoAgent(initialState);
  } catch (err) {
    console.error("\n❌ Video Agent 运行失败:", err);
    process.exit(1);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  console.log("\n" + "━".repeat(50));
  console.log(`✅ Video Agent 完成（用时 ${elapsed}s）`);
  console.log("━".repeat(50));

  // 检查结构化参数
  if (!state.videoParams || state.videoParams.length === 0) {
    console.error("❌ videoParams 为空，结构化步骤失败");
    process.exit(1);
  }

  console.log(`\n📐 结构化视频参数（共 ${state.videoParams.length} 组）：`);
  state.videoParams.forEach((p, i) => {
    console.log(`\n  步骤 ${p.step}：`);
    console.log(`    prompt:    ${p.prompt.slice(0, 80)}...`);
    console.log(`    negative:  ${p.negativePrompt.slice(0, 60)}...`);
    console.log(`    size:      ${p.size}`);
    console.log(`    duration:  ${p.duration}s`);
    console.log(`    extend:    ${p.promptExtend}`);
    void i;
  });

  // 检查视频输出
  if (!state.videos || state.videos.length === 0) {
    console.error("\n❌ 未能生成任何视频（videos 为空）");
    process.exit(1);
  }

  console.log(`\n🎥 生成视频（共 ${state.videos.length} 段）：`);
  state.videos.forEach((url, i) => {
    console.log(`  ${i + 1}. ${url}`);
  });

  console.log(`\n🏆 最终视频 URL：`);
  console.log(`   ${state.video}`);
  console.log("\n" + "━".repeat(50));
}

main().catch((err) => {
  console.error("test-video 运行错误:", err);
  process.exit(1);
});
