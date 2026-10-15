import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";
import { msg } from "./lang.js";

export const execShellKillTool = defineTool({
  name: "KillShell",
  description: "终止某个后台进程(Bash 的 background=true 启动的)——杀的是整个进程组(SIGTERM)," +
    "命令自己再拉起的子进程也会一起终止,不会留下孤儿进程。approval 是 auto:语义是清理一个你自己已经批准过" +
    "在跑的后台任务,不是发起新的有风险动作,不需要再确认一遍。发送请求不等于已经退出,状态" +
    "以实际退出事件为准;日志仍可读取。典型场景:后台起了个开发服务器/watch 进程,任务做完了要收尾," +
    "或者中途发现起错了命令,用这个把它结束掉,别让它一直占着端口/进程空跑。杀掉一个不存在/早已退出的 id 不会报错," +
    "只是提示信号已发送,自行用 BashOutput 确认真实状态。",
  descriptionEn: "Terminates a background process (started via Bash's background=true) — kills the entire process group (SIGTERM), " +
    "so any child processes the command spawned are terminated too, no orphans left behind. approval is auto: the semantics are cleaning up a " +
    "background task you already approved earlier, not initiating a new risky action, so no extra confirmation is needed. A cancellation request is not confirmation of exit; wait for the executor to close. Logs remain readable. Typical use: " +
    "you started a dev server/watch process in the background and the task is wrapping up, or you realize mid-way you started the wrong command — kill it " +
    "rather than leaving it occupying a port or running idle. Killing a nonexistent or already-exited id doesn't error — it just reports the signal was sent; " +
    "confirm the actual state yourself via BashOutput.",
  capability: "exec",
  approval: "auto",
  schema: z.object({
    id: z.string().describe("Bash 返回的后台进程 id"),
  }),
  handler: async (args) => {
    let recovery: string | undefined;
    try {
      recovery = await processManager.kill(args.id);
    } catch {
      // 未知 id(不存在或已被 reset 清理)——描述里承诺"不会报错",返回友好提示而非抛错。
      return msg(`${args.id} 不存在或已清理,无需终止。`, `${args.id} does not exist or has already been cleaned up; nothing to terminate.`);
    }
    const base = msg(`已向 ${args.id} 请求终止;执行器退出后才确认 canceled。`, `Requested termination of ${args.id}; canceled is confirmed only after executor exit.`);
    return recovery ? `${base}\n${recovery}` : base;
  },
});
