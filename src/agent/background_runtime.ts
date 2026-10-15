import { spillOutput } from "../tools/spill.js";
import { randomUUID } from "node:crypto";
import { isTerminal, type BackgroundEvent, type ExecutionEvent, type ExecutionSnapshot, type ExecutionSource, type WaitHandle, type WaitRequest } from "./background_types.js";

/** In-memory event inbox. Only the scheduler acknowledges events; observers never consume them. */
export class BackgroundRuntime {
  readonly sessionId = randomUUID();
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
  renderResult(text: string) { return spillOutput(text, this.workspaceRoot, 24000); }
  subscribe(cb: () => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private notify() { for (const listener of this.listeners) listener(); }
  publish(event: ExecutionEvent) {
    if (this.closed || !event.snapshot.background) return;
    const s = event.snapshot;
    const old = this.runs.get(s.runId);
    if (event.type !== "started" && !old) return; // old session/run after a reset
    if (old && isTerminal(old.status)) { this.counters.eventsDeduplicated++; this.record("event_deduplicated", { taskId: s.taskId, runId: s.runId }); return; }
    this.runs.set(s.runId, { ...s });
    if (event.type === "started") this.latest.set(s.taskId, s.runId);
    if (event.type !== "progress" && event.type !== "started" && (event.type !== "message" || event.requiresAttention)) {
      const seq = ++this.seq;
      const e = { ...event, snapshot: { ...s }, sessionId: this.sessionId, seq, eventId: `${this.sessionId}:${seq}` };
      this.inbox.set(e.eventId, e);
    }
    this.gc();
    this.notify();
  }
  snapshot(id: string) { const run = this.latest.get(id); return run ? this.runs.get(run) : undefined; }
  snapshots() { return [...this.latest.values()].flatMap((id) => this.runs.get(id) ?? []); }
  running() { return this.snapshots().filter((s) => !isTerminal(s.status)); }
  events() { return [...this.inbox.values()]; }
  acknowledge(ids: string[]) {
    let count = 0; for (const id of ids) if (this.inbox.delete(id)) count++;
    this.counters.eventsDelivered += count;
    if (count) this.record("event_delivered", { count });
    this.gc();
  }
  prepare(request: WaitRequest): { handle: WaitHandle; ready: boolean } {
    const ids = [...new Set(request.ids)];
    if (!ids.length || ids.length > 32) throw new Error("TaskWait 需要 1–32 个不同任务 ID。");
    const targets = ids.map((taskId) => {
      const s = this.snapshot(taskId);
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
    if (targets.some((s) => s!.status === "failed" || s!.status === "canceled")) return true;
    if (this.events().some((e) => e.requiresAttention || e.type === "failed" || e.type === "canceled")) return true;
    return handle.mode === "all" ? targets.every((s) => s!.status === "completed") : targets.some((s) => s!.status === "completed");
  }
  result(handle: WaitHandle) { return handle.targets.map((t) => ({ ...this.runs.get(t.runId)! })); }
  resultEventIds(handle: WaitHandle) {
    return this.events().filter((e) => e.type !== "message" && handle.targets.some((t) => t.runId === e.snapshot.runId)).map((e) => e.eventId);
  }
  release(handle: WaitHandle) {
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
    this.activated.clear(); this.waits.clear(); this.inbox.clear(); this.runs.clear(); this.latest.clear(); this.notify();
  }
  dispose() { this.closed = true; this.unsubscribers.forEach((fn) => fn()); this.unsubscribers = []; this.reset(); this.listeners.clear(); }
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
    return JSON.stringify({ status: ready ? "ready" : "waiting", waitId: handle.waitId, mode: handle.mode, targets: this.runtime.result(handle).map((s) => ({ ...s, result: s.result === undefined ? undefined : this.runtime.renderResult(s.result) })) });
  }
  commit(): WaitHandle | undefined {
    const handle = this.handle;
    this.handle = undefined;
    this.runtime.acknowledge(this.consumed); this.consumed = [];
    if (handle && this.readyResult) { this.runtime.release(handle); return; }
    return handle;
  }
  rollback() { if (this.handle) this.runtime.release(this.handle); this.handle = undefined; this.consumed = []; }
  get pending() { return !!this.handle; }
}
