import { describe, it, expect, vi, afterEach } from "vitest";
import { BUNDLED_AGENTS, GENERAL_PURPOSE_AGENT, EXPLORE_AGENT, PLAN_AGENT, VERIFY_AGENT } from "./bundled_agents.js";

describe("BUNDLED_AGENTS", () => {
  it("包含 4 个内置 agent", () => {
    expect(BUNDLED_AGENTS.length).toBe(4);
  });

  it("每个 agent 有 agentType 和 whenToUse", () => {
    for (const a of BUNDLED_AGENTS) {
      expect(a.agentType).toBeTruthy();
      expect(a.whenToUse).toBeTruthy();
      expect(a.source).toBe("built-in");
    }
  });
});

describe("EXPLORE_AGENT", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("disallowedTools 含 agent/edit/write", () => {
    expect(EXPLORE_AGENT.disallowedTools).toContain("Agent");
    expect(EXPLORE_AGENT.disallowedTools).toContain("Edit");
    expect(EXPLORE_AGENT.disallowedTools).toContain("Write");
  });
  it("omitClaudeMd = true", () => {
    expect(EXPLORE_AGENT.omitClaudeMd).toBe(true);
  });
  it("未配置模型时继承主模型，不猜测网关支持的模型名", () => {
    vi.stubEnv("DAO_EXPLORE_MODEL", "");
    expect(EXPLORE_AGENT.model).toBe("inherit");
  });
  it("显式模型配置保留完整网关 ID", () => {
    vi.stubEnv("DAO_EXPLORE_MODEL", " GLM-5.3-Flash-joybuilder ");
    expect(EXPLORE_AGENT.model).toBe("GLM-5.3-Flash-joybuilder");
  });
});

describe("PLAN_AGENT", () => {
  it("disallowedTools 含 agent/edit/write/Bash", () => {
    expect(PLAN_AGENT.disallowedTools).toContain("Agent");
    expect(PLAN_AGENT.disallowedTools).toContain("Bash");
  });
  it("omitClaudeMd = true", () => {
    expect(PLAN_AGENT.omitClaudeMd).toBe(true);
  });
});

describe("VERIFY_AGENT", () => {
  it("background = true", () => {
    expect(VERIFY_AGENT.background).toBe(true);
  });
  it("disallowedTools 含 agent/edit/write", () => {
    expect(VERIFY_AGENT.disallowedTools).toContain("Agent");
  });
  it("permissionMode = auto(子代理写操作走 AI 分类器,后台无人也能自答)", () => {
    expect(VERIFY_AGENT.permissionMode).toBe("auto");
  });
});

describe("GENERAL_PURPOSE_AGENT", () => {
  it("memory = project", () => {
    expect(GENERAL_PURPOSE_AGENT.memory).toBe("project");
  });
  it("tools = undefined(全部)", () => {
    expect(GENERAL_PURPOSE_AGENT.tools).toBeUndefined();
  });
  it("permissionMode = auto(子代理写操作走 AI 分类器,后台无人也能自答)", () => {
    expect(GENERAL_PURPOSE_AGENT.permissionMode).toBe("auto");
  });
});
