import type { TargetKind } from "../types/state.js";

/**
 * 现有代码到“通用 TaskSpec”抽象的映射表（第一版：用于重构对齐与迁移追踪）。
 *
 * 说明：
 * - reads/writes 表达该任务对 AgentState 的字段依赖与产出
 * - produces 表达该任务最终会产出的 artifact 类型（迁移期可能同时写旧字段）
 */
export const TASK_SPEC_MAP = {
  parse_input: {
    kind: "parse" as const,
    reads: ["topic"] as const,
    writes: ["userParams", "topic"] as const,
    produces: [] as TargetKind[],
    impl: "src/agents/parseInputAgent.ts",
  },
  plan_agent: {
    kind: "plan" as const,
    reads: ["userParams", "topic"] as const,
    writes: ["plan"] as const,
    produces: [] as TargetKind[],
    impl: "src/agents/planAgent.ts",
  },
  script_agent: {
    kind: "generate_text" as const,
    reads: ["plan", "topic"] as const,
    writes: ["script", "artifacts"] as const,
    produces: ["text"] as TargetKind[],
    impl: "src/agents/scriptAgent.ts",
  },
  image_agent: {
    kind: "generate_image" as const,
    reads: ["plan", "userParams"] as const,
    writes: ["images", "artifacts"] as const,
    produces: ["image"] as TargetKind[],
    impl: "src/agents/imageAgent.ts",
  },
  video_agent: {
    kind: "generate_video" as const,
    reads: ["plan", "userParams", "images", "audio"] as const,
    writes: ["videoParams", "videos", "video", "artifacts"] as const,
    produces: ["video"] as TargetKind[],
    impl: "src/agents/videoAgent.ts",
  },
  audio_agent: {
    kind: "generate_audio" as const,
    reads: ["script", "workflowSpec"] as const,
    writes: ["audio", "artifacts"] as const,
    produces: ["audio"] as TargetKind[],
    impl: "src/agents/audioAgent.ts",
  },
  router_agent: {
    kind: "router" as const,
    reads: ["workflowSpec", "userParams"] as const,
    writes: ["route", "workflowSpec"] as const,
    produces: [] as TargetKind[],
    impl: "src/agents/routerAgent.ts",
  },
};

