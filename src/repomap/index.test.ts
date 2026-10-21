import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildRepoMap, wrapRepoMapNotice, repoMapTokenBudget, resetRepoMapCacheForTest } from "./index.js";

let root: string;

beforeAll(async () => {
  resetRepoMapCacheForTest();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "repomap-e2e-"));
  // 模拟一个小仓库:core 被多方依赖,应排最前;unrelated 独立,应排最后或被裁掉
  await fs.writeFile(path.join(root, "core.ts"), `
export interface Config { a: number; }
export class Engine {
  start(): void {}
}
`);
  await fs.writeFile(path.join(root, "app.ts"), `
import { Config, Engine } from "./core";
export function main(c: Config): Engine { return new Engine(); }
`);
  await fs.writeFile(path.join(root, "util.ts"), `
import { Engine } from "./core";
export class Helper {
  wrap(e: Engine): Engine { return e; }
}
`);
  await fs.writeFile(path.join(root, "unrelated.ts"), `
export function lonelyThing(): void {}
`);
  // 非源码文件应被忽略
  await fs.writeFile(path.join(root, "README.md"), "# readme");
  // 压缩产物应被跳过
  await fs.writeFile(path.join(root, "bundle.min.js"), "function a(){}");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  resetRepoMapCacheForTest();
});

describe("buildRepoMap", () => {
  it("端到端:构建、排序(core 最前)、忽略非源码与 .min 文件", async () => {
    const r = await buildRepoMap(root, 4096);
    expect(r.fileCount).toBe(4); // core/app/util/unrelated
    expect(r.truncated).toBe(false);
    expect(r.text).not.toContain("README");
    expect(r.text).not.toContain("bundle.min.js");
    // core.ts 被 app/util 依赖,必须出现在地图最前面
    expect(r.text.indexOf("core.ts:")).toBeGreaterThanOrEqual(0);
    const coreIdx = r.text.indexOf("core.ts:");
    const appIdx = r.text.indexOf("app.ts:");
    const unrelatedIdx = r.text.indexOf("unrelated.ts:");
    if (appIdx >= 0) expect(coreIdx).toBeLessThan(appIdx);
    if (unrelatedIdx >= 0) expect(coreIdx).toBeLessThan(unrelatedIdx);
    // 签名在地图里
    expect(r.text).toContain("class Engine");
  });

  it("mtime 缓存:未变更文件不重新解析(第二次构建结果一致)", async () => {
    const r1 = await buildRepoMap(root, 4096);
    const r2 = await buildRepoMap(root, 4096);
    expect(r2.text).toBe(r1.text);
    expect(r2.fileCount).toBe(r1.fileCount);
  });

  it("预算很小:只包含排最前的文件", async () => {
    const r = await buildRepoMap(root, 300);
    expect(r.text).not.toBe("");
    // 预算 300 token 装不下全部 4 个文件;core.ts 必须在(rank 最高)
    expect(r.text).toContain("core.ts");
    expect(r.text.length).toBeLessThan(300 * 3 + 600); // 预算 * 3 字符 + 头部余量
  });

  it("空目录:返回空文本,不注入", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "repomap-empty-"));
    try {
      const r = await buildRepoMap(empty, 2048);
      expect(r.text).toBe("");
      expect(r.fileCount).toBe(0);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe("wrapRepoMapNotice", () => {
  it("中文:带 tag + 使用说明 + 文件数", () => {
    const out = wrapRepoMapNotice("src/a.ts:\n⋮...\n│function f()", false, 42);
    expect(out).toContain("<代码库地图");
    expect(out).toContain("共解析 42 个文件");
    expect(out).toContain("</代码库地图>");
  });

  it("英文 tag", () => {
    const out = wrapRepoMapNotice("src/a.ts:\n⋮...\n│function f()", true, 42);
    expect(out).toContain("<codebase-map");
    expect(out).toContain("</codebase-map>");
  });

  it("空文本返回空串", () => {
    expect(wrapRepoMapNotice("", false, 0)).toBe("");
  });
});

describe("repoMapTokenBudget", () => {
  it("默认 2048;显式覆盖;0 = 禁用", () => {
    const prev = process.env.DAO_REPO_MAP_TOKENS;
    try {
      delete process.env.DAO_REPO_MAP_TOKENS;
      expect(repoMapTokenBudget()).toBe(2048);
      process.env.DAO_REPO_MAP_TOKENS = "4096";
      expect(repoMapTokenBudget()).toBe(4096);
      process.env.DAO_REPO_MAP_TOKENS = "0";
      expect(repoMapTokenBudget()).toBe(0);
      process.env.DAO_REPO_MAP_TOKENS = "abc";
      expect(repoMapTokenBudget()).toBe(2048);
    } finally {
      if (prev === undefined) delete process.env.DAO_REPO_MAP_TOKENS;
      else process.env.DAO_REPO_MAP_TOKENS = prev;
    }
  });
});
