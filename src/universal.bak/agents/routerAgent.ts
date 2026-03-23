import type { UniversalState, RoutePlan } from "../types.js";

export async function runUniversalRouter(state: UniversalState): Promise<UniversalState> {
  const targets = state.intent?.targets?.length ? state.intent.targets : (state.spec.targets ?? ["text"]);
  const route: RoutePlan = { targets };
  return { ...state, route };
}

