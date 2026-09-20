import http from 'node:http';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Store } from './store.mjs';
import { Runner, projectPath } from './runner.mjs';
import { doctor } from './providers.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
function lock(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'server.lock');
  const claim = () => writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  try { claim(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-lock recovery. An initial claim can win the unlink gap;
    // exclusive creation then makes the recovering claimant fail safely.
    const recovery = path.join(directory, 'server.recovery.lock');
    try { writeFileSync(recovery, String(process.pid), { flag: 'wx', mode: 0o600 }); }
    catch { throw new Error(`Another process is checking the Relay lock. If this persists, inspect ${recovery}.`); }
    try {
      let existing;
      try { existing = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`Unreadable Relay lock: ${file}. Retry or inspect it before removing it.`); }
      if (!Number.isInteger(existing.pid) || existing.pid <= 0) throw new Error(`Invalid Relay lock: ${file}.`);
      let running = true;
      try { process.kill(existing.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
      if (running) throw new Error(`Relay is already running for this data directory (PID ${existing.pid}).`);
      unlinkSync(file);
      claim();
    } finally { unlinkSync(recovery); }
  }
  return () => { try { unlinkSync(file); } catch {} };
}
function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('Use application/json.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > 128_000) throw new Error('Request too large.'); chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value;
}
export async function startServer({ dataDir, port = 4317, concurrency = 2, runnerOptions = {}, providers: suppliedProviders } = {}) {
  const release = lock(dataDir);
  let store;
  try { store = new Store(dataDir); store.recover(); } catch (error) { release(); throw error; }
  const runner = new Runner(store, { concurrency, ...runnerOptions });
  const token = randomBytes(32).toString('hex');
  let origin, providers = suppliedProviders || await doctor();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, { error: 'Untrusted request origin.' });
    try {
      const url = new URL(req.url, origin);
      if (!url.pathname.startsWith('/api/')) {
        const asset = assets.get(url.pathname);
        if (req.method !== 'GET' || !asset) return json(res, 404, { error: 'Not found.' });
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(readFileSync(path.join(publicDir, asset[0]))); return;
      }
      const actual = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return json(res, 401, { error: 'Open the private URL printed by agent-relay to connect.' });
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { providers, concurrency, dataDir });
      if (req.method === 'GET' && url.pathname === '/api/tasks') return json(res, 200, { tasks: store.tasks() });
      if (req.method === 'POST' && url.pathname === '/api/doctor') { await body(req); providers = await doctor(); return json(res, 200, { providers }); }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const input = await body(req); const task = store.createTask({ ...input, project: projectPath(input.project) });
        return json(res, 201, { task });
      }
      const match = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]+)(?:\/(context|preview|runs))?$/);
      if (match) {
        const [, id, action] = match;
        if (req.method === 'GET' && !action) return json(res, 200, { task: store.task(id), runs: store.runs(id).map(run => ({ ...run, events: store.recentEvents(run.id, 100) })) });
        if (req.method === 'POST' && action === 'context') return json(res, 200, { task: store.setContext(id, (await body(req)).context) });
        if (req.method === 'POST' && action === 'preview') {
          const { task, ...preview } = await runner.prepare(id, await body(req)); return json(res, 200, preview);
        }
        if (req.method === 'POST' && action === 'runs') return json(res, 201, { run: await runner.enqueue(id, await body(req)) });
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)(?:\/(stop|events))?$/);
      if (runMatch) {
        const [, id, action] = runMatch; store.run(id);
        if (req.method === 'POST' && action === 'stop') { await body(req); runner.stop(id); return json(res, 200, { run: store.run(id) }); }
        if (req.method === 'GET' && action === 'events') {
          const after = Number(url.searchParams.get('after') || 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor.');
          return json(res, 200, { events: store.events(id, after) });
        }
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { store.close(); release(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  let closing;
  return { origin, token, url: `${origin}/#token=${token}`, store, runner, server,
    close() { return closing ||= (async () => {
      const stopped = new Promise(resolve => server.close(resolve)); server.closeIdleConnections();
      await runner.close(); await stopped; store.close(); release();
    })(); }
  };
}
