import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session } from '../session/session.js';
import { BackgroundRuntime } from './background_runtime.js';
import { SessionScheduler } from './session_scheduler.js';
import { runTurn, type TurnDeps } from './loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { taskWaitTool } from '../tools/task_wait.js';
import { executeToolCalls } from '../tools/execute.js';
import { processManager } from '../tools/process_manager.js';
import { createTaskManager } from './tasks.js';
import { taskUpdateTool } from '../tools/task_update.js';
import { deferred, execution, tick } from './background_test_helpers.js';
import type { AssistantMessage, StreamDelta, ToolCall } from '../client/types.js';
import type { ToolContext } from '../tools/types.js';
const gate: TurnDeps['gate'] = { decide: () => 'allow', decideAsync: async () => 'allow', requestBatch: async () => new Map() };
const call = (name: string, args: object, id = name): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function harness(runtime: BackgroundRuntime, script: AssistantMessage[], save: () => void | Promise<void> = () => {}) {
  const session = new Session('SYS', 'm'); session.addUser('start');
  const registry = new ToolRegistry(); registry.register(taskWaitTool);
  const ctx: ToolContext = { workspaceRoot: tmpdir() };
  let requests = 0;
  const deps: TurnDeps = { session, registry, ctx, gate, config: { baseUrl: 'https://unused', apiKey: 'unused' },
    backgroundRuntime: runtime, executeToolCalls, write: () => {}, onCheckpoint: save,
    streamChat: (() => (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
      const message = script[requests++]; if (!message) throw new Error('unexpected model request'); return message;
    })()) as TurnDeps['streamChat'] };
  return { session, ctx, deps, requests: () => requests };
}
describe('background waiting end to end', () => {
  afterEach(() => { processManager.reset(); });
  it('TaskWait persists paired tool result, returns waiting and does not request model until completion', async () => {
    const runtime = new BackgroundRuntime(); const a = execution(runtime); const saved: unknown[] = [];
    const h = harness(runtime, [{ role: 'assistant', content: null, tool_calls: [call('TaskWait', { ids: ['a'] })] }, { role: 'assistant', content: 'done' }], () => { saved.push(structuredClone(h.session.messages)); });
    const scheduler = new SessionScheduler({ runtime, session: h.session, save: h.deps.onCheckpoint!, user: async () => {},
      run: (signal, onBoundary) => runTurn({ ...h.deps, signal, onBoundary }) });
    scheduler.submit('go'); await scheduler.settled();
    expect(h.requests()).toBe(1); expect(scheduler.status().state).toBe('waiting');
    expect(h.session.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'TaskWait', content: expect.stringContaining('waiting') });
    expect(saved.at(-1)).toEqual(h.session.messages);
    for (let i = 0; i < 50; i++) a.progress(); await tick(); expect(h.requests()).toBe(1);
    a.finish(); await scheduler.finished(); expect(h.requests()).toBe(2); expect(runtime.events()).toEqual([]); expect(runtime.diagnostics().modelRequestsWhileWaiting).toBe(0); scheduler.close();
  });
  it('completion while wait result is saving is not lost, and does not run a concurrent turn', async () => {
    const runtime = new BackgroundRuntime(); const a = execution(runtime); const gateSave = deferred<void>();
    const h = harness(runtime, [{ role: 'assistant', content: null, tool_calls: [call('TaskWait', { ids: ['a'] })] }], () => gateSave.promise);
    const running = runTurn(h.deps); await tick(); a.finish(); expect(h.requests()).toBe(1); gateSave.resolve();
    const result = await running; expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('missing wait'); expect(runtime.ready(result.wait)).toBe(true); runtime.dispose();
  });
  it('save failure and abort roll back provisional wait while retaining pending terminal event', async () => {
    const runtime = new BackgroundRuntime(); execution(runtime).finish();
    const h = harness(runtime, [{ role: 'assistant', content: null, tool_calls: [call('TaskWait', { ids: ['a'] })] }], () => { throw new Error('disk full'); });
    expect(await runTurn(h.deps)).toMatchObject({ kind: 'failed', error: expect.objectContaining({ message: 'disk full' }) }); expect(runtime.activeWaits).toBe(0); expect(runtime.events()).toHaveLength(1);
    const ac = new AbortController();
    const second = harness(runtime, [{ role: 'assistant', content: null, tool_calls: [call('TaskWait', { ids: ['a'] })] }], () => { ac.abort(); });
    expect(await runTurn({ ...second.deps, signal: ac.signal })).toEqual({ kind: 'interrupted', reason: 'user' });
    expect(runtime.activeWaits).toBe(0); expect(runtime.events()).toHaveLength(1); runtime.dispose();
  });
  it('already terminal ready result is saved/acked once, then model continues normally', async () => {
    const runtime = new BackgroundRuntime(); execution(runtime).finish();
    const h = harness(runtime, [{ role: 'assistant', content: null, tool_calls: [call('TaskWait', { ids: ['a'] })] }, { role: 'assistant', content: 'done' }]);
    expect(await runTurn(h.deps)).toEqual({ kind: 'completed' }); expect(h.requests()).toBe(2);
    expect(runtime.activeWaits).toBe(0); expect(runtime.events()).toEqual([]); runtime.dispose();
  });
  it('mixed batches reject waits only and preserve other tools/permissions, including duplicate waits', async () => {
    const runtime = new BackgroundRuntime(); execution(runtime);
    const h = harness(runtime, []); const tm = createTaskManager(); const id = tm.create('todo'); h.ctx.taskManager = tm; h.deps.registry.register(taskUpdateTool);
    const request = vi.fn(); h.ctx.requestTaskWait = request;
    const results = await executeToolCalls([call('TaskWait', { ids: ['a'] }, 'w1'), call('TaskUpdate', { id, status: 'completed' }), call('TaskWait', { ids: ['a'] }, 'w2')], h.deps.registry, h.ctx, gate);
    expect(request).not.toHaveBeenCalled(); expect(results).toHaveLength(3); expect(results[0]?.content).toMatch(/^Error:/); expect(results[2]?.content).toMatch(/^Error:/); expect(tm.get(id)?.status).toBe('completed'); runtime.dispose();
  });
  it('post-tool hook failure rolls back via control channel, and attention text is never acked by snapshot-only ready result', async () => {
    const runtime = new BackgroundRuntime(); const a = execution(runtime); a.attention();
    const h = harness(runtime, [{ role: 'assistant', content: null, tool_calls: [call('TaskWait', { ids: ['a'] })] }, { role: 'assistant', content: 'retry later' }]);
    h.ctx.postToolHook = async () => { throw new Error('hook failed'); };
    expect(await runTurn(h.deps)).toEqual({ kind: 'completed' });
    expect(runtime.activeWaits).toBe(0); expect(runtime.events()).toHaveLength(1);
    const second = harness(runtime, [{ role: 'assistant', content: null, tool_calls: [call('TaskWait', { ids: ['a'] })] }, { role: 'assistant', content: 'handle message' }]);
    await runTurn(second.deps);
    expect(runtime.events()[0]?.message).toBe('needs decision'); runtime.dispose();
  });
  it('missing runtime/subagent execution is rejected; read-only plan exposes schema', async () => {
    const { apiToolsForMode } = await import('../tools/tools_for_mode.js');
    const runtime = new BackgroundRuntime(); const h = harness(runtime, []);
    expect(await taskWaitTool.handler({ ids: ['a'], mode: 'any' }, h.ctx)).toMatch(/^Error:/);
    const request = vi.fn(); expect(await taskWaitTool.handler({ ids: ['a'], mode: 'any' }, { ...h.ctx, subagentDepth: 1, requestTaskWait: request })).toMatch(/^Error:/);
    expect(request).not.toHaveBeenCalled(); expect(apiToolsForMode(h.deps.registry, 'plan')[0]?.function.name).toBe('TaskWait'); runtime.dispose();
  });
  it('real shell close wakes once, logs are complete and event delivery does not consume output cursor', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dao-wait-shell-')); const runtime = new BackgroundRuntime([processManager], root);
    try {
      const id = processManager.start("printf 'first\\nlast\\n'", root);
      const h = harness(runtime, [{ role: 'assistant', content: null, tool_calls: [call('TaskWait', { ids: [id] })] }, { role: 'assistant', content: 'done' }]);
      const scheduler = new SessionScheduler({ runtime, session: h.session, save: () => {}, user: async () => {}, run: (signal, onBoundary) => runTurn({ ...h.deps, signal, onBoundary }), keepAlive: true });
      scheduler.submit('go'); await scheduler.finished();
      expect(scheduler.lastError).toBeUndefined(); expect(h.requests()).toBe(2); expect(processManager.poll(id).stdout).toBe('first\nlast\n'); expect(runtime.events()).toEqual([]); scheduler.close();
    } finally { runtime.dispose(); processManager.reset(); rmSync(root, { recursive: true, force: true }); }
  });
  it('executor reset confirms cancellation of old run without overwriting a reused shell ID', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dao-wait-reset-')); const runtime = new BackgroundRuntime([processManager], root);
    try {
      const old = processManager.start('sleep 30', root);
      const oldWait = runtime.prepare({ ids: [old], mode: 'any' }).handle;
      processManager.reset();
      const fresh = processManager.start('printf new', root);
      expect(fresh).toBe(old);
      const newWait = runtime.prepare({ ids: [fresh], mode: 'any' }).handle;
      await new Promise<void>(resolve => {
        const unsubscribe = runtime.subscribe(() => {
          if (runtime.result(oldWait)[0]?.status === 'canceled' && runtime.result(newWait)[0]?.status === 'completed') { unsubscribe(); resolve(); }
        });
      });
      expect(runtime.snapshot(fresh)?.status).toBe('completed'); expect(runtime.result(oldWait)[0]?.status).toBe('canceled');
    } finally { runtime.dispose(); processManager.reset(); rmSync(root, { recursive: true, force: true }); }
  });
  it('canceling is not terminal until executor acknowledges; manual update cannot forge completion', async () => {
    const tm = createTaskManager(); const runtime = new BackgroundRuntime([tm]); const done = deferred<string>(); const id = tm.launch('work', () => done.promise);
    const w = runtime.prepare({ ids: [id], mode: 'all' }).handle;
    expect(await taskUpdateTool.handler({ id, status: 'completed' }, { workspaceRoot: tmpdir(), taskManager: tm })).toContain('运行时');
    expect(tm.cancel(id)).toBe(true); expect(runtime.snapshot(id)?.status).toBe('canceling'); expect(runtime.ready(w)).toBe(false);
    done.resolve('partial'); await tick(); expect(runtime.snapshot(id)?.status).toBe('canceled'); expect(runtime.ready(w)).toBe(true); expect(runtime.events()).toHaveLength(1); runtime.dispose();
  });
});
