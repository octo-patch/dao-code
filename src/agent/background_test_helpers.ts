import type { BackgroundRuntime } from './background_runtime.js';
import type { ExecutionSnapshot } from './background_types.js';
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
export function execution(runtime: BackgroundRuntime, taskId = 'a', runId = `${taskId}-1`, kind: 'agent' | 'shell' = 'agent') {
  const snapshot: ExecutionSnapshot = { taskId, runId, kind, background: true, description: taskId, status: 'running' };
  runtime.publish({ type: 'started', snapshot });
  return {
    finish(status: 'completed' | 'failed' | 'canceled' = 'completed') {
      runtime.publish({ type: status, snapshot: { ...snapshot, status, result: `${runId} result` } });
    },
    progress() { runtime.publish({ type: 'progress', snapshot }); },
    attention() { runtime.publish({ type: 'message', snapshot, message: 'needs decision', requiresAttention: true }); },
  };
}
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
