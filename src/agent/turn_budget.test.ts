import { afterEach, describe, expect, it, vi } from "vitest";
import { subagentMaxTurns } from "./turn_budget.js";

describe("subagent turn budget", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("defaults to 500 independently of the main-session budget", () => {
    vi.stubEnv("DAO_SUBAGENT_MAX_TURNS", "");
    vi.stubEnv("DAO_MAX_TURNS", "5");
    expect(subagentMaxTurns()).toBe(500);
  });
  it("honors call override, then definition, then environment", () => {
    vi.stubEnv("DAO_SUBAGENT_MAX_TURNS", "800");
    expect(subagentMaxTurns()).toBe(800);
    expect(subagentMaxTurns(undefined, 100)).toBe(100);
    expect(subagentMaxTurns(50, 100)).toBe(50);
  });
  it.each(["0", "-1", "NaN", "Infinity", "1.5", "800oops"])("rejects invalid budget %s", (value) => {
    vi.stubEnv("DAO_SUBAGENT_MAX_TURNS", value);
    expect(subagentMaxTurns()).toBe(500);
  });
});
