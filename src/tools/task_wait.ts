import { z } from "zod";
import { defineTool } from "./types.js";
export const taskWaitTool = defineTool({
  name: "TaskWait",
  description: "等待当前会话的后台子代理或 Shell 结果。没有独立工作时单独调用本工具,不要循环 TaskOutput/BashOutput 或 sleep。ids 为任务 ID,mode=any 等任一完成,all 等全部成功;失败、取消、需要处理的问题会提前唤醒。等待期间用户仍可输入。手动待办和前台任务不可等待。",
  descriptionEn: "Wait for background agent or shell results without polling. Call alone when no independent work remains. any waits for one completion; all for all successes. Failure, cancellation, attention, or user input wakes the session. Manual todos and foreground tasks cannot be waited on.",
  capability: "read", approval: "auto",
  schema: z.object({ ids: z.array(z.string().min(1)).min(1), mode: z.enum(["any", "all"]).default("any") }),
  handler: async (args, ctx) => {
    if (!ctx.requestTaskWait || (ctx.subagentDepth ?? 0) > 0) return "Error: 当前环境不支持 TaskWait。";
    return ctx.requestTaskWait(args);
  },
});
