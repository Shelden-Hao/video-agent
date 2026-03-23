import type { AgentState } from "../types/state.js";
import "dotenv/config";
import { task, entrypoint } from "@langchain/langgraph";
import { ChatAlibabaTongyi } from "@langchain/community/chat_models/alibaba_tongyi";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  IMAGE_SYSTEM_PROMPT,
  buildImageUserMessage,
  extractImagePrompts,
  buildFallbackImagePrompts,
  CHARACTER_ANCHOR_SYSTEM_PROMPT,
  buildCharacterAnchorUserMessage,
  parseCharacterAnchor,
  injectAnchorIntoPrompt,
  type CharacterAnchor,
} from "../prompts/imagePrompt.js";
import {
  validateImageStructure,
  checkImageQuality,
  checkImageSafety,
  checkCrossImageConsistency,
} from "../tools/imageChecks.js";
import { randomUUID } from "node:crypto";
import type { Artifact } from "../types/state.js";
import { evaluatorOptimizer } from "../workflow/evaluatorOptimizer.js";

// 懒初始化：首次调用时创建，避免模块加载时 dotenv 尚未读取 .env 文件
let _llm: ChatAlibabaTongyi | null = null;
function getLLM(): ChatAlibabaTongyi {
  if (!_llm) {
    _llm = new ChatAlibabaTongyi({
      alibabaApiKey: process.env.ALIBABA_API_KEY,
    });
  }
  return _llm;
}

type GenerateImageOpts = {
  model: string;
  size: string;
  baseUrl: string;
  promptExtend: boolean;
};

const MAX_RETRY_PER_IMAGE = Number(process.env.IMAGE_MAX_RETRY ?? "3");
const RATE_LIMIT_MAX_RETRY = 5;
const RATE_LIMIT_BASE_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseImageUrlFromResponse(json: unknown): string | null {
  const content = (json as any)?.output?.choices?.[0]?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item?.image && typeof item.image === "string") return item.image;
  }
  return null;
}

async function generateOneImageBySyncApi(
  prompt: string,
  opts: GenerateImageOpts,
): Promise<string> {
  const apiKey = process.env.ALIBABA_API_KEY;
  if (!apiKey) throw new Error("Missing API key: set ALIBABA_API_KEY");

  const url = `${opts.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;
  const body = {
    model: opts.model,
    input: {
      messages: [{ role: "user", content: [{ text: prompt }] }],
    },
    parameters: {
      size: opts.size,
      prompt_extend: opts.promptExtend,
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
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Image API non-JSON response: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    const code = (json as any)?.code ?? "HTTPError";
    const message = (json as any)?.message ?? text.slice(0, 200);
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

// ---------------------------------------------------------------------------
// Task 1：生成角色锚点（Character Anchor）
// ---------------------------------------------------------------------------

/**
 * [Task] 生成「角色与视觉锚点」。
 * 在所有图片生成之前运行一次，产出主角外观 + 画风关键词，
 * 后续每张图片的提示词都将注入此锚点，确保主角外观一致。
 */
const generateCharacterAnchorTask = task(
  "generateCharacterAnchor",
  async (state: AgentState): Promise<CharacterAnchor | null> => {
    console.log("[ImageAgent] 生成角色锚点...");
    const messages = [
      new SystemMessage(CHARACTER_ANCHOR_SYSTEM_PROMPT),
      new HumanMessage(buildCharacterAnchorUserMessage(state)),
    ];
    const res = await getLLM().invoke(messages);
    const raw = res.content?.toString?.() ?? "";
    const anchor = parseCharacterAnchor(raw);
    if (anchor) {
      console.log(`[ImageAgent] 角色锚点: ${anchor.characterDescription.slice(0, 80)}...`);
    } else {
      console.warn("[ImageAgent] 角色锚点生成失败，将使用无锚点模式");
    }
    return anchor;
  },
);

// ---------------------------------------------------------------------------
// Task 2：生成每步图片提示词
// ---------------------------------------------------------------------------

/**
 * [Task] 调用 LLM 生成每步的图片提示词，并注入角色锚点。
 */
const generateImagePromptsTask = task(
  "generateImagePrompts",
  async (params: {
    state: AgentState;
    anchor: CharacterAnchor | null;
  }): Promise<string[]> => {
    const { state, anchor } = params;
    const messages = [
      new SystemMessage(IMAGE_SYSTEM_PROMPT),
      new HumanMessage(buildImageUserMessage(state)),
    ];

    const res = await getLLM().invoke(messages);
    const raw = res.content?.toString?.() ?? "";
    const parsed = extractImagePrompts(raw);

    let basePrompts: string[];
    if (parsed.length > 0) {
      basePrompts = [...parsed]
        .sort((a, b) => a.step - b.step)
        .map((p) => p.prompt);
    } else {
      basePrompts = buildFallbackImagePrompts(state).map((p) => p.prompt);
    }

    // 将角色锚点注入每条提示词
    if (anchor) {
      return basePrompts.map((p) => injectAnchorIntoPrompt(p, anchor));
    }
    return basePrompts;
  },
);

// ---------------------------------------------------------------------------
// Task 3：生成单张图片
// ---------------------------------------------------------------------------

const generateImageTask = task(
  "generateImage",
  async (params: { prompt: string; opts: GenerateImageOpts }): Promise<string> => {
    let delay = RATE_LIMIT_BASE_DELAY_MS;
    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRY; attempt++) {
      try {
        return await generateOneImageBySyncApi(params.prompt, params.opts);
      } catch (err: unknown) {
        if ((err as any)?.isRateLimit && attempt < RATE_LIMIT_MAX_RETRY) {
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

// ---------------------------------------------------------------------------
// Task 4：多维评估（结构 + 质量 + 安全 + 跨图一致性）
// ---------------------------------------------------------------------------

/**
 * [Task] 并行运行四项评估：
 * 1. 结构化验证（与 prompt 语义是否匹配）
 * 2. 质量检测（清晰度/构图）
 * 3. 安全审核（NSFW/暴力/政治/仇恨）
 * 4. 跨图主角一致性（仅当提供 referenceImageUrl 时执行）
 */
const evaluateImageTask = task(
  "evaluateImage",
  async (params: {
    url: string;
    prompt: string;
    /** 参考图片 URL（第一张图片），用于跨图一致性检验 */
    referenceImageUrl?: string;
  }) => {
    const checks: Promise<{ ok: boolean; reason?: string }>[] = [
      validateImageStructure(params.url, params.prompt),
      checkImageQuality(params.url),
      checkImageSafety(params.url, params.prompt),
    ];

    // 仅在有参考图时执行跨图一致性检验（第一张图无需与自己对比）
    if (params.referenceImageUrl) {
      checks.push(
        checkCrossImageConsistency(params.url, params.referenceImageUrl),
      );
    }

    const results = await Promise.all(checks);
    const [sRes, qRes, safeRes, consistRes] = results;

    const feedback = (
      [
        !sRes.ok && `结构不符: ${sRes.reason}`,
        !qRes.ok && `质量不达标: ${qRes.reason}`,
        !safeRes.ok && `安全违规: ${safeRes.reason}`,
        consistRes && !consistRes.ok && `主角不一致: ${consistRes.reason}`,
      ] as (string | false | undefined)[]
    )
      .filter(Boolean)
      .join("; ");

    return {
      accepted:
        sRes.ok &&
        qRes.ok &&
        safeRes.ok &&
        (consistRes ? consistRes.ok : true),
      feedback,
      details: {
        structure: sRes,
        quality: qRes,
        safety: safeRes,
        consistency: consistRes ?? null,
      },
    };
  },
);

async function runImageEvaluatorOptimizer(params: {
  prompt: string;
  opts: GenerateImageOpts;
  maxRetry: number;
  referenceImageUrl?: string;
}): Promise<string> {
  const { prompt, opts, maxRetry, referenceImageUrl } = params;
  return await evaluatorOptimizer<string>({
    maxRetry,
    generate: async (feedback) => {
      const refinedPrompt = feedback
        ? `[修正要求：${feedback}] ${prompt}`.slice(0, 1200)
        : prompt;
      return await generateImageTask({ prompt: refinedPrompt, opts });
    },
    evaluate: async (url) => {
      const evaluation = await evaluateImageTask({
        url,
        prompt,
        referenceImageUrl,
      });
      return { accepted: evaluation.accepted, feedback: evaluation.feedback };
    },
    onAttempt: (attempt, max) => {
      console.log(`[ImageEval] attempt ${attempt}/${max} generating...`);
    },
  });
}

// ---------------------------------------------------------------------------
// 顶层 Image Agent 工作流
// ---------------------------------------------------------------------------

/**
 * Image Agent 工作流。
 *
 * 完整流程：
 *   1. generateCharacterAnchorTask     — LLM 生成主角外观 + 画风锚点
 *   2. generateImagePromptsTask        — LLM 生成每步图片提示词（注入锚点）
 *   3. 串行 imageEvaluatorOptimizer    — 每步独立闭环：
 *        generateImage → evaluate[结构+质量+安全+跨图一致性] → retry
 *      ★ 第一张图生成后作为 referenceImageUrl 传入后续所有步骤
 */
const imageAgentWorkflow = entrypoint(
  "imageAgent",
  async (state: AgentState): Promise<AgentState> => {
    if (state.route && state.route.needs.image === false) return state;
    if (!state.plan) return state;

    const apiKey = process.env.ALIBABA_API_KEY;
    if (!apiKey) throw new Error("Missing API key: set ALIBABA_API_KEY");

    const imageModel = process.env.BAILIAN_IMAGE_MODEL;
    if (!imageModel)
      throw new Error("Missing image model: set BAILIAN_IMAGE_MODEL");

    const imageSize = state.userParams?.imageSize ?? "1024*1024";

    const imageOpts: GenerateImageOpts = {
      model: imageModel,
      size: imageSize,
      baseUrl: process.env.DASHSCOPE_BASE_URL!,
      promptExtend: false,
    };

    // Step 1：生成角色锚点
    const anchor = await generateCharacterAnchorTask(state);

    // Step 2：生成每步提示词（注入锚点）
    console.log(`[ImageAgent] 图片尺寸: ${imageSize}，开始生成提示词...`);
    const prompts = await generateImagePromptsTask({ state, anchor });
    console.log(
      `[ImageAgent] 共 ${prompts.length} 条提示词，开始逐步生成图片（含跨图一致性检验）...`,
    );

    // Step 3：串行生成，第一张图作为后续图片的 referenceImageUrl
    const images: string[] = [];
    let referenceImageUrl: string | undefined = undefined;

    for (const [i, prompt] of prompts.entries()) {
      if (i > 0) await sleep(1500);
      console.log(
        `[ImageAgent] 正在生成第 ${i + 1}/${prompts.length} 张图片${referenceImageUrl ? "（将与第1张对比一致性）" : "（首图，作为后续参考）"}...`,
      );

      const url = await runImageEvaluatorOptimizer({
        prompt,
        opts: imageOpts,
        maxRetry: MAX_RETRY_PER_IMAGE,
        referenceImageUrl, // 第一张时为 undefined，之后传入第一张 URL
      });

      images.push(url);
      console.log(`[ImageAgent] 第 ${i + 1} 张图片完成: ${url}`);

      // 第一张图片通过校验后，作为后续所有图片的参考
      if (i === 0) {
        referenceImageUrl = url;
        console.log(`[ImageAgent] 第1张图片作为一致性参考基准已锁定`);
      }
    }

    const artifacts: Artifact[] = images.map((uri, i) => ({
      id: randomUUID(),
      kind: "image",
      step: i + 1,
      uri,
      mimeType: "image/*",
      metadata: {
        prompt: prompts[i],
        imageSize,
      },
      source: { agent: "imageAgent", model: imageModel },
      createdAt: new Date().toISOString(),
    }));

    return {
      ...state,
      images: images.length ? images : state.images,
      artifacts: [...(state.artifacts ?? []), ...artifacts],
    };
  },
);

export async function runImageAgent(state: AgentState): Promise<AgentState> {
  return imageAgentWorkflow.invoke(state);
}
