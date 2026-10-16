// Live-model acceptance: observes the real CLI and real HTTP responses, never mocks the model.
// Run: node scripts/verify-background-wait-live.mjs single|all|failure|agent [--auto]
// Uses the active DAO profile. Synthetic workspaces and credential-free evidence stay in /tmp.
// --auto preapproves only the two fixture commands; other operations use the real classifier.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '..');
const childRoot = process.env.DAO_WAIT_REPLAY_CHILD;
if (childRoot) {
  const scenario = process.env.DAO_WAIT_REPLAY_CASE;
  const log = (type, data = {}) => appendFileSync(path.join(childRoot, 'events.jsonl'), JSON.stringify({ at: Date.now(), type, ...data }) + '\n');
  const sockets = new Map();
  const gatesReleased = new Set();
  const server = createServer(socket => {
    socket.once('data', data => {
      const id = data.toString().trim();
      sockets.set(id, socket);
      log('worker_connected', { id });
      if (gatesReleased.has(id)) socket.end('complete');
    });
  });
  await new Promise(resolve => server.listen(path.join(childRoot, 'control.sock'), resolve));
  server.unref();
  const { BackgroundRuntime } = await import(pathToFileURL(path.join(repo, 'src/agent/background_runtime.ts')));
  const proto = BackgroundRuntime.prototype;
  let rootRuntime;
  const originalRecord = proto.record;
  proto.record = function (name, fields) { rootRuntime = this; log(name, fields); return originalRecord.call(this, name, fields); };
  const publish = proto.publish;
  proto.publish = function (event) {
    rootRuntime = this;
    log('execution', { event: event.type, taskId: event.snapshot.taskId, status: event.snapshot.status });
    return publish.call(this, event);
  };
  const active = new Set();
  const activate = proto.activate;
  let released = false;
  const releaseGate = (id) => {
    log('gate_release', { id });
    gatesReleased.add(id);
    sockets.get(id)?.end('complete');
  };
  const releaseFixtures = () => {
    if (released) return;
    released = true;
    if (scenario === 'all' || scenario === 'failure') {
      setTimeout(() => void releaseGate('a'), 3000).unref();
      setTimeout(() => void releaseGate('b'), 12000).unref();
    } else setTimeout(() => void releaseGate('a'), 12000).unref();
  };
  proto.activate = function (handle) {
    const result = activate.call(this, handle);
    active.add(handle.waitId);
    releaseFixtures();
    return result;
  };
  const release = proto.release;
  proto.release = function (handle) { active.delete(handle.waitId); return release.call(this, handle); };
  // A failure to wait must terminate with evidence instead of hanging the acceptance runner.
  setTimeout(() => { if (!released) { log('fallback_release'); releaseFixtures(); } }, 180000).unref();
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) : {};
    const isRoot = body.tools?.some(t => t.function?.name === 'TaskWait') ?? false;
    const id = ++requests;
    log('http_request', { id, model: body.model, isRoot, waiting: active.size > 0 });
    if (requests > 35) throw new Error('Live replay request budget exceeded');
    const response = await realFetch(url, options);
    log('http_response', { id, status: response.status });
    return response;
  };
  process.on('exit', () => log('diagnostics', rootRuntime?.diagnostics() ?? {}));
} else {
  const scenario = process.argv[2] || 'single';
  const auto = process.argv.includes('--auto');
  assert(['single', 'all', 'failure', 'agent'].includes(scenario), 'Unknown scenario');
  const config = JSON.parse(readFileSync(path.join(homedir(), '.dao/config.json'), 'utf8'));
  const profile = config.profiles[config.activeProfile];
  assert.equal(profile.model.toLowerCase(), 'glm-5.3-joybuilder', 'Select the GLM profile before replay');
  const root = mkdtempSync(path.join(tmpdir(), 'dao-glm-wait-' + scenario + '-'));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'worker.mjs'), `
import { createConnection } from 'node:net';
const id = process.argv[2];
const timer = setInterval(() => console.log('progress ' + id), 1000);
await new Promise((resolve, reject) => {
  const socket = createConnection(${JSON.stringify(path.join(root, 'control.sock'))});
  socket.on('connect', () => socket.write(id));
  socket.on('data', resolve);
  socket.on('error', reject);
});
clearInterval(timer);
console.log('RESULT_' + id.toUpperCase());
process.exit(${scenario === 'failure' ? "id === 'a' ? 7 : 0" : '0'});
`);
  const base = '这是一个隔离目录中的验收作业。worker.mjs 已准备好，由外部测试器放行后自然结束，持续输出 progress 是正常现象。不要修改脚本、门控文件或提前结束作业；不要重跑作业。';
  const prompts = {
    single: base + '请在后台运行 `node worker.mjs a`，另外直接算出 17×23，然后等后台作业完成，报告算式结果和作业最终 RESULT 标记。',
    all: base + '请同时后台运行 `node worker.mjs a` 和 `node worker.mjs b`。两份结果都完成后再统一汇报 RESULT 标记，中途正常进度与单个成功不需要处理。',
    failure: base + '请同时后台运行 `node worker.mjs a` 和 `node worker.mjs b`。正常情况下等两个都完成再汇总；如果任一个失败，及时报告失败，保留另一个运行，最后汇总两者状态。不要修复或重试。',
    agent: base + '请派一个后台子代理负责执行 `node worker.mjs a` 并返回最终 RESULT 标记，子代理应以前台命令执行并等待自然结束。你先独立计算 17×23，然后等子代理返回，汇报算式和 RESULT 标记。',
  };
  writeFileSync(path.join(root, 'prompt.txt'), prompts[scenario]);
  console.log(JSON.stringify({ scenario, permissionMode: auto ? 'auto' : 'bypass', model: profile.model, evidence: root }));
  const child = spawn(process.execPath, ['--import', path.join(repo, 'node_modules/tsx/dist/loader.mjs'), '--import', script,
    path.join(repo, 'src/index.ts'), '--eval', '--no-skills', '--no-hooks', ...(auto ? ['--permission-mode', 'auto', '--allow', 'Bash(node worker.mjs a)', '--allow', 'Bash(node worker.mjs b)'] : ['--yolo']), '--no-progress-advice', prompts[scenario]], {
    cwd: workspace, env: { ...process.env, DAO_WAIT_REPLAY_CHILD: root, DAO_WAIT_REPLAY_CASE: scenario, DAO_NO_CHECKPOINT: '1', DAO_REFLECT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { output += d; });
  const timeout = setTimeout(stop, 240000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timeout);
  writeFileSync(path.join(root, 'cli.log'), output);
  stop();
  const events = readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const sessions = path.join(workspace, '.dao/sessions');
  const stateFile = readdirSync(sessions).map(s => path.join(sessions, s, 'state.json')).find(p => { try { readFileSync(p); return true; } catch { return false; } });
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const calls = state.messages.flatMap(m => m.tool_calls || []).map(t => ({ name: t.function.name, args: JSON.parse(t.function.arguments) }));
  const waits = events.filter(e => e.type === 'wait_activated');
  const requestWhileWaiting = events.filter(e => e.type === 'http_request' && e.isRoot && e.waiting);
  const queries = calls.filter(c => ['TaskOutput', 'BashOutput', 'TaskGet', 'TaskList'].includes(c.name));
  const diagnostics = events.findLast(e => e.type === 'diagnostics');
  const summary = { scenario, permissionMode: auto ? 'auto' : 'bypass', fixtureCommandsPreapproved: auto, code, model: profile.model, evidence: root,
    totalHttpRequests: events.filter(e => e.type === 'http_request').length,
    modelRequests: events.filter(e => e.type === 'http_request' && e.model).length,
    rootRequests: events.filter(e => e.type === 'http_request' && e.isRoot).length,
    rootRequestsWhileWaiting: requestWhileWaiting.length,
    taskWaitCalls: calls.filter(c => c.name === 'TaskWait'),
    queryCalls: queries, waits: waits.length,
    waitReleases: events.filter(e => e.type === 'wait_released'),
    wakes: events.filter(e => e.type === 'wake_scheduled'),
    tools: calls.map(c => c.name), diagnostics, usage: state.usage,
  };
  writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(code, 0, 'CLI failed; see cli.log');
  assert(!events.some(e => e.type === 'fallback_release'), 'Model failed to enter waiting promptly');
  assert(summary.taskWaitCalls.length > 0, 'GLM did not choose TaskWait');
  assert(waits.length > 0, 'No actual waiting window');
  assert(summary.rootRequests > 0, 'Root HTTP request attribution failed');
  assert.equal(diagnostics?.modelRequests, summary.rootRequests, 'Runtime and HTTP model request counts disagree');
  assert.equal(diagnostics?.modelRequestsWhileWaiting, 0);
  assert.equal(diagnostics?.activeWaits, 0, 'Wait handle leaked');
  assert.equal(diagnostics?.pendingEvents, 0, 'Undelivered events remain');
  assert.equal(requestWhileWaiting.length, 0, 'Root requested model during waiting');
  assert.equal(queries.length, 0, 'Model queried background progress');
  assert(!calls.some(c => c.name === 'Bash' && /\bsleep\b/.test(c.args.command)), 'Model used sleep to wait');
  assert(!events.some(e => e.type === 'http_response' && e.status >= 400), 'Gateway error');
  assert(!/分类器模型 .*不可用/.test(output), 'Classifier fallback warning');
  assert.match(output, /RESULT_A/);
  if (scenario === 'single' || scenario === 'agent') assert.match(output, /391/);
  if (scenario === 'all' || scenario === 'failure') assert.match(output, /RESULT_B/);
  if (scenario === 'all') {
    assert(summary.taskWaitCalls.some(c => c.args.mode === 'all' && c.args.ids.length === 2));
    assert.equal(summary.wakes.filter(e => e.reason !== 'user').length, 1);
  }
  if (scenario === 'single' || scenario === 'agent') assert.equal(summary.wakes.filter(e => e.reason !== 'user').length, 1);
  if (scenario === 'failure') {
    const failed = events.find(e => e.type === 'execution' && e.status === 'failed');
    const secondRelease = events.find(e => e.type === 'gate_release' && e.id === 'b');
    assert(failed && secondRelease);
    assert(summary.wakes.some(e => e.reason !== 'user' && e.at >= failed.at && e.at < secondRelease.at), 'Failure did not wake early');
  }
  console.log('LIVE_GLM_WAIT_PASS ' + scenario);
}
