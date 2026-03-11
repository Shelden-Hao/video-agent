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

export type AgentState = {
  topic: string;
  /** Planner 生成的结构化计划（教培向、儿童适宜） */
  plan: VideoPlan | null;
  script: string;
  images: string[];
  audio: string;
  video: string;
};
