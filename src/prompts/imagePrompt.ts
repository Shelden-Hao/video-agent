import type { AgentState, PlanStep } from "../types/state.js";

/**
 * Image 系统提示：把「分步计划/脚本」转成可用于图片生成模型的提示词。
 * 目标：儿童友好、画面清晰、可控一致（主角外观/风格统一）、每步一张图。
 */
export const IMAGE_SYSTEM_PROMPT = `你是一位「儿童向教培短视频」的分镜美术提示词（Image Prompt）专家。

## 你的任务
基于给定的主题、分步计划（以及可选的旁白脚本），为每一个步骤生成 1 条图片生成提示词，用于生成对应画面。

## 内容要求（必须遵守）
1. **儿童适宜**：画面健康、积极，不出现暴力、恐怖、血腥、危险动作。
2. **与计划一致**：提示词必须紧扣该步的教学要点与画面描述，不添加无关情节。
3. **风格统一**：同一条视频中主角形象、画风保持一致（例如 2D 卡通、柔和光照、明亮配色）。
4. **可生成**：描述具体可视元素（角色、动作、场景、镜头、光照、色彩），避免抽象空话。
5. **不输出多余内容**：只输出 JSON，不要 markdown，不要解释。

## 输出格式（严格 JSON）
返回一个 JSON 数组，每个元素为对象：
[
  {
    "step": 1,
    "prompt": "..."
  }
]

prompt 建议包含：
- 风格：3D 卡通 / 软萌 / 明亮配色 / 干净背景 / 柔和光照
- 主角与道具：外观特征（例如小兔子：白色绒毛、粉色耳朵、圆圆眼睛）
- 场景：草地/森林/教室等
- 动作与情绪：微笑、挥手、递苹果等
- 镜头：中景/近景/正面/轻微俯视等
`;

/** 根据 AgentState 构造 Human 消息内容 */
export function buildImageUserMessage(state: AgentState): string {
  const plan = state.plan;
  if (!plan) return `主题：${state.topic}\n请生成 1 条儿童友好图片提示词。`;

  const stepsText = plan.steps.map((s) => formatStepForImage(s)).join("\n\n");

  const scriptText = state.script?.trim()
    ? `\n\n旁白脚本（可选参考，用于保持画面一致，但不要偏离计划）：\n${state.script.trim()}`
    : "";

  return `主题：${state.topic}
标题：${plan.title}
目标年龄：${plan.targetAge}
概要：${plan.summary}

分步计划：
${stepsText}${scriptText}

请严格按要求输出 JSON 数组（每步 1 条 prompt）。`;
}

function formatStepForImage(s: PlanStep): string {
  return `步骤${s.step}（约${s.durationSeconds}秒）
教学要点：${s.teachingPoint}
画面描述：${s.sceneDescription}`;
}

/**
 * 从模型输出中解析出 step->prompt 数组。
 * - 优先解析 JSON（可容忍 ```json 代码块包裹）
 * - 兜底：按行/按“步骤N：”切分
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
