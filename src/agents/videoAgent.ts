import type { AgentState } from "../types/state.js";

// 占位实现：后续会结合 Remotion + 视频生成模型。
export async function runVideoAgent(state: AgentState): Promise<AgentState> {
  if (!state.images.length || !state.audio) return state;

  const fakeVideoUrl = "https://example.com/video.mp4";

  return {
    ...state,
    video: fakeVideoUrl,
  };
}

