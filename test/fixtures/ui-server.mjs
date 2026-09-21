import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../src/server.mjs';
import { now } from '../../src/store.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'relay-ui-'));
const app = await startServer({
  dataDir: path.join(root, 'data'), port: 0, providers: [],
  runnerOptions: { resolveProvider: () => ({ command: process.execPath, prefix: [fileURLToPath(new URL('./provider.mjs', import.meta.url))] }) }
});
const task = app.store.createTask({ title: 'Existing task', project: root, prompt: 'Fixture only.', context: 'Original shared context.' });
const run = app.store.createRun({ task_id: task.id, agent: 'claude', permission: 'workspace-write', model: 'previous-custom-model', prompt: task.original_prompt });
app.store.patchRun(run.id, { state: 'completed', summary: 'Sample run for browser regression checks.', ended_at: now() });
console.log(JSON.stringify({ url: app.url, project: root, task }));
process.stdin.resume();
process.stdin.on('end', async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
