import type { Provider } from "../config/profiles.js";
import { defaultAuxiliaryModel, getAgentModel } from "../config/model_selection.js";

// WebFetch 按当前端点选择模型；缺端点信息时保守继承主模型，显式配置优先。
export function resolveExtractModel(envOverride: string | undefined, provider: Provider, sessionModel: string, baseUrl?: string): string {
  const model = baseUrl ? defaultAuxiliaryModel({ model: sessionModel, provider, baseUrl }) : sessionModel;
  return getAgentModel(model, sessionModel, envOverride);
}
