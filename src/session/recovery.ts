import type { ChatMessage } from "../client/types.js";
import type { BackgroundRuntime } from "../agent/background_runtime.js";
import type { TaskManager } from "../agent/tasks.js";
import type { DurableStore } from "./durable_store.js";
import { processManager } from "../tools/process_manager.js";
/** Preserve the assistant and every known result; missing outcomes are explicit, never replayed. */
export function repairToolPairs(messages: ChatMessage[], store: DurableStore, scope = "root"): ChatMessage[] {
    const records = new Map(store.toolRecords().filter(r => r.scope === scope).map(r => [r.id, r]));
    const out: ChatMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        out.push(m);
        if (m.role !== "assistant" || !m.tool_calls?.length)
            continue;
        const results = new Map<string, ChatMessage>();
        while (messages[i + 1]?.role === "tool") {
            const r = messages[++i]!;
            if (r.role === "tool")
                results.set(r.tool_call_id, r);
        }
        for (const call of m.tool_calls) {
            const record = records.get(call.id);
            out.push(results.get(call.id) ?? record?.result ?? { role: "tool", tool_call_id: call.id, content: record ? "[恢复：结果未知] 操作可能已执行；必须先核实，禁止自动重试。" : "[恢复：未执行] 此工具没有执行意图记录，未自动重放。" });
        }
    }
    return out;
}
export async function recoverBackground(store: DurableStore, runtime: BackgroundRuntime, tasks: TaskManager) {
    runtime.bind(store);
    processManager.bindStore(store);
    for (const original of store.runs()) {
        let snapshot = { ...original };
        if (snapshot.kind === "shell" && snapshot.recovery === "runner" && !store.launch<{resolvedByUser?:boolean}>(snapshot.runId)?.resolvedByUser) {
            try {
                await processManager.recover(snapshot);
            }
            catch (error) {
                snapshot = { ...snapshot, status: "unknown", result: `[恢复需核实] ${String(error)}` };
                runtime.publish({ type: "unknown", snapshot, requiresAttention: true, eventId: `${snapshot.runId}:recovery-unknown` });
            }
        }
        else {
            if (snapshot.status === "running" || snapshot.status === "canceling") {
                snapshot = { ...snapshot, status: "interrupted", result: "原执行进程已结束；请检查检查点后显式继续，未自动重放。" };
                runtime.publish({ type: "interrupted", snapshot, requiresAttention: true, eventId: `${snapshot.runId}:interrupted` });
            }
            if (snapshot.kind === "agent")
                tasks.restore(snapshot, store.agents().find(a => a.runId === snapshot.runId)?.messages);
        }
        // A lost tool response does not mean the launch should be repeated.
        const tool = store.launch<{
            tool?: {
                scope: string;
                id: string;
            };
        }>(snapshot.runId)?.tool;
        if (tool && store.toolRecords().some(r => r.scope === tool.scope && r.id === tool.id && r.state !== "result_committed")) {
            const current = runtime.snapshot(snapshot.taskId) ?? snapshot;
            store.afterTool(tool.scope, tool.id, { role: "tool", tool_call_id: tool.id, content: JSON.stringify({ status: current.status, task_id: current.taskId, runId: current.runId, recovered: true, result: current.result }) });
        }
    }
    for (const file of store.missingAttachments()) {
        const id = `attachment:${Buffer.from(file).toString("base64url")}`;
        if (!store.toolRecords().some(r => r.scope === "recovery" && r.id === id))
            store.beforeTool({ scope: "recovery", id, name: "MissingResultAttachment", args: file }, false);
    }
    store.markInterruptedTools();
    if (runtime.fault)
        throw runtime.fault;
}
