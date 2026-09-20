import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { now } from '../src/store.mjs';
const root = path.resolve('scratch/preview'); mkdirSync(root, { recursive: true });
const app = await startServer({ dataDir: path.join(root, 'data-' + Date.now()), port: 4318 });
if (!app.store.tasks().length) {
  const task = app.store.createTask({ title: 'Review the checkout flow', project: root, prompt: 'Review the checkout flow, document edge cases, and propose a focused fix.', context: 'Keep the public API stable. Focus on payment retries and clear error messages. This task contains sample data for interface verification.' });
  const run = app.store.createRun({ task_id: task.id, agent: 'claude', permission: 'read-only', prompt: task.original_prompt });
  app.store.patchRun(run.id, { state: 'completed', summary: 'Sample run: mapped the checkout flow and identified two retry edge cases. The proposed changes are ready for Codex to review. No real code was analyzed in this sample.', started_at: now(), ended_at: now() });
  app.store.event(run.id, 'message', 'Sample record for interface testing. No live agent was run.');
  const second = app.store.createTask({ title: 'Write the migration guide', project: root, prompt: 'Draft a migration guide from the proposed API changes.' });
  const failed = app.store.createRun({ task_id: second.id, agent: 'codex', permission: 'read-only', prompt: second.original_prompt });
  app.store.patchRun(failed.id, { state: 'needs_attention', summary: 'Sample: waiting for the final API decision before writing the guide.', ended_at: now() });
}
writeFileSync(path.join(root, 'url.txt'), app.url);
console.log(app.url);
const stop = async () => { await app.close(); }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
