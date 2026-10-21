import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DurableStore, readDurableState } from "./durable_store.js";
import { BackgroundRuntime, WaitControl } from "../agent/background_runtime.js";
import { SessionScheduler } from "../agent/session_scheduler.js";
import { Session } from "./session.js";
import { repairToolPairs } from "./recovery.js";
import type { PersistedState } from "./log.js";
const roots: string[] = [];
const stores: DurableStore[] = [];
const identity = { host: "test", boot: "boot", pid: 123, start: "start" };
const identities = { current: () => identity, alive: () => false };
function open(dir = mkdtempSync(path.join(tmpdir(), "dao-durable-"))) { if (!roots.includes(dir))
    roots.push(dir); const s = new DurableStore(dir, "session", dir, identities); stores.push(s); return s; }
const checkpoint = (messages: PersistedState["messages"] = []): PersistedState => ({ id: "session", cwd: "/tmp", model: "test", mode: "normal", messages, usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }, updatedAt: 1, done: false });
const run = { taskId: "shell-1", runId: "run-1", kind: "shell" as const, background: true, description: "test", status: "running" as const };
afterEach(() => { for (const s of stores.splice(0))
    try {
        s.close();
    }
    catch { } for (const d of roots.splice(0))
    rmSync(d, { recursive: true, force: true }); });
describe("durable recovery transactions", () => {
    it("rejects live owner and fences stale owners", () => { const s = open(); expect(() => new DurableStore(s.dir, "session", s.dir, { ...identities, alive: () => true })).toThrow(/不能并发/); const next = open(s.dir); expect(() => s.save(checkpoint())).toThrow(/所有权/); next.save(checkpoint()); expect(readDurableState(next.dir)?.id).toBe("session"); });
    it("rolls back event delivery and transcript together", () => { const s = open(); const r = new BackgroundRuntime(); r.bind(s); r.publish({ type: "started", snapshot: run }); r.publish({ type: "completed", snapshot: { ...run, status: "completed" } }); const event = r.events()[0]!; r.stageConsumed([event.eventId]); expect(() => s.atomic(() => { s.save(checkpoint([{ role: "user", content: "result" }]), r.checkpoint()); throw Error("disk fault"); })).toThrow(); expect(s.state()).toBeUndefined(); expect(s.pendingEvents()).toHaveLength(1); s.save(checkpoint([{ role: "user", content: "result" }]), r.checkpoint()); expect(s.pendingEvents()).toHaveLength(0); expect(s.state()?.messages).toHaveLength(1); });
    it("deduplicates terminal receipt across reopen", () => { const s = open(); const r = new BackgroundRuntime(); r.bind(s); r.publish({ type: "started", snapshot: run }); r.publish({ type: "completed", snapshot: { ...run, status: "completed" } }); const e = r.events()[0]!; s.event(e); expect(s.pendingEvents()).toHaveLength(1); s.close(); const next = open(s.dir); expect(next.event(e).seq).toBe(e.seq); expect(next.pendingEvents()).toHaveLength(1); });
    it("persists TaskWait and restores an event-driven wait without model polling", async () => { const s = open(); const r = new BackgroundRuntime(); r.bind(s); r.publish({ type: "started", snapshot: run }); const c = new WaitControl(r); c.request({ ids: [run.taskId], mode: "all" }); s.save(checkpoint(), r.checkpoint()); c.commit(); s.close(); const next = open(s.dir); const restored = new BackgroundRuntime(); restored.bind(next); const session = new Session("system", "test"); let calls = 0; const scheduler = new SessionScheduler({ runtime: restored, session, save: () => next.save(checkpoint(session.messages), restored.checkpoint()), user: async () => { }, run: async () => { calls++; return { kind: "completed" }; } }); scheduler.recover(); await scheduler.settled(); expect(scheduler.status().state).toBe("waiting"); expect(calls).toBe(0); restored.publish({ type: "completed", snapshot: { ...run, status: "completed" } }); await scheduler.finished(); expect(calls).toBe(1); expect(next.pendingEvents()).toHaveLength(0); scheduler.close(); });
    it("preserves paused state even when completion arrives offline", async () => { const s = open(); const r = new BackgroundRuntime(); r.bind(s); r.publish({ type: "started", snapshot: run }); r.setState("paused"); s.save(checkpoint(), r.checkpoint()); r.publish({ type: "completed", snapshot: { ...run, status: "completed" } }); const session = new Session("system", "test"); let calls = 0; const scheduler = new SessionScheduler({ runtime: r, session, save: () => { }, user: async () => { }, run: async () => { calls++; return { kind: "completed" }; } }); scheduler.recover(); await scheduler.finished(); expect(scheduler.status().state).toBe("paused"); expect(calls).toBe(0); expect(s.pendingEvents()).toHaveLength(1); scheduler.close(); });
    it("keeps known tool results, repairs missing pairs and blocks unknown side effects", () => { const s = open(); s.beforeTool({ scope: "root", id: "known", name: "Write", args: "{}" }, true); s.afterTool("root", "known", { role: "tool", tool_call_id: "known", content: "written" }); s.beforeTool({ scope: "root", id: "unknown", name: "Bash", args: "{}" }, true); s.markInterruptedTools(); const repaired = repairToolPairs([{ role: "assistant", content: null, tool_calls: ["known", "unknown", "not-started"].map(id => ({ id, type: "function", function: { name: "Bash", arguments: "{}" } })) }], s); expect(repaired).toHaveLength(4); expect(repaired[1]?.content).toBe("written"); expect(repaired[2]?.content).toContain("结果未知"); expect(repaired[3]?.content).toContain("未执行"); expect(() => s.beforeTool({ scope: "root", id: "retry", name: "Write", args: "{}" }, true)).toThrow(/未知/); expect(() => s.beforeTool({ scope: "root", id: "read", name: "Read", args: "{}" }, false)).not.toThrow(); s.resolveTool("root", "unknown", "已人工确认命令没有执行，不再重试"); expect(() => s.beforeTool({ scope: "root", id: "new", name: "Write", args: "{}" }, true)).not.toThrow(); });
    it("fails closed for corrupt or future database versions", () => { const s = open(); s.db.exec("PRAGMA user_version=99"); s.close(); expect(() => readDurableState(s.dir)).toThrow(/版本/); expect(() => open(s.dir)).toThrow(/版本/); writeFileSync(path.join(s.dir, "session.db"), "corrupt"); expect(() => readDurableState(s.dir)).toThrow(); });
    it("unknown recovery clears the old wait before persisting paused", async () => {
        const store=open(),runtime=new BackgroundRuntime();runtime.bind(store);
        runtime.publish({type:"started",snapshot:run});new WaitControl(runtime).request({ids:[run.taskId],mode:"all"});
        store.save(checkpoint(),runtime.checkpoint());runtime.publish({type:"unknown",snapshot:{...run,status:"unknown"},eventId:"unknown"});
        let calls=0;const scheduler=new SessionScheduler({runtime,session:new Session("sys","test"),save:()=>store.save(checkpoint(),runtime.checkpoint()),user:async()=>{},run:async()=>{calls++;return {kind:"completed"};}});
        scheduler.recover();store.save(checkpoint(),runtime.checkpoint());await scheduler.finished();
        expect(store.background()?.state).toBe("paused");expect(store.background()?.wait).toBeUndefined();expect(runtime.activeWaits).toBe(0);expect(calls).toBe(0);scheduler.close();
    });
    it("ready TaskWait atomically acknowledges only its own result",()=>{
        const store=open(),runtime=new BackgroundRuntime();runtime.bind(store);
        runtime.publish({type:"started",snapshot:run});runtime.publish({type:"completed",snapshot:{...run,status:"completed"}});
        const other={...run,taskId:"other",runId:"other-run"};runtime.publish({type:"started",snapshot:other});runtime.publish({type:"completed",snapshot:{...other,status:"completed"}});
        const control=new WaitControl(runtime);expect(control.request({ids:[run.taskId],mode:"any"})).toContain('"ready"');
        store.save(checkpoint(),runtime.checkpoint());control.commit();expect(store.pendingEvents().map(e=>e.snapshot.taskId)).toEqual(["other"]);expect(store.background()?.wait).toBeUndefined();
    });
    it("durable result attachments detect loss instead of silently truncating",()=>{
        const store=open(),runtime=new BackgroundRuntime();runtime.bind(store);const text="result ".repeat(5000);
        expect(runtime.renderResult(text)).toContain("完整输出已持久保存");expect(store.missingAttachments()).toEqual([]);
        const files=store.readMeta<Record<string,string>>("attachments")!;unlinkSync(Object.keys(files)[0]!);expect(store.missingAttachments()).toHaveLength(1);
    });
    it("a transaction failure cannot publish a terminal event to consumers",()=>{
        const store=open(),runtime=new BackgroundRuntime();runtime.bind(store);runtime.publish({type:"started",snapshot:run});
        store.db.exec("PRAGMA query_only=ON");runtime.publish({type:"completed",snapshot:{...run,status:"completed"}});
        expect(runtime.events()).toHaveLength(0);expect(runtime.fault).toBeDefined();store.db.exec("PRAGMA query_only=OFF");expect(store.runs()[0]?.status).toBe("running");
    });

});
