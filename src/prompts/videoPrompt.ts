import type {
  AgentState,
  PlanStep,
  UserParams,
  VideoGenerationParams,
} from "../types/state.js";

// ---------------------------------------------------------------------------
// 1. 结构化输入：将计划/UserParams 转换为视频生成参数
// ---------------------------------------------------------------------------

/**
 * 系统提示：将分步计划和用户参数转换为精确的视频生成参数 JSON。
 */
export const VIDEO_STRUCTURE_SYSTEM_PROMPT = `你是一位专业的「分镜脚本转视频生成参数」专家。

## 你的任务
基于给定的主题、用户参数（风格/情绪/受众/分辨率）和分步计划，为每一个步骤生成精确的视频生成参数 JSON。

## 视频生成要求（必须遵守）
1. **风格一致**：prompt 必须使用 style 参数指定的风格描述（如 "2D卡通" 则 prompt 包含 2D cartoon, soft cute 等）
2. **情绪贴合**：整体氛围要体现 mood 参数（如 "欢快活泼" 对应 lively, cheerful, bright colors）
3. **动态描述**：prompt 必须包含具体的动作信息，视频是动态的，要描述"发生了什么"（角色在做什么）
4. **镜头语言**：指定镜头运动（缓慢推进、俯拍、平移等）和景别（中景、近景等）
5. **字符限制**：每条 prompt 不超过 600 字符，negativePrompt 不超过 300 字符
6. **分辨率**：size 必须使用 videoSize 参数指定的值
7. **只输出JSON**：不要 markdown 代码块，不要解释，只输出 JSON 数组

## prompt 构成建议（按重要性排序）
- 主要动作：角色正在做什么（如：小兔子欢快地跑过草地，尾巴一摇一摇）
- 场景环境：背景描述（如：阳光明媚的森林，绿色草地，蓝天白云）
- 视觉风格：来自 style 参数（如 2D卡通 → 2D cartoon, soft cute, bright colors, clean background）
- 镜头运动：镜头缓慢跟随主角，中景，轻微俯视角
- 情绪氛围：来自 mood 参数（如 欢快 → lively, cheerful, joyful）

## negativePrompt 建议（通用）
"低分辨率，模糊，扭曲变形，成人内容，暴力，血腥，文字水印，多余的手指，比例失调"

## 参数约束
- size: 使用 videoSize 参数（如 "832*480" 或 "1280*720"）
- duration: 使用各步骤的 durationSeconds（若超过10则截断为10，若小于5则设为5）
- promptExtend: 推荐 true（AI 智能改写，提升效果）

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

/**
 * 根据 AgentState 构造视频结构化的 Human 消息。
 *
 * @param state - 当前 Agent 状态
 * @param imageStyleDescription - 从已生成图片提取的视觉风格描述（英文），用于约束视频风格与图片一致
 */
export function buildVideoStructureUserMessage(
  state: AgentState,
  imageStyleDescription?: string,
): string {
  const plan = state.plan;
  const up = state.userParams;

  if (!plan) {
    const styleHint = up ? `${up.style}风格，${up.mood}氛围` : "3D卡通风格";
    const sizeHint = up?.videoSize ?? "832*480";
    return `主题：${state.topic}\n风格：${styleHint}\n分辨率：${sizeHint}\n请生成 1 条视频生成参数。`;
  }

  const stepsText = plan.steps.map(formatStepForVideo).join("\n\n");

  const paramsContext = up
    ? `
画面风格：${up.style}
情绪氛围：${up.mood}
目标受众：${up.targetAudience}
主体角色：${up.role}
视频分辨率：${up.videoSize}（所有步骤的 size 必须使用此值）${up.extraRequirements ? `\n额外要求：${up.extraRequirements}` : ""}`
    : "";

  // ⚠️ 核心约束：当有图片风格描述时，强制要求视频与图片风格一致
  const imageStyleConstraint = imageStyleDescription
    ? `

⚠️ 【最高优先级】画面风格必须与已生成图片完全一致：
${imageStyleDescription}

要求：
1. 所有 prompt 开头必须包含上述风格关键词（尤其是 artStyle）
2. 主角外观描述（mainCharacter）必须出现在每条 prompt 中
3. 禁止改变渲染风格（如图片是2D卡通就必须是2D卡通，不能变成3D或写实）`
    : "";

  return `主题：${state.topic}
标题：${plan.title}
目标受众：${plan.targetAge}
内容概要：${plan.summary}${paramsContext}${imageStyleConstraint}

分步计划：
${stepsText}

请严格输出 JSON 数组（每步 1 条参数，共 ${plan.steps.length} 条）。`;
}

function formatStepForVideo(s: PlanStep): string {
  return `步骤${s.step}（建议时长 ${s.durationSeconds}秒）
核心要点：${s.teachingPoint}
画面描述：${s.sceneDescription}`;
}

/**
 * 从模型输出中解析出 VideoGenerationParams 数组。
 */
export function extractVideoParams(
  raw: string,
  fallbackState: AgentState,
): VideoGenerationParams[] {
  let text = raw?.trim() ?? "";
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();

  const defaultSize = fallbackState.userParams?.videoSize ?? "832*480";

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
          size: typeof x.size === "string" ? x.size : defaultSize,
          duration:
            typeof x.duration === "number"
              ? Math.min(Math.max(x.duration, 5), 10)
              : 5,
          promptExtend:
            typeof x.promptExtend === "boolean" ? x.promptExtend : true,
        }))
        .filter((x) => x.prompt.length > 0);

      if (parsed.length > 0) return parsed;
    }
  } catch {
    // ignore, fall through to fallback
  }

  return buildFallbackVideoParams(fallbackState);
}

const DEFAULT_NEGATIVE_PROMPT =
  "低分辨率，模糊，扭曲变形，成人内容，暴力，血腥，文字水印，多余的手指，比例失调";

function buildFallbackVideoParams(state: AgentState): VideoGenerationParams[] {
  const up = state.userParams;
  const steps = state.plan?.steps ?? [];
  const size = up?.videoSize ?? "832*480";
  const style = up
    ? `${up.style}风格，${up.mood}氛围，画面生动`
    : "2D卡通，软萌可爱，色彩明亮，光线柔和，儿童友好";

  if (steps.length === 0) {
    return [
      {
        step: 1,
        prompt: `${style}；主题:${state.topic}；角色在场景中活动，表情自然，镜头缓慢跟随，中景`,
        negativePrompt: DEFAULT_NEGATIVE_PROMPT,
        size,
        duration: up?.videoDuration
          ? Math.min(Math.max(up.videoDuration, 5), 10)
          : 10,
        promptExtend: true,
      },
    ];
  }

  return steps.map((s) => ({
    step: s.step,
    prompt:
      `${style}；步骤${s.step}:${s.teachingPoint}；` +
      `场景:${s.sceneDescription}；` +
      `镜头缓慢跟随主角，中景，画面流畅`,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    size,
    duration: Math.min(Math.max(s.durationSeconds, 5), 10),
    promptExtend: true,
  }));
}

// ---------------------------------------------------------------------------
// 2. 生成后校验：语义一致性评估提示词
// ---------------------------------------------------------------------------

/**
 * 视频语义一致性检测指令。
 * 额外传入 userParams 可做更精准的风格/受众匹配检测。
 */
export function buildVideoConsistencyInstruction(
  prompt: string,
  userParams?: UserParams,
): string {
  const styleNote = userParams
    ? `\n视频应使用「${userParams.style}」风格，情绪氛围为「${userParams.mood}」，面向「${userParams.targetAudience}」，主体角色为「${userParams.role}」。`
    : "";

  return `你是一个视频内容审核系统，用于语义一致性检验。

用户生成这段视频时使用的文本提示词（prompt）是：
"${prompt}"${styleNote}

请判断视频内容是否对提示词的「核心意图」进行了有效表现。判断标准（宽松匹配）：
1. 主要角色/主体是否出现？
2. 整体场景主题是否符合？
3. 画面是否有基本的动态内容（不是静止图片）？
4. 不需严格匹配风格细节，不要求精确还原每个动作细节。
5. 若视频内容与提示词完全无关，才判定为不匹配。

只输出一个 JSON：
- match: boolean，视频内容是否基本符合提示词核心意图
- confidence: number，0~1 之间，置信度
- summary: string，1~2 句描述视频内容（中文）`;
}

/** 视频安全审核指令 */
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

/** 视频质量评估指令 */
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
