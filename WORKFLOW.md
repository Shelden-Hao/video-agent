# Video Agent 工作流说明文档

> 基于 **LangGraph + 阿里云百炼（DashScope）** 构建的全自动 AI 视频创作流水线。  
> 用户输入一段自然语言描述，系统自动完成参数解析 → 计划生成 → 图片生成 → 视频生成，全程通过 JSON 结构传递数据，内置多维校验与自动重试机制。

---

## 目录

1. [整体架构](#1-整体架构)
2. [完整流程图](#2-完整流程图)
3. [核心数据结构](#3-核心数据结构)
4. [各阶段详解](#4-各阶段详解)
   - [Stage 0 — 入口](#stage-0--入口)
   - [Stage 1 — 参数解析（ParseInput）](#stage-1--参数解析-parseinput)
   - [Stage 2 — 计划生成（Plan）](#stage-2--计划生成-plan)
   - [Stage 3 — 图片生成（Image）](#stage-3--图片生成-image)
   - [Stage 4 — 视频生成（Video）](#stage-4--视频生成-video)
5. [校验机制说明](#5-校验机制说明)
6. [Evaluator-Optimizer 模式](#6-evaluator-optimizer-模式)
7. [环境变量配置](#7-环境变量配置)
8. [运行方式](#8-运行方式)
9. [目录结构](#9-目录结构)
10. [常见问题](#10-常见问题)

---

## 1. 整体架构

```
用户输入（自然语言）
        │
        ▼
┌─────────────────────────────────────────────────────┐
│                  LangGraph StateGraph                │
│                                                     │
│  parse_input → plan_agent → image_agent → video_agent │
│                                                     │
│  全程通过 AgentState（JSON 对象）传递数据             │
└─────────────────────────────────────────────────────┘
        │
        ▼
  结构化输出（图片 URL[] + 视频 URL[]）
```

**技术栈：**

| 层级 | 技术 |
|------|------|
| 工作流框架 | `@langchain/langgraph` — StateGraph + Functional API（task / entrypoint） |
| LLM 调用 | `@langchain/community` — ChatAlibabaTongyi（阿里云百炼 qwen 系列） |
| 图片生成 | 阿里云百炼 Z-Image（z-image-turbo） |
| 视频生成 | 阿里云百炼 Wan（wan2.5-t2v-preview / wanx2.1-i2v-turbo） |
| 视觉校验 | 阿里云百炼 Qwen-VL（qwen-vl-max） |
| 运行时 | Node.js + TypeScript（ESM） |

---

## 2. 完整流程图

```
用户输入: "一只橘色虎斑猫在花园里玩耍，2D卡通风格，欢快活泼"
│
├── Stage 1: parse_input
│   ├── LLM 解析自然语言 → UserParams（JSON）
│   └── 输出: topic, style, mood, videoSize, imageSize, sceneCount, ...
│
├── Stage 2: plan_agent
│   ├── LLM 按 UserParams 生成分步计划 → VideoPlan（JSON）
│   └── 输出: title, steps[{teachingPoint, sceneDescription, durationSeconds}]
│
├── Stage 3: image_agent（Evaluator-Optimizer 模式）
│   ├── 3.1 generateCharacterAnchorTask
│   │   └── LLM 生成角色锚点（主角外观描述 + 画风关键词）
│   ├── 3.2 generateImagePromptsTask
│   │   └── LLM 生成每步图片提示词，注入角色锚点
│   └── 3.3 for each step（串行）:
│       ├── imageEvaluatorOptimizer（最多 MAX_RETRY 次）
│       │   ├── generateImageTask → 调用图片生成 API
│       │   └── evaluateImageTask（并行四项校验）
│       │       ├── ✅ validateImageStructure（语义一致性）
│       │       ├── ✅ checkImageQuality（清晰度/构图）
│       │       ├── ✅ checkImageSafety（NSFW/暴力/政治/仇恨）
│       │       └── ✅ checkCrossImageConsistency（主角外观跨图一致性，第2+张）
│       └── 第1张图通过后锁定为「参考基准」，供后续跨图对比
│
└── Stage 4: video_agent（Evaluator-Optimizer 模式）
    ├── 4.1 extractImageStyleTask
    │   └── 视觉模型分析第1张图，提取风格描述（artStyle, mainCharacter, colorPalette）
    ├── 4.2 generateVideoParamsTask
    │   ├── LLM 生成每步视频参数（含图片风格约束）
    │   └── 若配置 BAILIAN_I2V_MODEL，注入 firstFrameUrl（i2v 模式）
    └── 4.3 for each step（串行，最多 VIDEO_MAX_STEPS 步）:
        └── videoEvaluatorOptimizer（最多 MAX_RETRY 次）
            ├── generateVideoTask
            │   ├── i2v 模式: 提交 img_url 首帧 + prompt → 轮询直到完成
            │   └── t2v 模式: 仅提交 prompt → 轮询直到完成（含风格约束）
            └── evaluateVideoTask（并行三项校验）
                ├── ✅ checkVideoConsistency（语义一致性 + 风格匹配）
                ├── ✅ checkVideoSafety（NSFW/暴力/政治/仇恨）
                └── ✅ checkVideoQuality（清晰度/流畅度/构图）

最终输出: { images: string[], videos: string[], userParams, plan }
```

---

## 3. 核心数据结构

整个工作流通过 `AgentState` 传递所有数据，每个 Agent 接收完整状态、返回更新后的状态。

### AgentState（工作流全局状态）

```typescript
type AgentState = {
  topic: string;            // 用户原始输入（入口）
  userParams: UserParams | null;  // Stage 1 解析结果
  plan: VideoPlan | null;         // Stage 2 计划
  script: string;           // 可选旁白（预留扩展）
  images: string[];         // Stage 3 输出：图片 URL 数组
  audio: string;            // 可选音频（预留扩展）
  video: string;            // Stage 4 输出：第一条视频 URL（兼容字段）
  videoParams?: VideoGenerationParams[];  // Stage 4 结构化参数
  videos?: string[];        // Stage 4 输出：视频 URL 数组
}
```

### UserParams（Stage 1 解析结果）

```typescript
type UserParams = {
  rawPrompt: string;         // 用户原始输入
  topic: string;             // 核心主题（简洁版）
  style: string;             // 画面风格，如 "2D卡通"、"写实"
  targetAudience: string;    // 目标受众，如 "3-6岁儿童"
  mood: string;              // 情绪氛围，如 "欢快活泼"
  videoDuration: number;     // 视频总时长（秒）
  videoSize: string;         // 视频分辨率，如 "832*480"
  imageSize: string;         // 图片尺寸，如 "1024*1024"
  sceneCount: number;        // 场景数量（1-5）
  useImageAsFirstFrame: boolean;  // 是否用图片作为视频首帧
  extraRequirements: string; // 额外要求
}
```

### VideoPlan（Stage 2 计划）

```typescript
type VideoPlan = {
  title: string;
  targetAge: string;
  totalDurationSeconds: number;
  summary: string;
  steps: PlanStep[];         // 与 images[] / videos[] 索引一一对应
}

type PlanStep = {
  step: number;
  teachingPoint: string;     // 本步要点（一句话）
  sceneDescription: string;  // 画面描述（供图片/视频生成）
  durationSeconds: number;   // 本步建议时长
}
```

### VideoGenerationParams（Stage 4 结构化参数）

```typescript
type VideoGenerationParams = {
  step: number;
  prompt: string;            // 优化后的视频生成提示词（含图片风格约束）
  negativePrompt: string;    // 反向提示词
  size: string;              // 分辨率（来自 userParams.videoSize）
  duration: number;          // 视频时长（秒，5-10）
  promptExtend: boolean;     // 是否启用 AI 提示词改写
  firstFrameUrl?: string;    // 图片首帧 URL（i2v 模式时注入）
}
```

---

## 4. 各阶段详解

### Stage 0 — 入口

**文件：** `src/index.ts`

用户通过命令行参数传入创作需求，系统初始化 `AgentState` 并启动 LangGraph 工作流。

```typescript
// 使用 import.meta.url 定位 .env，无论从哪个目录运行都能加载
config({ path: join(__dirname, "../.env") });

const initialState: AgentState = {
  topic: "用户输入的 prompt",
  userParams: null,
  plan: null,
  // ...
};

const result = await workflow.invoke(initialState);
```

> **设计说明：** dotenv 使用绝对路径加载，解决从 `src/` 子目录运行时找不到 `.env` 的问题。

---

### Stage 1 — 参数解析（ParseInput）

**文件：** `src/agents/parseInputAgent.ts` + `src/prompts/parseInputPrompt.ts`

**输入：** `state.topic`（用户自然语言）  
**输出：** `state.userParams`（UserParams JSON）

#### 工作原理

1. 调用 LLM（qwen 系列）解析用户自然语言
2. 提取结构化参数：主题、风格、受众、情绪、时长、分辨率、场景数等
3. 对每个字段做类型校验和范围约束，失败时回退默认值

#### 解析推断规则示例

| 用户输入关键词 | 推断结果 |
|---|---|
| "儿童"、"宝宝"、"小朋友" | `targetAudience: "3-6岁儿童"`, `style: "3D卡通"` |
| "竖屏"、"抖音"、"短视频" | `videoSize: "480*832"`, `imageSize: "720*1280"` |
| "30秒" | `videoDuration: 30` |
| "3个场景" | `sceneCount: 3` |
| "不用首帧" | `useImageAsFirstFrame: false` |

#### 示例输出

```json
{
  "rawPrompt": "一只橘色虎斑猫在花园里玩耍，2D卡通风格，欢快活泼",
  "topic": "橘色虎斑猫在花园里玩耍",
  "style": "2D卡通",
  "targetAudience": "成人通用",
  "mood": "欢快活泼",
  "videoDuration": 10,
  "videoSize": "832*480",
  "imageSize": "1024*1024",
  "sceneCount": 2,
  "useImageAsFirstFrame": true,
  "extraRequirements": ""
}
```

---

### Stage 2 — 计划生成（Plan）

**文件：** `src/agents/planAgent.ts` + `src/prompts/plannerPrompt.ts`

**输入：** `state.userParams`  
**输出：** `state.plan`（VideoPlan JSON）

#### 工作原理

1. 使用 `userParams` 构造结构化提示词（包含风格、受众、情绪、时长、场景数等约束）
2. 调用 LLM 生成分步计划
3. 步骤数严格等于 `userParams.sceneCount`，总时长等于 `userParams.videoDuration`
4. 每步包含可执行的画面描述（`sceneDescription`），直接供后续图片/视频生成使用

#### 示例输出

```json
{
  "title": "橘猫花园嬉戏",
  "targetAge": "成人通用",
  "totalDurationSeconds": 10,
  "summary": "橘色虎斑猫在阳光花园中的欢快玩耍时光",
  "steps": [
    {
      "step": 1,
      "teachingPoint": "橘色虎斑猫在花园中跳跃玩耍",
      "sceneDescription": "一只橘色虎斑猫在充满花朵的花园中欢快地跳跃，周围有鲜艳的花朵和阳光",
      "durationSeconds": 5
    },
    {
      "step": 2,
      "teachingPoint": "橘色虎斑猫追逐蝴蝶",
      "sceneDescription": "橘色虎斑猫在花园中追逐一只飞舞的蝴蝶，动作敏捷，表情充满兴奋",
      "durationSeconds": 5
    }
  ]
}
```

---

### Stage 3 — 图片生成（Image）

**文件：** `src/agents/imageAgent.ts` + `src/prompts/imagePrompt.ts` + `src/tools/imageChecks.ts`

**输入：** `state.plan` + `state.userParams`  
**输出：** `state.images`（图片 URL 数组，与 steps 一一对应）

#### 工作原理（三步流程）

```
Step 3.1  generateCharacterAnchorTask
          └─ LLM 提前生成主角外观锚点（character anchor）
             防止多张图片主角长相不同

Step 3.2  generateImagePromptsTask
          └─ LLM 生成每步图片提示词
             └─ injectAnchorIntoPrompt：将锚点注入每条提示词开头
                格式: [STYLE: ...] [CHARACTER: ...] [COLORS: ...]; <原提示词>

Step 3.3  for each prompt（串行）:
          imageEvaluatorOptimizer（最多 IMAGE_MAX_RETRY 次）
          ├─ generateImageTask → 调用 DashScope 图片生成 API（同步）
          └─ evaluateImageTask（并行四项，qwen-vl-max 视觉模型）
             ├─ 语义一致性：图片是否符合提示词核心意图
             ├─ 质量检测：清晰度 / 构图 / 分辨率评分 ≥ 0.6
             ├─ 安全审核：NSFW / 暴力 / 政治 / 仇恨均为 false
             └─ 跨图一致性（第2+张）：与第1张图对比主角外观和画风
                → 第1张图通过后自动锁定为「参考基准」
```

#### 角色锚点（Character Anchor）示例

```json
{
  "characterDescription": "orange tabby kitten with distinct tiger stripes, round big amber eyes, white belly and paws, fluffy tail",
  "styleKeywords": "flat 2D cartoon, clean vector lines, cel-shading, bright colors",
  "backgroundStyle": "cheerful garden with flowers and sunlight, bright green grass",
  "colorPalette": "warm orange, white, green, yellow, blue sky"
}
```

注入后的提示词示例：
```
[STYLE: flat 2D cartoon, clean vector lines] [CHARACTER: orange tabby kitten with distinct tiger stripes, round big amber eyes] [COLORS: warm orange, white, green]; 
orange tabby kitten bouncing joyfully in a sunlit garden, surrounded by colorful flowers, 2D cartoon style, medium shot
```

#### 图片 API 调用

- **端点：** `POST /api/v1/services/aigc/multimodal-generation/generation`
- **模型：** `z-image-turbo`（由 `BAILIAN_IMAGE_MODEL` 指定）
- **调用方式：** 同步（直接返回图片 URL）
- **内置限流重试：** 遇到 `Throttling` 错误时指数退避（初始 2s，最多 5 次）

---

### Stage 4 — 视频生成（Video）

**文件：** `src/agents/videoAgent.ts` + `src/prompts/videoPrompt.ts` + `src/tools/videoChecks.ts`

**输入：** `state.plan` + `state.userParams` + `state.images`  
**输出：** `state.videos`（视频 URL 数组）、`state.videoParams`（结构化参数）

#### 工作原理（三步流程）

```
Step 4.1  extractImageStyleTask
          └─ 视觉模型（qwen-vl-max）分析第1张图片，提取：
             artStyle, mainCharacter, colorPalette, atmosphere
             → 作为「最高优先级」风格约束注入视频提示词，确保视频与图片风格一致

Step 4.2  generateVideoParamsTask
          ├─ 将图片风格描述注入 buildVideoStructureUserMessage
          ├─ LLM 生成每步视频参数（prompt 开头包含图片风格关键词）
          └─ i2v 模式判断：
             ├─ 若 BAILIAN_I2V_MODEL 已配置 && useImageAsFirstFrame=true
             │  → 注入 firstFrameUrl，切换 i2v 模型
             └─ 否则：t2v 模式（风格已通过 prompt 约束）

Step 4.3  for each step（串行，最多 VIDEO_MAX_STEPS 步）:
          videoEvaluatorOptimizer（最多 VIDEO_MAX_RETRY 次）
          ├─ generateVideoTask
          │   ├─ submitVideoTask → 提交异步任务，返回 task_id
          │   │   ├─ i2v 模式: model=i2vModel, input.img_url=firstFrameUrl
          │   │   └─ t2v 模式: model=t2vModel（不传 img_url）
          │   └─ pollVideoTask → 每 15s 查询一次，最长等待 15 分钟
          └─ evaluateVideoTask（并行三项，视频输入）
             ├─ 语义一致性（含风格约束检验）
             ├─ 安全审核
             └─ 质量检测（清晰度/流畅度 overallScore ≥ 0.55）
```

#### 视频 API 调用

- **端点：** `POST /api/v1/services/aigc/video-generation/video-synthesis`
- **调用方式：** 异步（Header: `X-DashScope-Async: enable`）
- **轮询间隔：** 15s，最长等待 15 分钟
- **t2v 模型：** `wan2.5-t2v-preview`（支持 5s/10s，480P/720P）
- **i2v 模型：** `wanx2.1-i2v-turbo`（需额外开通，配置 `BAILIAN_I2V_MODEL`）
- **内置限流重试：** 遇到 `Throttling/RateQuota` 时指数退避（初始 3s，最多 4 次）

#### t2v vs i2v 模式对比

| 模式 | 触发条件 | 优点 | 缺点 |
|------|---------|------|------|
| **t2v**（文生视频） | 默认 / 未配置 i2v 模型 | 无需额外开通，稳定 | 风格靠 prompt 约束，可能有偏差 |
| **i2v**（图生视频） | 配置 `BAILIAN_I2V_MODEL` + `useImageAsFirstFrame=true` | 首帧严格与图片一致，风格可控 | 需单独开通 i2v 权限 |

---

## 5. 校验机制说明

所有校验均调用 `qwen-vl-max` 视觉大模型，返回结构化 JSON 判断结果。

### 图片校验（4项）

| 校验项 | 通过阈值 | 失败时动作 |
|--------|---------|----------|
| **语义一致性** | `match=true && confidence ≥ 0.6` | 携带原因重新生成 |
| **质量检测** | `acceptable=true && overallScore ≥ 0.6` | 携带原因重新生成 |
| **安全审核** | nsfw/violence/politics/hate 全为 false | 携带原因重新生成 |
| **跨图主角一致性** | `consistent=true && confidence ≥ 0.55` | 携带原因重新生成 |

> 跨图一致性仅在第 2 张及之后的图片执行，第 1 张图通过校验后作为参考基准。

### 视频校验（3项）

| 校验项 | 通过阈值 | 说明 |
|--------|---------|------|
| **语义一致性** | `match=true && confidence ≥ 0.6` | 含风格约束检验（传入 userParams） |
| **安全审核** | 全为 false | 与图片安全标准一致 |
| **质量检测** | `acceptable=true && overallScore ≥ 0.55` | 视频阈值比图片略宽松 |

### 校验失败自动修复

当校验不通过时，失败原因会被拼接为 `feedback` 字符串，在下次重新生成时前置注入到提示词中：

```
[修正要求：主角不一致: cross-image-inconsistent: 第2张图为灰色猫，与参考图橘色虎斑猫不符]
[STYLE: flat 2D cartoon] [CHARACTER: orange tabby kitten...]; <原提示词>
```

---

## 6. Evaluator-Optimizer 模式

图片和视频的生成均遵循 [LangGraph Evaluator-Optimizer](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents#evaluator-optimizer) 设计模式：

```
                    ┌─────────────────────┐
                    │    Generator        │
                    │  (生成图片/视频)      │
                    └──────────┬──────────┘
                               │ URL
                               ▼
                    ┌─────────────────────┐
                    │    Evaluator        │
                    │  (并行多项校验)       │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              │ accepted=true                    │ accepted=false
              ▼                                  ▼
          ✅ 返回 URL                     记录 feedback
                                          attempt < maxRetry?
                                               │
                              ┌────────────────┴────────────┐
                              │ yes                          │ no
                              ▼                              ▼
                    重新生成（携带 feedback）         ❌ 抛出错误
```

**实现方式：** 使用 LangGraph Functional API 的 `entrypoint` + `task` 组合：
- `imageEvaluatorOptimizer` / `videoEvaluatorOptimizer`：`entrypoint`，管理重试循环
- `generateImageTask` / `generateVideoTask`：`task`，执行实际 API 调用
- `evaluateImageTask` / `evaluateVideoTask`：`task`，并行执行多项校验

---

## 7. 环境变量配置

文件位置：项目根目录 `.env`

### 必填项

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `ALIBABA_API_KEY` | 阿里云百炼 API Key | `sk-xxxxxxxx` |
| `DASHSCOPE_BASE_URL` | DashScope 原生 API Base URL | `https://dashscope.aliyuncs.com` |
| `BAILIAN_IMAGE_MODEL` | 图片生成模型 | `z-image-turbo` |
| `BAILIAN_VIDEO_MODEL` | 视频生成模型（t2v） | `wan2.5-t2v-preview` |
| `BAILIAN_VISION_MODEL` | 视觉校验模型 | `qwen-vl-max` |

### 可选项

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `BAILIAN_I2V_MODEL` | 图生视频模型（i2v），不配置则 t2v 模式 | 未设置 |
| `VIDEO_MAX_RETRY` | 每步视频最大重试次数 | `3` |
| `VIDEO_MAX_STEPS` | 最多生成视频步骤数（节约配额） | `1` |
| `IMAGE_MAX_RETRY` | 每张图片最大重试次数 | `3` |

### 模型选型参考

**视频模型（t2v）：**
- `wan2.5-t2v-preview` — 推荐，支持 5s/10s，480P/720P/1080P，支持自动配音
- `wanx2.1-t2v-turbo` — 免费，但仅支持无声视频，固定5秒

**视频模型（i2v，首帧图片）：**
- `wanx2.1-i2v-turbo` — 图生视频，需在百炼控制台单独开通

---

## 8. 运行方式

### 前置要求

```bash
# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入 ALIBABA_API_KEY 等必填项
```

### 运行完整工作流

```bash
# 从任意目录运行（自动定位 .env）
npx tsx src/index.ts "你的视频创作需求"

# 示例
npx tsx src/index.ts "一只可爱的橘色虎斑猫在花园里玩耍，2D卡通风格，欢快活泼"
npx tsx src/index.ts "宇宙飞船穿越星云，赛博朋克风格，震撼壮观，竖屏"
npx tsx src/index.ts "小朋友学认识数字1到5，3D卡通，温馨活泼，3个场景"
```

### 单步测试

```bash
# 测试 Plan Agent
pnpm run test:plan "你的主题"

# 测试 Image Agent
pnpm run test:image

# 测试 Video Agent（耗时较长）
pnpm run test:video
```

### 构建

```bash
pnpm run build    # TypeScript 编译到 dist/
pnpm run start    # 运行编译后的版本
pnpm run dev      # 开发模式（tsx watch，自动重启）
```

---

## 9. 目录结构

```
video-agent/
├── .env                          # 环境变量（API Keys、模型名称）
├── package.json
├── tsconfig.json
│
└── src/
    ├── index.ts                  # 🚪 入口：接收用户输入，启动工作流
    │
    ├── types/
    │   └── state.ts              # 📦 核心类型定义（AgentState、UserParams、VideoPlan 等）
    │
    ├── workflow/
    │   └── graph.ts              # 🔗 LangGraph StateGraph 工作流定义
    │
    ├── agents/
    │   ├── parseInputAgent.ts    # 🔍 Stage 1: 自然语言 → UserParams
    │   ├── planAgent.ts          # 📋 Stage 2: UserParams → VideoPlan
    │   ├── imageAgent.ts         # 🖼️ Stage 3: 图片生成（角色锚点 + Evaluator-Optimizer）
    │   ├── videoAgent.ts         # 🎬 Stage 4: 视频生成（图片风格提取 + Evaluator-Optimizer）
    │   └── scriptAgent.ts        # 📝 可选: 旁白脚本生成（预留扩展）
    │
    ├── prompts/
    │   ├── parseInputPrompt.ts   # Stage 1 系统提示词
    │   ├── plannerPrompt.ts      # Stage 2 系统提示词
    │   ├── imagePrompt.ts        # Stage 3 系统提示词（含角色锚点生成提示）
    │   └── videoPrompt.ts        # Stage 4 系统提示词（含图片风格约束注入）
    │
    ├── tools/
    │   ├── imageChecks.ts        # 图片校验工具（结构/质量/安全/跨图一致性/风格提取）
    │   └── videoChecks.ts        # 视频校验工具（语义/安全/质量）
    │
    └── test/
        ├── test-plan.ts          # Planner 单步测试
        ├── test-script.ts        # Script 单步测试
        ├── test-image.ts         # Image Agent 单步测试
        └── test-video.ts         # Video Agent 单步测试
```

---

## 10. 常见问题

### Q: 运行报错 "Ali API key not found"

**原因：** dotenv 没有正确加载 `.env` 文件（常见于从 `src/` 子目录运行）。  
**解决：** 项目已处理此问题，确保使用以下方式运行：
```bash
npx tsx src/index.ts "..."  # ✅ 从项目根目录运行
# 或
cd src && npx tsx index.ts "..."  # ✅ 从 src/ 目录运行也可
```

### Q: 视频风格与图片不一致（如图片2D卡通但视频3D写实）

**原因：** 未配置 `BAILIAN_I2V_MODEL` 时，系统使用 t2v 模式。  
**解决方案1（推荐）：** 配置 i2v 模型：
```env
BAILIAN_I2V_MODEL=wanx2.1-i2v-turbo
```
**解决方案2：** 系统已内置图片风格提取机制，会将图片的 `artStyle`、`mainCharacter` 等约束注入视频 prompt，通常能确保风格基本一致。

### Q: 两张图片的主角长相不一样

**原因（已修复）：** 图片独立生成时缺乏一致性约束。  
**现有机制：**
1. 生成图片前 LLM 会生成「角色锚点」（精确的主角外观描述），注入每条提示词
2. 第2张及之后的图片会与第1张进行「跨图主角一致性」视觉对比
3. 不一致时自动携带原因重新生成

### Q: 视频生成超时

**原因：** 视频生成通常需要 1-5 分钟，网络异常时可能超时。  
**系统行为：** 默认最长等待 15 分钟，超时后抛出错误并触发重试。

### Q: 如何生成多段视频（多个步骤）

默认 `VIDEO_MAX_STEPS=1` 仅生成第 1 步以节约配额。修改方式：
```env
# .env
VIDEO_MAX_STEPS=3  # 生成前3步的视频
```
或与 `sceneCount` 匹配，生成所有步骤：
```env
VIDEO_MAX_STEPS=99  # 生成全部步骤
```

### Q: 校验始终不通过导致无限重试

**系统限制：** 每步最多重试 `VIDEO_MAX_RETRY`（默认3）次，超出后抛出错误并终止流程。  
**调整方式：**
```env
VIDEO_MAX_RETRY=5   # 增加重试次数
IMAGE_MAX_RETRY=5
```

---

*本文档对应代码版本：video-agent v1.0.0*
