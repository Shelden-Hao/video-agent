import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../.env") });

import { buildWorkflow } from "../workflow/graph.js";
import type { AgentState, WorkflowSpec } from "../types/state.js";

async function main() {
  const prompt = process.argv[2] ?? "用儿童友好的语气讲一个关于小猫学数数的故事，30秒";
  const spec: WorkflowSpec = { targets: ["audio"] };

  const workflow = buildWorkflow(spec);
  const initialState: AgentState = {
    topic: prompt,
    userParams: null,
    plan: null,
    script: "",
    images: [],
    audio: "",
    video: "",
    videoParams: [],
    videos: [],
    artifacts: [],
    memory: [],
    workflowSpec: spec,
  };

  const result = (await (workflow as any).invoke(initialState)) as AgentState;
  console.log(JSON.stringify({ audio: result.audio, artifacts: result.artifacts }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

