import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
let hasProjectConfig: typeof import("./trust.js").hasProjectConfig, isTrusted: typeof import("./trust.js").isTrusted, addTrusted: typeof import("./trust.js").addTrusted, shouldTrustProject: typeof import("./trust.js").shouldTrustProject;

let home: string, root: string, prevTrust: string | undefined;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "dao-home-"));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-proj-"));
  prevTrust = process.env.DAO_TRUST; delete process.env.DAO_TRUST;
  vi.spyOn(os,"homedir").mockReturnValue(home);vi.resetModules();
  ({hasProjectConfig,isTrusted,addTrusted,shouldTrustProject}=await import("./trust.js"));
});
afterEach(async () => {
  vi.restoreAllMocks();if (prevTrust !== undefined) process.env.DAO_TRUST = prevTrust; else delete process.env.DAO_TRUST;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

describe("目录信任", () => {
  it("无项目配置 → 视为可信(免打扰)", async () => {
    expect(hasProjectConfig(root)).toBe(false);
    expect(await shouldTrustProject(root)).toBe(true);
  });

  it("有项目配置但未信任 → 不可信;trust 后可信", async () => {
    await fs.mkdir(path.join(root, ".dao"), { recursive: true });
    await fs.writeFile(path.join(root, ".dao", "hooks.json"), "{}");
    expect(hasProjectConfig(root)).toBe(true);
    expect(await isTrusted(root)).toBe(false);
    expect(await shouldTrustProject(root)).toBe(false);
    await addTrusted(root);
    expect(await isTrusted(root)).toBe(true);
    expect(await shouldTrustProject(root)).toBe(true);
  });

  it("DAO_TRUST=1 → 强制可信(headless)", async () => {
    await fs.mkdir(path.join(root, ".dao"), { recursive: true });
    await fs.writeFile(path.join(root, ".dao", "settings.json"), "{}");
    process.env.DAO_TRUST = "1";
    expect(await shouldTrustProject(root)).toBe(true);
  });
});
