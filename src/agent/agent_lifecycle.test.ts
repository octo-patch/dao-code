// src/agent/agent_lifecycle.test.ts
import { describe, it, expect, vi } from "vitest";
import { runAsyncAgentLifecycle } from "./agent_lifecycle.js";
import type { ChatMessage } from "../client/types.js";
import { createTaskManager } from "./tasks.js";
import { BackgroundRuntime } from "./background_runtime.js";
import { SessionScheduler } from "./session_scheduler.js";
import { Session } from "../session/session.js";

async function* fakeStream(messages: ChatMessage[]): AsyncGenerator<ChatMessage, void> {
  for (const m of messages) yield m;
}

async function* throwingStream(before: ChatMessage[], err: Error): AsyncGenerator<ChatMessage, void> {
  for (const m of before) yield m;
  throw err;
}

function mkTaskManager() {
  return {
    appendMessage: vi.fn((_taskId: string, _m: ChatMessage) => true),
    updateSummary: vi.fn((_taskId: string, _s: string) => true),
    update: vi.fn((_taskId: string, _patch: { status?: "completed" | "failed" | "canceled"; result?: string }) => true),
  };
}

describe("runAsyncAgentLifecycle", () => {
  it("两个子代理报模型不存在时结束任务并唤醒主会话，不留在 TaskWait", async () => {
    const taskManager = createTaskManager();
    const runtime = new BackgroundRuntime([taskManager]);
    const session = new Session("SYS", "gateway-model");
    const jobs = ["a", "b"].map((agentId) => taskManager.registerAsyncAgent({ agentId, description: "review" }));
    let calls = 0;
    const scheduler = new SessionScheduler({
      runtime, session, save: () => {}, user: async () => {},
      run: async () => ++calls === 1
        ? { kind: "waiting", wait: runtime.prepare({ ids: ["a", "b"], mode: "all" }).handle }
        : { kind: "completed" },
    });
    try {
      scheduler.submit("review");
      await scheduler.settled();
      expect(scheduler.status().state).toBe("waiting");
      await Promise.all(jobs.map((job) => runAsyncAgentLifecycle({
        taskId: job.agentId, agentId: job.agentId, runId: job.runId,
        prompt: "review", model: "missing", taskManager,
        makeStream: () => throwingStream([], new Error("模型不存在")),
      })));
      await scheduler.finished();
      expect(taskManager.running()).toHaveLength(0);
      expect(taskManager.all().every((task) => task.status === "failed" && task.error?.includes("模型不存在"))).toBe(true);
      expect(calls).toBeGreaterThan(1);
      expect(runtime.activeWaits).toBe(0);
      expect(runtime.events()).toHaveLength(0);
      expect(scheduler.status().state).toBe("idle");
      expect(session.messages.some((message) => String(message.content).includes("模型不存在"))).toBe(true);
    } finally { scheduler.close(); }
  });
  it("逐条把 stream 产出的消息 appendMessage 到任务", async () => {
    const taskManager = mkTaskManager();
    const messages: ChatMessage[] = [
      { role: "assistant", content: "第一步" },
      { role: "assistant", content: "完成" },
    ];
    await runAsyncAgentLifecycle({
      taskId: "task-1", agentId: "agent-1", prompt: "do x", model: "flash",
      makeStream: () => fakeStream(messages),
      taskManager,
    });
    expect(taskManager.appendMessage).toHaveBeenCalledTimes(2);
    expect(taskManager.appendMessage).toHaveBeenNthCalledWith(1, "task-1", messages[0], undefined);
    expect(taskManager.appendMessage).toHaveBeenNthCalledWith(2, "task-1", messages[1], undefined);
  });

  it("正常结束后用最后一条 assistant 文本结算 completed", async () => {
    const taskManager = mkTaskManager();
    const messages: ChatMessage[] = [
      { role: "assistant", content: "中间" },
      { role: "assistant", content: "最终结论" },
    ];
    await runAsyncAgentLifecycle({
      taskId: "task-1", agentId: "agent-1", prompt: "do x", model: "flash",
      makeStream: () => fakeStream(messages),
      taskManager,
    });
    expect(taskManager.update).toHaveBeenCalledWith("task-1", { status: "completed", result: "最终结论" }, undefined);
  });

  it("stream 抛错时结算 failed,并带上已产出的部分结果", async () => {
    const taskManager = mkTaskManager();
    const messages: ChatMessage[] = [{ role: "assistant", content: "跑到一半" }];
    await runAsyncAgentLifecycle({
      taskId: "task-1", agentId: "agent-1", prompt: "do x", model: "flash",
      makeStream: () => throwingStream(messages, new Error("网络中断")),
      taskManager,
    });
    expect(taskManager.update).toHaveBeenCalledTimes(1);
    const [, patch] = taskManager.update.mock.calls[0]!;
    expect(patch.status).toBe("failed");
    expect(patch.result).toContain("网络中断");
    expect(patch.result).toContain("跑到一半");
  });

  it("makeStream 收到缓存安全参数回调时启动摘要,stream 结束后停止", async () => {
    const taskManager = mkTaskManager();
    const stopFn = vi.fn();
    const startSummarization = vi.fn(() => ({ stop: stopFn }));
    const messages: ChatMessage[] = [{ role: "assistant", content: "done" }];

    await runAsyncAgentLifecycle({
      taskId: "task-1", agentId: "agent-1", prompt: "do x", model: "flash",
      makeStream: (onCacheSafeParams) => {
        onCacheSafeParams({ systemPrompt: "sp", forkContextMessages: [] });
        return fakeStream(messages);
      },
      taskManager,
      startSummarization,
    });

    expect(startSummarization).toHaveBeenCalledWith(
      "task-1", "agent-1",
      { systemPrompt: "sp", messages: [], model: "flash" },
      expect.any(Function),
    );
    expect(stopFn).toHaveBeenCalledTimes(1);
  });
});
