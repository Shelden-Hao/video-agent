import { StateGraph, START, END } from "@langchain/langgraph";
import type {
  AgentState,
  UserParams,
  VideoGenerationParams,
} from "../types/state.js";
import { runParseInputAgent } from "../agents/parseInputAgent.js";
import { runPlanAgent } from "../agents/planAgent.js";
import { runImageAgent } from "../agents/imageAgent.js";
import { runVideoAgent } from "../agents/videoAgent.js";

/**
 * 构建完整的视频生成工作流。
 *
 * 流程：
 *   START
 *     → parse_input   （自然语言 → UserParams 结构化解析）
 *     → plan_agent    （UserParams → VideoPlan 分步计划）
 *     → image_agent   （每步图片生成 + 校验 Evaluator-Optimizer）
 *     → video_agent   （每步视频生成 + 校验 Evaluator-Optimizer，支持 i2v 首帧）
 *   END
 *
 * 整个流程通过 AgentState JSON 对象传递数据。
 */
export function buildVideoWorkflow() {
  const graph = new StateGraph<AgentState>({
    channels: {
      // value: (_, x) => x  表示"取 update 值覆盖当前值"（正确的 reducer 写法）
      topic: { value: (_: string, x: string) => x, default: () => "" },
      userParams: {
        value: (_: UserParams | null, x: UserParams | null) => x,
        default: () => null as UserParams | null,
      },
      plan: { value: (_, x) => x, default: () => null },
      script: { value: (_: string, x: string) => x, default: () => "" },
      images: {
        value: (_: string[], x: string[]) => x,
        default: () => [] as string[],
      },
      audio: { value: (_: string, x: string) => x, default: () => "" },
      video: { value: (_: string, x: string) => x, default: () => "" },
      videoParams: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: (_: any, x: any) => (x ?? []) as VideoGenerationParams[],
        default: () => [] as VideoGenerationParams[],
      },
      videos: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: (_: any, x: any) => (x ?? []) as string[],
        default: () => [] as string[],
      },
    },
  })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("parse_input", runParseInputAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("plan_agent", runPlanAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("image_agent", runImageAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("video_agent", runVideoAgent as any)
    .addEdge(START, "parse_input")
    .addEdge("parse_input", "plan_agent")
    .addEdge("plan_agent", "image_agent")
    .addEdge("image_agent", "video_agent")
    .addEdge("video_agent", END);

  return graph.compile();
}
