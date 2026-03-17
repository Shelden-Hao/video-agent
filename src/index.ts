import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 使用 import.meta.url 定位项目根目录的 .env，无论从哪个目录运行都能正确加载
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../.env") });

import { buildVideoWorkflow } from "./workflow/graph.js";
import type { AgentState } from "./types/state.js";

async function main() {
  // 用户输入：支持命令行参数，或直接修改 prompt 变量
  const prompt =
    process.argv[2] ?? "一只可爱的小猫咪在花园里玩耍，2D卡通风格，欢快活泼";

  if (!prompt.trim()) {
    console.error("请提供视频创作 prompt，例如：");
    console.error('  npx tsx src/index.ts "一只可爱的小猫咪在花园里玩耍"');
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("🎬 视频生成工作流启动");
  console.log("=".repeat(60));
  console.log(`用户输入：${prompt}`);
  console.log("");

  const workflow = buildVideoWorkflow();

  const initialState: AgentState = {
    topic: prompt,
    userParams: null,
    plan: null,
    script: "",
    images: [],
    audio: "",
    video: "",
    videoParams: [],
    videos: [],
  };

  console.log("[Workflow] 开始执行工作流...\n");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await (workflow as any).invoke(initialState)) as AgentState;

  console.log("\n" + "=".repeat(60));
  console.log("✅ 工作流执行完成");
  console.log("=".repeat(60));

  // 输出结构化结果
  console.log("\n📋 解析参数 (UserParams):");
  console.log(JSON.stringify(result.userParams, null, 2));

  console.log("\n📝 生成计划 (VideoPlan):");
  if (result.plan) {
    console.log(`  标题: ${result.plan.title}`);
    console.log(`  受众: ${result.plan.targetAge}`);
    console.log(`  时长: ${result.plan.totalDurationSeconds}秒`);
    console.log(`  概要: ${result.plan.summary}`);
    console.log(`  步骤数: ${result.plan.steps.length}`);
  }

  console.log("\n🖼️  生成图片:");
  (result.images ?? []).forEach((url: string, i: number) => {
    console.log(`  步骤${i + 1}: ${url}`);
  });

  console.log("\n🎬 生成视频:");
  (result.videos ?? []).forEach((url: string, i: number) => {
    console.log(`  步骤${i + 1}: ${url}`);
  });

  if (!result.images?.length && !result.videos?.length) {
    console.log("  (无输出 — 请检查 API Key 和环境变量配置)");
  }

  console.log("\n📦 完整结果 JSON:");
  console.log(
    JSON.stringify(
      {
        userParams: result.userParams,
        plan: result.plan,
        images: result.images,
        videos: result.videos,
        video: result.video,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("\n❌ 工作流执行错误:", err);
  process.exit(1);
});
