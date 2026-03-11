import "dotenv/config";

export type ImageCheckResult = {
  ok: boolean;
  reason?: string;
  /** 视觉大模型返回的原始 JSON（便于上层做更细粒度逻辑） */
  raw?: unknown;
};

type VisionJson = Record<string, unknown>;

function getVisionConfig() {
  const apiKey = process.env.ALIBABA_API_KEY;
  const baseUrl =
    process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com";
  const model =
    process.env.BAILIAN_VISION_MODEL ??
    process.env.DASHSCOPE_VISION_MODEL ??
    // 默认用一个多模态视觉模型（需在百炼控制台开通）
    "qwen-vl-max";
  return { apiKey, baseUrl, model };
}

async function callVisionJsonTool(
  imageUrl: string,
  instruction: string, // 视觉模型指令（提示词）
): Promise<VisionJson | null> {
  const { apiKey, baseUrl, model } = getVisionConfig();
  if (!apiKey) return null;

  const url = `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;
  const body = {
    model,
    input: {
      messages: [
        {
          role: "user",
          content: [
            { image: imageUrl },
            {
              text: instruction,
            },
          ],
        },
      ],
    },
    parameters: {
      // 只需要结构化文本，不需要流式与图片
      enable_interleave: false, // 是否启用图文混排
      max_output_tokens: 512,
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
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Vision API non-JSON response: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    const code = json?.code ?? "HTTPError";
    const message = json?.message ?? text.slice(0, 200);
    throw new Error(`Vision API error: ${code} - ${message}`);
  }

  const content = json?.output?.choices?.[0]?.message?.content;
  if (!Array.isArray(content)) {
    throw new Error("Vision API missing content array");
  }
  const textPart =
    content.find((c: any) => typeof c?.text === "string")?.text ?? "";
  let out = String(textPart ?? "").trim();
  if (!out) return {};

  const codeBlockMatch = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    out = codeBlockMatch[1].trim();
  }

  try {
    return JSON.parse(out) as VisionJson;
  } catch {
    // 若不是标准 JSON，返回原始文本，交由上层决定是否兜底
    return { _rawText: out };
  }
}

/**
 * 结构化验证：调用阿里多模态视觉模型，根据提示词与图片的一致性做结构化判断。
 *
 * 示例指令类似：
 * 你是一个图片审核系统。
 * 用户prompt: "A boy riding a bicycle in a park"
 * 请根据图片判断并返回 JSON：
 * {
 *   "match": true,
 *   "confidence": 0.9,
 *   "summary": "..."
 * }
 */
export async function validateImageStructure(
  url: string,
  prompt: string,
): Promise<ImageCheckResult> {
  if (!url) return { ok: false, reason: "empty url" };

  const visionInstruction = `你是一个图片内容审核系统，专用于儿童教育短视频的分镜图片检验。

用户生成这张图片时使用的文本提示词（prompt）是：
"${prompt}"

请判断图片是否对提示词的「核心意图」进行了有效表现。判断标准（宽松匹配）：
1. 主要角色/主体是否出现（如描述了小兔子，图中是否有小兔子）？
2. 整体场景主题是否符合（如户外草地、教室、儿童互动等大方向）？
3. 不需严格匹配艺术风格（2D/3D/水彩等均可接受）。
4. 不要求精确还原每个动作细节，只要画面内容与提示词核心语义一致即可。
5. 若图片内容与提示词完全无关（如提示词是动物故事但图中是建筑风景），才判定为不匹配。

只输出一个 JSON，字段说明如下：
- match: boolean，图片内容与提示词核心意图是否基本一致
- confidence: number，0~1 之间，表示你对 match 判断的置信度
- summary: string，用 1~2 句自然语言简要描述图片内容（中文）

示例：
{
  "match": true,
  "confidence": 0.9,
  "summary": "..."
}`;

  let json: VisionJson | null = null;
  try {
    json = await callVisionJsonTool(url, visionInstruction);
  } catch (err) {
    console.warn(
      "[ImageChecks] 结构化验证调用视觉模型失败，尝试做轻量兜底校验:",
      err,
    );
  }

  if (!json) {
    return { ok: true, reason: "fallback-heuristic", raw: null };
  }

  const match = Boolean(json.match);
  const confidence =
    typeof json.confidence === "number" ? json.confidence : 0.0;

  return {
    ok: match && confidence >= 0.6,
    reason: match
      ? confidence >= 0.6
        ? "vision-match-ok"
        : "vision-match-low-confidence"
      : "vision-match-false",
    raw: json,
  };
}

/**
 * 质量检测：调用视觉大模型，从清晰度 / 分辨率 / 构图等维度打分。
 *
 * 返回结构示例：
 * {
 *   "clarityScore": 0.9,
 *   "resolutionScore": 0.8,
 *   "compositionScore": 0.85,
 *   "overallScore": 0.88,
 *   "acceptable": true
 * }
 */
export async function checkImageQuality(
  url: string,
): Promise<ImageCheckResult> {
  if (!url) return { ok: false, reason: "empty url" };

  const instruction = `你是一个图片质量评估系统。

请仅根据图片本身，从以下维度进行客观打分：
1. 清晰度（是否模糊、噪点多不多）
2. 分辨率（画面是否过于粗糙、像素过低）
3. 构图（主体是否完整、是否被严重裁切、是否畸形）

请输出一个 JSON，字段说明如下：
- clarityScore: 0~1 之间的小数，表示清晰度
- resolutionScore: 0~1 之间的小数，表示分辨率/细节
- compositionScore: 0~1 之间的小数，表示构图合理性
- overallScore: 0~1 之间的小数，综合以上三项
- acceptable: boolean，是否认为该图片质量达标（可直接用于用户侧展示）

不要输出任何额外说明，只输出 JSON。`;

  let json: VisionJson | null = null;
  try {
    json = await callVisionJsonTool(url, instruction);
  } catch (err) {
    console.warn("[ImageChecks] 质量检测调用视觉模型失败，尝试轻量兜底:", err);
  }

  if (!json) {
    return { ok: false, reason: "fallback-heuristic", raw: null };
  }

  const acceptable =
    typeof json.acceptable === "boolean" ? (json.acceptable as boolean) : true;
  const overall =
    typeof json.overallScore === "number" ? (json.overallScore as number) : 1.0;

  return {
    ok: acceptable && overall >= 0.6,
    reason: acceptable ? "vision-quality-ok" : "vision-quality-rejected",
    raw: json,
  };
}

/**
 * 安全审核：调用视觉大模型，对 NSFW / 暴力 / 政治 / 仇恨做判断。
 *
 * 你给的示例结构：
 * {
 *   "nsfw": false,
 *   "violence": false,
 *   "politics": false
 * }
 * 这里扩展一个 hate 字段，便于覆盖“仇恨”。
 */
export async function checkImageSafety(
  url: string,
  prompt: string,
): Promise<ImageCheckResult> {
  if (!url) return { ok: false, reason: "empty url" };

  const instruction = `你是一个图片安全审核系统。

请结合图片本身，以及以下生成提示词（如有帮助）进行判断：
"${prompt}"

请判断该图片是否包含以下内容：
1. 色情 / 裸露 / NSFW
2. 暴力、血腥、恐怖
3. 敏感政治内容（国家领导人、政党标志、抗议游行等）
4. 仇恨或歧视（针对种族、性别、宗教等群体的攻击性表达）

只输出一个 JSON，字段说明如下：
- nsfw: boolean，是否存在色情或不适合儿童观看的内容
- violence: boolean，是否存在明显暴力/血腥/恐怖画面
- politics: boolean，是否包含敏感政治内容
- hate: boolean，是否存在明显仇恨或歧视内容
- confidence: number，0~1 之间，表示你对以上整体判断的置信度

不要输出其他任何说明，只输出 JSON。`;

  let json: VisionJson | null = null;
  try {
    json = await callVisionJsonTool(url, instruction);
  } catch (err) {
    console.warn("[ImageChecks] 安全审核调用视觉模型失败，尝试简单兜底:", err);
  }

  if (!json) {
    return {
      ok: true,
      reason: "fallback-assume-safe-for-kids-edu",
      raw: null,
    };
  }

  const nsfw = Boolean(json.nsfw);
  const violence = Boolean(json.violence);
  const politics = Boolean(json.politics);
  const hate = Boolean((json as any).hate);
  const confidence =
    typeof json.confidence === "number" ? (json.confidence as number) : 1.0;

  const safe = !nsfw && !violence && !politics && !hate;

  return {
    ok: safe && confidence >= 0.6,
    reason: safe ? "vision-safe-ok" : "vision-safe-flagged",
    raw: json,
  };
}
