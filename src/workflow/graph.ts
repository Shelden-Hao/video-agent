import { StateGraph, START, END } from "@langchain/langgraph";
import type { AgentState, VideoGenerationParams } from "../types/state.js";
import { runPlanAgent } from "../agents/planAgent.js";
import { runScriptAgent } from "../agents/scriptAgent.js";
import { runImageAgent } from "../agents/imageAgent.js";
import { runVideoAgent } from "../agents/videoAgent.js";

export function buildVideoWorkflow() {
  const graph = new StateGraph<AgentState>({
    channels: {
      topic: { value: (x) => x, default: () => "" },
      plan: { value: (x) => x, default: () => null },
      script: { value: (x) => x, default: () => "" },
      images: { value: (x) => x, default: () => [] as string[] },
      audio: { value: (x) => x, default: () => "" },
      video: { value: (x) => x, default: () => "" },
      videoParams: {
        value: (x) => x,
        default: () => [] as VideoGenerationParams[],
      },
      videos: { value: (x) => x, default: () => [] as string[] },
    },
  })
    .addNode("plan_agent", runPlanAgent)
    .addNode("script_agent", runScriptAgent)
    .addNode("image_agent", runImageAgent)
    .addNode("video_agent", runVideoAgent)
    .addEdge(START, "plan_agent")
    .addEdge("plan_agent", "script_agent")
    .addEdge("script_agent", "image_agent")
    .addEdge("image_agent", "video_agent")
    .addEdge("video_agent", END);

  return graph.compile();
}
