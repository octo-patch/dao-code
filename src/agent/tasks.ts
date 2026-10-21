// 后台任务管理器 + 通知队列:让子代理可异步后台跑,主循环不阻塞;完成后把结果作为
// <task-notification> 入队,主循环在后续回合注入给模型(CC 的异步任务 + 消息队列模型)。

import { randomUUID } from "node:crypto";
import { isTerminal, type ExecutionEvent, type ExecutionSnapshot, type ExecutionStatus, type MessageKind } from "./background_types.js";
import type { ChatMessage } from "../client/types.js";

export interface BgTask {
  id: string;
  runId: string;
  kind: "manual" | "agent" | "promise";
  description: string;
  status: ExecutionStatus;
  result?: string;
  error?: string;
  startedAt: number;
  background?: boolean; // 真正异步运行的任务;手动待办和前台任务不靠完成通知唤醒
  endedAt?: number;
  // 新增:进度/摘要/agent 类型
  summary?: string;
  messages?: ChatMessage[];
  agentType?: string;
}

export interface TaskManager {
  restore(snapshot: ExecutionSnapshot, messages?: ChatMessage[]): void;
  clearRestored(): void;
  // 后台启动一个任务(run 收到 signal 与自身 id),立即返回 task id。
  launch(description: string, run: (signal: AbortSignal, id: string) => Promise<string>): string;
  // 接管一个已在运行的 promise,交给 TaskManager 追踪:完成/失败时入队通知。不可取消。
  adopt(description: string, promise: Promise<string>): string;
  // 手动建一个任务(不背靠任何 promise/进程)——纯状态追踪,配合 update() 手动推进。
  create(description: string): string;
  // 手动更新一个任务(仅对 create() 建的、或已结束的任务生效;运行中的 launch/adopt 任务由 promise 驱动,
  // 不接受手动改 status,防止和自动结算打架——但 description 任何时候都能改)。
  // status 改为 completed/failed 时,和 promise 结算路径一样入队 <task-notification>。
  update(id: string, patch: { status?: "completed" | "failed" | "canceled"; result?: string; description?: string }, runId?: string): boolean;
  // 前台任务在"没有转后台、正常跑完"这条路径上结算:running -> completed,但不入队 <task-notification>
  // (结果已经作为工具调用本身的返回值同步交给父代理了,再入队会在下一回合边界重复投递同一个结果)。
  // 只做状态收尾,好让 cancelAll()/TaskStop 别把一个早就跑完的前台任务当成还在运行的任务去"中止"。
  // status 默认 completed;runOne 内部抛错时传 "failed" 结算(错误本身已经作为异常同步抛给父代理)。
  settle(id: string, status?: "completed" | "failed"): boolean;
  // 给运行中的任务追加一条消息(SendMessage),由其在下一个工具回合边界消费。
  send(id: string, message: string): boolean;
  // 运行中任务给父代理发一条 mid-run 消息(进度/发现/提问):入通知队列 + 触发 onChange。
  emitFromTask(id: string, message: string, kind?: MessageKind, runId?: string): boolean;
  // 取出并清空某任务的待消费消息(子代理 runTurn 在回合边界调用)。
  drainPending(id: string): string[];
  drainNotifications(): string[]; // 取出并清空待通知(已完成/失败任务的 XML 通知)
  hasPending(): boolean;
  running(): BgTask[];
  all(): BgTask[]; // 全部任务(含已结束),供 TaskList 工具查询历史
  get(id: string): BgTask | undefined;
  cancel(id: string): boolean;
  cancelAll(): void;
  subscribe(cb: (event: ExecutionEvent) => void): () => void;
  onChange(cb: () => void): void; // 任务状态变化(启动/完成/失败/取消)时回调,驱动 UI 刷新与通知处理
  // 前台 agent 注册。taskId 恒等于 agentId(与 registerAsyncAgent 用同一套 id 空间)——此前这里
  // 另起一个 task-N 计数器,和子代理自己的 agentId 是两套不相干的 id,导致 TaskSend/cancel 用
  // task-N 发消息,而子代理的 drainPending 却用 agentId 去读,两边永远对不上号,消息发了等于没发。
  // 内部自建 abortController 并随结果返回(与 registerAsyncAgent 同一套写法)——调用方不用自己
  // new 一个再传进来,这样 cancel()/TaskStop 才能真正中止这个还在跑的子代理,而不是只翻状态位。
  // 前台就是前台:同步等到它跑完,不会被任何计时器悄悄转后台——需要后台就在派发时显式声明
  // (Agent 工具的 background 参数),真要中途打断一个跑太久的前台调用,用户自己 ESC。
  registerAgentForeground(opts: { agentId: string; description: string }): { taskId: string; abortController: AbortController };
  // 新增:后台 agent 注册(独立 AbortController)
  registerAsyncAgent(opts: { agentId: string; description: string }): { agentId: string; runId: string; abortController: AbortController };
  // 新增:更新任务摘要
  updateSummary(taskId: string, summary: string, runId?: string): boolean;
  // 新增:追加消息到任务的实时消息列表
  appendMessage(taskId: string, message: ChatMessage, runId?: string): boolean;
}

// 转义注入文本里的 XML 元字符:description/result/message 来自用户任务或子代理输出,
// 可能含 < > &(甚至字面 </message>),不转义会破坏父代理对通知块的解析。
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function notificationXml(t: BgTask): string {
  const body = t.status === "completed" ? (t.result ?? "") : (t.error ?? "");
  return [
    `<task-notification>`,
    `<task-id>${t.id}</task-id>`,
    `<description>${escapeXml(t.description)}</description>`,
    `<status>${t.status}</status>`,
    `<result>`,
    escapeXml(body),
    `</result>`,
    `</task-notification>`,
  ].join("\n");
}

function taskMessageXml(t: BgTask, message: string): string {
  return [
    `<task-message>`,
    `<task-id>${t.id}</task-id>`,
    `<description>${escapeXml(t.description)}</description>`,
    `<message>`,
    escapeXml(message),
    `</message>`,
    `</task-message>`,
  ].join("\n");
}

export function createTaskManager(): TaskManager {
  const tasks = new Map<string, BgTask>();
  const controllers = new Map<string, AbortController>();
  const pending = new Map<string, string[]>(); // 各任务待消费消息(SendMessage)
  const notifications: string[] = [];
  let counter = 0;
  let onChangeCb: (() => void) | undefined;
  const notify = () => onChangeCb?.();
  const listeners = new Set<(event: ExecutionEvent) => void>();
  const publish = (t: BgTask, type: ExecutionEvent["type"], message?: string, requiresAttention = false) => {
    if (t.kind === "manual") { notify(); return; }
    const event: ExecutionEvent = { type, message, requiresAttention, snapshot: {
      taskId: t.id, runId: t.runId, kind: "agent", background: !!t.background,
      description: t.description, status: t.status, result: t.result ?? t.error, progress: t.summary,
    } };
    for (const listener of listeners) listener(event);
    notify();
  };
  const finish = (t: BgTask, status: "completed" | "failed", result: string) => {
    if (tasks.get(t.id) !== t || isTerminal(t.status)) return;
    t.status = t.status === "canceling" ? "canceled" : status;
    if (t.status === "completed") t.result = result; else t.error = result;
    t.endedAt = Date.now();
    controllers.delete(t.id);
    if (t.background && !listeners.size) notifications.push(notificationXml(t));
    publish(t, t.status);
    gcFinished();
  };

  // 已结束任务保留供 TaskList(include_finished) 查历史,但无限累积会泄漏内存。
  // 超过上限时删掉最老的已结束任务及其 controllers/pending 残留。
  const MAX_FINISHED_TASKS = 200;
  const gcFinished = () => {
    let finished = 0;
    for (const t of tasks.values()) if (isTerminal(t.status)) finished++;
    if (finished <= MAX_FINISHED_TASKS) return;
    // 按 endedAt 升序排已结束任务,删最老的直到不超限
    const old = [...tasks.values()]
      .filter((t) => isTerminal(t.status))
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    const toRemove = old.slice(0, finished - MAX_FINISHED_TASKS);
    for (const t of toRemove) {
      tasks.delete(t.id);
      controllers.delete(t.id);
      pending.delete(t.id);
    }
  };

  const cancelOne = (id: string): boolean => {
    const t = tasks.get(id);
    if (!t || t.status !== "running") return false;
    const ac = controllers.get(id);
    if (t.kind !== "manual" && !ac) return false; // adopt 的 promise 无可取消执行器
    if (t.kind === "manual") { t.status = "canceled"; t.endedAt = Date.now(); }
    else t.status = "canceling";
    ac?.abort();
    publish(t, "progress");
    return true;
  };

  return {
    clearRestored() { if(controllers.size) throw new Error("仍有子代理运行，不能切换会话。"); tasks.clear();pending.clear();notifications.length=0; },
    restore(s,messages) { tasks.set(s.taskId,{id:s.taskId,runId:s.runId,kind:"agent",description:s.description,status:s.status,result:s.result,background:true,startedAt:Date.now(),messages}); },
    launch(description, run) {
      const id = `task-${++counter}`;
      const ac = new AbortController();
      const t: BgTask = { id, runId: randomUUID(), kind: "promise", description, status: "running", startedAt: Date.now(), background: true };
      tasks.set(id, t);
      controllers.set(id, ac);
      publish(t, "started");
      let execution: Promise<string>;
      try { execution = run(ac.signal, id); } catch (error) { execution = Promise.reject(error); }
      execution.then(
        (result) => finish(t, "completed", result),
        (e) => finish(t, "failed", e instanceof Error ? e.message : String(e)),
      );
      return id;
    },
    adopt(description, promise) {
      const id = `task-${++counter}`;
      const t: BgTask = { id, runId: randomUUID(), kind: "promise", description, status: "running", startedAt: Date.now(), background: true };
      tasks.set(id, t);
      publish(t, "started");
      promise.then(
        (result) => finish(t, "completed", result),
        (e) => finish(t, "failed", e instanceof Error ? e.message : String(e)),
      );
      return id;
    },
    create(description) {
      const id = `task-${++counter}`;
      const t: BgTask = { id, runId: randomUUID(), kind: "manual", description, status: "running", startedAt: Date.now() };
      tasks.set(id, t);
      notify();
      return id;
    },
    update(id, patch, runId) {
      const t = tasks.get(id);
      if (!t || (runId && t.runId !== runId)) return false;
      if (patch.description !== undefined) t.description = patch.description;
      if (patch.status !== undefined) {
        if (isTerminal(t.status)) return false; // 已结束的任务不可再改状态(防止和自动结算的通知重复)
        t.status = t.status === "canceling" ? "canceled" : patch.status;
        t.endedAt = Date.now();
        controllers.delete(id);
        if (patch.result !== undefined) {
          if (t.status === "completed") t.result = patch.result;
          else t.error = patch.result;
        }
        if (t.kind !== "manual" && !listeners.size) notifications.push(notificationXml(t));
        publish(t, t.status);
        gcFinished();
      }
      notify();
      return true;
    },
    settle(id, status = "completed") {
      const t = tasks.get(id);
      if (!t || isTerminal(t.status)) return false;
      t.status = t.status === "canceling" ? "canceled" : status;
      t.endedAt = Date.now();
      controllers.delete(id);
      gcFinished();
      notify();
      return true;
    },
    send(id, message) {
      const t = tasks.get(id);
      if (!t || t.status !== "running") return false;
      (pending.get(id) ?? pending.set(id, []).get(id)!).push(message);
      return true;
    },
    emitFromTask(id, message, kind = "attention", runId) {
      const t = tasks.get(id);
      if (!t || t.status !== "running" || (runId && t.runId !== runId)) return false;
      if (kind === "attention" && !listeners.size) notifications.push(taskMessageXml(t, message));
      if (kind === "progress") t.summary = message;
      publish(t, kind === "progress" ? "progress" : "message", message, kind === "attention");
      return true;
    },
    drainPending(id) {
      const q = pending.get(id);
      if (!q || q.length === 0) return [];
      pending.set(id, []);
      return q;
    },
    drainNotifications() {
      return notifications.splice(0);
    },
    hasPending() {
      return notifications.length > 0;
    },
    running() {
      return [...tasks.values()].filter((t) => !isTerminal(t.status));
    },
    all() {
      return [...tasks.values()];
    },
    get(id) {
      return tasks.get(id);
    },
    cancel: cancelOne,
    cancelAll() {
      // 遍历所有 running 任务,而非只遍历 controllers——create() 建的手动任务没有 controller,
      // 不在 controllers 里,只遍历 controllers 会漏掉它们,导致退出时这些任务永远挂着 running。
      for (const t of tasks.values()) if (t.status === "running") cancelOne(t.id);
    },
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    onChange(cb) {
      onChangeCb = cb;
    },
    registerAgentForeground(opts) {
      const id = opts.agentId;
      const ac = new AbortController();
      tasks.set(id, { id, runId: randomUUID(), kind: "agent", description: opts.description, status: "running", startedAt: Date.now() });
      controllers.set(id, ac);
      notify();
      return { taskId: id, abortController: ac };
    },
    registerAsyncAgent(opts) {
      const id = opts.agentId;
      const ac = new AbortController();
      tasks.set(id, { id, runId: randomUUID(), kind: "agent", description: opts.description, status: "running", startedAt: Date.now(), background: true });
      controllers.set(id, ac);
      notify();
      publish(tasks.get(id)!, "started");
      return { agentId: id, runId: tasks.get(id)!.runId, abortController: ac };
    },
    updateSummary(taskId, summary, runId) {
      const t = tasks.get(taskId);
      if (!t || (runId && t.runId !== runId)) return false;
      t.summary = summary;
      publish(t, "progress", summary);
      return true;
    },
    appendMessage(taskId, message, runId) {
      const t = tasks.get(taskId);
      if (!t || (runId && t.runId !== runId)) return false;
      if (!t.messages) t.messages = [];
      t.messages.push(message);
      return true;
    },
  };
}
