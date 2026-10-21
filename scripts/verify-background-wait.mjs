// Deterministic CLI wiring smoke: fake model responses, real Bash/FIFO/process exit.
// No credentials or network requests. This is not a live-model acceptance test.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const replMode = process.argv.includes('--repl');
// Exercise the installed Bun executable (including its self-spawn path) when supplied.
const binary = process.env.DAO_WAIT_TEST_BINARY;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(path.join(tmpdir(), 'dao-wait-cli-'));
try {
  execFileSync('mkfifo', [path.join(fixture, 'gate')]);
  const preload = path.join(fixture, 'model.mjs');
  if (binary) assert(!/\s/.test(preload), 'BUN_OPTIONS requires a preload path without whitespace');
  writeFileSync(preload, `
import { writeFileSync } from 'node:fs';
const root = ${JSON.stringify(fixture)};
let requests = 0, released = false;
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options?.body || '{}');
  if (!body.messages) throw new Error('Unexpected non-model request in isolated smoke');
  const n = ++requests;
  writeFileSync(root + '/requests.json', JSON.stringify({ requests, released }));
  let delta, finish;
  if (n === 1) {
    delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'plan', type: 'function', function: { name: 'TodoWrite', arguments: JSON.stringify({ todos: [{ content: 'Verify shell completion', status: 'in_progress' }] }) } }, { index: 1, id: 'start', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'tee /dev/null < ' + root + '/gate', background: true }) } }] }; finish = 'tool_calls';
  } else if (n === 2) {
    const shellResult = body.messages.find(m => m.role === 'tool' && /proc-[a-z0-9]+/.test(String(m.content)));
    const shellId = String(shellResult?.content).match(/proc-[a-z0-9]+/)?.[0];
    if (!shellId) throw new Error('Missing Bash result');
    delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'wait', type: 'function', function: { name: 'TaskWait', arguments: JSON.stringify({ ids: [shellId], mode: 'all' }) } }] }; finish = 'tool_calls';
    setTimeout(() => {
      if (requests !== 2) throw new Error('Model was polled while waiting');
      released = true;
      writeFileSync(root + '/gate', 'shell completed\\n');
    }, 200);
  } else if (n === 3) {
    if (!released) throw new Error('Premature model wake');
    if (!body.messages.some(m => String(m.content).includes('[后台任务数据'))) throw new Error('Missing background delivery');
    const callIndex = body.messages.findIndex(m => m.role === 'assistant' && m.tool_calls?.some(t => t.id === 'wait'));
    if (body.messages[callIndex + 1]?.tool_call_id !== 'wait') throw new Error('Unpaired wait tool result');
    delta = { role: 'assistant', content: 'CLI_WAIT_OK' }; finish = 'stop';
  } else throw new Error('Extra model request: ' + n);
  return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\\n\\n' +
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
};
`);
  const result = await new Promise((resolve, reject) => {
    const entryArgs = binary ? [] : ['--import', path.join(repo, 'node_modules/tsx/dist/loader.mjs'), '--import', preload, path.join(repo, 'src/index.ts')];
    const child = spawn(binary || process.execPath, [...entryArgs,
      '--api-key', 'test-only-no-credentials', '--provider', 'deepseek', '--eval', '--no-skills', '--no-hooks', '--yolo', ...(replMode ? [] : ['verify background wait'])],
      { cwd: fixture, env: { ...process.env, DAO_NO_CHECKPOINT: '1', DAO_REFLECT: '0',
        ...(process.env.DAO_WAIT_TEST_TMPDIR ? { TMPDIR: process.env.DAO_WAIT_TEST_TMPDIR } : {}),
        ...(binary ? { BUN_OPTIONS: `--preload ${preload}` } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(replMode ? 'verify background wait\n' : '');
    let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('CLI smoke timed out\n' + output)); }, 15000);
    child.once('error', reject); child.once('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /CLI_WAIT_OK/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(fixture, 'requests.json'), 'utf8')), { requests: 3, released: true });
  const sessions = path.join(fixture, '.dao', 'sessions');
  const runs = readdirSync(sessions).flatMap(id => {
    const dir = path.join(sessions, id, 'runs');
    return existsSync(dir) ? readdirSync(dir).map(run => path.join(dir, run)) : [];
  });
  assert.equal(runs.length, 1, 'Expected exactly one runner');
  const receipt = JSON.parse(readFileSync(path.join(runs[0], 'terminal.json'), 'utf8'));
  assert.equal(receipt.snapshot.status, 'completed');
  assert.equal(receipt.exitCode, 0);
  assert.equal(readFileSync(path.join(runs[0], 'stdout.log'), 'utf8'), 'shell completed\n');
  assert(existsSync(path.join(runs[0], 'runner.log')), 'Missing startup diagnostics');
  if (process.env.DAO_WAIT_TEST_TMPDIR) {
    const manifest = JSON.parse(readFileSync(path.join(runs[0], 'manifest.json'), 'utf8'));
    assert.equal(path.dirname(manifest.endpoint), '/tmp', 'Expected fallback from unusable TMPDIR');
  }
  console.log((binary ? 'installed binary ' : 'source ') + (replMode ? 'REPL' : 'argv') + ' CLI wait smoke passed: one runner completed with exit 0 and verified stdout; 3 model requests total; 0 during waiting; completion resumed once.');
} finally { rmSync(fixture, { recursive: true, force: true }); }
