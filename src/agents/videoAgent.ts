/**
 * Video Agent — 基于 LangGraph Functional API（task + entrypoint）
 *
 * 完整流程（Evaluator-Optimizer 模式）：
 *
 *  Step 1 · 输入结构化
 *    generateVideoParamsTask(AgentState) → VideoGenerationParams[]
 *    LLM 将自然语言 topic/plan/script 转换为精确的视频 API 参数（prompt、size、负面词等）
 *
 *  Step 2 · 视频生成（异步 Wan API + 轮询）
 *    generateVideoTask({ params }) → string（videoUrl）
 *    调用 wan2.5-t2v-preview（支持自动配音 + 10s），创建异步任务，每 15s 轮询状态，最长等待 15 分钟
 *
 *  Step 3 · 生成后校验（并行三项）
 *    evaluateVideoTask({ videoUrl, params }) → EvaluationResult
 *    - 语义一致性：视频内容是否符合 prompt
 *    - 安全审核：NSFW / 暴力 / 政治 / 仇恨
 *    - 质量检测：清晰度 / 流畅度 / 构图
 *
 *  Step 4 · 自动修改（不满足时重新生成）
 *    videoEvaluatorOptimizer: 最多 MAX_RETRY 次，每次将上次失败原因反馈给 prompt，
 *    直到三项均通过或耗尽重试次数
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

// ---------------------------------------------------------------------------
// 常量与工具函数
// ---------------------------------------------------------------------------

/** 每步视频最多重试次数（生成 + 校验循环） */
const MAX_RETRY_PER_VIDEO = Number(process.env.VIDEO_MAX_RETRY ?? "3");

/** 视频生成 API 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 15_000;

/** 视频生成最大等待时间（毫秒），15 分钟 */
const POLL_MAX_WAIT_MS = 15 * 60 * 1000;

/** 限流重试初始等待时间（ms），每次翻倍 */
const RATE_LIMIT_BASE_DELAY_MS = 3_000;

/** 限流最大重试次数 */
const RATE_LIMIT_MAX_RETRY = 4;

/**
 * 最大处理步骤数：视频生成耗时且消耗配额，默认只处理前 N 步。
 * 可通过 VIDEO_MAX_STEPS 环境变量覆盖。
 */
const MAX_VIDEO_STEPS = Number(process.env.VIDEO_MAX_STEPS ?? "1");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// LLM（用于结构化参数生成）
const llm = new ChatAlibabaTongyi({
  alibabaApiKey: process.env.ALIBABA_API_KEY,
  temperature: 0.5,
});

// ---------------------------------------------------------------------------
// Wan 视频生成 API（异步 + 轮询）
// ---------------------------------------------------------------------------

type WanVideoParams = {
  model: string;
  prompt: string;
  negativePrompt: string;
  size: string;
  duration: number;
  promptExtend: boolean;
  audioUrl?: string;
  baseUrl: string;
};

/**
 * Step 1 of Wan API：提交视频生成任务，返回 task_id。
 */
async function submitVideoTask(params: WanVideoParams): Promise<string> {
  const apiKey = process.env.ALIBABA_API_KEY;
  if (!apiKey) throw new Error("Missing ALIBABA_API_KEY");

  const url = `${params.baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`;
  const body: Record<string, unknown> = {
    model: params.model,
    input: {
      prompt: params.prompt,
      ...(params.negativePrompt
        ? { negative_prompt: params.negativePrompt }
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
      // 异步模式：必须设置此请求头
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Video API non-JSON response: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  }

  if (!res.ok) {
    const code = json?.code ?? "HTTPError";
    const message = json?.message ?? text.slice(0, 300);
    const err = new Error(
      `Video API submit error: ${code} - ${message}`,
    ) as Error & { isRateLimit?: boolean };
    err.isRateLimit =
      String(code).includes("Throttling") || String(code).includes("RateQuota");
    throw err;
  }

  const taskId = json?.output?.task_id;
  if (!taskId || typeof taskId !== "string") {
    throw new Error(
      `Video API missing task_id in response: ${text.slice(0, 300)}`,
    );
  }

  console.log(`[VideoAgent] 任务已提交，task_id: ${taskId}`);
  return taskId;
}

/**
 * Step 2 of Wan API：轮询 task_id 直到任务完成，返回视频 URL。
 * 间隔 POLL_INTERVAL_MS，超时 POLL_MAX_WAIT_MS 后抛出错误。
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
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      console.warn(`[VideoAgent] 轮询非 JSON 响应: ${text.slice(0, 200)}`);
      continue;
    }

    const status = json?.output?.task_status;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[VideoAgent] 轮询中... 状态: ${status}，已等待 ${elapsed}s`);

    if (status === "SUCCEEDED") {
      const videoUrl = json?.output?.video_url;
      if (!videoUrl || typeof videoUrl !== "string") {
        throw new Error(
          `Video task SUCCEEDED but missing video_url: ${text.slice(0, 300)}`,
        );
      }
      console.log(`[VideoAgent] 视频生成成功: ${videoUrl}`);
      return videoUrl;
    }

    if (status === "FAILED") {
      const code = json?.output?.code ?? "FAILED";
      const message = json?.output?.message ?? "Unknown error";
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
 * [Task] Step 1：输入结构化
 *
 * LLM 将 topic/plan/script 转换为每步的结构化视频生成参数 VideoGenerationParams[]。
 * 若解析失败则回退到基于 plan.steps 的简单参数拼接。
 */
const generateVideoParamsTask = task(
  "generateVideoParams",
  async (state: AgentState): Promise<VideoGenerationParams[]> => {
    console.log("[VideoAgent] Step 1: 开始结构化视频生成参数...");

    const messages = [
      new SystemMessage(VIDEO_STRUCTURE_SYSTEM_PROMPT),
      new HumanMessage(buildVideoStructureUserMessage(state)),
    ];
    console.log(
      "🚀 ~ videoAgent.ts:245 ~ buildVideoStructureUserMessage(state):",
      buildVideoStructureUserMessage(state),
    );

    const res = await llm.invoke(messages);
    console.log("🚀 ~ videoAgent.ts:248 ~ res:", res);
    const raw = res.content?.toString?.() ?? "";
    const params = extractVideoParams(raw, state);
    console.log("🚀 ~ videoAgent.ts:251 ~ params:", params);

    console.log(`[VideoAgent] Step 1 完成：生成 ${params.length} 组视频参数`);
    return params;
  },
);

/**
 * [Task] Step 2：视频生成（含限流指数退避重试）
 *
 * 调用 Wan 文生视频 API（异步），轮询直到任务完成，返回视频 URL。
 * 内置限流重试（Throttling.RateQuota），与外层评估重试独立。
 */
const generateVideoTask = task(
  "generateVideo",
  async (params: {
    videoParams: VideoGenerationParams;
    feedback?: string; // 上次评估失败的反馈，用于调整 prompt
    model: string;
    baseUrl: string;
    audioUrl?: string;
  }): Promise<string> => {
    const { videoParams, feedback, model, baseUrl, audioUrl } = params;

    // 若有上次失败反馈，在 prompt 前追加修改指示
    let refinedPrompt = videoParams.prompt;
    if (feedback) {
      const feedbackNote = `[请修正以下问题：${feedback}]；`;
      refinedPrompt = (feedbackNote + refinedPrompt).slice(0, 800);
      console.log(`[VideoAgent] Step 2: 携带修正反馈重新生成，prompt 已调整`);
    }

    const wanParams: WanVideoParams = {
      model,
      prompt: refinedPrompt,
      negativePrompt: videoParams.negativePrompt,
      size: videoParams.size,
      duration: videoParams.duration,
      promptExtend: videoParams.promptExtend,
      baseUrl,
      audioUrl,
    };

    let delay = RATE_LIMIT_BASE_DELAY_MS;
    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRY; attempt++) {
      try {
        const taskId = await submitVideoTask(wanParams);
        const videoUrl = await pollVideoTask(taskId, baseUrl);
        return videoUrl;
      } catch (err: any) {
        if (err?.isRateLimit && attempt < RATE_LIMIT_MAX_RETRY) {
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
 *
 * 同时执行语义一致性、安全审核、质量检测，汇总结果。
 * 任一项不通过则整体不通过，并附带失败原因供 Step 4 参考。
 */
const evaluateVideoTask = task(
  "evaluateVideo",
  async (params: { videoUrl: string; videoParams: VideoGenerationParams }) => {
    const { videoUrl, videoParams } = params;

    console.log("[VideoAgent] Step 3: 开始校验（语义/安全/质量）...");

    const [consistencyRes, safetyRes, qualityRes] = await Promise.all([
      checkVideoConsistency(videoUrl, videoParams.prompt),
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
  model: string;
  baseUrl: string;
  audioUrl?: string;
};

/**
 * 单步视频「生成 → 校验 → 反馈 → 重新生成」闭环。
 *
 * 遵循 LangGraph evaluator-optimizer 模式：
 *   generateVideo → evaluateVideo → [accepted? ✓end : ✗generateVideo]
 *
 * 校验不通过时将失败原因作为 feedback 传入下次生成，让模型自动修正。
 */
const videoEvaluatorOptimizer = entrypoint(
  "videoEvaluatorOptimizer",
  async ({
    videoParams,
    maxRetry,
    model,
    baseUrl,
    audioUrl,
  }: VideoWorkflowInput): Promise<string> => {
    let lastFeedback = "";

    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      console.log(
        `[VideoAgent] Step 4: 开始第 ${attempt}/${maxRetry} 次生成尝试（步骤 ${videoParams.step}）`,
      );

      const videoUrl = await generateVideoTask({
        videoParams,
        feedback: lastFeedback || undefined,
        model,
        baseUrl,
        audioUrl,
      });

      const evaluation = await evaluateVideoTask({ videoUrl, videoParams });

      if (evaluation.accepted) {
        console.log(
          `[VideoAgent] 步骤 ${videoParams.step} 视频通过校验，URL: ${videoUrl}`,
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
 * 所有 task 都在此 entrypoint 上下文内执行，保证 LangGraph 运行时上下文可用。
 *
 * 完整流程：
 *   generateVideoParamsTask (LLM 结构化)
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

    const model = process.env.BAILIAN_VIDEO_MODEL ?? "wanx2.1-t2v-turbo";
    const baseUrl =
      process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com";

    // Step 1：输入结构化
    const allParams = await generateVideoParamsTask(state);

    // 限制最大处理步骤数（节约免费配额）
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
        model,
        baseUrl,
        audioUrl: state.audio || undefined,
      });

      videos.push(videoUrl);
    }

    const finalVideo = videos[0] ?? state.video ?? "";

    console.log(`[VideoAgent] 全部完成，共生成 ${videos.length} 段视频`);

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
