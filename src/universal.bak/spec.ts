import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { UniversalSpec } from "./types.js";

export function defaultUniversalSpec(): UniversalSpec {
  return {
    targets: ["text"],
    models: {
      intent: { provider: "bailian", model: "qwen-plus", temperature: 0.2, region: "china" },
      text: { provider: "bailian", model: "qwen-plus", temperature: 0.7, region: "china" },
    },
    guardrails: {
      bannedKeywords: ["hack", "exploit", "malware"],
    },
  };
}

export async function loadUniversalSpecFromPath(specPath?: string): Promise<UniversalSpec> {
  if (!specPath) return defaultUniversalSpec();
  const abs = resolve(specPath);
  if (abs.endsWith(".ts") || abs.endsWith(".mts") || abs.endsWith(".js") || abs.endsWith(".mjs")) {
    // 允许 TS/JS 作为高级入口（在 tsx 运行时可直接 import TS）
    const mod = await import(pathToFileURL(abs).toString());
    const cfg = (mod?.default ?? mod) as UniversalSpec;
    return {
      ...defaultUniversalSpec(),
      ...cfg,
      models: { ...defaultUniversalSpec().models, ...(cfg.models ?? {}) },
    };
  }
  const raw = readFileSync(abs, "utf-8");
  const json = JSON.parse(raw) as UniversalSpec;
  return { ...defaultUniversalSpec(), ...json, models: { ...defaultUniversalSpec().models, ...(json.models ?? {}) } };
}

