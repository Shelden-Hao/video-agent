import type { AgentState, RoutePlan, WorkflowSpec } from "../types/state.js";

function targetsFromUserParamsTargetFormat(
  targetFormat?: string,
): WorkflowSpec {
  const tf = (targetFormat ?? "").trim().toLowerCase();
  if (tf === "text") return { targets: ["text"] };
  if (tf === "image") return { targets: ["image"] };
  if (tf === "video") return { targets: ["video"] };
  // 兼容 voice
  if (tf === "audio" || tf === "voice") return { targets: ["audio"] };
  return { targets: ["image", "video"] };
}

/**
 * Router Agent：把 workflowSpec + userParams 映射为 route（路由决策结果）。
 *
 * 第一版目标：
 * - route 只用于观测与调试（graph 的实际节点拼装由 buildWorkflow(spec) 决定）
 * - 后续可扩展为：由 route 决定子图/并行/分支合流
 */
export async function runRouterAgent(state: AgentState): Promise<AgentState> {
  // 优先级：
  // 1) 入口显式 workflowSpec（用户用 --spec 指定）
  // 2) intentAgent 的粗粒度 targets（由 IntentAgent 生成）
  // 3) userParams.targetFormat（兼容旧 parseInput），后续会删掉
  const workflowSpec = state.workflowSpec
    ? state.workflowSpec
    : state.intent?.targets?.length
      ? { targets: state.intent.targets }
      : targetsFromUserParamsTargetFormat(state.userParams?.targetFormat);
  const targets = workflowSpec.targets ?? [];

  const wants = new Set(targets);
  const wantsVideo = wants.has("video");
  const wantsImage = wants.has("image");
  const wantsAudio = wants.has("audio");
  const wantsText = wants.has("text");

  const needsText = wantsAudio || wantsText;

  // videoMode=auto：尊重 userParams.useImageAsFirstFrame；t2v：不强制需要图片；i2v：强制需要图片
  const videoMode = workflowSpec.constraints?.videoMode ?? "auto";
  const useFirstFrame = state.userParams?.useImageAsFirstFrame ?? false;

  const generateImagesForVideo =
    workflowSpec.constraints?.generateImagesForVideo ??
    (videoMode === "i2v" || (videoMode === "auto" && useFirstFrame));

  const needsImageForVideo = wantsVideo && generateImagesForVideo;
  const needsImage = wantsImage || needsImageForVideo;
  const needsPlan = needsImage || wantsVideo;

  const route: RoutePlan = {
    targets,
    needs: {
      plan: needsPlan,
      text: needsText,
      image: needsImage,
      video: wantsVideo,
      audio: wantsAudio,
    },
  };

  console.log(
    `[Router] targets=${targets.join(",")} needs=${JSON.stringify(route.needs)}`,
  );

  return {
    ...state,
    workflowSpec,
    route,
  };
}
