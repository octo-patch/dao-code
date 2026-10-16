// Real GLM + real CLI SIGKILL recovery acceptance; no model/HTTP stubs.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, watch } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const script = fileURLToPath(import.meta.url), repo = path.resolve(path.dirname(script), '..');
if (process.env.DAO_RECOVERY_CHILD) {
    const root = process.env.DAO_RECOVERY_CHILD, stage = process.env.DAO_RECOVERY_STAGE;
    const log = (type, data = {}) => { const event = { at: Date.now(), stage, type, ...data }; appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify(event) + '\n'); process.send?.(event); };
    const { BackgroundRuntime } = await import(pathToFileURL(path.join(repo, 'src/agent/background_runtime.ts')));
    const { SessionScheduler } = await import(pathToFileURL(path.join(repo, 'src/agent/session_scheduler.ts')));
    let runtime, scheduler;
    const active = new Set();
    const record = BackgroundRuntime.prototype.record;
    BackgroundRuntime.prototype.record = function (type, fields) { runtime = this; log(type, fields); return record.call(this, type, fields); };
    const activate = BackgroundRuntime.prototype.activate;
    BackgroundRuntime.prototype.activate = function (handle) { active.add(handle.waitId); const result = activate.call(this, handle); log('checkpoint_wait', { sessionId: this.sessionId }); return result; };
    const release = BackgroundRuntime.prototype.release;
    BackgroundRuntime.prototype.release = function (handle) { active.delete(handle.waitId); return release.call(this, handle); };
    const recover = SessionScheduler.prototype.recover;
    SessionScheduler.prototype.recover = function () { scheduler = this; const result = recover.call(this); log('recovered', { status: this.status() }); return result; };
    process.on('message', m => { if (m === 'pause') {
        scheduler.pause();
        log('paused');
    } });
    const realFetch = globalThis.fetch;
    let count = 0;
    globalThis.fetch = async (url, options) => { const body = typeof options?.body === 'string' ? JSON.parse(options.body) : {}; const isRoot = body.tools?.some(t => t.function?.name === 'TaskWait') ?? false; log('http', { isRoot, model: body.model, waiting: active.size > 0 }); if (++count > 30)
        throw Error('replay request budget'); return realFetch(url, options); };
    process.on('exit', () => log('diagnostics', runtime?.diagnostics() ?? {}));
}
else {
    const scenario = process.argv[2] ?? 'running';
    assert(['running', 'offline', 'all', 'paused', 'agent', 'unknown'].includes(scenario));
    const config = JSON.parse(readFileSync(path.join(homedir(), '.dao/config.json'), 'utf8'));
    assert.match(config.profiles[config.activeProfile].model, /glm-5.3-joybuilder/i);
    const root = mkdtempSync(path.join(tmpdir(), 'dao-glm-recovery-' + scenario + '-')), workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    const sockets = new Map(), released = new Set();
    const server = createServer(s => s.once('data', d => { const id = d.toString().trim(); sockets.set(id, s); if (released.has(id))
        s.end('done'); }));
    const endpoint = path.join(root, 'gate.sock');
    await new Promise(r => server.listen(endpoint, r));
    const release = id => { released.add(id); sockets.get(id)?.end('done'); };
    writeFileSync(path.join(workspace, 'worker.mjs'), `import {createConnection} from 'node:net';import {appendFileSync} from 'node:fs';const id=process.argv[2];appendFileSync('starts',id+'\\n');await new Promise((r,j)=>{const s=createConnection(${JSON.stringify(endpoint)});s.on('connect',()=>s.write(id));s.on('data',r);s.on('error',j);});console.log('RESULT_'+id.toUpperCase());`);
    const base = '这是隔离目录中的验收作业。worker.mjs 由外部放行后自然结束。不要修改脚本、提前终止、重试或重跑。';
    const prompt = base + (scenario === 'agent' ? '请派一个后台 general-purpose 子代理以前台方式执行 `node worker.mjs a`，等子代理自然完成后报告 RESULT 标记。' : scenario === 'unknown' ? '请以前台方式运行 `node worker.mjs a`，等自然结束后报告结果。' : scenario === 'all' ? '请同时后台运行 `node worker.mjs a` 和 `node worker.mjs b`，等两份结果都完成后统一报告 RESULT 标记，忽略正常进度和单个成功。' : '请后台运行 `node worker.mjs a`，独立计算 17×23，等作业完成后报告算式及 RESULT 标记。');
    const children = [], events = [];
    let output = '';
    let waiters = [];
    const waitFor = (predicate, ms = 120000) => new Promise((resolve, reject) => { const found = events.find(predicate); if (found) {
        resolve(found);
        return;
    } const entry = { predicate, resolve: e => { clearTimeout(timer); resolve(e); } }; const timer = setTimeout(() => { waiters = waiters.filter(w => w !== entry); reject(Error('event timeout')); }, ms); waiters.push(entry); });
    const launch = (stage, args) => { const c = spawn(process.execPath, ['--import', path.join(repo, 'node_modules/tsx/dist/loader.mjs'), '--import', script, path.join(repo, 'src/index.ts'), '--eval', '--no-skills', '--no-hooks', '--yolo', '--no-progress-advice', ...args], { cwd: workspace, env: { ...process.env, DAO_RECOVERY_CHILD: root, DAO_RECOVERY_STAGE: stage, DAO_REFLECT: '0', DAO_NO_CHECKPOINT: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true }); children.push(c); for (const s of [c.stdout, c.stderr])
        s.on('data', d => { output += `[${stage}] ${d}`; }); c.on('message', e => { events.push(e); for (const w of [...waiters])
        if (w.predicate(e)) {
            waiters = waiters.filter(x => x !== w);
            w.resolve(e);
        } }); c.done = new Promise(resolve => c.once('exit', (code, signal) => resolve({ code, signal }))); return c; };
    const stop = c => { if (c.exitCode === null && c.signalCode === null)
        try {
            process.kill(-c.pid, 'SIGTERM');
        }
        catch { } };
    const timeout = setTimeout(() => { for (const c of children)
        stop(c); release('a'); release('b'); server.close(); }, 230000);
    console.log(JSON.stringify({ scenario, evidence: root }));
    try {
        const first = launch('before', [prompt]);
        let sessionId;
        if (scenario === 'unknown') {
            await new Promise((r, j) => { const w = watch(workspace, () => { if (existsSync(path.join(workspace, 'starts'))) {
                w.close();
                clearTimeout(t);
                r();
            } }); const t = setTimeout(() => { w.close(); j(Error('worker not started')); }, 120000); });
            sessionId = readdirSync(path.join(workspace, '.dao/sessions'))[0];
        }
        else {
            const waited = await waitFor(e => e.type === 'checkpoint_wait' && e.stage === 'before');
            sessionId = waited.sessionId;
        }
        if (scenario === 'agent' && !existsSync(path.join(workspace, 'starts'))) {
            await new Promise((r, j) => { const w = watch(workspace, () => { if (existsSync(path.join(workspace, 'starts'))) {
                w.close();
                clearTimeout(t);
                r();
            } }); const t = setTimeout(() => { w.close(); j(Error('agent worker not started')); }, 120000); });
        }
        if (scenario === 'paused') {
            first.send('pause');
            await waitFor(e => e.type === 'paused');
        }
        if (scenario === 'all') {
            release('a');
            await new Promise(r => setTimeout(r, 1500));
        }
        first.kill('SIGKILL');
        await first.done;
        if (['offline', 'paused', 'agent', 'unknown'].includes(scenario)) {
            release('a');
            await new Promise(r => setTimeout(r, 1000));
        }
        const second = launch('after', ['-c', sessionId]);
        const recovered = await waitFor(e => e.type === 'recovered' && e.stage === 'after');
        if (['paused', 'agent', 'unknown'].includes(scenario))
            assert.equal(recovered.status.state, 'paused');
        else if (scenario !== 'offline') {
            assert.equal(recovered.status.state, 'waiting');
            await new Promise(r => setTimeout(r, 3000));
            release(scenario === 'all' ? 'b' : 'a');
        }
        const exit = await second.done;
        assert.equal(exit.code, 0);
        const { DurableStore } = await import(pathToFileURL(path.join(repo, 'src/session/durable_store.ts')));
        const store = new DurableStore(path.join(workspace, '.dao/sessions', sessionId), sessionId, workspace);
        const state = store.state(), runs = store.runs(), pending = store.pendingEvents(), unresolved = store.unresolved();
        store.close();
        const calls = state.messages.flatMap(m => m.tool_calls ?? []).map(t => ({ name: t.function.name, args: JSON.parse(t.function.arguments) }));
        const requests = events.filter(e => e.stage === 'after' && e.type === 'http' && e.isRoot);
        assert.equal(events.filter(e => e.type === 'http' && e.isRoot && e.waiting).length, 0);
        assert.equal(calls.filter(c => ['TaskOutput', 'BashOutput', 'TaskGet', 'TaskList'].includes(c.name)).length, 0);
        const starts = readFileSync(path.join(workspace, 'starts'), 'utf8').trim().split('\n');
        assert.equal(starts.filter(x => x === 'a').length, 1);
        if (scenario === 'all')
            assert.equal(starts.filter(x => x === 'b').length, 1);
        if (['paused', 'agent', 'unknown'].includes(scenario))
            assert.equal(requests.length, 0);
        else {
            assert(requests.length > 0);
            assert.equal(pending.length, 0);
            assert.match(output, /RESULT_A/);
        }
        if (scenario === 'agent')
            assert(runs.some(r => r.status === 'interrupted'));
        if (scenario === 'unknown')
            assert(unresolved.some(r => r.name === 'Bash'));
        const summary = { pass: true, scenario, evidence: root, sessionId, starts, rootRequestsAfterResume: requests.length, rootRequestsWhileWaiting: 0, queryCalls: 0, runs: runs.map(r => ({ taskId: r.taskId, runId: r.runId, status: r.status })), pendingEvents: pending.length, unresolved: unresolved.length };
        writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
        console.log(JSON.stringify(summary, null, 2));
    }
    finally {
        writeFileSync(path.join(root, 'cli.log'), output);
        clearTimeout(timeout);
        release('a');
        release('b');
        for (const c of children)
            stop(c);
        for (const s of sockets.values())
            s.destroy();
        server.close();
    }
}
