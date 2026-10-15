import { z } from "zod";
import { defineTool } from "./types.js";
import type { ChatMessage } from "../client/types.js";

function trunc(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n)}…(截断)` : s;
}

function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join(" ");
}

// 把一条消息渲染成一行摘要;不值得展示的(空 content 的 system/user 等)返回 null。
function renderMessage(m: ChatMessage): string | null {
  if (m.role === "assistant") {
    const parts: string[] = [];
    if (m.content) parts.push(trunc(m.content));
    for (const tc of m.tool_calls ?? []) parts.push(`[调用 ${tc.function.name}] ${trunc(tc.function.arguments)}`);
    return parts.length ? parts.join("\n") : null;
  }
  if (m.role === "tool") {
    const text = textOf(m.content).trim();
    return text ? `[结果] ${trunc(text)}` : null;
  }
  if (m.role === "user") {
    const text = textOf(m.content).trim();
    return text ? `[追加消息] ${trunc(text)}` : null;
  }
  return null;
}

// 按任务对象保存增量游标,避免不同管理器的同名 id 串数据。完成后仍保留游标,
// 防止重复查询重放全部消息;任务被回收后 WeakMap 自动释放。
const cursors = new WeakMap<object, number>();

export const taskOutputTool = defineTool({
  name: "TaskOutput",
  description: "完成后会自动通知。仅在需要检查中间进展或用户询问时调用,不要连续轮询;没有其他工作时单独调用 TaskWait 等待所需任务。" +
    "增量读取某个【后台子代理】任务自上次调用以来新产生的中间消息(思考/工具调用/工具结果),让你在任务还在跑" +
    "的时候看到进度,不用干等 TaskGet 给最终结果。每次调用推进读取位置,不会重复看到同一条消息;未读消息保留到下次查询" +
    "(TaskGet 随时能查最终结果/报错,不受影响)。仅对 agent(background:true) 真正派发的子代理任务有效——" +
    "这类任务从子代理产生每条消息起就实时记录;TaskCreate 手动建的任务没有中间消息可看,调用会提示改用 TaskGet。" +
    "典型场景:派了个跑很久的子代理去调研/改代码,过一会儿想知道'它现在做到哪一步了',用这个看最近几步在干什么," +
    "而不是盯着 TaskList 的 running 状态干等。",
  descriptionEn: "Completion is delivered automatically. Do not poll repeatedly; call TaskWait alone when no independent work remains. " +
    "Incrementally reads new intermediate messages (reasoning/tool calls/tool results) a background subagent task has produced since " +
    "the last call — lets you see progress while it's still running, instead of waiting for TaskGet's final result. Each call advances the read cursor, " +
    "so messages are not repeated; unread messages remain available on the next call. TaskGet's final result/error is unaffected. " +
    "Only works for tasks genuinely dispatched via agent(background:true) — those record every message in real time as the subagent produces it. " +
    "Tasks manually created via TaskCreate have no intermediate messages; calling this on one tells you to use TaskGet instead. Typical use: you " +
    "dispatched a long-running research/coding subagent and want to know 'where is it right now' — use this to see its recent steps, rather than " +
    "staring at TaskList's running status waiting.",
  capability: "read",
  approval: "auto",
  // 不再 defer,见 task_create.ts 顶部注释(2026-07-28)。
  schema: z.object({
    id: z.string().min(1).describe("任务 id(来自 TaskList/agent(background:true) 的返回)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪。";
    const t = ctx.taskManager.get(args.id);
    if (!t) return `未找到任务 ${args.id}。`;
    if (!t.messages || t.messages.length === 0) {
      return t.status === "running"
        ? "该任务暂无中间消息(可能是刚启动的子代理,还没产生第一条消息;也可能是 TaskCreate 手动建的任务,本来就没有中间输出)。完成后会自动通知,不要连续查询;手动任务可用 TaskGet 查看详情。"
        : `该任务没有记录中间消息(通常是 TaskCreate 手动建的任务)。用 TaskGet 查看最终结果。`;
    }
    const from = cursors.get(t) ?? 0;
    const fresh = t.messages.slice(from);
    cursors.set(t, t.messages.length);
    const lines = fresh.map(renderMessage).filter((l): l is string => l !== null);
    if (lines.length === 0) {
      return `状态: ${t.status}(自上次查询以来没有新消息)。完成后会自动通知,不要连续查询。`;
    }
    return [`状态: ${t.status}`, ...lines].join("\n");
  },
});
