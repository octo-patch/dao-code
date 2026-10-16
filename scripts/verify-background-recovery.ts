import { randomUUID } from "node:crypto";
import { ManagedShell } from "../src/tools/managed_shell.js";
import { durableJson } from "../src/session/durable_file.js";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { DurableStore } from "../src/session/durable_store.js";
import { BackgroundRuntime, WaitControl } from "../src/agent/background_runtime.js";
import { SessionScheduler } from "../src/agent/session_scheduler.js";
import { processManager } from "../src/tools/process_manager.js";
import { createTaskManager } from "../src/agent/tasks.js";
import { recoverBackground } from "../src/session/recovery.js";
import { Session } from "../src/session/session.js";
const worker = process.argv[2] === "worker";
const dir = process.argv[3] ?? mkdtempSync(path.join(tmpdir(), "dao-recovery-live-"));
function awaitFile(file: string, limit = 20000) { return new Promise<void>((resolve, reject) => { const w = watch(path.dirname(file), () => { if (existsSync(file))
    end(); }); const t = setTimeout(() => end(Error(`timeout ${file}`)), limit); function end(e?: Error) { clearTimeout(t); w.close(); e ? reject(e) : resolve(); } if (existsSync(file))
    end(); }); }
if (worker) {
    const store = new DurableStore(dir, "recovery-test", dir), runtime = new BackgroundRuntime([processManager]);
    runtime.bind(store);
    processManager.bindStore(store);
    const command = "printf 'start\\n' >> starts; sleep 3; printf recovered > result";
    let id: string;
    if (process.env.DAO_RECOVERY_TEST_BINARY) {
        const runId = randomUUID(), taskId = `proc-${runId.slice(0, 8)}`, runnerDir = path.join(dir, "runs", runId);
        mkdirSync(runnerDir, { recursive: true });
        const snapshot = { taskId, runId, kind: "shell" as const, background: true, description: command, status: "running" as const, recovery: "runner" as const, runnerDir };
        runtime.publish({ type: "started", snapshot });
        store.setLaunch(runId, { granted: false });
        durableJson(path.join(runnerDir, "manifest.json"), { sessionId: store.sessionId, taskId, runId, command, cwd: dir, endpoint: path.join(tmpdir(), `dao-${runId}.sock`) });
        writeFileSync(path.join(runnerDir, "capability"), randomUUID(), { mode: 0o600 });
        const runner = spawn(process.env.DAO_RECOVERY_TEST_BINARY, ["--dao-shell-runner", runnerDir], { detached: true, stdio: "ignore" });
        runner.unref();
        await awaitFile(path.join(runnerDir, "runner-state.json"));
        const shell = new ManagedShell(store, snapshot, event => runtime.publish(event));
        await shell.connect(true);
        id = taskId;
    }
    else
        id = await processManager.startManaged(command, dir);
    const wait = new WaitControl(runtime);
    wait.request({ ids: [id], mode: "all" });
    store.save({ id: store.sessionId, cwd: dir, model: "test", mode: "normal", messages: [], usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }, updatedAt: Date.now(), done: false }, runtime.checkpoint());
    wait.commit();
    writeFileSync(path.join(dir, "ready"), id);
    await new Promise(() => { });
}
else {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "worker", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", d => stderr += d);
    try {
        await awaitFile(path.join(dir, "ready"));
    }
    catch (e) {
        throw Error(String(e) + stderr);
    }
    child.kill("SIGKILL");
    await new Promise(r => child.once("exit", r));
    const store = new DurableStore(dir, "recovery-test", dir), tasks = createTaskManager(), runtime = new BackgroundRuntime([processManager, tasks]);
    await recoverBackground(store, runtime, tasks);
    const session = new Session("test", "test");
    let modelCalls = 0;
    const scheduler = new SessionScheduler({ runtime, session, user: async () => { }, save: () => store.save({ ...store.state()!, messages: session.messages }, runtime.checkpoint()), run: async () => { modelCalls++; return { kind: "completed" }; } });
    scheduler.recover();
    assert.equal(modelCalls, 0);
    await scheduler.finished();
    assert.equal(modelCalls, 1);
    assert.equal(readFileSync(path.join(dir, "result"), "utf8"), "recovered");
    assert.equal(readFileSync(path.join(dir, "starts"), "utf8"), "start\n");
    assert.equal(store.pendingEvents().length, 0);
    scheduler.close();
    processManager.detach();
    store.close();
    const again = new DurableStore(dir, "recovery-test", dir), r2 = new BackgroundRuntime([processManager]);
    await recoverBackground(again, r2, createTaskManager());
    assert.equal(r2.events().length, 0);
    assert.equal(again.runs().length, 1);
    r2.dispose();
    processManager.detach();
    again.close();
    console.log(JSON.stringify({ pass: true, dir, modelCalls, commandStarts: 1, duplicateDelivery: 0 }));
}
