import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DurableStore } from "../session/durable_store.js";
import { ManagedShell } from "./managed_shell.js";
import { BackgroundRuntime } from "../agent/background_runtime.js";
import { recoverBackground } from "../session/recovery.js";
import { createTaskManager } from "../agent/tasks.js";
import { processManager } from "./process_manager.js";
import type { ExecutionEvent } from "../agent/background_types.js";
const roots: string[] = [], stores: DurableStore[] = [], shells: ManagedShell[] = [];
function open(dir = mkdtempSync(path.join(tmpdir(), "dao-runner-test-"))) { if (!roots.includes(dir))
    roots.push(dir); const store = new DurableStore(dir, "test", dir); stores.push(store); return store; }
function nextEvent() { let resolve!: (e: ExecutionEvent) => void; const promise = new Promise<ExecutionEvent>(r => resolve = r); return { promise, emit: (e: ExecutionEvent) => { if (["completed", "failed", "canceled", "unknown"].includes(e.type))
        resolve(e); } }; }
afterEach(() => { processManager.detach(); for (const s of shells.splice(0)) {
    try {
        s.cancel();
    }
    catch { }
    s.disconnect();
} for (const s of stores.splice(0))
    try {
        s.close();
    }
    catch { } for (const d of roots.splice(0))
    rmSync(d, { recursive: true, force: true }); });
describe("managed shell durable boundaries (real processes)", () => {
    it("imports a completion written while the owner was offline, then deduplicates", async () => {
        const store = open(), first = nextEvent();
        const shell = await ManagedShell.start(store, "sleep 0.3; printf offline", store.dir, first.emit);
        shells.push(shell);
        shell.disconnect();
        store.close();
        // Wait on the real receipt notification through a second authenticated connection.
        const next = open(store.dir), done = nextEvent();
        const observer = new ManagedShell(next, { ...shell.snapshot }, done.emit);
        shells.push(observer);
        await observer.connect();
        await done.promise;
        expect(readFileSync(path.join(shell.dir, "stdout.log"), "utf8")).toBe("offline");
        const runtime = new BackgroundRuntime([processManager]);
        await recoverBackground(next, runtime, createTaskManager());
        expect(runtime.events()).toHaveLength(1);
        await recoverBackground(next, runtime, createTaskManager());
        expect(runtime.events()).toHaveLength(1);
        runtime.dispose();
    }, 15000);
    it("persists cancellation and reports canceled only after real close", async () => {
        const store = open(), done = nextEvent();
        const shell = await ManagedShell.start(store, "sleep 30", store.dir, done.emit);
        shells.push(shell);
        shell.cancel();
        expect(JSON.parse(readFileSync(path.join(shell.dir, "cancel.json"), "utf8")).epoch).toBe(store.epoch);
        const event = await done.promise;
        expect(event.type).toBe("canceled");
        expect(JSON.parse(readFileSync(path.join(shell.dir, "terminal.json"), "utf8")).snapshot.status).toBe("canceled");
    }, 15000);
    it("a missing result attachment becomes unknown and never triggers a second launch", async () => {
        const store = open(), done = nextEvent();
        const shell = await ManagedShell.start(store, "printf once >> starts", store.dir, done.emit);
        shells.push(shell);
        await done.promise;
        unlinkSync(path.join(shell.dir, "stdout.log"));
        const runtime = new BackgroundRuntime([processManager]);
        await recoverBackground(store, runtime, createTaskManager());
        expect(runtime.snapshot(shell.snapshot.taskId)?.status).toBe("unknown");
        expect(runtime.events()).toHaveLength(1);
        expect(readFileSync(path.join(store.dir, "starts"), "utf8")).toBe("once");
        runtime.dispose();
    }, 15000);
    it("rejects mismatched run identity before accepting a terminal receipt", async () => {
        const store = open(), done = nextEvent();
        const shell = await ManagedShell.start(store, "true", store.dir, done.emit);
        shells.push(shell);
        await done.promise;
        const receipt = JSON.parse(readFileSync(path.join(shell.dir, "terminal.json"), "utf8"));
        receipt.snapshot.runId = "other";
        writeFileSync(path.join(shell.dir, "terminal.json"), JSON.stringify(receipt));
        const other = new ManagedShell(store, { ...shell.snapshot }, () => { });
        shells.push(other);
        await expect(other.connect()).rejects.toThrow(/身份/);
    }, 15000);
    it("stops reconnecting after runner loss and reports unknown once", async () => {
        const store=open(),done=nextEvent();let unknownCount=0;
        const shell=await ManagedShell.start(store,"sleep 1",store.dir,event=>{if(event.type==="unknown")unknownCount++;done.emit(event);});shells.push(shell);
        const identity=JSON.parse(readFileSync(path.join(shell.dir,"runner-state.json"),"utf8")).identity;
        process.kill(identity.pid,"SIGKILL");
        const event=await done.promise;expect(event.type).toBe("unknown");expect(shell.snapshot.status).toBe("unknown");expect(unknownCount).toBe(1);
    },15000);

});
