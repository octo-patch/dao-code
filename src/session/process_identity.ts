import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
export interface ProcessIdentity {
    host: string;
    boot: string;
    pid: number;
    start: string;
}
let boot: string | undefined;
function bootIdentity(): string {
    if (boot)
        return boot;
    if (process.platform === "linux")
        boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    else if (process.platform === "darwin")
        boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
    else
        throw new Error("后台恢复只支持已验证的 macOS/Linux 进程身份。");
    return boot;
}
export function processIdentity(pid = process.pid): ProcessIdentity | null {
    try {
        process.kill(pid, 0);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH")
            return null;
        throw e;
    }
    let start: string;
    if (process.platform === "linux") {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    }
    else if (process.platform === "darwin") {
        start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    }
    else
        throw new Error("当前平台无法核实后台进程身份。");
    if (!start)
        throw new Error(`无法核实进程 ${pid} 的启动身份。`);
    return { host: hostname(), boot: bootIdentity(), pid, start };
}
export function identityAlive(identity: ProcessIdentity): boolean {
    if (identity.host !== hostname())
        throw new Error("会话来自另一台机器，不能自动接管。");
    if (identity.boot !== bootIdentity())
        return false;
    const now = processIdentity(identity.pid);
    return !!now && now.start === identity.start;
}
