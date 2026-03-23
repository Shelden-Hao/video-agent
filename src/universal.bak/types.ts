export type TargetKind = "text" | "image" | "video" | "audio";

export type MemoryItem = {
  key: string;
  value: string;
  at: string;
};

export type IntentSpec = {
  targets: TargetKind[];
  primaryTarget: TargetKind;
  confidence: number; // 0~1
  missingSlots: string[];
  publicRationale: string;
};

export type Artifact = {
  id: string;
  kind: TargetKind;
  text?: string;
  uri?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  source?: { agent: string; provider?: string; model?: string };
};

export type ModelProvider = "bailian" | "openai" | "anthropic" | "google";

export type ModelConfig = {
  provider: ModelProvider;
  model: string;
  temperature?: number;
  region?: "china" | "singapore" | "us";
};

export type GuardrailsConfig = {
  /** 简单关键词黑名单（演示；后续可替换为更严格的 guardrails 组合） */
  bannedKeywords?: string[];
};

export type UniversalSpec = {
  targets?: TargetKind[];
  models: {
    intent: ModelConfig;
    text: ModelConfig;
    image?: ModelConfig;
    video?: ModelConfig;
    audio?: ModelConfig;
  };
  guardrails?: GuardrailsConfig;
};

export type RoutePlan = {
  targets: TargetKind[];
};

export type UniversalState = {
  input: string;
  intent?: IntentSpec;
  route?: RoutePlan;
  memory: MemoryItem[];
  artifacts: Artifact[];
  spec: UniversalSpec;
};

