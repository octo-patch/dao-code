import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DurableStore } from "../session/durable_store.js";
import { resumeAgentBackground } from "./resume_agent.js";
import { GENERAL_PURPOSE_AGENT } from "./bundled_agents.js";
import { createTaskManager } from "./tasks.js";
import type { ChatMessage } from "../client/types.js";
function fixture() {
    const dir = mkdtempSync(path.join(tmpdir(), "dao-agent-recovery-"));
    const store = new DurableStore(dir, "test", dir, { current: () => ({ host: "test", boot: "boot", pid: 1, start: "start" }), alive: () => false });
    const tasks = createTaskManager();
    tasks.restore({ taskId: "agent", runId: "old-run", kind: "agent", background: true, description: "saved", status: "interrupted" });
    store.saveAgent({ taskId: "agent", runId: "old-run", messages: [{ role: "assistant", content: "saved analysis", tool_calls: [{ id: "write", type: "function", function: { name: "Write", arguments: "{}" } }] }], metadata: { agentType: GENERAL_PURPOSE_AGENT.agentType, description: "saved", model: "saved-model", worktreePath: dir } });
    store.beforeTool({ scope: "old-run", id: "write", name: "Write", args: "{}" }, true);
    store.markInterruptedTools();
    const runAgent = vi.fn((_: unknown) => (async function* () { yield { role: "assistant", content: "continued" } as ChatMessage; })());
    const opts = { agentId: "agent", prompt: "inspect only", subagentsDir: dir, agentDefs: [GENERAL_PURPOSE_AGENT], durableStore: store, runAgent, taskManager: tasks, registerAsyncAgent: (o: {
            agentId: string;
            description: string;
        }) => tasks.registerAsyncAgent(o) };
    return { dir, store, tasks, runAgent, opts, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
describe("durable agent continuation", () => {
    it("requires resolving unknown tool results, then creates a new run with saved model and repaired pairs", async () => {
        const f = fixture();
        try {
            await expect(resumeAgentBackground(f.opts)).rejects.toThrow(/未决/);
            expect(f.runAgent).not.toHaveBeenCalled();
            f.store.resolveTool("old-run", "write", "已确认写入成功，不重复写入");
            await resumeAgentBackground(f.opts);
            const params = f.runAgent.mock.calls[0]![0] as {
                model: string;
                promptMessages: ChatMessage[];
                worktreePath: string;
            };
            expect(params.model).toBe("saved-model");
            expect(params.worktreePath).toBe(f.dir);
            expect(params.promptMessages[0]?.content).toBe("saved analysis");
            expect(params.promptMessages[1]?.role).toBe("tool");
            expect(params.promptMessages[1]?.content).toContain("不重复写入");
            expect(f.tasks.get("agent")?.runId).not.toBe("old-run");
            await new Promise(r => setImmediate(r));
            expect(f.tasks.get("agent")?.status).toBe("completed");
        }
        finally {
            f.close();
        }
    });
    it("does not replace a missing saved agent definition or worktree", async () => {
        const f = fixture();
        try {
            f.store.resolveTool("old-run", "write", "确认完成");
            await expect(resumeAgentBackground({ ...f.opts, agentDefs: [] })).rejects.toThrow(/定义/);
            const saved = f.store.agents()[0]!;
            saved.metadata.worktreePath = path.join(f.dir, "missing");
            f.store.saveAgent(saved);
            await expect(resumeAgentBackground(f.opts)).rejects.toThrow();
            expect(f.runAgent).not.toHaveBeenCalled();
        }
        finally {
            f.close();
        }
    });
});
