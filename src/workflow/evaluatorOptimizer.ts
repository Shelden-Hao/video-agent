export type EvaluationResult = {
  accepted: boolean;
  feedback: string;
};

/**
 * 通用 Evaluator-Optimizer 执行器（生成→评估→反馈→重试）。
 *
 * 约定：
 * - generate(feedback) 负责把 feedback 注入到提示词/参数中（由调用方决定注入策略）
 * - evaluate(output) 返回 accepted + feedback（用于下一轮 generate）
 */
export async function evaluatorOptimizer<TOutput>(opts: {
  maxRetry: number;
  generate: (feedback: string) => Promise<TOutput>;
  evaluate: (output: TOutput) => Promise<EvaluationResult>;
  onAttempt?: (attempt: number, maxRetry: number) => void;
}): Promise<TOutput> {
  const { maxRetry, generate, evaluate, onAttempt } = opts;
  let lastFeedback = "";

  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    onAttempt?.(attempt, maxRetry);

    const output = await generate(lastFeedback);
    const ev = await evaluate(output);

    if (ev.accepted) return output;
    lastFeedback = ev.feedback ?? "";
  }

  throw new Error(
    `[EvaluatorOptimizer] exceeded maxRetry=${maxRetry}, lastFeedback=${lastFeedback}`,
  );
}

