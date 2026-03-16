import type {
  AgentState,
  PlanStep,
  VideoGenerationParams,
} from "../types/state.js";

// ---------------------------------------------------------------------------
// 1. 结构化输入：将计划/脚本转换为视频生成参数
// ---------------------------------------------------------------------------

/**
 * 系统提示：将分步计划和旁白脚本转换为精确的视频生成参数 JSON。
 *
 * 目标模型：wanx2.1-t2v-turbo（免费），参数约束：
 * - size: "832*480"（16:9 横屏）或 "480*832"（9:16 竖屏）
 * - duration: 固定 5（wanx2.1 不支持修改）
 * - promptExtend: 通常 true（自动改写提升效果）
 * - prompt 限制 800 字符（wanx2.1）
 */
export const VIDEO_STRUCTURE_SYSTEM_PROMPT = `你是一位专业的儿童教培短视频「分镜脚本」转「视频生成参数」专家。

## 你的任务
基于给定的主题、分步计划和旁白脚本，为每一个步骤生成精确的视频生成参数 JSON。

## 视频生成要求（必须遵守）
1. **儿童适宜**：画面健康积极，不出现暴力、恐怖、血腥、成人内容、危险动作。
2. **动态描述**：prompt 必须包含具体的动作和运动信息，视频不是图片，要描述"发生了什么"。
3. **镜头语言**：指定摄像机运动（缓慢推进、俯拍、平移等）和景别（中景、近景等）。
4. **风格统一**：同一视频系列使用一致的画风（3D卡通、软萌、明亮配色、柔和光照）。
5. **字符限制**：每条 prompt 不超过 600 字符，negativePrompt 不超过 300 字符。
6. **只输出JSON**：不要 markdown 代码块，不要解释，只输出 JSON 数组。

## prompt 构成建议（按重要性排序）
- 主要动作：角色正在做什么（如：小兔子欢快地跑过草地，尾巴一摇一摇）
- 场景环境：背景描述（如：阳光明媚的森林，绿色草地，蓝天白云）
- 视觉风格：3D 卡通，软萌可爱，色彩明亮，光线柔和，儿童友好
- 镜头运动：镜头缓慢跟随主角，中景，轻微俯视角
- 情绪氛围：欢快、温馨、充满好奇心

## negativePrompt 建议（通用）
"低分辨率，模糊，扭曲变形，成人内容，暴力，血腥，文字水印，多余的手指，比例失调"

## 参数约束（wan2.5-t2v-preview）
- size: 横屏 "832*480"（480P）或 "1280*720"（720P），教育视频推荐 "832*480" 节约配额
- duration: 可填 5 或 10（单位：秒），教育视频推荐 10 秒以承载更多内容
- promptExtend: 推荐 true（AI 智能改写，提升效果；较短 prompt 效果提升更明显）
- 无需 audio_url：若不传入音频 URL，模型将根据视频内容自动生成匹配的背景音乐或音效

## 输出格式（严格 JSON 数组）
[
  {
    "step": 1,
    "prompt": "...",
    "negativePrompt": "...",
    "size": "832*480",
    "duration": 5,
    "promptExtend": true
  }
]`;

/** 根据 AgentState 构造视频结构化的 Human 消息 */
export function buildVideoStructureUserMessage(state: AgentState): string {
  const plan = state.plan;
  if (!plan) {
    return `主题：${state.topic}\n请生成 1 条儿童友好的视频生成参数。`;
  }

  const stepsText = plan.steps.map(formatStepForVideo).join("\n\n");
  const scriptText = state.script?.trim()
    ? `\n\n旁白脚本（可选参考，确保画面与旁白内容协调）：\n${state.script.trim()}`
    : "";

  return `主题：${state.topic}
标题：${plan.title}
目标年龄：${plan.targetAge}
内容概要：${plan.summary}

分步计划：
${stepsText}${scriptText}

请严格输出 JSON 数组（每步 1 条参数，共 ${plan.steps.length} 条）。`;
}

function formatStepForVideo(s: PlanStep): string {
  return `步骤${s.step}（建议时长 ${s.durationSeconds}秒）
教学要点：${s.teachingPoint}
画面描述：${s.sceneDescription}`;
}

/**
 * 从模型输出中解析出 VideoGenerationParams 数组。
 * - 优先解析 JSON（容忍 ```json 代码块包裹）
 * - 兜底：按计划 steps 数量生成简单参数
 */
export function extractVideoParams(
  raw: string,
  fallbackState: AgentState,
): VideoGenerationParams[] {
  let text = raw?.trim() ?? "";
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();

  try {
    const obj = JSON.parse(text) as unknown;
    if (Array.isArray(obj)) {
      const parsed = obj
        .filter(
          (x): x is Record<string, unknown> => !!x && typeof x === "object",
        )
        .map((x, i) => ({
          step: typeof x.step === "number" ? x.step : i + 1,
          prompt: typeof x.prompt === "string" ? x.prompt.trim() : "",
          negativePrompt:
            typeof x.negativePrompt === "string"
              ? x.negativePrompt.trim()
              : DEFAULT_NEGATIVE_PROMPT,
          size: typeof x.size === "string" ? x.size : "832*480",
          duration: typeof x.duration === "number" ? x.duration : 5,
          promptExtend:
            typeof x.promptExtend === "boolean" ? x.promptExtend : true,
        }))
        .filter((x) => x.prompt.length > 0);

      if (parsed.length > 0) return parsed;
    }
  } catch {
    // ignore, fall through to fallback
  }

  // 兜底：按计划 steps 生成基础参数
  return buildFallbackVideoParams(fallbackState);
}

const DEFAULT_NEGATIVE_PROMPT =
  "低分辨率，模糊，扭曲变形，成人内容，暴力，血腥，文字水印，多余的手指，比例失调";

function buildFallbackVideoParams(state: AgentState): VideoGenerationParams[] {
  const steps = state.plan?.steps ?? [];
  const style =
    "2D卡通，软萌可爱，色彩明亮，光线柔和，卡通风格，儿童友好，矢量无描边插画风格；";

  if (steps.length === 0) {
    return [
      {
        step: 1,
        prompt: `${style}主题:${state.topic}；角色在场景中活动，表情开心，镜头缓慢跟随，中景`,
        negativePrompt: DEFAULT_NEGATIVE_PROMPT,
        size: "832*480",
        duration: 10,
        promptExtend: true,
      },
    ];
  }

  return steps.map((s) => ({
    step: s.step,
    prompt:
      `${style}步骤${s.step}:${s.teachingPoint}；` +
      `场景:${s.sceneDescription}；` +
      `镜头缓慢跟随主角，中景，情绪温馨愉快`,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    size: "832*480",
    duration: 10,
    promptExtend: true,
  }));
}

// ---------------------------------------------------------------------------
// 2. 生成后校验：语义一致性评估提示词
// ---------------------------------------------------------------------------

/**
 * 视频语义一致性检测指令。
 * 用于调用多模态模型（qwen-vl-max）分析视频内容是否符合 prompt。
 */
export function buildVideoConsistencyInstruction(prompt: string): string {
  return `你是一个视频内容审核系统，专用于儿童教育短视频的语义一致性检验。

用户生成这段视频时使用的文本提示词（prompt）是：
"${prompt}"

请判断视频内容是否对提示词的「核心意图」进行了有效表现。判断标准（宽松匹配）：
1. 主要角色/主体是否出现（如描述了小兔子，视频中是否有小兔子）？
2. 整体场景主题是否符合（如户外草地、教室、儿童互动等大方向）？
3. 画面是否有基本的动态内容（不是静止图片）？
4. 不需严格匹配艺术风格，不要求精确还原每个动作细节。
5. 若视频内容与提示词完全无关，才判定为不匹配。

只输出一个 JSON：
- match: boolean，视频内容是否基本符合提示词核心意图
- confidence: number，0~1 之间，置信度
- summary: string，1~2 句描述视频内容（中文）`;
}

/**
 * 视频安全审核指令。
 */
export function buildVideoSafetyInstruction(prompt: string): string {
  return `你是一个视频安全审核系统。

生成该视频时使用的提示词（供参考）：
"${prompt}"

请判断视频是否包含以下内容：
1. 色情/裸露/NSFW
2. 暴力、血腥、恐怖
3. 敏感政治内容（国家领导人、政党标志、抗议游行等）
4. 仇恨或歧视（针对种族、性别、宗教等群体的攻击性表达）

只输出一个 JSON：
- nsfw: boolean
- violence: boolean
- politics: boolean
- hate: boolean
- confidence: number，0~1 之间`;
}

/**
 * 视频质量评估指令。
 */
export const VIDEO_QUALITY_INSTRUCTION = `你是一个视频质量评估系统。

请仅根据视频本身，从以下维度进行客观打分：
1. 清晰度（是否模糊、噪点多不多）
2. 流畅度（动作是否连贯、有无明显跳帧或卡顿）
3. 构图（主体是否完整、是否被严重裁切、是否畸形扭曲）
4. 内容完整性（视频是否完整播放，有无黑屏或截断）

只输出一个 JSON：
- clarityScore: 0~1
- fluencyScore: 0~1
- compositionScore: 0~1
- overallScore: 0~1
- acceptable: boolean`;
