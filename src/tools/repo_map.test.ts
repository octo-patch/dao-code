import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { repoMapTool } from "./repo_map.js";
import { resetRepoMapCacheForTest } from "../repomap/index.js";
import type { ToolContext } from "./types.js";

let root: string;

beforeAll(async () => {
  resetRepoMapCacheForTest();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "repomap-tool-"));
  await fs.writeFile(path.join(root, "a.ts"), "export function alpha(): void {}\n");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  resetRepoMapCacheForTest();
});

function makeCtx(): ToolContext {
  return { workspaceRoot: root, cwd: root } as ToolContext;
}

describe("repoMapTool", () => {
  it("handler 返回带 tag 的地图", async () => {
    const out = await repoMapTool.handler({}, makeCtx());
    expect(out).toContain("<代码库地图");
    expect(out).toContain("a.ts");
    expect(out).toContain("alpha");
  });

  it("无源文件的目录:返回提示而不是空串", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "repomap-tool-empty-"));
    try {
      const ctx = { workspaceRoot: empty, cwd: empty } as ToolContext;
      const out = await repoMapTool.handler({}, ctx);
      expect(out).toContain("没找到支持语言的源文件");
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("schema 校验:max_tokens 下限 256", () => {
    expect(() => repoMapTool.schema.parse({ max_tokens: 100 })).toThrow();
    expect(() => repoMapTool.schema.parse({ max_tokens: 1024 })).not.toThrow();
    expect(() => repoMapTool.schema.parse({})).not.toThrow();
    expect(() => repoMapTool.schema.parse({ refresh: true })).not.toThrow();
  });
});
