import "dotenv/config";
import { callMultimodalJson } from "./multimodalClient.js";

export type ImageCheckResult = {
  ok: boolean;
  reason?: string;
  /** 视觉大模型返回的原始 JSON（便于上层做更细粒度逻辑） */
  raw?: unknown;
};

type VisionJson = Record<string, unknown>;

function getVisionConfig() {
  const model =
    process.env.BAILIAN_VISION_MODEL ??
    process.env.DASHSCOPE_VISION_MODEL ??
    "qwen-vl-max";
  return { model };
}

/**
 * 通用视觉模型调用（支持多图对比）。
 * contentItems 为 content 数组中除最后一条 text 指令之外的所有项（image/video 等）。
 * qwen-vl-max 支持在 content 数组中传入多个 { image: url } 项以进行跨图对比。
 */
async function callVisionApi(
  contentItems: Array<Record<string, string>>,
  instruction: string,
): Promise<VisionJson | null> {
  const { model } = getVisionConfig();
  return callMultimodalJson({
    model,
    content: [...(contentItems as any), { text: instruction }],
    maxOutputTokens: 600,
  });
}

/** 单图视觉调用（原 callVisionJsonTool） */
async function callVisionJsonTool(
  imageUrl: string,
  instruction: string,
): Promise<VisionJson | null> {
  return callVisionApi([{ image: imageUrl }], instruction);
}

// ---------------------------------------------------------------------------
// 现有三项校验（结构化、质量、安全）
// ---------------------------------------------------------------------------

/**
 * 结构化验证：图片内容是否符合生成提示词的核心语义。
 */
export async function validateImageStructure(
  url: string,
  prompt: string,
): Promise<ImageCheckResult> {
  if (!url) return { ok: false, reason: "empty url" };

  const visionInstruction = `你是一个图片内容审核系统。

用户生成这张图片时使用的文本提示词（prompt）是：
"${prompt}"

请判断图片是否对提示词的「核心意图」进行了有效表现。判断标准（宽松匹配）：
1. 主要角色/主体是否出现？
2. 整体场景主题是否符合？
3. 不需严格匹配风格细节，不要求精确还原每个动作细节。
4. 若图片内容与提示词完全无关，才判定为不匹配。

只输出一个 JSON：
- match: boolean，图片内容与提示词核心意图是否基本一致
- confidence: number，0~1 之间，置信度
- summary: string，1~2 句描述图片内容（中文）`;

  let json: VisionJson | null = null;
  try {
    json = await callVisionJsonTool(url, visionInstruction);
  } catch (err) {
    console.warn("[ImageChecks] 结构化验证调用失败，兜底通过:", err);
  }

  if (!json) return { ok: true, reason: "fallback-heuristic", raw: null };

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
 * 质量检测：清晰度 / 分辨率 / 构图评分。
 */
export async function checkImageQuality(
  url: string,
): Promise<ImageCheckResult> {
  if (!url) return { ok: false, reason: "empty url" };

  const instruction = `你是一个图片质量评估系统。

请仅根据图片本身，从以下维度进行客观打分：
1. 清晰度（是否模糊、噪点多不多）
2. 分辨率（画面是否过于粗糙）
3. 构图（主体是否完整、是否被严重裁切、是否畸形）

只输出一个 JSON：
- clarityScore: 0~1
- resolutionScore: 0~1
- compositionScore: 0~1
- overallScore: 0~1
- acceptable: boolean`;

  let json: VisionJson | null = null;
  try {
    json = await callVisionJsonTool(url, instruction);
  } catch (err) {
    console.warn("[ImageChecks] 质量检测调用失败，兜底:", err);
  }

  if (!json) return { ok: false, reason: "fallback-heuristic", raw: null };

  const acceptable =
    typeof json.acceptable === "boolean" ? (json.acceptable as boolean) : true;
  const overall =
    typeof json.overallScore === "number" ? (json.overallScore as number) : 1.0;

  return {
    ok: acceptable && overall >= 0.6,
    reason: acceptable ? "vision-quality-ok" : "vision-quality-rejected",
    raw: json,
  };
}

/**
 * 安全审核：NSFW / 暴力 / 政治 / 仇恨。
 */
export async function checkImageSafety(
  url: string,
  prompt: string,
): Promise<ImageCheckResult> {
  if (!url) return { ok: false, reason: "empty url" };

  const instruction = `你是一个图片安全审核系统。

生成提示词（供参考）："${prompt}"

请判断该图片是否包含以下内容：
1. 色情 / 裸露 / NSFW
2. 暴力、血腥、恐怖
3. 敏感政治内容
4. 仇恨或歧视内容

只输出一个 JSON：
- nsfw: boolean
- violence: boolean
- politics: boolean
- hate: boolean
- confidence: number，0~1 之间`;

  let json: VisionJson | null = null;
  try {
    json = await callVisionJsonTool(url, instruction);
  } catch (err) {
    console.warn("[ImageChecks] 安全审核调用失败，兜底通过:", err);
  }

  if (!json) {
    return { ok: true, reason: "fallback-assume-safe", raw: null };
  }

  const nsfw = Boolean(json.nsfw);
  const violence = Boolean(json.violence);
  const politics = Boolean(json.politics);
  const hate = Boolean(json.hate);
  const confidence =
    typeof json.confidence === "number" ? (json.confidence as number) : 1.0;

  const safe = !nsfw && !violence && !politics && !hate;

  return {
    ok: safe && confidence >= 0.6,
    reason: safe ? "vision-safe-ok" : "vision-safe-flagged",
    raw: json,
  };
}

// ---------------------------------------------------------------------------
// 新增：跨图主角一致性检验
// ---------------------------------------------------------------------------

/**
 * 跨图主角一致性检验。
 *
 * 比较「当前图片」与「参考图片（第一张）」的主角外观和画风是否一致。
 * 使用 qwen-vl-max 多图输入（content 数组传两个 image 项）进行对比。
 *
 * 判断维度（宽松）：
 * - 主角是否为同一类型角色（如：同为橘色虎斑猫，而非一只猫一只狗）
 * - 画风/渲染风格是否一致（如：同为2D卡通，而非一张2D一张3D）
 * - 允许场景、动作、背景不同
 */
export async function checkCrossImageConsistency(
  imageUrl: string,
  referenceUrl: string,
): Promise<ImageCheckResult> {
  if (!imageUrl || !referenceUrl) {
    return { ok: true, reason: "no-reference-skip" };
  }

  const instruction = `你是一个图片视觉一致性审核系统，负责确保同一视频中的所有画面风格统一。

以下提供了两张图片：
- 第1张（参考图）：已确认的合格画面，作为视觉一致性标准
- 第2张（待检图）：需要检验的新画面

请对比判断两张图片的「主角外观」和「画风」是否一致：
1. 主角类型是否相同（如：同为橘色虎斑猫/同为白色兔子，不能一只猫一只狗）
2. 渲染风格是否相同（如：同为2D平面卡通、同为3D渲染，不能风格混搭）
3. 主角的外观颜色/特征是否大致相符（允许细节差异，但不能完全不同）

注意：
- 允许场景、背景、动作、表情不同（这是正常的场景变化）
- 只在主角外观或画风明显不一致时才判定为 false

只输出一个 JSON：
- consistent: boolean，主角外观和画风是否基本一致
- confidence: number，0~1 之间，置信度
- reason: string，简要说明不一致的地方（如一致则填"主角外观和画风一致"）`;

  let json: VisionJson | null = null;
  try {
    json = await callVisionApi(
      [{ image: referenceUrl }, { image: imageUrl }],
      instruction,
    );
  } catch (err) {
    console.warn(
      "[ImageChecks] 跨图一致性检验调用失败，宽松兜底（通过）:",
      err,
    );
    return { ok: true, reason: "fallback-consistency-skip", raw: null };
  }

  if (!json) {
    return { ok: true, reason: "fallback-consistency-skip", raw: null };
  }

  const consistent = Boolean(json.consistent);
  const confidence =
    typeof json.confidence === "number" ? json.confidence : 0.5;

  return {
    ok: consistent && confidence >= 0.55,
    reason: consistent
      ? confidence >= 0.55
        ? "cross-image-consistent"
        : "cross-image-low-confidence"
      : `cross-image-inconsistent: ${json.reason ?? ""}`,
    raw: json,
  };
}

// ---------------------------------------------------------------------------
// 新增：图片视觉风格提取（供视频生成使用）
// ---------------------------------------------------------------------------

/**
 * 从已生成图片中提取视觉风格描述，用于约束后续视频生成的画面风格。
 *
 * 返回一段英文描述，如：
 * "2D flat cartoon style; orange tabby cat with round big eyes, fluffy tail;
 *  bright green garden background; warm cheerful color palette"
 */
export async function extractImageVisualStyle(
  imageUrl: string,
): Promise<string> {
  if (!imageUrl) return "";

  const instruction = `你是一个图片视觉风格分析系统。

请分析这张图片，提取以下信息并用于后续视频生成的风格约束。
只输出一个 JSON：
- artStyle: 渲染风格（英文，如 "2D flat cartoon"、"3D rendered"、"watercolor"）
- mainCharacter: 主角的精确外观描述（英文，30-60词，包含颜色、形状、关键特征）
- colorPalette: 主色调关键词（英文，逗号分隔，3-5个）
- atmosphere: 整体氛围（英文，如 "warm and cheerful"）`;

  let json: VisionJson | null = null;
  try {
    json = await callVisionJsonTool(imageUrl, instruction);
  } catch (err) {
    console.warn("[ImageChecks] 图片风格提取失败，跳过:", err);
    return "";
  }

  if (!json || json._rawText) return "";

  const parts = [
    json.artStyle && `art style: ${json.artStyle}`,
    json.mainCharacter && `main character: ${json.mainCharacter}`,
    json.colorPalette && `color palette: ${json.colorPalette}`,
    json.atmosphere && `atmosphere: ${json.atmosphere}`,
  ].filter(Boolean);

  return parts.join("; ");
}
