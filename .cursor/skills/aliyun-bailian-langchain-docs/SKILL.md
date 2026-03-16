---
name: aliyun-bailian-langchain-docs
description: 查阅阿里云百炼大模型 API 文档（文字、音频、图片、视频多模态）以及 LangChain JS / LangGraph JS 框架文档。当用户询问阿里云百炼 API 用法、模型选型、多模态调用，或 LangChain/LangGraph 的节点、状态管理、工具调用等问题时使用本技能。
---

# 阿里云百炼 + LangChain/LangGraph 文档查阅

## 项目技术栈速览

本项目（`video-agent`）核心依赖：

- **`@langchain/community`** — 包含 `ChatAlibabaTongyi`，对接阿里云百炼文字模型
- **`@langchain/core`** — 消息类型、工具定义、Runnable 接口
- **`@langchain/langgraph`** — 多 Agent 工作流编排（StateGraph / StateSchema）
- **认证** — 环境变量 `ALIBABA_API_KEY`

---

## 一、查阅 LangChain / LangGraph 文档

优先使用 **`search_docs_by_lang_chain`** MCP 工具（`user-Docs by LangChain` 服务），它可全文检索 LangChain 和 LangGraph 官方文档。

### 常用查询示例

| 需求                          | 推荐查询词                                            |
| ----------------------------- | ----------------------------------------------------- |
| 状态图定义与节点添加          | `StateGraph addNode addEdge LangGraph JavaScript`     |
| 工具调用（Tool Calling）      | `tool calling bind_tools LangChain JavaScript`        |
| 消息类型（HumanMessage 等）   | `HumanMessage SystemMessage AIMessage LangChain core` |
| 流式输出                      | `streaming LangGraph LangChain JavaScript`            |
| 人工介入（Human-in-the-loop） | `interrupt human in the loop LangGraph`               |
| 持久化内存                    | `memory checkpointer LangGraph persistence`           |
| 条件边 / 路由                 | `addConditionalEdges conditional routing LangGraph`   |
| Agent 结构                    | `createAgent ReAct agent LangChain JavaScript`        |

### 官方文档入口（供引用）

- LangChain JS 概览：https://docs.langchain.com/oss/javascript/langchain/overview
- LangGraph JS 概览：https://docs.langchain.com/oss/javascript/langgraph/overview
- LangChain 完整索引：https://docs.langchain.com/llms.txt

---

## 二、查阅阿里云百炼 API 文档

百炼控制台：https://bailian.console.aliyun.com/

### 按模态分类的文档入口

#### 文字（Text / Chat）

- 模型列表：https://help.aliyun.com/zh/model-studio/models
- OpenAI 兼容接口：https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope
- 主要文字模型：`qwen-turbo`、`qwen-plus`、`qwen-max`、`qwen-long`

#### 图片（Image Generation & Vision）

- 文生图（Wanx）：https://help.aliyun.com/zh/model-studio/wanx-image-generation-api
- 图片理解（视觉）：https://help.aliyun.com/zh/model-studio/vision
- 主要图片模型：`wanx-v1`、`qwen-vl-max`、`qwen-vl-plus`

#### 音频（Audio / TTS / ASR）

- 语音合成（TTS / CosyVoice）：https://help.aliyun.com/zh/model-studio/cosyvoice-tts-api
- 语音识别（ASR / Paraformer）：https://help.aliyun.com/zh/model-studio/paraformer-asr-api
- 主要音频模型：`cosyvoice-v1`、`paraformer-realtime-v2`

#### 视频（Video Generation）

- 文生视频（Wan）：https://help.aliyun.com/zh/model-studio/wan-video-api
- 图生视频：https://help.aliyun.com/zh/model-studio/image-to-video
- 主要视频模型：`wan-x1`、`wan2.1-t2v-turbo`、`wan2.1-i2v-turbo`

### API 认证方式

所有百炼 API 使用同一个 API Key，通过 `ALIBABA_API_KEY` 环境变量注入：

```typescript
import { ChatAlibabaTongyi } from "@langchain/community/chat_models/alibaba_tongyi";

const model = new ChatAlibabaTongyi({
  alibabaApiKey: process.env.ALIBABA_API_KEY,
  model: "qwen-max", // 可选，指定模型
  temperature: 0.7,
});
```

对于图片、音频、视频等非文字模型，百炼提供 **OpenAI 兼容接口**，可直接使用 `@langchain/openai` 的 `ChatOpenAI` 并替换 `baseURL`：

```typescript
import { ChatOpenAI } from "@langchain/openai";

const visionModel = new ChatOpenAI({
  apiKey: process.env.ALIBABA_API_KEY,
  model: "qwen-vl-max",
  configuration: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
});
```

---

## 三、查询流程

1. **LangChain/LangGraph 问题** → 先调用 `search_docs_by_lang_chain` MCP 工具，再参考官方文档链接
2. **百炼 API 问题** → 按模态找到对应文档链接，用 WebFetch 工具获取详细内容
3. **集成问题（百炼 + LangChain）** → 同时查阅两方，优先找 `@langchain/community` 的相关适配器

## 四、额外参考

- 百炼免费额度查看：https://bailian.console.aliyun.com/#/model-usage/free-quota
- DashScope Python/JS SDK：https://help.aliyun.com/zh/model-studio/developer-reference/
- LangChain 社区集成（阿里通义）：https://js.langchain.com/docs/integrations/chat/alibaba_tongyi/
