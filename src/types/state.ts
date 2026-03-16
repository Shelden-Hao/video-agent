/** 计划中的单步（供脚本/分镜参考） */
export type PlanStep = {
  /** 步骤序号 */
  step: number;
  /** 本步教学目标或情节要点（一句话） */
  teachingPoint: string;
  /** 画面/场景描述（供后续图片与视频分镜使用） */
  sceneDescription: string;
  /** 建议时长（秒），用于控制节奏 */
  durationSeconds: number;
};

/** Planner 输出的结构化计划 */
export type VideoPlan = {
  /** 视频标题（适合儿童、教培场景） */
  title: string;
  /** 目标年龄段，如 "3-6岁"、"6-9岁" */
  targetAge: string;
  /** 总建议时长（秒） */
  totalDurationSeconds: number;
  /** 教学/内容要点摘要（1-2 句） */
  summary: string;
  /** 分步计划，对应后续脚本与画面 */
  steps: PlanStep[];
};

/**
 * 单步视频生成的结构化参数（由 LLM 将自然语言/计划转换而来）。
 * 用于精确控制 Wan 文生视频 API 的调用参数。
 */
export type VideoGenerationParams = {
  /** 对应计划步骤序号 */
  step: number;
  /** 优化后的视频生成提示词（动态描述、镜头语言、风格、情绪） */
  prompt: string;
  /** 反向提示词（排除不想要的元素） */
  negativePrompt: string;
  /** 分辨率，如 "832*480"（480P）或 "1280*720"（720P） */
  size: string;
  /** 视频时长（秒），wanx2.1-t2v-turbo 固定为 5 */
  duration: number;
  /** 是否启用 prompt 智能改写 */
  promptExtend: boolean;
};

export type AgentState = {
  topic: string;
  /** Planner 生成的结构化计划（教培向、儿童适宜） */
  plan: VideoPlan | null;
  script: string;
  images: string[];
  audio: string;
  video: string;
  /** LLM 结构化后的每步视频生成参数（步骤1对应索引0） */
  videoParams?: VideoGenerationParams[];
  /** 每步生成的视频 URL（与 videoParams 索引对应） */
  videos?: string[];
};
