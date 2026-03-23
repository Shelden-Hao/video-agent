import { randomUUID } from "node:crypto";
import type { UniversalState, TargetKind } from "../types.js";

function stubArtifact(kind: TargetKind, agent: string, state: UniversalState) {
  return {
    id: randomUUID(),
    kind,
    text: `（占位）${kind} 生成模块尚未接入：${agent}`,
    createdAt: new Date().toISOString(),
    source: { agent, provider: state.spec.models.intent.provider, model: state.spec.models.intent.model },
    metadata: { status: "not_implemented" },
  };
}

export async function runUniversalAudio(state: UniversalState): Promise<UniversalState> {
  return { ...state, artifacts: [...state.artifacts, stubArtifact("audio", "universal.audio", state)] };
}

export async function runUniversalImage(state: UniversalState): Promise<UniversalState> {
  return { ...state, artifacts: [...state.artifacts, stubArtifact("image", "universal.image", state)] };
}

export async function runUniversalVideo(state: UniversalState): Promise<UniversalState> {
  return { ...state, artifacts: [...state.artifacts, stubArtifact("video", "universal.video", state)] };
}

