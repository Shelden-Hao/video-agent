import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 使用 import.meta.url 定位项目根目录的 .env，无论从哪个目录运行都能正确加载
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../.env") });

import { buildWorkflow } from "./workflow/graph.js";
import { buildUniversalWorkflow } from "./universal.bak/workflow.js";
import type { UniversalState } from "./universal.bak/types.js";
import type { WorkflowSpec, AgentState } from "./types/state.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadUniversalSpecFromPath } from "./universal.bak/spec.js";

/**
 * 解析命令行参数
 * @param argv 命令行参数
 * @returns 解析后的参数
 * @example
 * npx tsx src/index.ts "下雨天妈妈送孩子上学的故事" --spec specs/text-only.json
 */
function parseArgs(argv: string[]) {
  const args = { prompt: "", specPath: "", threadId: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] ?? "";
    // 使用 --spec 指定 workflow 配置文件
    if (a === "--spec") {
      args.specPath = argv[i + 1] ?? "";
      i++;
      continue;
    }
    // 使用 --thread 指定 thread_id，thread_id 指的是工作流执行的唯一标识
    if (a === "--thread") {
      args.threadId = argv[i + 1] ?? "";
      i++;
      continue;
    }
    if (!a.startsWith("--") && !args.prompt) {
      args.prompt = a;
    }
  }
  return args;
}

/**
 * 加载 workflow 的 json 配置文件
 * @param specPath 配置文件路径
 * @returns 配置文件内容
 * @example
 * loadWorkflowSpec("specs/text-only.json")
 */
function loadWorkflowSpec(specPath: string): WorkflowSpec | undefined {
  if (!specPath) return undefined;
  const abs = resolve(specPath);
  const raw = readFileSync(abs, "utf-8");
  const json = JSON.parse(raw) as WorkflowSpec;
  if (
    !json?.targets ||
    !Array.isArray(json.targets) ||
    json.targets.length === 0
  ) {
    throw new Error(`Invalid WorkflowSpec.targets in ${abs}`);
  }
  return json;
}

async function main() {
  // 用户输入：支持命令行参数，或直接修改 prompt 变量
  const {
    prompt: argPrompt,
    specPath,
    threadId: argThreadId,
  } = parseArgs(process.argv);
  const prompt = argPrompt ?? "";
  //const spec = await loadUniversalSpecFromPath(specPath);
  const workflowSpec = loadWorkflowSpec(specPath);
  const threadId = argThreadId || randomUUID();

  if (!prompt.trim()) {
    console.error("请提供用户输入，例如：");
    console.error(
      '  npx tsx src/index.ts "帮我写一个下雨天妈妈送孩子上学的故事"',
    );
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("🤖 通用智能体工作流启动");
  console.log("=".repeat(60));
  console.log(`用户输入：${prompt}`);
  console.log("");

  //const workflow = buildUniversalWorkflow();
  const workflow = buildWorkflow(workflowSpec);
  const config = { configurable: { thread_id: threadId } };

  // const initialState: UniversalState = {
  //   input: prompt,
  //   spec,
  //   artifacts: [],
  //   memory: [],
  // };
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
    artifacts: [],
    memory: [],
    workflowSpec,
  };

  console.log("[Workflow] 开始执行工作流...\n");

  /**
   * @description readline 接口，用于交互式输入
   * @example
   * const rl = createInterface({ input, output });
   * const ans = await rl.question("> 请输入继续所需的信息：\n> ");
   */
  const rl = createInterface({ input, output });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any = await (workflow as any).invoke(initialState, config);
  /*
  result 的结构：
  {
    vals: [], // 工作流执行的结果
    __interrupt__: [ // 中断信息
      { id: '...', value: 'question_a' }, // 中断的 id 和 value
      { id: '...', value: 'question_b' }, // 中断的 id 和 value
    ],
    // ...
  }
  */

  // 交互式 interrupt 循环：可中断、可继续、可恢复（thread_id 固定）
  // 保持持续判断中断状态是否存在
  while (result && result.__interrupt__) {
    const intr = result.__interrupt__;
    const first = Array.isArray(intr) ? intr[0] : intr;
    const payload = first?.value ?? first;

    //if (payload?.type === "clarify") {
    // 需要澄清意图
    if (payload?.type === "clarify_intent") {
      console.log("\n[需要澄清] 意图不够明确：");
      console.log(payload.intent);
      // 中断信息，用于恢复工作流执行
      const resume: Record<string, string> = {};
      for (const q of payload.questions ?? []) {
        const opts = q.options?.length
          ? `（可选：${q.options.join(", ")}）`
          : "";
        // eslint-disable-next-line no-await-in-loop
        const ans = await rl.question(`- ${q.prompt}${opts}\n> `);
        resume[q.key] = ans;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // 通过 Command 对象传递 resume 信息，恢复工作流执行
      result = await (workflow as any).invoke(new Command({ resume }), config);
      // 继续执行工作流
      continue;
    }

    // 需要人工Review
    if (payload?.type === "review") {
      // console.log(
      //   `\n[人工Review] targets=${(payload.targets ?? []).join(",")}`,
      // );
      // console.log("\n[预览]");
      // console.log(payload.preview ?? "（无）");
      console.log(`\n[人工Review] 产物概览：${payload.summary}`);
      if (payload.previews?.length) {
        console.log("\n[预览]");
        for (const p of payload.previews) {
          if (p.kind === "text") {
            console.log(`- text: ${p.preview}`);
          } else {
            console.log(`- ${p.kind}: ${p.preview}`);
          }
        }
      }
      const ans = await rl.question("> 是否满意？(yes/no + 可选改进意见)\n> ");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await (workflow as any).invoke(
        new Command({ resume: ans }),
        config,
      );
      // 继续执行工作流
      continue;
    }

    // 未识别的 interrupt：直接把原始 payload 打印出来并要求用户输入一个 resume 字符串
    console.log("\n[需要输入] 工作流暂停：");
    console.log(payload);
    const ans = await rl.question("> 请输入继续所需的信息：\n> ");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result = await (workflow as any).invoke(
      new Command({ resume: ans }),
      config,
    );
  }

  rl.close();

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
        threadId,
        intent: result.intent,
        route: result.route,
        // spec: result.spec,
        // memory: result.memory,
        artifacts: result.artifacts,
        images: result.images,
        videos: result.videos,
        audio: result.audio,
        video: result.video,
        videoParams: result.videoParams,
        memory: result.memory,
        workflowSpec: result.workflowSpec,
        userParams: result.userParams,
        plan: result.plan,
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
