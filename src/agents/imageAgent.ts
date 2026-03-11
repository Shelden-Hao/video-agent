import type { AgentState } from "../types/state.js";
import "dotenv/config";
import { task, entrypoint } from "@langchain/langgraph";
import { ChatAlibabaTongyi } from "@langchain/community/chat_models/alibaba_tongyi";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  IMAGE_SYSTEM_PROMPT,
  buildImageUserMessage,
  extractImagePrompts,
} from "../prompts/imagePrompt.js";
import {
  validateImageStructure,
  checkImageQuality,
  checkImageSafety,
} from "../tools/imageChecks.js";

const llm = new ChatAlibabaTongyi({
  alibabaApiKey: process.env.ALIBABA_API_KEY,
});

type GenerateImagesOptions = {
  /** 图片风格/尺寸等元信息（预留） */
  styleHint?: string;
  /** 输出尺寸，例如 "1024*1024" 或 "1K"（不同模型支持略有差异） */
  size?: string;
  /** 模型名：例如 "z-image-turbo"、"qwen-image"、"wan2.6-image"（以开通为准） */
  model?: string;
  /** 地域 base url，默认北京 */
  baseUrl?: string;
  /** 是否开启提示词智能改写（会影响费用/耗时，默认 false） */
  promptExtend?: boolean;
};

const MAX_RETRY_PER_IMAGE = Number(process.env.IMAGE_MAX_RETRY ?? "3");
/** 限流重试：最多重试次数 */
const RATE_LIMIT_MAX_RETRY = 5;
/** 限流重试初始等待时间（ms），每次翻倍 */
const RATE_LIMIT_BASE_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseImageUrlFromResponse(json: any): string | null {
  const content = json?.output?.choices?.[0]?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item?.image && typeof item.image === "string") return item.image;
  }
  return null;
}

async function generateOneImageBySyncApi(
  prompt: string,
  opts: Required<
    Pick<GenerateImagesOptions, "model" | "size" | "baseUrl" | "promptExtend">
  >,
): Promise<string> {
  const apiKey = process.env.ALIBABA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing API key: set ALIBABA_API_KEY");
  }

  // 同步文生图：multimodal-generation/generation
  // 参考：Z-Image 文档返回 output.choices[0].message.content[].image
  // https://www.alibabacloud.com/help/zh/model-studio/z-image-api-reference
  const url = `${opts.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;
  const body = {
    model: opts.model,
    input: {
      messages: [
        {
          role: "user",
          content: [{ text: prompt }],
        },
      ],
    },
    parameters: {
      // z-image 支持 size 形如 "1024*1024"；wan2.6-image 文档也支持像素值
      size: opts.size,
      prompt_extend: opts.promptExtend,
      // 若调用的是 wan2.6-image，这里不启用图文混排（避免流式）
      enable_interleave: false,
      // 生成1张图片
      n: 1,
      // 水印
      watermark: false,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Image API non-JSON response: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    const code = json?.code ?? "HTTPError";
    const message = json?.message ?? text.slice(0, 200);
    const err = new Error(`Image API error: ${code} - ${message}`) as Error & {
      isRateLimit?: boolean;
    };
    err.isRateLimit = String(code).includes("Throttling");
    throw err;
  }

  const imageUrl = parseImageUrlFromResponse(json);
  if (!imageUrl) {
    throw new Error(`Image API missing image url: ${text.slice(0, 300)}`);
  }
  return imageUrl;
}

/**
 * [Task] 调用对话 LLM，根据 plan + script 生成每步的图片提示词数组。
 * 输出为有序字符串数组，与 plan.steps 下标一一对应。
 * 若解析失败则回退到基于 sceneDescription 的简单拼接。
 */
const generateImagePromptsTask = task(
  "generateImagePrompts",
  async (state: AgentState): Promise<string[]> => {
    const messages = [
      new SystemMessage(IMAGE_SYSTEM_PROMPT),
      new HumanMessage(buildImageUserMessage(state)),
    ];

    const res = await llm.invoke(messages);
    const raw = res.content?.toString?.() ?? "";
    const parsed = extractImagePrompts(raw);

    if (parsed.length > 0) {
      return [...parsed].sort((a, b) => a.step - b.step).map((p) => p.prompt);
    }

    // 兜底：按 plan.steps 顺序逐步拼接
    const style = "3D卡通, 软萌可爱, 明亮配色, 柔和光照, 干净背景, 儿童友好";
    return (state.plan?.steps ?? []).map((s) => {
      const stepHint = `步骤${s.step}: ${s.teachingPoint}`.trim();
      const scene = s.sceneDescription?.trim() ?? "";
      return `${style}; 主题:${state.topic}; ${stepHint}; 场景:${scene}; 情绪:开心温暖; 镜头:中景, 正面`;
    });
  },
);

/**
 * [Task] 调用图片生成 API，产出单张图片 URL。
 * 内置限流（Throttling.RateQuota）指数退避重试，与质量评估的重试相互独立。
 * 对应 evaluator-optimizer 中的 "generator" 角色。
 *
 * https://docs.langchain.com/oss/javascript/langgraph/functional-api#task
 */
const generateImageTask = task(
  "generateImage",
  async (params: {
    prompt: string;
    opts: Required<
      Pick<GenerateImagesOptions, "model" | "size" | "baseUrl" | "promptExtend">
    >;
  }): Promise<string> => {
    let delay = RATE_LIMIT_BASE_DELAY_MS;
    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRY; attempt++) {
      try {
        return await generateOneImageBySyncApi(params.prompt, params.opts);
      } catch (err: any) {
        if (err?.isRateLimit && attempt < RATE_LIMIT_MAX_RETRY) {
          console.warn(
            `[RateLimit] 限流，${delay / 1000}s 后重试（第 ${attempt} 次）`,
          );
          await sleep(delay);
          delay *= 2;
          continue;
        }
        throw err;
      }
    }
    throw new Error("[generateImageTask] 超出限流重试上限");
  },
);

/**
 * [Task] 并行运行结构化验证 / 质量检测 / 安全审核三项评估。
 * 对应 evaluator-optimizer 中的 "evaluator" 角色。
 */
const evaluateImageTask = task(
  "evaluateImage",
  async (params: { url: string; prompt: string }) => {
    const [sRes, qRes, safeRes] = await Promise.all([
      validateImageStructure(params.url, params.prompt),
      checkImageQuality(params.url),
      checkImageSafety(params.url, params.prompt),
    ]);

    const feedback = (
      [
        !sRes.ok && `结构不符: ${sRes.reason}`,
        !qRes.ok && `质量不达标: ${qRes.reason}`,
        !safeRes.ok && `安全违规: ${safeRes.reason}`,
      ] as (string | false)[]
    )
      .filter(Boolean)
      .join("; ");

    return {
      accepted: sRes.ok && qRes.ok && safeRes.ok,
      feedback,
      details: { structure: sRes, quality: qRes, safety: safeRes },
    };
  },
);

type ImageWorkflowInput = {
  prompt: string;
  opts: Required<
    Pick<GenerateImagesOptions, "model" | "size" | "baseUrl" | "promptExtend">
  >;
  maxRetry: number; // 最大重试次数
};

/**
 * 单张图片的「生成 → 评估 → 反馈 → 重试」闭环。
 *
 * 遵循 LangGraph evaluator-optimizer 模式：
 *   generateImage → evaluateImage → [accepted? ✓end : ✗generateImage]
 *
 * entrypoint 函数可用于从函数创建工作流。它封装了工作流逻辑并管理执行流程，包括处理长时间运行的任务和中断。
 *
 * https://docs.langchain.com/oss/javascript/langgraph/workflows-agents#evaluator-optimizer
 */
const imageEvaluatorOptimizer = entrypoint(
  "imageEvaluatorOptimizer",
  async ({ prompt, opts, maxRetry }: ImageWorkflowInput): Promise<string> => {
    let lastFeedback = ""; // 上次评估反馈

    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      const url = await generateImageTask({ prompt, opts });
      const evaluation = await evaluateImageTask({ url, prompt });

      if (evaluation.accepted) {
        return url;
      }

      lastFeedback = evaluation.feedback;
      console.warn(
        `[ImageEval] attempt ${attempt}/${maxRetry} 未通过 | ${lastFeedback}`,
        evaluation.details,
      );
    }

    throw new Error(
      `[ImageEval] 图片在 ${maxRetry} 次重试后仍未通过校验，最后失败原因: ${lastFeedback}`,
    );
  },
);

/**
 * 顶层 Image Agent 工作流。
 *
 * 所有 task 都在此 entrypoint 的上下文内执行，保证 LangGraph 运行时上下文可用。
 *
 * 流程：
 *   generateImagePromptsTask (LLM)
 *         ↓ prompts[]
 *   Promise.all → imageEvaluatorOptimizer.invoke() × N（每张图独立闭环）
 */
const imageAgentWorkflow = entrypoint(
  "imageAgent",
  async (state: AgentState): Promise<AgentState> => {
    if (!state.plan) return state;

    const apiKey = process.env.ALIBABA_API_KEY;
    if (!apiKey) throw new Error("Missing API key: set ALIBABA_API_KEY");

    const model = process.env.BAILIAN_IMAGE_MODEL;
    if (!model) throw new Error("Missing image model: set BAILIAN_IMAGE_MODEL");

    const imageOpts = {
      model,
      size: "1024*1024",
      // 北京地域（中国内地版）。国际版可用 dashscope-intl
      baseUrl: process.env.DASHSCOPE_BASE_URL!,
      promptExtend: false,
    };

    const prompts = await generateImagePromptsTask(state);

    // 顺序生成，避免并发触发限流；每张图之间稍作等待
    const images: string[] = [];
    for (const [i, prompt] of prompts.entries()) {
      if (i > 0) await sleep(1500);
      const url = await imageEvaluatorOptimizer.invoke({
        prompt,
        opts: imageOpts,
        maxRetry: MAX_RETRY_PER_IMAGE,
      });
      images.push(url);
    }

    return {
      ...state,
      images: images.length ? images : state.images,
    };
  },
);

export async function runImageAgent(state: AgentState): Promise<AgentState> {
  return imageAgentWorkflow.invoke(state);
}
