import type { Provider } from "../config/profiles.js";
import { defaultAuxiliaryModel, getAgentModel } from "../config/model_selection.js";
import { isContextLengthError, isRateLimitError } from "../client/client.js";

interface ModelContext {
  model: string;
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  override?: string;
}

export function defaultClassifierModel(c: ModelContext): string {
  return defaultAuxiliaryModel(c);
}

/** 权限判定和 handoff 共用的会话级回退缓存;切账号/端点/模型/显式配置后独立选择。 */
export function createClassifierRunner(notice: (text: string) => void) {
  const fallbacks = new Set<string>();
  return async <T>(c: ModelContext, run: (model: string) => Promise<T>): Promise<T> => {
    const preferred = getAgentModel(defaultClassifierModel(c), c.model, c.override);
    const key = JSON.stringify([c.provider, c.baseUrl, c.apiKey, c.model, preferred]);
    const model = fallbacks.has(key) ? c.model : preferred;
    try {
      return await run(model);
    } catch (e) {
      if (model === c.model || isContextLengthError(e) || isRateLimitError(e)) throw e;
      const result = await run(c.model);
      // 只有回退请求成功才缓存/提示;并发回退也只提示一次。
      if (!fallbacks.has(key)) {
        fallbacks.add(key);
        notice(`\n[智能判定] 分类器模型 ${model} 不可用,本会话已改用主模型 ${c.model} 判定。\n`);
      }
      return result;
    }
  };
}
