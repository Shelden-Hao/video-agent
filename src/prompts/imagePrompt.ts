import type { AgentState, PlanStep, UserParams } from "../types/state.js";

// ---------------------------------------------------------------------------
// 角色锚点（Character Anchor）——确保同一视频所有图片主角外观一致
// ---------------------------------------------------------------------------

/**
 * 角色锚点类型。由 LLM 提前生成，注入到所有图片提示词中，
 * 确保同一视频里每张图片的主角外观和画风完全统一。
 */
export type CharacterAnchor = {
  /** 主角精确外观描述（英文，用于图片生成提示词） */
  characterDescription: string;
  /** 画风关键词（英文，逗号分隔，如 "flat 2D cartoon, clean vector lines"） */
  styleKeywords: string;
  /** 背景/环境风格（英文） */
  backgroundStyle: string;
  /** 主色调（英文） */
  colorPalette: string;
};

/**
 * 系统提示：生成「角色与视觉锚点」，用于约束同一视频中所有图片的一致性。
 */
export const CHARACTER_ANCHOR_SYSTEM_PROMPT = `你是一位视觉一致性设计师，负责在视频制作前生成「角色与视觉锚点」，确保同一视频中所有画面的主角外观和风格完全统一。

## 任务
根据视频主题和用户参数，生成一份精确的视觉锚点描述，用于后续每张图片的生成提示词中。

## 关键要求
1. characterDescription 必须非常具体、可复现：
   - ✅ 好的示例："orange tabby kitten, round big amber eyes, fluffy white chest, small pink nose, curled tail"
   - ❌ 差的示例："a cute cat" （太模糊）
2. styleKeywords 必须与用户指定的 style 参数对应：
   - 2D卡通 → "flat 2D cartoon, clean vector lines, cel-shading"
   - 3D卡通 → "3D cartoon render, soft shading, toy-like proportions"
   - 写实 → "photorealistic, detailed texture"
3. 不要使用模糊词，要用具体颜色/形状/材质描述

## 输出（严格 JSON，不含 markdown）
{
  "characterDescription": "主角外观的精确英文描述（40-80 词）",
  "styleKeywords": "画风关键词（英文，逗号分隔）",
  "backgroundStyle": "背景/环境风格（英文，20-40 词）",
  "colorPalette": "主色调（英文，3-5个颜色词，逗号分隔）"
}`;

/** 根据 AgentState 构造生成角色锚点的 Human 消息 */
export function buildCharacterAnchorUserMessage(state: AgentState): string {
  const up = state.userParams;
  const plan = state.plan;

  const lines = [
    `主题：${state.topic}`,
    up && `画面风格：${up.style}`,
    up && `情绪氛围：${up.mood}`,
    up && `目标受众：${up.targetAudience}`,
    plan && `视频概要：${plan.summary}`,
    plan &&
      `主要场景描述：${plan.steps.map((s) => s.sceneDescription).join("；")}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `${lines}\n\n请生成角色与视觉锚点 JSON，确保后续所有图片的主角外观和画风完全统一。只输出 JSON。`;
}

/** 解析 LLM 返回的角色锚点 JSON */
export function parseCharacterAnchor(raw: string): CharacterAnchor | null {
  let text = raw?.trim() ?? "";
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();

  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const characterDescription =
      typeof obj.characterDescription === "string"
        ? obj.characterDescription.trim()
        : "";
    if (!characterDescription) return null;
    return {
      characterDescription,
      styleKeywords:
        typeof obj.styleKeywords === "string" ? obj.styleKeywords.trim() : "",
      backgroundStyle:
        typeof obj.backgroundStyle === "string"
          ? obj.backgroundStyle.trim()
          : "",
      colorPalette:
        typeof obj.colorPalette === "string" ? obj.colorPalette.trim() : "",
    };
  } catch {
    return null;
  }
}

/** 将角色锚点注入到图片生成提示词中（前置） */
export function injectAnchorIntoPrompt(
  prompt: string,
  anchor: CharacterAnchor,
): string {
  const anchorPrefix = [
    `[STYLE: ${anchor.styleKeywords}]`,
    `[CHARACTER: ${anchor.characterDescription}]`,
    anchor.colorPalette && `[COLORS: ${anchor.colorPalette}]`,
  ]
    .filter(Boolean)
    .join(" ");

  return `${anchorPrefix}; ${prompt}`.slice(0, 1200);
}

// ---------------------------------------------------------------------------
// Image 提示词生成
// ---------------------------------------------------------------------------

/**
 * Image 系统提示：把「分步计划」转成图片生成模型的提示词。
 * 目标：画面清晰可控、与 UserParams 风格/情绪/受众一致、每步一张图。
 */
export const IMAGE_SYSTEM_PROMPT = `你是一位专业的「分镜美术提示词（Image Prompt）」专家，根据视频计划生成每步画面的图片生成提示词。

## 你的任务
基于给定的主题、用户参数（风格/情绪/受众）和分步计划，为每一个步骤生成 1 条图片生成提示词。

## 内容要求（必须遵守）
1. **风格一致**：所有步骤的提示词必须使用与 style 参数一致的画风（如 "3D卡通" 就描述3D卡通风格）
2. **情绪贴合**：画面氛围要反映 mood 参数（如 "温馨治愈" 则配色柔和、光线暖调）
3. **受众适配**：内容要适合 targetAudience（如儿童受众禁止暴力/恐怖/成人内容）
4. **与计划一致**：提示词必须紧扣该步的核心要点与场景描述，不添加无关元素
5. **可生成性**：描述具体可视元素（角色、动作、场景、镜头、光照、色彩），避免抽象空话
6. **只输出JSON**：不要 markdown 代码块，不要解释，只输出 JSON 数组

## 输出格式（严格 JSON 数组）
[
  {
    "step": 1,
    "prompt": "详细的图片生成提示词（英文更好，或中文亦可）"
  }
]

## 提示词构成建议
- 风格标签（来自 style 参数，如：3D cartoon, soft cute, bright colors, clean background）
- 主角与道具（外观特征：颜色、形状、表情）
- 场景环境（具体背景）
- 动作与情绪（如：smiling, waving, running）
- 镜头（如：medium shot, frontal view, slight top-down angle）
- 光照（如：soft warm lighting, bright daylight）`;

/** 根据 AgentState 构造图片提示词生成的 Human 消息 */
export function buildImageUserMessage(state: AgentState): string {
  const plan = state.plan;
  const up = state.userParams;

  if (!plan) {
    const styleHint = up ? `${up.style}风格，${up.mood}氛围` : "3D卡通风格";
    return `主题：${state.topic}\n风格：${styleHint}\n请生成 1 条图片提示词。`;
  }

  const stepsText = plan.steps.map((s) => formatStepForImage(s)).join("\n\n");

  // 构造用户参数上下文
  const paramsContext = up
    ? `
画面风格：${up.style}
情绪氛围：${up.mood}
目标受众：${up.targetAudience}
图片尺寸：${up.imageSize}（提示词应适合此比例的画面构图）${up.extraRequirements ? `\n额外要求：${up.extraRequirements}` : ""}`
    : "";

  return `主题：${state.topic}
标题：${plan.title}
目标受众：${plan.targetAge}
内容概要：${plan.summary}${paramsContext}

分步计划：
${stepsText}

请严格按要求输出 JSON 数组（每步 1 条 prompt，共 ${plan.steps.length} 条）。`;
}

function formatStepForImage(s: PlanStep): string {
  return `步骤${s.step}（约${s.durationSeconds}秒）
核心要点：${s.teachingPoint}
画面描述：${s.sceneDescription}`;
}

/**
 * 从模型输出中解析出 step->prompt 数组。
 * - 优先解析 JSON（可容忍 ```json 代码块包裹）
 * - 兜底：按行/按"步骤N："切分
 */
export function extractImagePrompts(
  raw: string,
): Array<{ step: number; prompt: string }> {
  let text = raw?.trim() ?? "";
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();

  // 1) JSON 解析优先
  try {
    const obj = JSON.parse(text) as unknown;
    if (Array.isArray(obj)) {
      return obj
        .filter(
          (x): x is Record<string, unknown> => !!x && typeof x === "object",
        )
        .map((x, i) => ({
          step: typeof x.step === "number" ? x.step : i + 1,
          prompt: typeof x.prompt === "string" ? x.prompt.trim() : "",
        }))
        .filter((x) => x.prompt);
    }
    if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      const arr = Array.isArray(o.prompts) ? o.prompts : null;
      if (arr) {
        return arr
          .filter(
            (x): x is Record<string, unknown> => !!x && typeof x === "object",
          )
          .map((x, i) => ({
            step: typeof x.step === "number" ? x.step : i + 1,
            prompt: typeof x.prompt === "string" ? x.prompt.trim() : "",
          }))
          .filter((x) => x.prompt);
      }
    }
  } catch {
    // ignore
  }

  // 2) 兜底：按行解析 "步骤N：..."
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const out: Array<{ step: number; prompt: string }> = [];
  for (const line of lines) {
    const m = line.match(/^步骤\s*(\d+)\s*[:：]\s*(.+)$/);
    if (m) {
      out.push({ step: Number(m[1]), prompt: m[2].trim() });
    }
  }
  return out;
}

/**
 * 根据 UserParams 构建兜底图片提示词（当 LLM 解析失败时使用）。
 */
export function buildFallbackImagePrompts(
  state: AgentState,
): Array<{ step: number; prompt: string }> {
  const up = state.userParams;
  const style = up
    ? `${up.style}, ${up.mood}氛围`
    : "3D卡通, 软萌可爱, 明亮配色, 柔和光照, 干净背景";

  return (state.plan?.steps ?? []).map((s) => ({
    step: s.step,
    prompt: `${style}; 主题:${state.topic}; 步骤${s.step}: ${s.teachingPoint}; 场景:${s.sceneDescription}; 镜头:中景, 正面`,
  }));
}
