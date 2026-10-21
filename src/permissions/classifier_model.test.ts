import { describe, it, expect, vi } from "vitest";
import { createClassifierRunner, defaultClassifierModel } from "./classifier_model.js";
import { DEFAULTS } from "../config/profiles.js";

const context = { model: "GLM-5.3-joybuilder", provider: "deepseek" as const, baseUrl: "http://llm-gw.jd.local/v1", apiKey: "test" };
describe("classifier model selection and fallback", () => {
  it("非 DeepSeek 官方 provider 不请求 DeepSeek，inherit 显式配置跟随当前模型", async () => {
    const runner = createClassifierRunner(vi.fn());
    const run = vi.fn(async (model: string) => model);
    for (const provider of ["anthropic", "openai"] as const) {
      const c = { ...context, provider, ...DEFAULTS[provider] };
      expect(await runner(c, run)).toBe(c.model);
      expect(run.mock.calls.at(-1)).toEqual([c.model]);
    }
    expect(await runner({ ...context, provider: "zhipu", ...DEFAULTS.zhipu, override: " inherit " }, run)).toBe(DEFAULTS.zhipu.model);
  });
  it("custom gateway uses selected model directly, official GLM retains flash default", () => {
    expect(defaultClassifierModel(context)).toBe(context.model);
    expect(defaultClassifierModel({ ...context, provider: "zhipu", model: "glm-5.3", baseUrl: DEFAULTS.zhipu.baseUrl })).toBe("glm-5.3-flash");
  });
  it("successful fallback is reused, notices once including concurrent calls; settings isolate cache", async () => {
    const notice = vi.fn();
    const runner = createClassifierRunner(notice);
    const c = { ...context, override: "missing" };
    const run = vi.fn(async (model: string) => { if (model === "missing") throw new Error("模型不存在"); return false; });
    await Promise.all([runner(c, run), runner(c, run)]);
    expect(notice).toHaveBeenCalledTimes(1);
    run.mockClear();
    expect(await runner(c, run)).toBe(false); // 判定拒绝也是成功响应,不改变安全裁决
    expect(run.mock.calls).toEqual([[context.model]]);
    run.mockClear();
    await runner({ ...c, apiKey: "other-account" }, run);
    expect(run.mock.calls[0]).toEqual(["missing"]);
    run.mockClear();
    await runner({ ...c, override: "explicit-new-model" }, run);
    expect(run.mock.calls).toEqual([["explicit-new-model"]]);
  });
  it("rate limits do not trigger a model fallback", async () => {
    const runner = createClassifierRunner(vi.fn());
    const error = Object.assign(new Error("rate limit exceeded"), { status: 429 });
    const run = vi.fn(async () => { throw error; });
    await expect(runner({ ...context, override: "flash" }, run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("failed fallback is not cached or announced as successful", async () => {
    const notice = vi.fn();
    const runner = createClassifierRunner(notice);
    const run = vi.fn(async () => { throw new Error("offline"); });
    await expect(runner({ ...context, override: "missing" }, run)).rejects.toThrow("offline");
    expect(notice).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
