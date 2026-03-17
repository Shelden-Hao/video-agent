/**
 * Video Agent — 基于 LangGraph Functional API（task + entrypoint）
 *
 * 完整流程（Evaluator-Optimizer 模式）：
 *
 *  Step 1 · 输入结构化
 *    generateVideoParamsTask(AgentState) → VideoGenerationParams[]
 *    LLM 将 userParams/plan 转换为精确的视频 API 参数（prompt、size、负面词等）
 *    若 userParams.useImageAsFirstFrame=true，自动将 state.images 注入为 firstFrameUrl
 *
 *  Step 2 · 视频生成（异步 Wan API + 轮询）
 *    generateVideoTask({ params }) → string（videoUrl）
 *    - 若有 firstFrameUrl → 使用 i2v（图生视频）模式
 *    - 否则 → 使用 t2v（纯文生视频）模式
 *
 *  Step 3 · 生成后校验（并行三项）
 *    evaluateVideoTask({ videoUrl, params }) → EvaluationResult
 *    - 语义一致性：视频内容是否符合 prompt（含风格/情绪/受众检验）
 *    - 安全审核：NSFW / 暴力 / 政治 / 仇恨
 *    - 质量检测：清晰度 / 流畅度 / 构图
 *
 *  Step 4 · 自动修改（不满足时重新生成）
 *    videoEvaluatorOptimizer: 最多 MAX_RETRY 次，每次将上次失败原因反馈给 prompt
 *
 * 架构参考：
 *   https://docs.langchain.com/oss/javascript/langgraph/workflows-agents#evaluator-optimizer
 */

import "dotenv/config";
import { task, entrypoint } from "@langchain/langgraph";
import { ChatAlibabaTongyi } from "@langchain/community/chat_models/alibaba_tongyi";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState, VideoGenerationParams } from "../types/state.js";
import {
  VIDEO_STRUCTURE_SYSTEM_PROMPT,
  buildVideoStructureUserMessage,
  extractVideoParams,
} from "../prompts/videoPrompt.js";
import {
  checkVideoConsistency,
  checkVideoSafety,
  checkVideoQuality,
} from "../tools/videoChecks.js";
import { extractImageVisualStyle } from "../tools/imageChecks.js";

// ---------------------------------------------------------------------------
// 常量与工具函数
// ---------------------------------------------------------------------------

const MAX_RETRY_PER_VIDEO = Number(process.env.VIDEO_MAX_RETRY ?? "3");
const POLL_INTERVAL_MS = 15_000;
const POLL_MAX_WAIT_MS = 15 * 60 * 1000;
const RATE_LIMIT_BASE_DELAY_MS = 3_000;
const RATE_LIMIT_MAX_RETRY = 4;
const MAX_VIDEO_STEPS = Number(process.env.VIDEO_MAX_STEPS ?? "1");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 懒初始化：首次调用时创建，避免模块加载时 dotenv 尚未读取 .env 文件
let _llm: ChatAlibabaTongyi | null = null;
function getLLM(): ChatAlibabaTongyi {
  if (!_llm) {
    _llm = new ChatAlibabaTongyi({
      alibabaApiKey: process.env.ALIBABA_API_KEY,
      temperature: 0.5,
    });
  }
  return _llm;
}

// ---------------------------------------------------------------------------
// Wan 视频生成 API（异步 + 轮询）
// ---------------------------------------------------------------------------

type WanVideoParams = {
  /** 文生视频（t2v）模型名，如 "wanx2.1-t2v-turbo" */
  t2vModel: string;
  /** 图生视频（i2v）模型名（可选），如 "wanx2.1-i2v-turbo" */
  i2vModel?: string;
  prompt: string;
  negativePrompt: string;
  size: string;
  duration: number;
  promptExtend: boolean;
  /** 首帧图片 URL（提供则自动切换 i2v 模式） */
  firstFrameUrl?: string;
  audioUrl?: string;
  baseUrl: string;
};

/**
 * 提交视频生成任务，返回 task_id。
 *
 * i2v 模式（图生视频）：仅当同时满足以下条件时才启用：
 *   1. firstFrameUrl 不为空
 *   2. i2vModel 已配置（需在 .env 中设置 BAILIAN_I2V_MODEL）
 * 否则回退为 t2v（纯文生视频）模式，不传 img_url。
 */
async function submitVideoTask(params: WanVideoParams): Promise<string> {
  const apiKey = process.env.ALIBABA_API_KEY;
  if (!apiKey) throw new Error("Missing ALIBABA_API_KEY");

  // 只有同时有 firstFrameUrl 且有 i2v 模型时才真正使用 i2v 模式
  const useI2V = Boolean(params.firstFrameUrl) && Boolean(params.i2vModel);
  const model = useI2V ? params.i2vModel! : params.t2vModel;

  if (useI2V) {
    console.log(
      `[VideoAgent] ✅ i2v 模式，首帧: ${params.firstFrameUrl?.slice(0, 80)}...`,
    );
  } else if (params.firstFrameUrl && !params.i2vModel) {
    console.log(
      `[VideoAgent] ⚠️  有首帧图但未配置 BAILIAN_I2V_MODEL，使用 t2v 模式（风格已通过 prompt 约束）`,
    );
  }

  const url = `${params.baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`;
  const body: Record<string, unknown> = {
    model,
    input: {
      prompt: params.prompt,
      ...(params.negativePrompt
        ? { negative_prompt: params.negativePrompt }
        : {}),
      // 仅 i2v 模式才传 img_url；t2v 模型不识别 img_url 会生成随机风格
      ...(useI2V && params.firstFrameUrl
        ? { img_url: params.firstFrameUrl }
        : {}),
      ...(params.audioUrl ? { audio_url: params.audioUrl } : {}),
    },
    parameters: {
      size: params.size,
      duration: params.duration,
      prompt_extend: params.promptExtend,
      watermark: false,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Video API non-JSON response: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  }

  if (!res.ok) {
    const code = (json as any)?.code ?? "HTTPError";
    const message = (json as any)?.message ?? text.slice(0, 300);
    const err = new Error(
      `Video API submit error: ${code} - ${message}`,
    ) as Error & { isRateLimit?: boolean };
    err.isRateLimit =
      String(code).includes("Throttling") || String(code).includes("RateQuota");
    throw err;
  }

  const taskId = (json as any)?.output?.task_id;
  if (!taskId || typeof taskId !== "string") {
    throw new Error(
      `Video API missing task_id in response: ${text.slice(0, 300)}`,
    );
  }

  console.log(`[VideoAgent] 任务已提交，task_id: ${taskId}`);
  return taskId;
}

/**
 * 轮询 task_id 直到任务完成，返回视频 URL。
 */
async function pollVideoTask(taskId: string, baseUrl: string): Promise<string> {
  const apiKey = process.env.ALIBABA_API_KEY;
  if (!apiKey) throw new Error("Missing ALIBABA_API_KEY");

  const queryUrl = `${baseUrl}/api/v1/tasks/${taskId}`;
  const startTime = Date.now();

  while (Date.now() - startTime < POLL_MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const res = await fetch(queryUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      console.warn(`[VideoAgent] 轮询非 JSON 响应: ${text.slice(0, 200)}`);
      continue;
    }

    const status = (json as any)?.output?.task_status;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[VideoAgent] 轮询中... 状态: ${status}，已等待 ${elapsed}s`);

    if (status === "SUCCEEDED") {
      const videoUrl = (json as any)?.output?.video_url;
      if (!videoUrl || typeof videoUrl !== "string") {
        throw new Error(
          `Video task SUCCEEDED but missing video_url: ${text.slice(0, 300)}`,
        );
      }
      console.log(`[VideoAgent] 视频生成成功: ${videoUrl}`);
      return videoUrl;
    }

    if (status === "FAILED") {
      const code = (json as any)?.output?.code ?? "FAILED";
      const message = (json as any)?.output?.message ?? "Unknown error";
      throw new Error(`Video task FAILED: ${code} - ${message}`);
    }

    if (status === "CANCELED") {
      throw new Error("Video task was CANCELED");
    }

    if (status === "UNKNOWN") {
      throw new Error(
        `Video task UNKNOWN (task_id may have expired): ${taskId}`,
      );
    }
    // PENDING / RUNNING：继续轮询
  }

  throw new Error(
    `Video task timeout after ${POLL_MAX_WAIT_MS / 1000}s, task_id: ${taskId}`,
  );
}

// ---------------------------------------------------------------------------
// LangGraph Task 定义
// ---------------------------------------------------------------------------

/**
 * [Task] Step 1：从已生成图片中提取视觉风格描述，用于约束视频风格。
 *
 * 分析第一张图片的渲染风格（2D卡通/3D/写实）、主角外观、色调，
 * 生成英文描述字符串，注入到视频生成提示词中，确保风格一致。
 */
const extractImageStyleTask = task(
  "extractImageStyle",
  async (params: { imageUrl: string }): Promise<string> => {
    console.log("[VideoAgent] 正在提取图片视觉风格（用于约束视频风格）...");
    const styleDesc = await extractImageVisualStyle(params.imageUrl);
    if (styleDesc) {
      console.log(`[VideoAgent] 图片风格提取完成: ${styleDesc.slice(0, 100)}...`);
    } else {
      console.warn("[VideoAgent] 图片风格提取失败，将依赖 userParams.style");
    }
    return styleDesc;
  },
);

/**
 * [Task] Step 2：输入结构化
 *
 * 先提取图片视觉风格，再让 LLM 将 userParams/plan 转换为每步结构化视频生成参数。
 * 视觉风格描述作为最高优先级约束注入到 LLM 提示词中，确保视频风格与图片一致。
 * 最后注入每步对应的 firstFrameUrl（若 i2v 模型已配置）。
 */
const generateVideoParamsTask = task(
  "generateVideoParams",
  async (state: AgentState): Promise<VideoGenerationParams[]> => {
    console.log("[VideoAgent] Step 1: 开始结构化视频生成参数...");

    // 提取图片视觉风格（若有已生成图片）
    let imageStyleDescription = "";
    if (state.images.length > 0) {
      imageStyleDescription = await extractImageStyleTask({
        imageUrl: state.images[0],
      });
    }

    const messages = [
      new SystemMessage(VIDEO_STRUCTURE_SYSTEM_PROMPT),
      new HumanMessage(
        buildVideoStructureUserMessage(state, imageStyleDescription || undefined),
      ),
    ];

    const res = await getLLM().invoke(messages);
    const raw = res.content?.toString?.() ?? "";
    let params = extractVideoParams(raw, state);

    // 若 i2v 模型已配置 + 用户要求图片作为视频首帧，注入 firstFrameUrl
    const useFirstFrame = state.userParams?.useImageAsFirstFrame ?? false;
    const hasI2VModel = Boolean(process.env.BAILIAN_I2V_MODEL);
    if (useFirstFrame && hasI2VModel && state.images.length > 0) {
      console.log(
        `[VideoAgent] i2v 模式：为 ${Math.min(params.length, state.images.length)} 步注入首帧图片`,
      );
      params = params.map((p, i) => ({
        ...p,
        firstFrameUrl: state.images[i] ?? undefined,
      }));
    } else if (useFirstFrame && !hasI2VModel) {
      console.log(
        `[VideoAgent] 未配置 BAILIAN_I2V_MODEL，跳过首帧注入，风格已通过 prompt 约束`,
      );
    }

    console.log(`[VideoAgent] Step 1 完成：生成 ${params.length} 组视频参数`);
    return params;
  },
);

/**
 * [Task] Step 2：视频生成（含限流指数退避重试）
 */
const generateVideoTask = task(
  "generateVideo",
  async (params: {
    videoParams: VideoGenerationParams;
    feedback?: string;
    t2vModel: string;
    i2vModel?: string;
    baseUrl: string;
    audioUrl?: string;
  }): Promise<string> => {
    const { videoParams, feedback, t2vModel, i2vModel, baseUrl, audioUrl } =
      params;

    let refinedPrompt = videoParams.prompt;
    if (feedback) {
      const feedbackNote = `[请修正以下问题：${feedback}]；`;
      refinedPrompt = (feedbackNote + refinedPrompt).slice(0, 800);
      console.log(`[VideoAgent] Step 2: 携带修正反馈重新生成，prompt 已调整`);
    }

    const wanParams: WanVideoParams = {
      t2vModel,
      i2vModel,
      prompt: refinedPrompt,
      negativePrompt: videoParams.negativePrompt,
      size: videoParams.size,
      duration: videoParams.duration,
      promptExtend: videoParams.promptExtend,
      firstFrameUrl: videoParams.firstFrameUrl,
      baseUrl,
      audioUrl,
    };

    let delay = RATE_LIMIT_BASE_DELAY_MS;
    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRY; attempt++) {
      try {
        const taskId = await submitVideoTask(wanParams);
        const videoUrl = await pollVideoTask(taskId, baseUrl);
        return videoUrl;
      } catch (err: unknown) {
        if ((err as any)?.isRateLimit && attempt < RATE_LIMIT_MAX_RETRY) {
          console.warn(
            `[VideoAgent] 触发限流，${delay / 1000}s 后重试（第 ${attempt} 次）`,
          );
          await sleep(delay);
          delay *= 2;
          continue;
        }
        throw err;
      }
    }
    throw new Error("[generateVideoTask] 超出限流重试上限");
  },
);

/**
 * [Task] Step 3：生成后校验（并行三项）
 */
const evaluateVideoTask = task(
  "evaluateVideo",
  async (params: {
    videoUrl: string;
    videoParams: VideoGenerationParams;
    userParams?: AgentState["userParams"];
  }) => {
    const { videoUrl, videoParams, userParams } = params;

    console.log("[VideoAgent] Step 3: 开始校验（语义/安全/质量）...");

    const [consistencyRes, safetyRes, qualityRes] = await Promise.all([
      checkVideoConsistency(videoUrl, videoParams.prompt, userParams ?? undefined),
      checkVideoSafety(videoUrl, videoParams.prompt),
      checkVideoQuality(videoUrl),
    ]);

    const feedback = (
      [
        !consistencyRes.ok && `语义不符: ${consistencyRes.reason}`,
        !safetyRes.ok && `安全违规: ${safetyRes.reason}`,
        !qualityRes.ok && `质量不达标: ${qualityRes.reason}`,
      ] as (string | false)[]
    )
      .filter(Boolean)
      .join("; ");

    const accepted = consistencyRes.ok && safetyRes.ok && qualityRes.ok;

    if (accepted) {
      console.log("[VideoAgent] Step 3: 校验通过 ✓");
    } else {
      console.warn(`[VideoAgent] Step 3: 校验未通过 — ${feedback}`);
    }

    return {
      accepted,
      feedback,
      details: {
        consistency: consistencyRes,
        safety: safetyRes,
        quality: qualityRes,
      },
    };
  },
);

// ---------------------------------------------------------------------------
// Step 4：Evaluator-Optimizer 闭环（自动修改）
// ---------------------------------------------------------------------------

type VideoWorkflowInput = {
  videoParams: VideoGenerationParams;
  maxRetry: number;
  t2vModel: string;
  i2vModel?: string;
  baseUrl: string;
  audioUrl?: string;
  userParams?: AgentState["userParams"];
};

/**
 * 单步视频「生成 → 校验 → 反馈 → 重新生成」闭环。
 *
 * 遵循 LangGraph evaluator-optimizer 模式：
 *   generateVideo → evaluateVideo → [accepted? ✓end : ✗generateVideo]
 */
const videoEvaluatorOptimizer = entrypoint(
  "videoEvaluatorOptimizer",
  async ({
    videoParams,
    maxRetry,
    t2vModel,
    i2vModel,
    baseUrl,
    audioUrl,
    userParams,
  }: VideoWorkflowInput): Promise<string> => {
    let lastFeedback = "";

    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      console.log(
        `[VideoAgent] Step 4: 开始第 ${attempt}/${maxRetry} 次生成尝试（步骤 ${videoParams.step}）`,
      );

      const videoUrl = await generateVideoTask({
        videoParams,
        feedback: lastFeedback || undefined,
        t2vModel,
        i2vModel,
        baseUrl,
        audioUrl,
      });

      const evaluation = await evaluateVideoTask({
        videoUrl,
        videoParams,
        userParams,
      });

      if (evaluation.accepted) {
        console.log(
          `[VideoAgent] 步骤 ${videoParams.step} 视频通过校验 ✓ URL: ${videoUrl}`,
        );
        return videoUrl;
      }

      lastFeedback = evaluation.feedback;
      console.warn(
        `[VideoAgent] attempt ${attempt}/${maxRetry} 未通过 | ${lastFeedback}`,
        evaluation.details,
      );
    }

    throw new Error(
      `[VideoEval] 步骤 ${videoParams.step} 在 ${maxRetry} 次重试后仍未通过校验，` +
        `最后失败原因: ${lastFeedback}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 顶层 Video Agent 工作流
// ---------------------------------------------------------------------------

/**
 * 顶层视频 Agent entrypoint。
 *
 * 完整流程：
 *   generateVideoParamsTask (LLM 结构化 + 注入 firstFrameUrl)
 *         ↓ VideoGenerationParams[]
 *   forEach step (串行，避免触发限流):
 *     videoEvaluatorOptimizer.invoke() → videoUrl
 *         ↓
 *   return { ...state, videoParams, videos, video }
 */
const videoAgentWorkflow = entrypoint(
  "videoAgent",
  async (state: AgentState): Promise<AgentState> => {
    if (!state.plan) {
      console.warn("[VideoAgent] 无 plan，跳过视频生成");
      return state;
    }

    const apiKey = process.env.ALIBABA_API_KEY;
    if (!apiKey) throw new Error("Missing ALIBABA_API_KEY");

    const t2vModel = process.env.BAILIAN_VIDEO_MODEL ?? "wanx2.1-t2v-turbo";
    // i2v 模型：专用图生视频，未设置则回退到 t2v（不使用首帧）
    const i2vModel = process.env.BAILIAN_I2V_MODEL ?? undefined;
    const baseUrl =
      process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com";

    const useFirstFrame = state.userParams?.useImageAsFirstFrame ?? false;
    if (useFirstFrame && !i2vModel) {
      console.warn(
        "[VideoAgent] useImageAsFirstFrame=true 但未设置 BAILIAN_I2V_MODEL，首帧将被忽略（t2v 模式不支持）",
      );
    }

    // Step 1：输入结构化（含 firstFrameUrl 注入）
    const allParams = await generateVideoParamsTask(state);

    // 限制最大处理步骤数
    const paramsToProcess = allParams.slice(0, MAX_VIDEO_STEPS);

    console.log(
      `[VideoAgent] 共 ${allParams.length} 步，本次处理前 ${paramsToProcess.length} 步`,
      `（VIDEO_MAX_STEPS=${MAX_VIDEO_STEPS}）`,
    );

    // Step 2 + 3 + 4：串行生成每步视频（避免并发触发限流）
    const videos: string[] = [];
    for (const [i, vp] of paramsToProcess.entries()) {
      if (i > 0) {
        console.log("[VideoAgent] 等待 3s 后处理下一步（限流缓冲）...");
        await sleep(3_000);
      }

      const videoUrl = await videoEvaluatorOptimizer.invoke({
        videoParams: vp,
        maxRetry: MAX_RETRY_PER_VIDEO,
        t2vModel,
        i2vModel,
        baseUrl,
        audioUrl: state.audio || undefined,
        userParams: state.userParams ?? undefined,
      });

      videos.push(videoUrl);
    }

    const finalVideo = videos[0] ?? state.video ?? "";

    console.log(`[VideoAgent] 全部完成，共生成 ${videos.length} 段视频`);
    if (videos.length > 0) {
      videos.forEach((v, i) => console.log(`  步骤 ${i + 1}: ${v}`));
    }

    return {
      ...state,
      videoParams: allParams,
      videos: videos.length > 0 ? videos : (state.videos ?? []),
      video: finalVideo,
    };
  },
);

export async function runVideoAgent(state: AgentState): Promise<AgentState> {
  return videoAgentWorkflow.invoke(state);
}
