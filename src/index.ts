import "dotenv/config";
import type { AgentState } from "./types/state.js";

async function main() {
  // process.argv[2]是传入的参数
  const topic = process.argv[2] ?? "";

  // 先不真正构建 LangGraph，避免在骨架阶段引入运行时错误。
  // 只构造一个符合设计的初始状态，确保后端可以稳定跑起来。
  const initialState: AgentState = {
    topic,
    plan: null,
    script: "",
    images: [],
    audio: "",
    video: "",
  };

  console.log("[video-agent] backend skeleton running with state:");
  console.log(initialState);
}

main().catch((err) => {
  console.error("video-agent run error:", err);
  process.exit(1);
});
