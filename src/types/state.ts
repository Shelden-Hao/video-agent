/**
 * 用户结构化参数（从自然语言 prompt 解析而来）。
 * 整个工作流以此为核心数据契约，所有 Agent 均通过 JSON 对象形式传递数据。
 */
export type UserParams = {
  /** 用户原始输入文本 */
  rawPrompt: string;
  /** 核心内容主题（简洁，供 Planner 使用） */
  topic: string;
  /** 主体角色（某个人物/动物/静物） */
  role: string;
  /** 画面风格，如 "3D卡通"、"写实"、"水彩动漫"、"赛博朋克" */
  style: string;
  /** 目标受众，如 "3-6岁儿童"、"青少年"、"成人通用" */
  targetAudience: string;
  /** 目标格式，如 "video"、"text"、"voice"、"image" */
  targetFormat: string;
  /** 目标类型，如 "education"、"entertainment"、"other" */
  targetType: string;
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

export type TargetKind = "text" | "image" | "video" | "audio";

export type IntentSpec = {
  /** 意图目标集合（粗粒度） */
  targets: TargetKind[];
  /** 主目标（可选） */
  primaryTarget?: TargetKind;
  /** 置信度 0~1（仅表达意图分类的确定程度） */
  confidence: number;
  /** 哪些关键槽位缺失（用于触发澄清提问） */
  missingSlots: string[];
  /** 对用户可见的决策摘要（避免暴露模型私密推理） */
  publicRationale?: string;
};

export type MemoryItem = {
  key: string;
  value: string;
  at: string;
};

export type Artifact = {
  /** 全局唯一 id */
  id: string;
  /** 产物类型 */
  kind: TargetKind;
  /** 可选：对应 plan 的步骤号（从 1 开始） */
  step?: number;
  /** 资源地址（如 https://... 或本地相对路径） */
  uri?: string;
  /** 文本产物内容（如脚本/总结） */
  text?: string;
  /** 可选：MIME 类型（如 audio/mp3, image/png） */
  mimeType?: string;
  /** 任意扩展元信息：质量/安全/一致性/参数/trace 等 */
  metadata?: Record<string, unknown>;
  /** 产物来源（哪个 agent、模型等） */
  source?: {
    agent: string;
    model?: string;
  };
  /** ISO 时间戳 */
  createdAt: string;
};

export type WorkflowSpec = {
  /** 期望生成的产物集合（配置驱动入口） */
  targets: TargetKind[];
  /** 可选：约束与策略（第一版先放这里，后续可拆分为更细的 spec） */
  constraints?: {
    /** 限制最多生成的视频步数（覆盖 env VIDEO_MAX_STEPS） */
    maxVideoSteps?: number;
    /** 是否为视频生成预先生成图片（用于 i2v 或风格约束） */
    generateImagesForVideo?: boolean;
    /** 强制视频模式：auto=t2v/i2v 按 userParams 与环境决定 */
    videoMode?: "auto" | "t2v" | "i2v";
    /** 语音合成参数（CosyVoice WebSocket API） */
    tts?: {
      model?: string;
      voice?: string;
      format?: "mp3" | "wav" | "pcm";
      sampleRate?: number;
      rate?: number;
      pitch?: number;
      volume?: number;
      enableSsml?: boolean;
    };
  };
};

export type RoutePlan = {
  targets: TargetKind[];
  needs: {
    plan: boolean;
    text: boolean;
    image: boolean;
    video: boolean;
    audio: boolean;
  };
};

/** 主 Agent 状态 —— 工作流全程通过此 JSON 对象传递数据 */
export type AgentState = {
  /** 用户原始输入（入口字段） */
  topic: string;
  /** 结构化参数（由 parseInputAgent 从 topic 解析） */
  userParams: UserParams | null;
  /** Planner 生成的结构化计划 */
  plan: VideoPlan | null;
  /** 文本输出（可选：文案/脚本/总结等；第一版先复用为 audio 的输入） */
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

  /** 完全的 --spec 参数配置驱动的工作流声明（可选，入口可从 CLI 注入） */
  workflowSpec?: WorkflowSpec;
  /** Router 的路由决策结果（可选，便于观测与调试） */
  route?: RoutePlan;
  /** 意图分析的粗粒度结构化输出（可中断等待用户澄清） */
  intent?: IntentSpec;
  /** 短期 memory：跨多轮/多次恢复保留的关键信息（澄清答案、反馈等） */
  memory: MemoryItem[];
  /** 通用产物集合（迁移期：与 images/videos/audio/script 等并存） */
  artifacts: Artifact[];
};
