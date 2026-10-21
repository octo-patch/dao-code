import { describe, it, expect } from 'vitest';
import { BackgroundRuntime, WaitControl } from './background_runtime.js';
import { execution } from './background_test_helpers.js';
import { createTaskManager } from './tasks.js';

describe('BackgroundRuntime', () => {
  it.each(['any', 'all'] as const)('mixed agent/shell %s waits and unrelated completion buffering', (mode) => {
    const runtime = new BackgroundRuntime();
    const a = execution(runtime, 'a'), b = execution(runtime, 'b', 'b-1', 'shell'), c = execution(runtime, 'c');
    const { handle, ready } = runtime.prepare({ ids: ['a', 'b', 'a'], mode });
    expect(handle.targets).toHaveLength(2); expect(ready).toBe(false);
    c.finish(); a.progress(); expect(runtime.ready(handle)).toBe(false);
    a.finish(); expect(runtime.ready(handle)).toBe(mode === 'any');
    b.finish(); expect(runtime.ready(handle)).toBe(true);
    runtime.release(handle); expect(runtime.activeWaits).toBe(0);
  });
  it.each(['failed', 'canceled', 'attention'] as const)('unrelated %s interrupts all wait', (kind) => {
    const runtime = new BackgroundRuntime(); execution(runtime, 'a'); const b = execution(runtime, 'b');
    const { handle } = runtime.prepare({ ids: ['a'], mode: 'all' });
    if (kind === 'attention') b.attention(); else b.finish(kind);
    expect(runtime.ready(handle)).toBe(true);
  });
  it('validates all targets atomically, excludes manual/foreground, enforces distinct limit', () => {
    const tm = createTaskManager(); const runtime = new BackgroundRuntime([tm]);
    const manual = tm.create('todo'); tm.registerAgentForeground({ agentId: 'fg', description: 'foreground' });
    execution(runtime, 'a');
    for (const id of ['missing', manual, 'fg']) expect(() => runtime.prepare({ ids: ['a', id], mode: 'any' })).toThrow();
    expect(runtime.activeWaits).toBe(0);
    expect(() => runtime.prepare({ ids: [], mode: 'any' })).toThrow();
    expect(() => runtime.prepare({ ids: Array.from({ length: 33 }, (_, i) => `${i}`), mode: 'any' })).toThrow();
    const h = runtime.prepare({ ids: Array(50).fill('a'), mode: 'any' }).handle;
    expect(h.targets).toHaveLength(1);
    runtime.dispose();
  });
  it('completion before prepare is ready; completion during save remains visible after commit', () => {
    const runtime = new BackgroundRuntime(); const a = execution(runtime); const control = new WaitControl(runtime);
    expect(JSON.parse(control.request({ ids: ['a'], mode: 'any' })).status).toBe('waiting');
    a.finish(); const h = control.commit()!;
    expect(runtime.ready(h)).toBe(true); expect(runtime.events()).toHaveLength(1);
    runtime.release(h);
    const ready = new WaitControl(runtime);
    expect(JSON.parse(ready.request({ ids: ['a'], mode: 'any' })).status).toBe('ready');
    expect(runtime.events()).toHaveLength(1); // not acked before save
    expect(ready.commit()).toBeUndefined(); expect(runtime.events()).toHaveLength(0);
  });
  it('wait binds runId; duplicate/late terminal cannot overwrite new execution', () => {
    const tm = createTaskManager(); const runtime = new BackgroundRuntime([tm]);
    const old = tm.registerAsyncAgent({ agentId: 'same', description: 'old' });
    const h = runtime.prepare({ ids: ['same'], mode: 'any' }).handle;
    tm.update('same', { status: 'completed', result: 'old' }, old.runId);
    const current = tm.registerAsyncAgent({ agentId: 'same', description: 'new' });
    expect(current.runId).not.toBe(old.runId);
    expect(tm.update('same', { status: 'failed' }, old.runId)).toBe(false);
    expect(tm.appendMessage('same', { role: 'assistant', content: 'stale' }, old.runId)).toBe(false);
    expect(runtime.result(h)[0]?.result).toBe('old'); expect(runtime.snapshot('same')?.status).toBe('running');
    runtime.dispose();
  });
  it('pinned result survives history GC and releases; repeated waits leave no handles', () => {
    const runtime = new BackgroundRuntime(); const a = execution(runtime); const h = runtime.prepare({ ids: ['a'], mode: 'all' }).handle;
    a.finish(); runtime.acknowledge(runtime.events().map(e => e.eventId));
    for (let i = 0; i < 1000; i++) {
      execution(runtime, `t${i}`).finish(); const w = runtime.prepare({ ids: [`t${i}`], mode: 'any' }).handle;
      runtime.acknowledge(runtime.events().map(e => e.eventId)); runtime.release(w);
    }
    expect(runtime.result(h)[0]?.result).toBe('a-1 result'); expect(runtime.activeWaits).toBe(1);
    runtime.release(h); expect(runtime.activeWaits).toBe(0); expect(runtime.snapshots().length).toBeLessThanOrEqual(200);
  });
  it('progress has no inbox entry; reset/dispose reject previous execution events', () => {
    const runtime = new BackgroundRuntime(); const a = execution(runtime); a.progress(); expect(runtime.events()).toEqual([]);
    runtime.reset(); a.finish(); expect(runtime.events()).toEqual([]);
    runtime.dispose(); execution(runtime, 'b').finish(); expect(runtime.events()).toEqual([]);
  });
});
