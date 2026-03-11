import type { AgentState } from "../types/state.js";

// 占位实现：后续会调用阿里云百炼语音生成工具。
export async function runVoiceAgent(state: AgentState): Promise<AgentState> {
  if (!state.script) return state;

  // 目前只返回一个假的音频地址，方便前后端联调。
  const fakeAudioUrl = "https://example.com/audio.mp3";

  return {
    ...state,
    audio: fakeAudioUrl,
  };
}

