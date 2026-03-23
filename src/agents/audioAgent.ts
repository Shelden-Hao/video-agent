import "dotenv/config";
import type { AgentState, Artifact } from "../types/state.js";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { evaluatorOptimizer } from "../workflow/evaluatorOptimizer.js";

type TtsParams = {
  model: string;
  voice: string;
  format: "mp3" | "wav" | "pcm";
  sampleRate: number;
  volume: number;
  rate: number;
  pitch: number;
  enableSsml: boolean;
};

function nowIso() {
  return new Date().toISOString();
}

function ensureOutputsDir(): string {
  const dir = join(process.cwd(), "outputs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function checkTextSafetyHeuristic(text: string): { ok: boolean; reason?: string } {
  const lowered = text.toLowerCase();
  const banned = [
    "porn",
    "nude",
    "sex",
    "bloody",
    "kill",
    "terror",
    "suicide",
    "drugs",
    "nsfw",
  ];
  for (const w of banned) {
    if (lowered.includes(w)) return { ok: false, reason: `unsafe-keyword:${w}` };
  }
  return { ok: true };
}

function checkAudioFileQuality(filePath: string): { ok: boolean; reason?: string } {
  try {
    const st = statSync(filePath);
    if (st.size <= 1024) return { ok: false, reason: "audio-too-small" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `audio-stat-failed:${String((err as any)?.message ?? err)}` };
  }
}

/**
 * CosyVoice WebSocket API（run-task/continue-task/finish-task）生成音频文件。
 *
 * 文档参考（CosyVoice WebSocket API / Node.js 示例）：
 * - wss://dashscope.aliyuncs.com/api-ws/v1/inference/
 * - header.action: run-task / continue-task / finish-task
 * - payload.task_group: audio, payload.task: tts, payload.function: SpeechSynthesizer
 */
async function synthesizeTtsToFile(params: {
  apiKey: string;
  websocketUrl: string;
  tts: TtsParams;
  text: string;
  outputFilePath: string;
}): Promise<void> {
  const { apiKey, websocketUrl, tts, text, outputFilePath } = params;
  const taskId = randomUUID();

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(websocketUrl, {
      headers: {
        Authorization: `bearer ${apiKey}`,
        "X-DashScope-DataInspection": "enable",
      },
    });

    let taskStarted = false;
    let finished = false;
    const fileStream = createWriteStream(outputFilePath, { flags: "a" });

    const cleanup = (err?: unknown) => {
      if (!finished) finished = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      try {
        fileStream.end();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve();
    };

    ws.on("open", () => {
      const runTaskMessage = JSON.stringify({
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex",
        },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: tts.model,
          parameters: {
            text_type: "PlainText",
            voice: tts.voice,
            format: tts.format,
            sample_rate: tts.sampleRate,
            volume: tts.volume,
            rate: tts.rate,
            pitch: tts.pitch,
            enable_ssml: tts.enableSsml,
          },
          input: {},
        },
      });
      ws.send(runTaskMessage);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        fileStream.write(data as Buffer);
        return;
      }

      let message: any;
      try {
        message = JSON.parse(data.toString());
      } catch (err) {
        cleanup(err);
        return;
      }

      const evt = message?.header?.event;
      if (evt === "task-started") {
        taskStarted = true;
        const continueTaskMessage = JSON.stringify({
          header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
          payload: { input: { text } },
        });
        ws.send(continueTaskMessage);

        const finishTaskMessage = JSON.stringify({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        });
        ws.send(finishTaskMessage);
        return;
      }

      if (evt === "task-finished") {
        cleanup();
        return;
      }

      if (evt === "task-failed" || evt === "error") {
        const msg =
          message?.header?.error_message ??
          message?.payload?.message ??
          "Unknown TTS error";
        cleanup(new Error(`TTS task failed: ${msg}`));
        return;
      }
    });

    ws.on("error", (err) => cleanup(err));
    ws.on("close", () => {
      if (!finished) cleanup(new Error("TTS websocket closed before finished"));
    });
  });
}

export async function runAudioAgent(state: AgentState): Promise<AgentState> {
  if (state.route && state.route.needs.audio === false) return state;
  const apiKey = process.env.ALIBABA_API_KEY;
  if (!apiKey) throw new Error("Missing ALIBABA_API_KEY");

  const websocketUrl =
    process.env.DASHSCOPE_TTS_WS_URL ??
    "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";

  const tts: TtsParams = {
    model: state.workflowSpec?.constraints?.tts?.model ?? "cosyvoice-v3-flash",
    voice: state.workflowSpec?.constraints?.tts?.voice ?? "longanyang",
    format: state.workflowSpec?.constraints?.tts?.format ?? "mp3",
    sampleRate: state.workflowSpec?.constraints?.tts?.sampleRate ?? 22050,
    volume: state.workflowSpec?.constraints?.tts?.volume ?? 50,
    rate: state.workflowSpec?.constraints?.tts?.rate ?? 1,
    pitch: state.workflowSpec?.constraints?.tts?.pitch ?? 1,
    enableSsml: state.workflowSpec?.constraints?.tts?.enableSsml ?? false,
  };

  // 第一版：audio 直接基于 script（若无 script 则跳过）
  const text = (state.script ?? "").trim();
  if (!text) {
    console.warn("[AudioAgent] 无 script，跳过语音合成");
    return state;
  }

  const safety = checkTextSafetyHeuristic(text);
  if (!safety.ok) {
    throw new Error(`[AudioAgent] 文本安全校验未通过: ${safety.reason}`);
  }

  const outDir = ensureOutputsDir();
  const maxRetry = Number(process.env.AUDIO_MAX_RETRY ?? "2");

  const outputPath = await evaluatorOptimizer<string>({
    maxRetry,
    generate: async () => {
      const filename = `tts_${Date.now()}_${randomUUID().slice(0, 8)}.${tts.format}`;
      const p = join(outDir, filename);
      writeFileSync(p, Buffer.from([]));
      console.log(
        `[AudioAgent] 开始合成语音：model=${tts.model} voice=${tts.voice} format=${tts.format}`,
      );
      await synthesizeTtsToFile({
        apiKey,
        websocketUrl,
        tts,
        text,
        outputFilePath: p,
      });
      return p;
    },
    evaluate: async (p) => {
      const q = checkAudioFileQuality(p);
      return { accepted: q.ok, feedback: q.reason ?? "" };
    },
  });

  const artifact: Artifact = {
    id: randomUUID(),
    kind: "audio",
    uri: outputPath,
    mimeType:
      tts.format === "mp3"
        ? "audio/mpeg"
        : tts.format === "wav"
          ? "audio/wav"
          : "audio/pcm",
    metadata: { tts },
    source: { agent: "audioAgent", model: tts.model },
    createdAt: nowIso(),
  };

  return {
    ...state,
    audio: outputPath,
    artifacts: [...(state.artifacts ?? []), artifact],
  };
}

