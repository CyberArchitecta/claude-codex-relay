import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startServer } from '../src/server.mjs';

async function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-http-')); const project = path.join(root, 'project'); mkdirSync(project);
  const app = await startServer({ dataDir: path.join(root, 'data'), port: 0, providers: [], runnerOptions: { resolveProvider: () => ({ command: process.execPath, prefix: [fileURLToPath(new URL('./fixtures/provider.mjs', import.meta.url))] }) } });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (route, data, headers = {}) => fetch(app.origin + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${app.token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { root, project, app, request };
}
test('HTTP API requires its private token and rejects foreign Origin and Host', async t => {
  const { app, request } = await setup(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal((await fetch(app.origin + '/api/tasks')).status, 401);
  assert.equal((await request('/api/tasks', undefined, { Origin: 'https://evil.example' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(app.origin + '/api/tasks', { headers: { Host: 'evil.example', Authorization: `Bearer ${app.token}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await request('/api/tasks', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request('/api/tasks')).status, 200);
  const index = await fetch(app.origin); assert.equal(index.status, 200); assert(index.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal((await fetch(app.origin + '/package.json')).status, 404);
  assert.equal((await fetch(app.origin + '/%2e%2e/package.json')).status, 404);
});
test('task API persists context and preview never starts a provider', async t => {
  const { project, request, app } = await setup(t);
  const response = await request('/api/tasks', { title: '<script>alert(1)</script>', project, prompt: 'Review this project.' }); assert.equal(response.status, 201);
  const { task } = await response.json(); assert.equal((await request(`/api/tasks/${task.id}/context`, { context: 'Keep public APIs stable.' })).status, 200);
  const preview = await (await request(`/api/tasks/${task.id}/preview`, { agent: 'codex' })).json();
  assert(preview.prompt.includes('Keep public APIs stable.')); assert.equal(existsSync(path.join(project, 'received.jsonl')), false); assert.equal(app.store.runs().length, 0);
  assert.equal((await request(`/api/tasks/${task.id}/runs`, { agent: 'other' })).status, 400);
  assert.equal((await request('/api/tasks', { title: 'Nope', project: path.join(project, 'missing'), prompt: 'Run' })).status, 400);
  assert.equal((await request('/api/tasks', { title: 'Nope', project, prompt: 'Run' }, { 'Content-Type': 'text/plain' })).status, 400);
});
test('a second server cannot recover or steal the first server’s run state', async t => {
  const { root } = await setup(t);
  await assert.rejects(() => startServer({ dataDir: path.join(root, 'data'), port: 0, providers: [] }), /already running/);
});

test('stale context saves return 409 and preserve remote changes', async t => {
  const { project, request, app } = await setup(t);
  const { task } = await (await request('/api/tasks', { title: 'Shared context', project, prompt: 'Coordinate.', context: 'Original' })).json();
  const route = `/api/tasks/${task.id}/context`;
  assert.equal((await request(route, { context: 'Remote note', expected_context: 'Original' })).status, 200);
  const stale = await request(route, { context: 'Stale draft', expected_context: 'Original' });
  assert.equal(stale.status, 409); assert.match((await stale.json()).error, /changed elsewhere/);
  assert.equal(app.store.task(task.id).context, 'Remote note');
  app.store.appendContext(task.id, '[claude] Preserve this too.');
  assert.equal((await request(route, { context: 'Merged too early', expected_context: 'Remote note' })).status, 409);
  const latest = app.store.task(task.id).context;
  const merged = await request(route, { context: latest + '\nUser draft', expected_context: latest });
  assert.equal(merged.status, 200); assert.equal((await merged.json()).task.context, latest + '\nUser draft');
  assert.equal((await request(route, { context: 'Invalid', expected_context: null })).status, 400);
  assert.equal(app.store.task(task.id).context, latest + '\nUser draft');
});
