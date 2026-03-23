declare module "../agents/routerAgent.js" {
  import type { AgentState } from "./state.js";
  export function runRouterAgent(state: AgentState): Promise<AgentState>;
}

declare module "../agents/audioAgent.js" {
  import type { AgentState } from "./state.js";
  export function runAudioAgent(state: AgentState): Promise<AgentState>;
}

declare module "../agents/intentAgent.js" {
  import type { AgentState } from "./state.js";
  export function runIntentAgent(state: AgentState): Promise<AgentState>;
}

declare module "../agents/textAgent.js" {
  import type { AgentState } from "./state.js";
  export function runTextAgent(state: AgentState): Promise<AgentState>;
}

declare module "../agents/reviewAgent.js" {
  import type { AgentState } from "./state.js";
  export function runReviewAgent(state: AgentState): Promise<any>;
}

