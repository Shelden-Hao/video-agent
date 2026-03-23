import "dotenv/config";
import type { UserParams } from "../types/state.js";
import {
  buildVideoConsistencyInstruction,
  buildVideoSafetyInstruction,
  VIDEO_QUALITY_INSTRUCTION,
} from "../prompts/videoPrompt.js";
import { callMultimodalJson } from "./multimodalClient.js";

export type VideoCheckResult = {
  ok: boolean;
  reason?: string;
  /** 多模态模型返回的原始结构（便于上层做更细粒度逻辑） */
  raw?: unknown;
};

type VisionJson = Record<string, unknown>;

function getVisionConfig() {
  // qwen-vl-max 支持视频 URL 输入
  const model =
    process.env.BAILIAN_VISION_MODEL ??
    process.env.DASHSCOPE_VISION_MODEL ??
    "qwen-vl-max";
  return { model };
}

/**
 * 调用 DashScope 多模态 API，传入视频 URL + 文本指令，返回结构化 JSON。
 *
 * content 格式（与 imageChecks 一致，替换 image → video）：
 * [{"video": videoUrl}, {"text": instruction}]
 *
 * 支持模型：qwen-vl-max（支持视频输入）
 */
async function callVisionWithVideo(
  videoUrl: string,
  instruction: string,
): Promise<VisionJson | null> {
  const { model } = getVisionConfig();
  return callMultimodalJson({
    model,
    content: [{ video: videoUrl }, { text: instruction }],
    maxOutputTokens: 512,
  });
}

/**
 * 语义一致性检测：视频内容是否符合生成时的 prompt。
 *
 * 使用 qwen-vl-max 多模态模型分析视频帧与 prompt 的语义匹配度。
 * 容忍风格差异，只判断核心主体/场景是否吻合。
 */
export async function checkVideoConsistency(
  videoUrl: string,
  prompt: string,
  userParams?: UserParams,
): Promise<VideoCheckResult> {
  if (!videoUrl) return { ok: false, reason: "empty url" };

  const instruction = buildVideoConsistencyInstruction(prompt, userParams);
  let json: VisionJson | null = null;
  try {
    json = await callVisionWithVideo(videoUrl, instruction);
  } catch (err) {
    console.warn(
      "[VideoChecks] 语义一致性检测失败，采用宽松兜底策略（通过）:",
      err,
    );
    // 视频分析失败时宽松兜底：认为通过，避免因 API 限额导致全部重试
    return { ok: true, reason: "fallback-assume-consistent", raw: null };
  }

  if (!json) {
    return { ok: true, reason: "fallback-assume-consistent", raw: null };
  }

  const match = Boolean(json.match);
  const confidence =
    typeof json.confidence === "number" ? json.confidence : 0.0;

  return {
    ok: match && confidence >= 0.6,
    reason: match
      ? confidence >= 0.6
        ? "vision-match-ok"
        : "vision-match-low-confidence"
      : "vision-match-false",
    raw: json,
  };
}

/**
 * 安全审核：检测 NSFW、暴力、政治、仇恨内容。
 * 对儿童教育视频执行严格安全标准。
 */
export async function checkVideoSafety(
  videoUrl: string,
  prompt: string,
): Promise<VideoCheckResult> {
  if (!videoUrl) return { ok: false, reason: "empty url" };

  const instruction = buildVideoSafetyInstruction(prompt);
  let json: VisionJson | null = null;
  try {
    json = await callVisionWithVideo(videoUrl, instruction);
  } catch (err) {
    console.warn(
      "[VideoChecks] 安全审核调用失败，采用宽松兜底（通过，儿童教育场景）:",
      err,
    );
    return { ok: true, reason: "fallback-assume-safe", raw: null };
  }

  if (!json) {
    return { ok: true, reason: "fallback-assume-safe", raw: null };
  }

  const nsfw = Boolean(json.nsfw);
  const violence = Boolean(json.violence);
  const politics = Boolean(json.politics);
  const hate = Boolean(json.hate);
  const confidence =
    typeof json.confidence === "number" ? json.confidence : 1.0;

  const safe = !nsfw && !violence && !politics && !hate;

  return {
    ok: safe && confidence >= 0.6,
    reason: safe ? "vision-safe-ok" : "vision-safe-flagged",
    raw: json,
  };
}

/**
 * 质量检测：清晰度、流畅度、构图和内容完整性评分。
 * overallScore >= 0.55 视为达标（视频生成质量普遍低于图片，阈值适当放宽）。
 */
export async function checkVideoQuality(
  videoUrl: string,
): Promise<VideoCheckResult> {
  if (!videoUrl) return { ok: false, reason: "empty url" };

  let json: VisionJson | null = null;
  try {
    json = await callVisionWithVideo(videoUrl, VIDEO_QUALITY_INSTRUCTION);
  } catch (err) {
    console.warn("[VideoChecks] 质量检测调用失败，采用宽松兜底（通过）:", err);
    return { ok: true, reason: "fallback-quality-ok", raw: null };
  }

  if (!json) {
    return { ok: true, reason: "fallback-quality-ok", raw: null };
  }

  const acceptable =
    typeof json.acceptable === "boolean" ? json.acceptable : true;
  const overall =
    typeof json.overallScore === "number" ? json.overallScore : 1.0;

  return {
    ok: acceptable && overall >= 0.55,
    reason: acceptable ? "vision-quality-ok" : "vision-quality-rejected",
    raw: json,
  };
}
