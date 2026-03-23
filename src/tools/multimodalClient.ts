import "dotenv/config";

export type MultimodalJson = Record<string, unknown>;

export type MultimodalContentItem =
  | { image: string }
  | { video: string }
  | { text: string };

export function getDashscopeConfig() {
  const apiKey = process.env.ALIBABA_API_KEY;
  const baseUrl = process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com";
  return { apiKey, baseUrl };
}

export async function callMultimodalJson(opts: {
  model: string;
  content: MultimodalContentItem[];
  maxOutputTokens?: number;
}): Promise<MultimodalJson | null> {
  const { apiKey, baseUrl } = getDashscopeConfig();
  if (!apiKey) return null;

  const url = `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;
  const body = {
    model: opts.model,
    input: {
      messages: [
        {
          role: "user",
          content: opts.content,
        },
      ],
    },
    parameters: {
      enable_interleave: false,
      max_output_tokens: opts.maxOutputTokens ?? 600,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `DashScope multimodal non-JSON response: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    const code = (json as any)?.code ?? "HTTPError";
    const message = (json as any)?.message ?? text.slice(0, 200);
    throw new Error(`DashScope multimodal error: ${code} - ${message}`);
  }

  const content = (json as any)?.output?.choices?.[0]?.message?.content;
  if (!Array.isArray(content)) {
    throw new Error("DashScope multimodal missing content array");
  }
  const textPart =
    content.find((c: any) => typeof c?.text === "string")?.text ?? "";
  let out = String(textPart ?? "").trim();
  if (!out) return {};

  const codeBlockMatch = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) out = codeBlockMatch[1].trim();

  try {
    return JSON.parse(out) as MultimodalJson;
  } catch {
    return { _rawText: out };
  }
}

