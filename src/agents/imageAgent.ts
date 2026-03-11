import type { AgentState } from "../types/state.js";
import "dotenv/config";
import { task, entrypoint } from "@langchain/langgraph";
import {
  validateImageStructure,
  checkImageQuality,
  checkImageSafety,
} from "../tools/imageChecks.js";

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
      n: 1,
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
    throw new Error(`Image API error: ${code} - ${message}`);
  }

  const imageUrl = parseImageUrlFromResponse(json);
  if (!imageUrl) {
    throw new Error(`Image API missing image url: ${text.slice(0, 300)}`);
  }
  return imageUrl;
}

// ─── LangGraph Tasks ──────────────────────────────────────────────────────────

/**
 * [Task] 调用图片生成 API，产出单张图片 URL。
 * 对应 evaluator-optimizer 中的 "generator" 角色。
 */
const generateImageTask = task(
  "generateImage",
  async (params: {
    prompt: string;
    opts: Required<
      Pick<GenerateImagesOptions, "model" | "size" | "baseUrl" | "promptExtend">
    >;
  }): Promise<string> => generateOneImageBySyncApi(params.prompt, params.opts),
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

// ─── Evaluator-Optimizer Workflow（单图闭环）─────────────────────────────────

type ImageWorkflowInput = {
  prompt: string;
  opts: Required<
    Pick<GenerateImagesOptions, "model" | "size" | "baseUrl" | "promptExtend">
  >;
  maxRetry: number;
};

/**
 * 单张图片的「生成 → 评估 → 反馈 → 重试」闭环。
 *
 * 遵循 LangGraph evaluator-optimizer 模式：
 *   generateImage → evaluateImage → [accepted? ✓end : ✗generateImage]
 *
 * 参考：https://docs.langchain.com/oss/javascript/langgraph/workflows-agents#evaluator-optimizer
 */
const imageEvaluatorOptimizer = entrypoint(
  "imageEvaluatorOptimizer",
  async ({ prompt, opts, maxRetry }: ImageWorkflowInput): Promise<string> => {
    let lastFeedback = "";

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

// ─── Generate Images from Prompts ────────────────────────────────────────────

/**
 * 根据每步的图片提示词并发生成图片 URL 列表。
 * 每张图片独立走 imageEvaluatorOptimizer 闭环（生成 + 三重评估 + 重试）。
 */
async function generateImagesFromPrompts(
  prompts: string[],
  opts: GenerateImagesOptions = {},
): Promise<string[]> {
  const safePrompts = Array.isArray(prompts) ? prompts : [];

  const apiKey = process.env.ALIBABA_API_KEY;
  if (!apiKey) throw new Error("Missing API key: set ALIBABA_API_KEY");

  const model = process.env.BAILIAN_IMAGE_MODEL;
  if (!model) throw new Error("Missing image model: set BAILIAN_IMAGE_MODEL");

  const imageOpts = {
    model,
    size: opts.size ?? "1024*1024",
    // 北京地域（中国内地版）。国际版可用 dashscope-intl
    baseUrl: opts.baseUrl ?? process.env.DASHSCOPE_BASE_URL!,
    promptExtend: opts.promptExtend ?? false,
  };

  return Promise.all(
    safePrompts.map((prompt) =>
      imageEvaluatorOptimizer.invoke({
        prompt,
        opts: imageOpts,
        maxRetry: MAX_RETRY_PER_IMAGE,
      }),
    ),
  );
}

export async function runImageAgent(state: AgentState): Promise<AgentState> {
  if (!state.plan) return state;

  // 这里不再调用对话模型“生成图片提示词”，而是直接用 plan 的画面描述拼出 prompt，
  // 然后交给百炼视觉/图片模型生成真实图片（无 key 时 imageTool 会自动兜底为占位 URL）。
  const style = "3D卡通, 软萌可爱, 明亮配色, 柔和光照, 干净背景, 儿童友好";
  const prompts = state.plan.steps.map((s) => {
    const stepHint = `步骤${s.step}: ${s.teachingPoint}`.trim();
    const scene = s.sceneDescription?.trim() ?? "";
    return `${style}; 主题:${state.topic}; ${stepHint}; 场景:${scene}; 情绪:开心温暖; 镜头:中景, 正面`;
  });

  const images = await generateImagesFromPrompts(prompts, {
    styleHint: "kids-edu-cartoon",
  });

  return {
    ...state,
    images: images.length ? images : state.images,
  };
}
