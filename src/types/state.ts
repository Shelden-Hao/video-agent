/**
 * 用户结构化参数（从自然语言 prompt 解析而来）。
 * 整个工作流以此为核心数据契约，所有 Agent 均通过 JSON 对象形式传递数据。
 */
export type UserParams = {
  /** 用户原始输入文本 */
  rawPrompt: string;
  /** 核心内容主题（简洁，供 Planner 使用） */
  topic: string;
  /** 画面风格，如 "3D卡通"、"写实"、"水彩动漫"、"赛博朋克" */
  style: string;
  /** 目标受众，如 "3-6岁儿童"、"青少年"、"成人通用" */
  targetAudience: string;
  /** 情绪/氛围，如 "欢快活泼"、"温馨治愈"、"紧张刺激" */
  mood: string;
  /** 总视频时长（秒） */
  videoDuration: number;
  /** 视频分辨率，如 "832*480"（横屏480P）、"1280*720"（横屏720P）、"480*832"（竖屏） */
  videoSize: string;
  /** 图片尺寸，如 "1024*1024" */
  imageSize: string;
  /** 期望场景/步骤数量（1-5） */
  sceneCount: number;
  /** 是否将生成的图片用作视频首帧（i2v 模式） */
  useImageAsFirstFrame: boolean;
  /** 用户的其他特殊要求（无则为空字符串） */
  extraRequirements: string;
};

/** 计划中的单步（供分镜/图片/视频生成参考） */
export type PlanStep = {
  /** 步骤序号 */
  step: number;
  /** 本步标题或情节要点（一句话） */
  teachingPoint: string;
  /** 画面/场景描述（供后续图片与视频分镜使用） */
  sceneDescription: string;
  /** 建议时长（秒） */
  durationSeconds: number;
};

/** Planner 输出的结构化计划 */
export type VideoPlan = {
  /** 视频标题 */
  title: string;
  /** 目标受众描述，如 "3-6岁儿童"、"成人通用" */
  targetAge: string;
  /** 总建议时长（秒） */
  totalDurationSeconds: number;
  /** 内容要点摘要（1-2 句） */
  summary: string;
  /** 分步计划，对应后续图片与视频生成步骤 */
  steps: PlanStep[];
};

/**
 * 单步视频生成的结构化参数（由 LLM 将计划/UserParams 转换而来）。
 * 用于精确控制 Wan 文生视频 / 图生视频 API 的调用参数。
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
  /** 视频时长（秒） */
  duration: number;
  /** 是否启用 prompt 智能改写 */
  promptExtend: boolean;
  /**
   * 图片首帧 URL（可选）。
   * 若提供，将切换为 i2v（图生视频）模式，以此图片作为视频第一帧。
   */
  firstFrameUrl?: string;
};

/** 主 Agent 状态 —— 工作流全程通过此 JSON 对象传递数据 */
export type AgentState = {
  /** 用户原始输入（入口字段） */
  topic: string;
  /** 结构化参数（由 parseInputAgent 从 topic 解析） */
  userParams: UserParams | null;
  /** Planner 生成的结构化计划 */
  plan: VideoPlan | null;
  /** 旁白脚本（可选，供扩展使用） */
  script: string;
  /** 每步生成的图片 URL（与 plan.steps 索引对应） */
  images: string[];
  /** 音频 URL（可选，供视频合成使用） */
  audio: string;
  /** 单条视频 URL（兼容字段，取 videos[0]） */
  video: string;
  /** LLM 结构化后的每步视频生成参数（步骤1对应索引0） */
  videoParams?: VideoGenerationParams[];
  /** 每步生成的视频 URL（与 videoParams 索引对应） */
  videos?: string[];
};
