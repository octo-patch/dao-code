import { toolExecution } from "../session/tool_execution.js";
import { createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { DurableStore } from "../session/durable_store.js";
import { identityAlive } from "../session/process_identity.js";
import { durableJson } from "../session/durable_file.js";
import { sandboxSpawn } from "./sandbox.js";
import { scrubbedEnv } from "./safe_env.js";
import type { ExecutionSnapshot, ExecutionEvent } from "../agent/background_types.js";
import type { RunnerManifest, RunnerState } from "./shell_runner.js";
export class ManagedShell {
    private socket?: Socket;
    private watcher?: FSWatcher;
    private ended = false;
    private retries = 0;
    private retryTimer?: ReturnType<typeof setTimeout>;
    state?: RunnerState;
    constructor(readonly store: DurableStore, readonly snapshot: ExecutionSnapshot, private emit: (event: ExecutionEvent) => void) { }
    get dir() { return this.snapshot.runnerDir!; }
    private readState(file: string): RunnerState | undefined {
        if (!existsSync(path.join(this.dir, file)))
            return;
        const state = JSON.parse(readFileSync(path.join(this.dir, file), "utf8")) as RunnerState;
        if (state.snapshot?.runId !== this.snapshot.runId || state.snapshot.taskId !== this.snapshot.taskId)
            throw new Error("runner 收据执行身份不匹配。");
        if (file === "terminal.json") {
            if (!["completed", "failed", "canceled"].includes(state.snapshot.status))
                throw new Error("终态收据缺少可信终态。");
            for (const name of ["stdout.log", "stderr.log"])
                if (!existsSync(path.join(this.dir, name)))
                    throw new Error(`结果附件缺失：${name}`);
        }
        return state;
    }
    private accept(state: RunnerState) {
        if (this.ended)
            return;
        this.state = state;
        Object.assign(this.snapshot, state.snapshot);
        const terminal = ["completed", "failed", "canceled"].includes(state.snapshot.status);
        this.emit({ type: terminal ? state.snapshot.status as "completed" | "failed" | "canceled" : "progress", snapshot: { ...state.snapshot }, eventId: terminal ? `${state.snapshot.runId}:terminal` : undefined });
        if (terminal) {
            this.ended = true;
            this.disconnect();
        }
    }
    private terminal() { const receipt = this.readState("terminal.json"); if (receipt)
        this.accept(receipt); return !!receipt; }
    private request(action: string) {
        this.store.assertOwner();
        this.socket?.write(JSON.stringify({ action, token: readFileSync(path.join(this.dir, "capability"), "utf8"), runId: this.snapshot.runId, epoch: this.store.epoch }) + "\n");
    }
    async connect(start = false): Promise<void> {
        if (this.terminal())
            return;
        const manifest = JSON.parse(readFileSync(path.join(this.dir, "manifest.json"), "utf8")) as RunnerManifest;
        if (manifest.runId !== this.snapshot.runId || manifest.sessionId !== this.store.sessionId)
            throw new Error("runner 清单身份不匹配。");
        const state = this.readState("runner-state.json");
        if (!state || !identityAlive(state.identity))
            throw new Error("runner 不存在，执行结果需核实。");
        this.watcher ??= watch(this.dir, () => { try {
            this.terminal();
        }
        catch (error) {
            this.unknown(error);
        } });
        this.watcher.on("error", error => this.unknown(error));
        await new Promise<void>((resolve, reject) => {
            const socket = createConnection(manifest.endpoint);
            this.socket = socket;
            let buf = "", ready = false;
            const timer = setTimeout(() => { socket.destroy(); reject(new Error("runner 连接超时。")); }, 3000);
            socket.on("error", e => { if (!ready)
                reject(e); });
            socket.on("connect", () => this.request("subscribe"));
            socket.on("data", d => {
                buf += d.toString();
                for (let i; (i = buf.indexOf("\n")) >= 0;) {
                    const raw = buf.slice(0, i);
                    buf = buf.slice(i + 1);
                    try {
                        const next = JSON.parse(raw);
                        if (next.error)
                            throw new Error(next.error);
                        if (next.snapshot?.runId !== this.snapshot.runId || next.epoch !== this.store.epoch)
                            throw new Error("runner 握手不匹配。");
                        if (start && !next.started) {
                            durableJson(path.join(this.dir, "grant.json"), { epoch: this.store.epoch });
                            this.store.setLaunch(this.snapshot.runId, { granted: true });
                            this.request("start");
                            continue;
                        }
                        if (!next.started && !["completed", "failed", "canceled"].includes(next.snapshot.status))
                            throw new Error("启动握手未完成，未自动重复启动，请核实。");
                        this.accept(next);
                        ready = true;
                        clearTimeout(timer);
                        resolve();
                    }
                    catch (error) {
                        clearTimeout(timer);
                        socket.destroy();
                        reject(error);
                    }
                }
            });
            socket.on("close", () => {
                clearTimeout(timer);
                if(!ready) {
                    if(this.state && ["completed","failed","canceled"].includes(this.state.snapshot.status))resolve();
                    else reject(new Error("runner 握手中断。"));
                } else if(!this.ended)this.reconnect();
            });
        });
    }
    private reconnect() {
        if (this.ended)
            return;
        try {
            if (this.terminal())
                return;
        }
        catch (error) {
            this.unknown(error);
            return;
        }
        if (this.retries++ >= 3) {
            this.unknown(new Error("runner 断开，已停止自动重连。"));
            return;
        }
        this.retryTimer = setTimeout(() => { void this.connect().catch(() => this.reconnect()); }, 250 * 2 ** this.retries);
    }
    private unknown(error: unknown) {
        this.snapshot.status = "unknown";
        this.snapshot.result = String(error);
        this.emit({ type: "unknown", snapshot: { ...this.snapshot }, requiresAttention: true, eventId: `${this.snapshot.runId}:recovery-unknown` });
        this.disconnect();
    }
    cancel() {
        this.store.assertOwner();
        if (this.ended)
            return;
        this.snapshot.status = "canceling";
        this.store.saveRun(this.snapshot);
        durableJson(path.join(this.dir, "cancel.json"), { epoch: this.store.epoch });
    }
    disconnect() { this.ended = true; if (this.retryTimer)
        clearTimeout(this.retryTimer); this.socket?.destroy(); this.watcher?.close(); }
    static async start(store: DurableStore, command: string, cwd: string, emit: (event: ExecutionEvent) => void): Promise<ManagedShell> {
        store.assertOwner();
        const runId = randomUUID(), taskId = `proc-${runId.slice(0, 8)}`;
        const dir = path.join(store.dir, "runs", runId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const snapshot: ExecutionSnapshot = { taskId, runId, kind: "shell", background: true, description: command, status: "running", runnerDir: dir, recovery: "runner" };
        const sb = sandboxSpawn(command, cwd);
        if (sb && "error" in sb)
            throw new Error(sb.error);
        const manifest: RunnerManifest = { sessionId: store.sessionId, taskId, runId, command, cwd, endpoint: path.join(tmpdir(), `dao-${runId}.sock`), spawnSpec: sb ?? undefined };
        store.saveRun(snapshot);
        store.setLaunch(runId, { granted: false, tool: toolExecution.getStore() });
        durableJson(path.join(dir, "manifest.json"), manifest);
        writeFileSync(path.join(dir, "capability"), randomUUID(), { mode: 0o600 });
        emit({ type: "started", snapshot });
        const main = fileURLToPath(new URL("../index.js", import.meta.url));
        const source = main.replace(/\.js$/, ".ts");
        const isSource = existsSync(source) && !main.includes("$bunfs");
        const args = process.versions.bun && main.includes("$bunfs") ? [] : [...(isSource && !process.versions.bun ? ["--import", createRequire(import.meta.url).resolve("tsx")] : []), isSource ? source : main];
        const child = spawn(process.execPath, [...args, "--dao-shell-runner", dir], { cwd, detached: true, stdio: "ignore", env: scrubbedEnv() });
        child.unref();
        const managed = new ManagedShell(store, snapshot, emit);
        try {
            await new Promise<void>((resolve, reject) => {
                let finished = false;
                const watcher = watch(dir, () => { if (existsSync(path.join(dir, "runner-state.json")))
                    finish(); });
                const timer = setTimeout(() => finish(new Error("runner 启动超时，未重复执行。")), 10000);
                const finish = (error?: Error) => { if (finished)
                    return; finished = true; clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(); };
                child.once("error", finish);
                child.once("exit", () => { if (!existsSync(path.join(dir, "runner-state.json")))
                    finish(new Error("runner 启动失败。")); });
                if (existsSync(path.join(dir, "runner-state.json")))
                    finish();
            });
            await managed.connect(true);
            return managed;
        }
        catch (error) {
            if(managed.state && ["completed","failed","canceled"].includes(managed.state.snapshot.status))return managed;
            managed.unknown(error);
            throw error;
        }
    }
}
