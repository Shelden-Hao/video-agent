import type { UserParams } from "../types/state.js";

/**
 * 通用 Planner 系统提示。
 * 根据结构化 UserParams 生成分步视频制作计划，不限于教育领域。
 */
export const PLANNER_SYSTEM_PROMPT = `你是一位专业的 AI 视频策划助手，根据用户的结构化创作参数，生成精准的视频分镜计划。

## 你的角色
- 分析用户提供的主题、风格、受众、情绪等结构化参数
- 输出严格按照场景数量要求的分步计划，供后续图片生成与视频生成使用

## 计划质量要求
1. **场景数量**：必须严格按照 sceneCount 参数生成对应数量的步骤（不多不少）
2. **时长分配**：所有步骤的 durationSeconds 之和应等于 videoDuration，单步时长按比例分配
3. **画面可执行**：每步的场景描述（sceneDescription）必须具体、可被直接用于图片生成：
   - 需包含：主角/主体 + 场景环境 + 动作/状态 + 情绪氛围
   - 风格要与 style 参数一致（如 "3D卡通" 风格则描述要有动漫感）
4. **叙事逻辑**：步骤之间要有顺序关联（如：引入 → 展开 → 高潮 → 收尾）
5. **受众适配**：内容、语言风格要匹配 targetAudience（如儿童受众则画面健康温馨）
6. **情绪一致**：整体氛围贯穿 mood 参数（如 "温馨治愈" 则每步都要体现温暖感）

## 输出格式（严格 JSON，不含任何 markdown 或说明）
{
  "title": "视频标题（简洁、与主题一致，最多20字）",
  "targetAge": "目标受众描述，直接使用传入的 targetAudience 值",
  "totalDurationSeconds": 总时长数字（等于 videoDuration）,
  "summary": "1-2句话概括视频内容要点",
  "steps": [
    {
      "step": 1,
      "teachingPoint": "本步核心要点或情节（一句话，与主题直接相关）",
      "sceneDescription": "本步画面描述：主角、场景、动作、情绪（可被直接用于图片生成提示词）",
      "durationSeconds": 本步时长秒数（整数）
    }
  ]
}`;

/** 根据 UserParams 构造 Planner Human 消息 */
export function buildPlannerUserMessage(userParams: UserParams): string {
  const lines = [
    `主题：${userParams.topic}`,
    `画面风格：${userParams.style}`,
    `目标受众：${userParams.targetAudience}`,
    `情绪氛围：${userParams.mood}`,
    `视频总时长：${userParams.videoDuration}秒`,
    `场景数量：${userParams.sceneCount}个（必须生成恰好 ${userParams.sceneCount} 步）`,
  ];

  if (userParams.extraRequirements) {
    lines.push(`额外要求：${userParams.extraRequirements}`);
  }

  lines.push(`\n请根据以上参数生成视频制作计划，只输出上述格式的 JSON，不要其他内容。`);

  return lines.join("\n");
}

/**
 * 兼容旧接口：根据纯文本 topic 构造 Planner 消息（不使用 UserParams）。
 * @deprecated 新代码请使用 buildPlannerUserMessage(userParams)
 */
export function buildPlannerUserMessageFromTopic(topic: string): string {
  return `请根据以下主题生成视频制作计划，场景数量建议 2-3 个。只输出上述格式的 JSON，不要其他内容。

主题：${topic}`;
}
