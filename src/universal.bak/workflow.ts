import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import type { UniversalState, UniversalSpec } from "./types.js";
import { runUniversalIntent } from "./agents/intentAgent.js";
import { runUniversalClarify } from "./agents/clarifyAgent.js";
import { runUniversalRouter } from "./agents/routerAgent.js";
import { runUniversalText } from "./agents/textAgent.js";
import { runUniversalAudio, runUniversalImage, runUniversalVideo } from "./agents/stubMediaAgents.js";
import { runUniversalReview } from "./agents/reviewAgent.js";

export function buildUniversalWorkflow() {
  const graph = new StateGraph<UniversalState>({
    channels: {
      input: { value: (_: string, x: string) => x, default: () => "" },
      spec: { value: (_: any, x: any) => x, default: () => ({}) as UniversalSpec },
      intent: { value: (_: any, x: any) => x, default: () => undefined },
      route: { value: (_: any, x: any) => x, default: () => undefined },
      memory: { value: (_: any, x: any) => (Array.isArray(x) ? x : []), default: () => [] },
      artifacts: { value: (_: any, x: any) => (Array.isArray(x) ? x : []), default: () => [] },
    },
  })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("intent_node", runUniversalIntent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("clarify_node", runUniversalClarify as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("router_node", runUniversalRouter as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("dispatch_node", (async (s: UniversalState) => s) as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("text_node", runUniversalText as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("audio_node", runUniversalAudio as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("image_node", runUniversalImage as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("video_node", runUniversalVideo as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addNode("review_node", runUniversalReview as any)
    .addEdge(START, "intent_node")
    .addEdge("intent_node", "clarify_node")
    .addEdge("clarify_node", "router_node")
    .addEdge("router_node", "dispatch_node");

  // dispatch：按 route.targets 依次补齐 artifacts
  graph.addConditionalEdges(
    "dispatch_node",
    (s: UniversalState) => {
      const targets = s.route?.targets ?? [];
      const done = new Set(s.artifacts.map((a) => a.kind));
      for (const t of targets) {
        if (!done.has(t)) return t;
      }
      return "review";
    },
    {
      text: "text_node",
      audio: "audio_node",
      image: "image_node",
      video: "video_node",
      review: "review_node",
    },
  );

  graph.addEdge("text_node", "dispatch_node");
  graph.addEdge("audio_node", "dispatch_node");
  graph.addEdge("image_node", "dispatch_node");
  graph.addEdge("video_node", "dispatch_node");
  graph.addEdge("review_node", END);

  return graph.compile({ checkpointer: new MemorySaver() });
}

