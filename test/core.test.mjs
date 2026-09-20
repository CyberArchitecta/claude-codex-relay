import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { providerArgs, parseEvent } from '../src/providers.mjs';
import { Runner, pathsOverlap } from '../src/runner.mjs';

const fixture = fileURLToPath(new URL('./fixtures/provider.mjs', import.meta.url));
const provider = () => ({ command: process.execPath, prefix: [fixture] });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 12_000; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for runner'); await pause(20); } }
function setup(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-test-')); const project = path.join(root, 'project'); mkdirSync(project);
  const store = new Store(path.join(root, 'data')), runner = new Runner(store, { resolveProvider: provider, ...options });
  t.after(async () => { await runner.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const create = (overrides = {}) => store.createTask({ title: 'Test task', project, prompt: 'Do the bounded fixture task.', ...overrides });
  return { root, project, store, runner, create };
}

test('provider arguments preserve sandbox policy on start and resume', () => {
  for (const permission of ['read-only', 'workspace-write']) {
    for (const session_id of [null, 'saved-session']) {
      const args = providerArgs({ agent: 'codex', permission, session_id });
      assert(args.includes(`sandbox_mode="${permission}"`)); assert(args.includes('approval_policy="never"')); assert.equal(args.at(-1), '-');
      assert(!args.some(arg => arg.includes('dangerously')));
    }
  }
  const args = providerArgs({ agent: 'claude', permission: 'read-only' });
  assert(args.includes('dontAsk')); assert(args.includes('Read,Glob,Grep')); assert(args.includes('--strict-mcp-config'));
  assert.throws(() => providerArgs({ agent: 'codex', permission: 'danger-full-access' }));
  assert.throws(() => providerArgs({ agent: 'claude', session_id: '--bypass' + ' '.repeat(2) }));
});
test('normalizes explicit completion, errors and permission denial', () => {
  assert.equal(parseEvent('codex', { type: 'turn.completed' }).terminal, 'completed');
  assert.equal(parseEvent('codex', { type: 'turn.failed', error: { message: 'Rate limit reached' } }).terminal, 'limited');
  assert.equal(parseEvent('claude', { type: 'result', result: 'Done', permission_denials: [{}] }).terminal, 'needs_attention');
  assert.equal(parseEvent('claude', { type: 'result', is_error: true, errors: ['Please log in'] }).terminal, 'needs_attention');
  assert.equal(parseEvent('codex', { type: 'error', message: 'Retrying' }).terminal, undefined);
});
test('message bridge routes unread messages and validates reply channels', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-bridge-')); const claude = new Bridge(root, 'claude'), codex = new Bridge(root, 'codex');
  t.after(() => { claude.close(); codex.close(); rmSync(root, { recursive: true, force: true }); });
  const sent = claude.send({ message: 'Please review the patch.', channel: 'project' });
  assert.equal(codex.status().unread_messages, 1);
  assert.equal(codex.inbox({ channel: 'unrelated' }).messages.length, 0);
  assert.equal(codex.inbox({ mark_read: false }).messages.length, 1);
  assert(codex.inbox().messages[0].read_at); assert.equal(codex.inbox().messages.length, 0);
  assert.throws(() => codex.send({ message: 'Reply', channel: 'other', reply_to: sent.id }));
  codex.send({ message: 'Reviewed.', channel: 'project', reply_to: sent.id });
  assert.equal(claude.inbox().messages[0].body, 'Reviewed.'); assert.equal(codex.history().messages.length, 2);
  assert.throws(() => claude.send({ message: '', channel: '../bad' }));
});
test('data persists and interrupted runs never auto-resume on recovery', t => {
  const { root, store, create } = setup(t); const task = create(); store.createRun({ task_id: task.id, agent: 'claude', permission: 'read-only', prompt: 'Hi' });
  const second = new Store(path.join(root, 'data')); second.recover();
  assert.equal(second.tasks()[0].state, 'interrupted'); assert.equal(second.task(task.id).original_prompt, task.original_prompt); second.close();
});
test('path overlap distinguishes nested folders and siblings', () => {
  const base = path.resolve('example'); assert(pathsOverlap(base, path.join(base, 'src')));
  assert(pathsOverlap(base, base)); assert(!pathsOverlap(base, `${base}-other`));
});
test('real child process: start, resume, handoff and Unicode output', async t => {
  const { project, store, runner, create } = setup(t); const task = create({ context: 'secret-fixture-context' });
  const first = await runner.enqueue(task.id, { agent: 'claude' }); await until(() => !runner.active.size);
  assert.equal(store.run(first.id).state, 'completed'); assert.equal(store.run(first.id).session_id, 'claude-fixture-session');
  assert(store.run(first.id).summary.includes('café 🛰️')); assert(store.run(first.id).summary.includes('context received'));
  const resumed = await runner.enqueue(task.id, { agent: 'claude', note: 'Continue with the next step.' }); await until(() => !runner.active.size);
  assert.equal(store.run(resumed.id).state, 'completed');
  const preview = await runner.prepare(task.id, { agent: 'codex', note: 'Review prior work.' });
  assert.equal(preview.handoff, true); assert.equal(preview.session_id, null); assert(preview.prompt.includes('Handoff record')); assert(preview.prompt.includes('Continue with the next step.')); assert(preview.prompt.includes('secret-fixture-context'));
  const handoff = await runner.enqueue(task.id, { agent: 'codex', note: 'Review prior work.' }); await until(() => !runner.active.size);
  assert.equal(store.run(handoff.id).state, 'completed');
  const received = readFileSync(path.join(project, 'received.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(received[1].args.includes('--resume')); assert(received[1].args.includes('claude-fixture-session'));
  assert(!received[2].args.includes('resume')); assert(received[2].prompt.includes('Verified fixture response'));
  const fourth = await runner.enqueue(task.id, { agent: 'codex', note: 'Another step.' }); await until(() => !runner.active.size);
  assert.equal(store.run(fourth.id).state, 'completed');
  const last = JSON.parse(readFileSync(path.join(project, 'received.jsonl'), 'utf8').trim().split('\n').at(-1)); assert(last.args.includes('codex-fixture-session'));
});
test('overlapping workspaces serialize; separate projects can run together', async t => {
  const { root, project, store, runner, create } = setup(t); writeFileSync(path.join(project, 'fixture.json'), JSON.stringify({ delay: 250 }));
  const first = create(), second = create({ title: 'Same project' }); const otherProject = path.join(root, 'other'); mkdirSync(otherProject); writeFileSync(path.join(otherProject, 'fixture.json'), JSON.stringify({ delay: 250 }));
  const third = create({ title: 'Other project', project: otherProject });
  const a = await runner.enqueue(first.id, { agent: 'claude' }); const b = await runner.enqueue(second.id, { agent: 'codex' }); const c = await runner.enqueue(third.id, { agent: 'codex' });
  assert.equal(store.run(a.id).state, 'running'); assert.equal(store.run(b.id).state, 'queued'); assert.equal(store.run(c.id).state, 'running');
  await until(() => store.runs().every(r => r.state === 'completed')); assert.equal(runner.active.size, 0);
  assert(store.run(b.id).started_at >= store.run(a.id).ended_at);
});
test('concurrent submissions cannot start the same task twice', async t => {
  const { project, runner, store, create } = setup(t); writeFileSync(path.join(project, 'fixture.json'), JSON.stringify({ delay: 250 }));
  const task = create(); const outcomes = await Promise.allSettled([runner.enqueue(task.id, { agent: 'claude' }), runner.enqueue(task.id, { agent: 'codex' })]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(store.runs().length, 1);
});
test('stopping an agent terminates the process and frees its project slot', async t => {
  const { project, runner, store, create } = setup(t); writeFileSync(path.join(project, 'fixture.json'), JSON.stringify({ mode: 'hang' }));
  const task = create(); const run = await runner.enqueue(task.id, { agent: 'codex' });
  await until(() => store.run(run.id).session_id); runner.stop(run.id); await until(() => !runner.active.size);
  assert.equal(store.run(run.id).state, 'cancelled'); assert(store.run(run.id).ended_at);
});
for (const [agent, mode, expected] of [['claude', 'permission', 'needs_attention'], ['claude', 'rate', 'limited'], ['codex', 'rate', 'limited'], ['codex', 'missing', 'failed'], ['codex', 'startup_error', 'needs_attention']]) {
  test(`${agent}: ${mode} is reported as ${expected}`, async t => {
    const { project, runner, store, create } = setup(t); writeFileSync(path.join(project, 'fixture.json'), JSON.stringify({ mode }));
    const run = await runner.enqueue(create().id, { agent }); await until(() => !runner.active.size); assert.equal(store.run(run.id).state, expected);
  });
}
