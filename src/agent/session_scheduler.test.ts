import { describe, it, expect, vi } from 'vitest';
import { Session } from '../session/session.js';
import { BackgroundRuntime } from './background_runtime.js';
import { SessionScheduler, type SchedulerDeps } from './session_scheduler.js';
import { deferred, execution, tick } from './background_test_helpers.js';
function setup(run: SchedulerDeps['run'], save: SchedulerDeps['save'] = () => {}) {
  const runtime = new BackgroundRuntime(); const session = new Session('SYS', 'model');
  const user = vi.fn(async (text: Parameters<SchedulerDeps['user']>[0]) => { session.addUser(text); });
  const scheduler = new SessionScheduler({ runtime, session, user, run, save });
  return { runtime, session, user, scheduler };
}
describe('SessionScheduler', () => {
  it('close resolves existing waiters after the active run settles', async () => {
    const done = deferred<void>();
    const { scheduler } = setup(async () => { await done.promise; return { kind: 'completed' }; });
    scheduler.submit('start'); await tick(); const settled = scheduler.settled(); const finished = scheduler.finished();
    scheduler.close(); done.resolve(); await Promise.all([settled, finished]); expect(scheduler.status().state).toBe('closed');
  });
  it('implicit wait saves before activation and save failure pauses without a leaked handle', async () => {
    const runtime = new BackgroundRuntime(); execution(runtime); const session = new Session('', 'm');
    const scheduler = new SessionScheduler({ runtime, session, user: async () => {}, run: async () => ({ kind: 'completed' }),
      keepAlive: true, save: () => { if (runtime.activeWaits) throw new Error('disk full'); } });
    scheduler.submit('start'); await scheduler.finished();
    expect(scheduler.status().state).toBe('paused'); expect(runtime.activeWaits).toBe(0); scheduler.close();
  });
  it('waits with zero model calls on progress/foreign success, resumes all once and delivers without user hook', async () => {
    const run = vi.fn<SchedulerDeps['run']>(); const { runtime, session, scheduler, user } = setup(run);
    const a = execution(runtime), b = execution(runtime, 'b'), c = execution(runtime, 'c');
    run.mockImplementationOnce(async () => ({ kind: 'waiting', wait: runtime.prepare({ ids: ['a', 'b'], mode: 'all' }).handle }))
      .mockResolvedValue({ kind: 'completed' });
    scheduler.submit('start'); await scheduler.settled();
    expect(scheduler.status().state).toBe('waiting');
    for (let i = 0; i < 100; i++) a.progress(); c.finish(); a.finish(); await tick();
    expect(run).toHaveBeenCalledTimes(1);
    b.finish(); await scheduler.finished();
    expect(run).toHaveBeenCalledTimes(2); expect(user).toHaveBeenCalledTimes(1);
    expect(session.messages.filter(m => String(m.content).includes('[后台任务数据'))).toHaveLength(1);
    expect(runtime.events()).toEqual([]); scheduler.close();
  });
  it('Esc retains events but prevents auto-resume until user input', async () => {
    const run = vi.fn<SchedulerDeps['run']>(); const { runtime, scheduler } = setup(run); const a = execution(runtime);
    run.mockImplementationOnce(async () => ({ kind: 'waiting', wait: runtime.prepare({ ids: ['a'], mode: 'any' }).handle })).mockResolvedValue({ kind: 'completed' });
    scheduler.submit('start'); await scheduler.settled(); scheduler.pause(); a.finish(); await tick();
    expect(scheduler.status().state).toBe('paused'); expect(run).toHaveBeenCalledTimes(1); expect(runtime.events()).toHaveLength(1);
    scheduler.submit('continue'); await scheduler.finished(); expect(run).toHaveBeenCalledTimes(2); expect(runtime.events()).toHaveLength(0);
    scheduler.close();
  });
  it('user input releases wait immediately, and late results never start concurrent model turns', async () => {
    const run = vi.fn<SchedulerDeps['run']>(); const { runtime, scheduler, user } = setup(run); const a = execution(runtime);
    const gate = deferred<void>(); let boundary!: () => Promise<void>;
    run.mockImplementationOnce(async () => ({ kind: 'waiting', wait: runtime.prepare({ ids: ['a'], mode: 'any' }).handle }))
      .mockImplementationOnce(async (_signal, cb) => { boundary = cb; await gate.promise; return { kind: 'completed' }; })
      .mockResolvedValue({ kind: 'completed' });
    scheduler.submit('start'); await scheduler.settled(); scheduler.submit('change plan'); await tick();
    expect(runtime.activeWaits).toBe(0); expect(run).toHaveBeenCalledTimes(2);
    a.finish(); scheduler.submit('more'); await tick(); expect(run).toHaveBeenCalledTimes(2);
    await boundary(); expect(user).toHaveBeenCalledTimes(3); expect(runtime.events()).toHaveLength(0);
    gate.resolve(); await scheduler.finished(); expect(run).toHaveBeenCalledTimes(2); scheduler.close();
  });
  it('failed save pauses, retries same delivery without duplicate append or losing events', async () => {
    const run = vi.fn<SchedulerDeps['run']>().mockResolvedValue({ kind: 'completed' }); let fail = true;
    const { runtime, session, scheduler } = setup(run, () => { if (fail) throw new Error('disk full'); });
    execution(runtime).finish(); await scheduler.settled();
    expect(run).not.toHaveBeenCalled(); expect(scheduler.status().state).toBe('paused'); expect(runtime.events()).toHaveLength(1);
    fail = false; scheduler.submit('retry'); await scheduler.finished();
    expect(run).toHaveBeenCalledTimes(1); expect(runtime.events()).toHaveLength(0);
    expect(session.messages.filter(m => String(m.content).includes('[后台任务数据'))).toHaveLength(1); scheduler.close();
  });
  it('submit during interrupted run waits for it to stop, then starts one new run', async () => {
    const gate = deferred<void>(); const run = vi.fn<SchedulerDeps['run']>()
      .mockImplementationOnce(async () => { await gate.promise; return { kind: 'interrupted', reason: 'user' }; })
      .mockResolvedValue({ kind: 'completed' });
    const { scheduler } = setup(run);
    scheduler.submit('start'); await tick(); scheduler.pause(); scheduler.submit('continue');
    expect(run).toHaveBeenCalledTimes(1); gate.resolve(); await scheduler.finished(); expect(run).toHaveBeenCalledTimes(2); scheduler.close();
  });
  it('hook-rejected input does not call model; reset invalidates earlier events', async () => {
    const run = vi.fn<SchedulerDeps['run']>().mockResolvedValue({ kind: 'completed' }); const { runtime, user, scheduler } = setup(run);
    user.mockImplementation(async () => false as never); scheduler.submit('blocked'); await scheduler.finished(); expect(run).not.toHaveBeenCalled();
    const a = execution(runtime); scheduler.reset(); a.finish(); await tick(); expect(run).not.toHaveBeenCalled(); scheduler.close();
  });
  it('headless completion creates implicit wait, ignores manual jobs and retains liveness until result', async () => {
    const runtime = new BackgroundRuntime(); const session = new Session('', 'm'); const a = execution(runtime);
    const run = vi.fn<SchedulerDeps['run']>().mockResolvedValue({ kind: 'completed' });
    const scheduler = new SessionScheduler({ runtime, session, run, save: () => {}, user: async () => {}, keepAlive: true });
    scheduler.submit('start'); await scheduler.settled(); expect(scheduler.status().state).toBe('waiting');
    let done = false; const finished = scheduler.finished().then(() => { done = true; }); await tick(); expect(done).toBe(false);
    a.finish(); await finished; expect(run).toHaveBeenCalledTimes(2); scheduler.close();
  });
});
