import {
  StateGraph,
  START,
  END,
  MemorySaver,
  InMemoryStore,
} from "@langchain/langgraph";
import type {
  AgentState,
  UserParams,
  VideoGenerationParams,
  WorkflowSpec,
} from "../types/state.js";
import { runParseInputAgent } from "../agents/parseInputAgent.js";
import { runPlanAgent } from "../agents/planAgent.js";
import { runImageAgent } from "../agents/imageAgent.js";
import { runVideoAgent } from "../agents/videoAgent.js";
import { runScriptAgent } from "../agents/scriptAgent.js";
import { runRouterAgent } from "../agents/routerAgent.js";
import { runAudioAgent } from "../agents/audioAgent.js";
import { runIntentAgent } from "../agents/intentAgent.js";
import { runTextAgent } from "../agents/textAgent.js";
import { runReviewAgent } from "../agents/reviewAgent.js";

export function buildWorkflow(spec?: WorkflowSpec) {
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
      // 仅当入口显式传入时才存在；否则由 intent/router 生成最终的 workflowSpec
      workflowSpec: { value: (_: any, x: any) => x, default: () => spec },
      route: { value: (_: any, x: any) => x, default: () => undefined },
      artifacts: {
        value: (_: any, x: any) => (Array.isArray(x) ? x : []),
        default: () => [] as AgentState["artifacts"],
      },
      intent: { value: (_: any, x: any) => x, default: () => undefined },
      memory: {
        value: (_: any, x: any) => (Array.isArray(x) ? x : []),
        default: () => [] as AgentState["memory"],
      },
    },
  })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("intent_agent", runIntentAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("router_agent", runRouterAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("refine_params", runParseInputAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("plan_agent", runPlanAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("text_agent", runTextAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("image_agent", runImageAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("audio_agent", runAudioAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("video_agent", runVideoAgent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("review_agent", runReviewAgent as any)
    .addEdge(START, "intent_agent")
    .addEdge("intent_agent", "router_agent");

  // router -> next
  graph.addConditionalEdges(
    "router_agent",
    (s: AgentState) => {
      const needs = s.route?.needs;
      if (needs?.image || needs?.video) return "refine_params";
      if (needs?.text) return "text_agent";
      if (needs?.audio) return "audio_agent";
      return "review_agent";
    },
    // 第三个参数的 key 是 router_agent 的返回值，value 是下一个节点的名称
    {
      refine_params: "refine_params",
      text_agent: "text_agent",
      audio_agent: "audio_agent",
      review_agent: "review_agent",
    },
  );

  // refine_params -> plan -> image
  graph
    .addEdge("refine_params", "plan_agent")
    .addEdge("plan_agent", "image_agent");

  // text -> (audio?) -> review
  graph.addConditionalEdges(
    "text_agent",
    (s: AgentState) => (s.route?.needs.audio ? "audio_agent" : "review_agent"),
    { audio_agent: "audio_agent", review_agent: "review_agent" },
  );

  // image -> (audio? video? review)
  graph.addConditionalEdges(
    "image_agent",
    (s: AgentState) => {
      if (s.route?.needs.audio) return "audio_agent";
      if (s.route?.needs.video) return "video_agent";
      return "review_agent";
    },
    {
      audio_agent: "audio_agent",
      video_agent: "video_agent",
      review_agent: "review_agent",
    },
  );

  // audio -> (video?) -> review
  graph.addConditionalEdges(
    "audio_agent",
    (s: AgentState) => (s.route?.needs.video ? "video_agent" : "review_agent"),
    { video_agent: "video_agent", review_agent: "review_agent" },
  );

  // video -> review
  graph.addEdge("video_agent", "review_agent");

  // review -> end (或 reviewAgent 内部 goto intent_agent)
  graph.addEdge("review_agent", END);

  return graph.compile({
    checkpointer: new MemorySaver(),
    store: new InMemoryStore(),
  });
}

// 兼容旧入口：默认仍为 image+video
export function buildVideoWorkflow() {
  return buildWorkflow();
}
