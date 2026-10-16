import { createServer, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, watch } from "node:fs";
import path from "node:path";
import { durableJson } from "../session/durable_file.js";
import { processIdentity, type ProcessIdentity } from "../session/process_identity.js";
import { scrubbedEnv } from "./safe_env.js";
import type { ExecutionSnapshot } from "../agent/background_types.js";
export interface RunnerManifest {
    sessionId: string;
    taskId: string;
    runId: string;
    command: string;
    cwd: string;
    endpoint: string;
    spawnSpec?: {
        file: string;
        args: string[];
    };
}
export interface RunnerState {
    snapshot: ExecutionSnapshot;
    identity: ProcessIdentity;
    epoch: number;
    childIdentity?: ProcessIdentity;
    started: boolean;
    exitCode?: number | null;
    signal?: string | null;
}
export async function runShellRunner(dir: string): Promise<void> {
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as RunnerManifest;
    const token = readFileSync(path.join(dir, "capability"), "utf8");
    const state: RunnerState = { snapshot: { taskId: manifest.taskId, runId: manifest.runId, kind: "shell", background: true, description: manifest.command, status: "running", recovery: "runner", runnerDir: dir }, identity: processIdentity()!, epoch: 0, started: false };
    const clients = new Set<Socket>();
    let child: ChildProcess | undefined, canceled = false, finished = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveFinished!: () => void;
    const done = new Promise<void>(r => { resolveFinished = r; });
    const persist = () => durableJson(path.join(dir, "runner-state.json"), state);
    const broadcast = () => { const line = JSON.stringify(state) + "\n"; for (const socket of clients)
        socket.write(line); };
    const settle = (code: number | null, signal: string | null, error?: string) => {
        if (finished)
            return;
        finished = true;
        if (startupTimer)
            clearTimeout(startupTimer);
        state.exitCode = code;
        state.signal = signal;
        state.snapshot.status = canceled ? "canceled" : code === 0 ? "completed" : "failed";
        state.snapshot.result = `exit=${code}, signal=${signal}; stdout: ${path.join(dir, "stdout.log")}; stderr: ${path.join(dir, "stderr.log")}${error ? `; ${error}` : ""}`;
        try {
            for (const name of ["stdout.log", "stderr.log"]) {
                const fd = openSync(path.join(dir, name), "a", 0o600);
                try {
                    fsyncSync(fd);
                }
                finally {
                    closeSync(fd);
                }
            }
            durableJson(path.join(dir, "terminal.json"), state);
            persist();
            broadcast();
        }
        finally {
            for (const socket of clients)
                socket.end();
            server.close();
            cancelWatch.close();
            resolveFinished();
        }
    };
    const cancel = () => {
        if (finished || canceled)
            return;
        canceled = true;
        state.snapshot.status = "canceling";
        persist();
        broadcast();
        if (child?.pid) {
            try {
                process.kill(-child.pid, "SIGTERM");
            }
            catch { }
        }
        else
            settle(null, "canceled-before-start");
    };
    const start = () => {
        if (state.started || finished)
            return;
        const grant = JSON.parse(readFileSync(path.join(dir, "grant.json"), "utf8")) as {
            epoch: number;
        };
        if (grant.epoch !== state.epoch)
            throw new Error("启动许可已过期。");
        if (existsSync(path.join(dir, "start.claim")))
            throw new Error("执行已被启动，不允许重复启动。");
        const claim = openSync(path.join(dir, "start.claim"), "wx", 0o600);
        fsyncSync(claim);
        closeSync(claim);
        const parent = openSync(dir, "r");
        fsyncSync(parent);
        closeSync(parent);
        state.started = true;
        if (startupTimer)
            clearTimeout(startupTimer);
        persist();
        if (existsSync(path.join(dir, "cancel.json"))) {
            cancel();
            return;
        }
        const out = openSync(path.join(dir, "stdout.log"), "a", 0o600), err = openSync(path.join(dir, "stderr.log"), "a", 0o600);
        try {
            const options = { cwd: manifest.cwd, detached: true, stdio: ["ignore", out, err] as [
                    "ignore",
                    number,
                    number
                ], env: scrubbedEnv() };
            child = manifest.spawnSpec ? spawn(manifest.spawnSpec.file, manifest.spawnSpec.args, options) : spawn(manifest.command, { ...options, shell: true });
            child.once("error", e => settle(-1, null, e.message));
            child.once("close", (code, signal) => settle(code, signal));
            try {
                if (child.pid)
                    state.childIdentity = processIdentity(child.pid) ?? undefined;
            }
            catch { /* runner remains the authority over this live child */ }
            persist();
            broadcast();
        }
        finally {
            closeSync(out);
            closeSync(err);
        }
    };
    const server = createServer(socket => {
        let buffer = "";
        socket.on("error", () => { });
        socket.on("close", () => clients.delete(socket));
        socket.on("data", data => {
            buffer += data.toString();
            if (buffer.length > 65536) {
                socket.destroy();
                return;
            }
            for (let i; (i = buffer.indexOf("\n")) >= 0;) {
                const line = buffer.slice(0, i);
                buffer = buffer.slice(i + 1);
                try {
                    const request = JSON.parse(line);
                    if (request.token !== token || request.runId !== manifest.runId || !Number.isSafeInteger(request.epoch) || request.epoch < state.epoch) {
                        socket.destroy();
                        return;
                    }
                    if (request.epoch > state.epoch) {
                        for (const old of clients)
                            if (old !== socket)
                                old.destroy();
                        state.epoch = request.epoch;
                        persist();
                    }
                    clients.add(socket);
                    if (request.action === "start")
                        start();
                    else if (request.action === "cancel")
                        cancel();
                    socket.write(JSON.stringify(state) + "\n");
                }
                catch (e) {
                    socket.write(JSON.stringify({ error: (e as Error).message }) + "\n");
                }
            }
        });
    });
    const cancelWatch = watch(dir, () => { if (existsSync(path.join(dir, "cancel.json")))
        cancel(); });
    try {
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(manifest.endpoint, resolve); });
        persist();
        startupTimer = setTimeout(() => { if (!state.started)
            cancel(); }, 30000);
        if (existsSync(path.join(dir, "cancel.json")))
            cancel();
        process.once("SIGTERM", cancel);
        process.once("SIGINT", cancel);
        await done;
    }
    finally {
        server.close();
        cancelWatch.close();
        try {
            unlinkSync(manifest.endpoint);
        }
        catch { }
    }
}
