import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree } from "./worktree.js";

// afterEach 里 fs.rm(repo) 在 macOS 上偶尔和 git 后台 gc/文件句柄竞态报 ENOTEMPTY
// (git worktree remove 后 .git/objects/pack 等目录可能还有后台句柄未释放)。
// 加有限重试:遇到 ENOTEMPTY/EBUSY 退避后重试,规避 flaky。
async function rmWithRetry(target: string, retries = 5): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code === "ENOTEMPTY" || code === "EBUSY") && i < retries - 1) {
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

let repo: string;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "dao-wt-"));
  git(["init"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(path.join(repo, "a.txt"), "hi");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
});
afterEach(async () => { await rmWithRetry(repo); });

describe("createWorktree", () => {
  it("非 git 目录 → null", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dao-nogit-"));
    expect(createWorktree(tmp, "x")).toBeNull();
    await rmWithRetry(tmp);
  });

  it("建 worktree;hasChanges 反映工作树状态;cleanup 移除", () => {
    const wt = createWorktree(repo, "t1")!;
    expect(wt).not.toBeNull();
    expect(existsSync(wt.root)).toBe(true);
    expect(wt.hasChanges()).toBe(false); // 刚建,无改动
    writeFileSync(path.join(wt.root, "b.txt"), "new");
    expect(wt.hasChanges()).toBe(true); // 有未提交改动
    wt.cleanup();
    expect(existsSync(wt.root)).toBe(false); // 已移除
  });

  it("hasUnpushedCommits:刚建的 worktree 没有分支专属提交 → false", () => {
    const wt = createWorktree(repo, "t2")!;
    expect(wt.hasUnpushedCommits()).toBe(false);
  });

  it("hasUnpushedCommits:在 worktree 里提交后即使工作区变干净,仍能识别出这些提交(hasChanges 已经看不出来了)", () => {
    const wt = createWorktree(repo, "t3")!;
    writeFileSync(path.join(wt.root, "b.txt"), "new");
    git(["add", "."], wt.root);
    git(["commit", "-m", "work done in worktree"], wt.root);
    expect(wt.hasChanges()).toBe(false); // 已提交,工作区干净——这正是旧检查会漏掉的情况
    expect(wt.hasUnpushedCommits()).toBe(true); // 但确实有原分支没有的提交
  });

  // ---- 目标项目自己的 .gitignore 要能排除 .dao/,否则 worktree 目录会作为未跟踪内容
  // 出现在被操作项目自己的 git status 里,用户一次 `git add -A` 就会把整个 worktree 吸进去。 ----
  describe("目标项目 .gitignore 兜底", () => {
    it("项目没有 .gitignore → 建 worktree 时补一份,排除 .dao/", () => {
      expect(existsSync(path.join(repo, ".gitignore"))).toBe(false);
      createWorktree(repo, "g1");
      const content = readFileSync(path.join(repo, ".gitignore"), "utf8");
      expect(content).toMatch(/^\.dao\/$/m);
    });

    it("项目已有 .gitignore 但没排除 .dao/ → 追加一行,不覆盖已有内容", () => {
      writeFileSync(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
      createWorktree(repo, "g2");
      const content = readFileSync(path.join(repo, ".gitignore"), "utf8");
      expect(content).toContain("node_modules/");
      expect(content).toContain("dist/");
      expect(content).toMatch(/^\.dao\/$/m);
    });

    it("项目已经排除过 .dao/(或 .dao)→ 不重复追加", () => {
      writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.dao/\n");
      createWorktree(repo, "g3");
      const content = readFileSync(path.join(repo, ".gitignore"), "utf8");
      expect(content.match(/\.dao\/?\s*$/gm)?.length).toBe(1);
    });
  });
});
