import type { ContentPart } from "../client/types.js";
import type { Session } from "../session/session.js";
import { BackgroundDelivery } from "./background_delivery.js";
import type { BackgroundRuntime } from "./background_runtime.js";
import type { SessionState, TurnOutcome, WaitHandle } from "./background_types.js";

export interface SchedulerStatus { state: SessionState; waiting?: { count: number; mode: "any" | "all" }; runningTasks: number }
export interface SchedulerDeps {
  runtime: BackgroundRuntime;
  session: Session;
  save: () => void | Promise<void>;
  run: (signal: AbortSignal, boundary: () => Promise<void>) => Promise<TurnOutcome>;
  user: (text: string | ContentPart[]) => Promise<boolean | void>;
  notice?: (text: string) => void;
  // headless: preserve existing "wait for remaining background work before exit" behavior.
  keepAlive?: boolean;
}

export class SessionScheduler {
  private state: SessionState = "idle";
  private wait?: WaitHandle;
  private inputs: (string | ContentPart[])[] = [];
  private listeners = new Set<(status: SchedulerStatus) => void>();
  private controller?: AbortController;
  private active = false;
  private scheduled = false;
  private delivery: BackgroundDelivery;
  private unsubscribe: () => void;
  private epoch = 0;
  lastError?: Error;
  readonly counters = { runCalls: 0, failures: 0 };
  constructor(private deps: SchedulerDeps) {
    if(deps.runtime.store) this.state="recovering";
    this.delivery = new BackgroundDelivery(deps.session, deps.runtime, deps.save);
    this.unsubscribe = deps.runtime.subscribe(() => {
      if(deps.runtime.fault){this.pause();this.lastError=deps.runtime.fault;deps.notice?.(`[持久化失败，已暂停] ${this.lastError.message}`);}
      this.notify(); this.schedule();
    });
  }
  recover() {
    this.state="recovering";
    const b=this.deps.runtime.store?.background();
    if(!b) {this.state="idle";this.notify();return;}
    const unsafe=this.deps.runtime.snapshots().some(s=>s.status==="unknown"||s.status==="interrupted") || !!this.deps.runtime.store?.unresolved().length;
    if(b.state==="waiting" && b.wait && !unsafe) {
      this.wait=b.wait;
      try {this.deps.runtime.ready(b.wait);this.state="waiting";this.deps.runtime.activate(b.wait);}
      catch(error){this.state="paused";this.deps.notice?.(`[等待恢复失败] ${String(error)}`);}
    } else this.state=b.state==="paused"||b.state==="running"||unsafe||this.deps.runtime.events().length?"paused":"idle";
    if(this.state==="paused") {this.wait??=b.wait;this.release();this.deps.runtime.setState("paused",true);this.deps.notice?.("[恢复已暂停] 请查看任务和未决操作后明确继续。\n");}
    this.notify();this.schedule();
  }
  status(): SchedulerStatus { return { state: this.state, waiting: this.wait ? { count: this.wait.targets.length, mode: this.wait.mode } : undefined, runningTasks: this.deps.runtime.running().length }; }
  subscribe(cb: (status: SchedulerStatus) => void) { this.listeners.add(cb); cb(this.status()); return () => { this.listeners.delete(cb); }; }
  private notify() { for (const cb of this.listeners) cb(this.status()); }
  private release() { if (this.wait) this.deps.runtime.release(this.wait); this.wait = undefined; }
  hasQueued(text: string) { return this.inputs.includes(text); }
  submit(text: string | ContentPart[]) {
    if (this.state === "closed") return;
    this.inputs.push(text); this.lastError = undefined;
    this.release();
    if (!this.active || this.state === "paused") this.state = "idle";
    this.schedule();
  }
  pause(persist = true) {
    if (this.state === "closed") return;
    this.state = "paused"; this.inputs = []; this.release(); this.controller?.abort();
    this.deps.runtime.setState("paused");
    if(persist) {try {this.deps.runtime.setState("paused",true);} catch(error) {this.lastError=error as Error;this.deps.notice?.(`[暂停未能保存] ${this.lastError.message}`);}}
    this.notify();
  }
  reset() { this.pause(); this.epoch++; if(!this.deps.runtime.store)this.deps.runtime.reset(); this.delivery.reset(); this.lastError = undefined; this.state = "idle"; this.notify(); }
  close() {
    if (this.state === "closed") return;
    this.controller?.abort(); this.inputs=[]; this.state = "closed"; this.unsubscribe(); this.deps.runtime.dispose(); this.notify();
    if (!this.active) this.listeners.clear();
  }
  private canRun() {
    if (this.state === "paused" || this.state === "closed" || this.state === "recovering") return false;
    if(this.deps.runtime.fault) return true;
    if (this.inputs.length) return true;
    if (this.wait) return this.deps.runtime.ready(this.wait);
    return this.deps.runtime.events().length > 0;
  }
  private schedule() {
    if (this.active || this.scheduled || !this.canRun()) return;
    this.scheduled = true;
    this.deps.runtime.counters.wakesScheduled++;
    this.deps.runtime.record("wake_scheduled", { reason: this.inputs.length ? "user" : this.wait ? "wait_ready" : "event", count: this.deps.runtime.events().length });
    queueMicrotask(() => { this.scheduled = false; void this.pump(); this.notify(); });
  }
  private async boundary(): Promise<boolean> {
    if (this.state === "paused" || this.state === "closed" || this.controller?.signal.aborted) return false;
    let accepted = false;
    while (this.inputs.length) {
      const input = this.inputs.shift()!;
      accepted = (await this.deps.user(input)) !== false || accepted;
      if (this.controller?.signal.aborted) return false;
    }
    const events = this.deps.runtime.events();
    await this.delivery.deliver(events);
    if (accepted && !events.length) await this.deps.save();
    return accepted || events.length > 0;
  }
  private async run() {
    this.counters.runCalls++;
    return this.deps.run(this.controller!.signal, async () => { await this.boundary(); });
  }
  private async pump() {
    if (this.active || !this.canRun()) return;
    if(!this.inputs.length && (this.deps.runtime.snapshots().some(s=>s.status==="unknown"||s.status==="interrupted") || this.deps.runtime.store?.unresolved().length)) {
      this.pause(); this.deps.notice?.("[恢复需核实] 后台执行或工具结果不确定，请用 /recovery 查看。\n");return;
    }
    this.active = true;
    const epoch = this.epoch;
    this.release(); this.state = "running";
    this.controller = new AbortController(); this.notify();
    try {
      if(this.deps.runtime.fault)throw this.deps.runtime.fault;
      this.deps.runtime.setState("running");
      const work = await this.boundary();
      const result = this.controller.signal.aborted ? { kind: "interrupted" as const, reason: "user" as const } : !work ? { kind: "completed" as const } : await this.run();
      if (epoch !== this.epoch || this.status().state === "closed" || this.status().state === "paused") {
        if (result.kind === "waiting") this.deps.runtime.release(result.wait);
        return;
      }
      if (result.kind === "failed") throw result.error;
      if (result.kind === "interrupted") this.state = this.inputs.length ? "idle" : "paused";
      else if (result.kind === "waiting") { this.wait = result.wait; this.state = "waiting"; this.deps.runtime.setState("waiting"); this.deps.runtime.activate(result.wait); }
      else {
        this.state = "idle";this.deps.runtime.setState("idle",true);
        const running = this.deps.runtime.running();
        if (this.deps.keepAlive && running.length) {
          this.wait = this.deps.runtime.prepare({ ids: running.slice(0, 32).map((s) => s.taskId), mode: "any" }).handle;
          await this.deps.save();
          if (!this.wait || epoch !== this.epoch || this.status().state === "paused" || this.status().state === "closed") return;
          this.state = "waiting";
          this.deps.runtime.activate(this.wait);
        }
      }
    } catch (error) {
      if (epoch !== this.epoch || this.status().state === "closed") return;
      this.counters.failures++;
      this.release(); this.lastError = error instanceof Error ? error : new Error(String(error));
      if (this.status().state !== "closed") { this.state = "paused"; try {this.deps.runtime.setState("paused",true);}catch{} this.deps.notice?.(`[会话已暂停] ${this.lastError.message}`); }
    } finally {
      this.active = false; this.controller = undefined; this.schedule(); this.notify();
      if (this.status().state === "closed") this.listeners.clear();
    }
  }
  /** Resolves when the current turn yields (including waiting), without consuming events. */
  async settled() {
    await Promise.resolve();
    if (!this.active && !this.scheduled) return;
    await new Promise<void>((resolve) => {
      const cb = () => { if (!this.active && !this.scheduled) { this.listeners.delete(cb); resolve(); } };
      this.listeners.add(cb); cb();
    });
  }
  /** CLI liveness: no polling, and no orphan readLine promises. */
  async finished() {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      const cb = () => {
        if (this.active || this.scheduled) return;
        if (this.state === "closed" || this.state === "paused" || (!this.wait && !this.inputs.length && !this.deps.runtime.events().length)) {
          this.listeners.delete(cb); resolve();
        }
      };
      this.listeners.add(cb); cb();
    });
  }
}
