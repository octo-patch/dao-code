import { describe, it, expect, afterEach } from "vitest";
import { execShellPollTool } from "./exec_shell_poll.js";
import { execShellKillTool } from "./exec_shell_kill.js";
import { processManager } from "./process_manager.js";

afterEach(() => processManager.reset());
const ctx = { workspaceRoot: process.cwd() };

async function waitFor(pred: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("BashOutput / KillShell", () => {
  it("polls a background process's output and status", async () => {
    const id = processManager.start("echo polled", process.cwd());
    await waitFor(() => processManager.poll(id).status === "exited");
    const id2 = processManager.start("echo via-tool", process.cwd());
    await new Promise((r) => setTimeout(r, 200));
    const formatted = await execShellPollTool.handler({ id: id2 }, ctx);
    expect(formatted).toContain("状态:");
  });

  it("kills a background process via the tool", async () => {
    const id = processManager.start("sleep 30", process.cwd());
    const out = await execShellKillTool.handler({ id }, ctx);
    expect(out).toContain(id);
    await waitFor(() => processManager.poll(id).status === "exited");
    expect(processManager.poll(id).status).toBe("exited");
  });

  it("declares auto approval", () => {
    expect(execShellPollTool.approval).toBe("auto");
    expect(execShellKillTool.approval).toBe("auto");
    expect(execShellPollTool.name).toBe("BashOutput");
    expect(execShellKillTool.name).toBe("KillShell");
  });

  it("单次 poll 输出超 2 万字符时截断(保留首尾,标注实际字符数)", async () => {
    // 产出大量 stdout:用 perl 一次写 5 万个 'a' 到 stdout(实际可能因缓冲多写一些)
    const id = processManager.start("perl -e 'print \"a\" x 50000'", process.cwd());
    // 不用 waitFor(它会 poll 消费输出),直接等进程退出
    await new Promise((r) => setTimeout(r, 500));
    // handler 内部 poll 一次读走全部输出,应截断到 2 万
    const formatted = await execShellPollTool.handler({ id }, ctx);
    // 截断标注存在
    expect(formatted).toContain("已截断");
    // 返回值总长度应远小于原始输出(截断后约 2 万 + 标注)
    expect(formatted.length).toBeLessThan(25000);
    // 首尾都保留了(头部 'a' 和尾部 'a')
    expect(formatted).toContain("a");
  });
});
