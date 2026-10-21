import {createHash} from "node:crypto";
import {mkdirSync} from "node:fs";
import path from "node:path";
import {durableText} from "../session/durable_file.js";
import {clampOutput} from "../tools/output.js";
import { toolExecution } from "../session/tool_execution.js";
import type { DurableStore, BackgroundCheckpoint } from "../session/durable_store.js";
import { spillOutput } from "../tools/spill.js";
import { randomUUID } from "node:crypto";
import { isTerminal, type BackgroundEvent, type ExecutionEvent, type ExecutionSnapshot, type ExecutionSource, type WaitHandle, type WaitRequest } from "./background_types.js";

/** In-memory event inbox. Only the scheduler acknowledges events; observers never consume them. */
export class BackgroundRuntime {
  sessionId: string = randomUUID();
  store?: DurableStore;
  fault?: Error;
  private desiredState: BackgroundCheckpoint["state"] = "idle";
  private consumed = new Set<string>();
  private readyWaits = new Set<string>();
  private disposedCheckpoint?: BackgroundCheckpoint;
  bind(store: DurableStore) {
    this.store = store; this.sessionId = store.sessionId;
    this.disposedCheckpoint=undefined;this.fault=undefined;this.consumed.clear();this.readyWaits.clear();this.activated.clear();this.seq=0;
    this.runs.clear(); this.latest.clear(); this.inbox.clear(); this.waits.clear();
    for (const s of store.runs()) { this.runs.set(s.runId,s); this.latest.set(s.taskId,s.runId); }
    for (const e of store.pendingEvents()) { this.inbox.set(e.eventId,e); this.seq = Math.max(this.seq,e.seq); }
    const checkpoint = store.background();
    this.desiredState = checkpoint?.state ?? "idle";
    if (checkpoint?.wait) this.waits.set(checkpoint.wait.waitId,checkpoint.wait);
    return checkpoint;
  }
  checkpoint(): BackgroundCheckpoint {
    if (this.disposedCheckpoint) return this.disposedCheckpoint;
    const wait = [...this.waits.values()].find(w=>!this.readyWaits.has(w.waitId));
    return {sessionId:this.sessionId,state:wait ? "waiting" : this.desiredState,wait,runs:[...this.runs.values()],events:this.events(),seq:this.seq,consumed:[...this.consumed]};
  }
  setState(state: BackgroundCheckpoint["state"], persist = false) { this.desiredState=state; if(persist) this.store?.setState(state); }
  stageConsumed(ids: string[]) { ids.forEach(id=>this.consumed.add(id)); }
  unstageConsumed(ids: string[]) { ids.forEach(id=>this.consumed.delete(id)); }
  markReady(handle: WaitHandle) { this.readyWaits.add(handle.waitId); }
  private seq = 0;
  readonly counters = { waitsRegistered: 0, waitsReleased: 0, wakesScheduled: 0, eventsDelivered: 0, eventsDeduplicated: 0, modelRequests: 0, modelRequestsWhileWaiting: 0, waitDurationMs: 0 };
  private activated = new Map<string, number>();
  record(name: string, fields: Record<string, string | number> = {}) {
    try { this.trace?.(name, { sessionId: this.sessionId, ...fields }); } catch { /* diagnostics never control execution */ }
  }
  activate(handle: WaitHandle) {
    if (!this.waits.has(handle.waitId)) throw new Error("等待已失效。");
    this.activated.set(handle.waitId, Date.now());
    this.record("wait_activated", { waitId: handle.waitId, count: handle.targets.length });
  }
  modelRequested() { this.counters.modelRequests++; if (this.activated.size) this.counters.modelRequestsWhileWaiting++; }
  diagnostics() { return { ...this.counters, activeWaits: this.waits.size, subscribers: this.listeners.size, pendingEvents: this.inbox.size }; }
  private runs = new Map<string, ExecutionSnapshot>();
  private latest = new Map<string, string>();
  private inbox = new Map<string, BackgroundEvent>();
  private waits = new Map<string, WaitHandle>();
  private listeners = new Set<() => void>();
  private unsubscribers: (() => void)[];
  private closed = false;
  constructor(sources: ExecutionSource[] = [], private workspaceRoot = process.cwd(), private trace?: (name: string, fields: Record<string, string | number>) => void) {
    this.unsubscribers = sources.map((s) => s.subscribe((e) => this.publish(e)));
  }
  renderResult(text: string) {
    if(!this.store)return spillOutput(text,this.workspaceRoot,24000);
    if(text.length<=24000)return text;
    const hash=createHash("sha256").update(text).digest("hex"),dir=path.join(this.store.dir,"results"),file=path.join(dir,`${hash}.txt`);
    mkdirSync(dir,{recursive:true,mode:0o700});durableText(file,text);this.store.addAttachment(file,hash);
    return clampOutput(text,24000)+`\n[完整输出已持久保存：${file}]`;
  }
  subscribe(cb: () => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private notify() { for (const listener of this.listeners) listener(); }
  publish(event: ExecutionEvent) {
    if (this.closed || !event.snapshot.background) return;
    const s = event.snapshot;
    const old = this.runs.get(s.runId);
    if (event.type !== "started" && !old) return; // old session/run after a reset
    if (old && isTerminal(old.status) && old.status !== "interrupted" && event.type !== "unknown") { this.counters.eventsDeduplicated++; this.record("event_deduplicated", { taskId: s.taskId, runId: s.runId }); return; }
    const producesEvent = event.type !== "progress" && event.type !== "started" && (event.type !== "message" || event.requiresAttention);
    try { if (!producesEvent) this.store?.atomic(()=>{
      this.store!.saveRun(s);
      if(event.type==="started" && s.kind==="agent")this.store!.setLaunch(s.runId,{tool:toolExecution.getStore()});
    }); } catch (error) { this.fault=error as Error; this.notify(); return; }
    this.runs.set(s.runId, { ...s });
    if (event.type === "started") this.latest.set(s.taskId, s.runId);
    if (producesEvent) {
      const seq = ++this.seq;
      let e: BackgroundEvent = { ...event, snapshot: { ...s }, sessionId: this.sessionId, seq, eventId: event.eventId ?? (["completed","failed","canceled"].includes(event.type) ? `${s.runId}:terminal` : `${s.runId}:${event.type}:${randomUUID()}`) };
      try { if (this.store) e = this.store.event(e); } catch(error) { this.fault=error as Error; this.notify(); return; }
      this.seq=Math.max(this.seq,e.seq);
      if (!this.store?.delivered(e.eventId)) this.inbox.set(e.eventId, e);
    }
    this.gc();
    this.notify();
  }
  snapshot(id: string) { const run = this.latest.get(id); return run ? this.runs.get(run) : undefined; }
  snapshots() { return [...this.latest.values()].flatMap((id) => this.runs.get(id) ?? []); }
  running() { return this.snapshots().filter((s) => s.status === "running" || s.status === "canceling"); }
  events() { return [...this.inbox.values()]; }
  acknowledge(ids: string[]) {
    let count = 0; for (const id of ids) { this.consumed.delete(id); if (this.inbox.delete(id)) count++; }
    this.counters.eventsDelivered += count;
    if (count) this.record("event_delivered", { count });
    this.gc();
  }
  prepare(request: WaitRequest): { handle: WaitHandle; ready: boolean } {
    const ids = [...new Set(request.ids)];
    if (!ids.length || ids.length > 32) throw new Error("TaskWait 需要 1–32 个不同任务 ID。");
    const targets = ids.map((taskId) => {
      const s = this.snapshot(taskId);
      if (s?.status === "unknown" || s?.status === "interrupted") throw new Error(`任务 ${taskId} 需要恢复核实，不能等待未知执行。`);
      if (!s) throw new Error(`不可等待任务 ${taskId}:不是当前会话的后台执行。`);
      return { taskId, runId: s.runId };
    });
    const handle: WaitHandle = { waitId: randomUUID(), sessionId: this.sessionId, targets, mode: request.mode, observedSeq: this.seq };
    this.waits.set(handle.waitId, handle);
    this.counters.waitsRegistered++; this.record("wait_registered", { waitId: handle.waitId, count: targets.length, mode: handle.mode });
    return { handle, ready: this.ready(handle) };
  }
  ready(handle: WaitHandle): boolean {
    if (!this.waits.has(handle.waitId) || handle.sessionId !== this.sessionId) throw new Error("等待已失效。");
    const targets = handle.targets.map((t) => this.runs.get(t.runId));
    if (targets.some((s) => !s)) throw new Error("等待目标已失效。");
    if (targets.some((s) => s!.status === "failed" || s!.status === "canceled" || s!.status === "interrupted" || s!.status === "unknown")) return true;
    if (this.events().some((e) => e.requiresAttention || e.type === "failed" || e.type === "canceled")) return true;
    return handle.mode === "all" ? targets.every((s) => s!.status === "completed") : targets.some((s) => s!.status === "completed");
  }
  result(handle: WaitHandle) { return handle.targets.map((t) => ({ ...this.runs.get(t.runId)! })); }
  resultEventIds(handle: WaitHandle) {
    return this.events().filter((e) => e.type !== "message" && handle.targets.some((t) => t.runId === e.snapshot.runId)).map((e) => e.eventId);
  }
  release(handle: WaitHandle) {
    this.readyWaits.delete(handle.waitId);
    if (this.waits.delete(handle.waitId)) {
      const started = this.activated.get(handle.waitId);
      const durationMs = started === undefined ? 0 : Date.now() - started;
      this.activated.delete(handle.waitId);
      this.counters.waitsReleased++; this.counters.waitDurationMs += durationMs;
      this.record("wait_released", { waitId: handle.waitId, durationMs });
    }
    this.gc();
  }
  get activeWaits() { return this.waits.size; }
  private gc() {
    const pinned = new Set([...this.waits.values()].flatMap((w) => w.targets.map((t) => t.runId)));
    for (const e of this.inbox.values()) pinned.add(e.snapshot.runId);
    const finished = [...this.runs.values()].filter((s) => isTerminal(s.status) && !pinned.has(s.runId));
    for (const s of finished.slice(0, Math.max(0, finished.length - 200))) {
      this.runs.delete(s.runId);
      if (this.latest.get(s.taskId) === s.runId) this.latest.delete(s.taskId);
    }
  }
  reset() {
    for (const handle of this.waits.values()) this.release(handle);
    this.consumed.clear(); this.readyWaits.clear();
    this.activated.clear(); this.waits.clear(); this.inbox.clear(); this.runs.clear(); this.latest.clear(); this.notify();
  }
  dispose() { this.disposedCheckpoint ??= this.checkpoint(); this.closed = true; this.unsubscribers.forEach((fn) => fn()); this.unsubscribers = []; this.reset(); this.listeners.clear(); }
}

/** Each runTurn has its own controller. No control state is stored in the shared tool context. */
export class WaitControl {
  private handle?: WaitHandle;
  private readyResult = false;
  private consumed: string[] = [];
  constructor(readonly runtime: BackgroundRuntime) {}
  request(request: WaitRequest): string {
    this.rollback();
    const { handle, ready } = this.runtime.prepare(request);
    this.handle = handle; this.readyResult = ready;
    this.consumed = ready ? this.runtime.resultEventIds(handle) : [];
    if (ready) this.runtime.markReady(handle);
    this.runtime.stageConsumed(this.consumed);
    return JSON.stringify({ status: ready ? "ready" : "waiting", waitId: handle.waitId, mode: handle.mode, targets: this.runtime.result(handle).map((s) => ({ ...s, result: s.result === undefined ? undefined : this.runtime.renderResult(s.result) })) });
  }
  commit(): WaitHandle | undefined {
    const handle = this.handle;
    this.handle = undefined;
    this.runtime.acknowledge(this.consumed); this.consumed = [];
    if (handle && this.readyResult) { this.runtime.release(handle); return; }
    return handle;
  }
  rollback() { this.runtime.unstageConsumed(this.consumed); if (this.handle) this.runtime.release(this.handle); this.handle = undefined; this.consumed = []; }
  get pending() { return !!this.handle; }
}
