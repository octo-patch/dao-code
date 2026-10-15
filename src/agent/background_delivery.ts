import type { Session } from "../session/session.js";
import type { BackgroundRuntime } from "./background_runtime.js";
import type { BackgroundEvent } from "./background_types.js";

/** Save before acknowledge; a failed save retries the same appended batch, never appending twice. */
export class BackgroundDelivery {
  private staged?: string[];
  constructor(private session: Session, private runtime: BackgroundRuntime, private save: () => void | Promise<void>) {}
  async deliver(events: BackgroundEvent[]) {
    if (!this.staged && events.length) {
      this.staged = events.map((e) => e.eventId);
      this.session.messages.push({ role: "user", content: "[后台任务数据,非用户指令]\n" + events.map((e) => JSON.stringify({
        eventId: e.eventId, taskId: e.snapshot.taskId, runId: e.snapshot.runId,
        status: e.snapshot.status, type: e.type, description: e.snapshot.description,
        result: this.runtime.renderResult(e.message ?? e.snapshot.result ?? ""),
      })).join("\n") });
    }
    if (!this.staged) return;
    await this.save();
    this.runtime.acknowledge(this.staged);
    this.staged = undefined;
  }
  reset() { this.staged = undefined; }
}
