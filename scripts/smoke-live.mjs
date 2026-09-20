import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/runner.mjs';
const root = mkdtempSync(path.join(tmpdir(), 'relay-live-'));
const project = path.join(root, 'project'); mkdirSync(project);
execFileSync('git', ['init', project], { stdio: 'ignore', windowsHide: true });
writeFileSync(path.join(project, 'AGENTS.md'), 'This is an isolated integration test. Do not use tools, read other files, or modify files. Reply briefly to the current instruction.\n');
writeFileSync(path.join(project, 'CLAUDE.md'), 'This is an isolated integration test. Do not use tools, read other files, or modify files. Reply briefly to the current instruction.\n');
const store = new Store(path.join(root, 'data')), runner = new Runner(store, { timeoutMs: 120_000 });
const task = store.createTask({ title: 'Live provider compatibility', project, prompt: 'Integration test: do not use any tools or change files. Reply exactly RELAY_READY.', context: 'Test-only shared marker: ORBIT-17. Preserve it when explicitly asked.' });
const results = []; const failedAgents = new Set();
try {
  for (const [agent, note, check] of [
    ['claude', 'Do not use tools. Reply exactly RELAY_READY.', 'RELAY_READY'],
    ['claude', 'Do not use tools. Reply exactly RELAY_RESUMED.', 'RELAY_RESUMED'],
    ['codex', 'Do not use tools. Reply with the test-only shared marker from the context, and nothing else.', 'ORBIT-17'],
    ['codex', 'Do not use tools. Reply exactly RELAY_RESUMED.', 'RELAY_RESUMED']
  ]) {
    if (failedAgents.has(agent)) continue;
    const run = await runner.enqueue(task.id, { agent, note });
    process.stdout.write(agent + ': started ' + run.id + '\n');
    while (runner.active.size || store.run(run.id).state === 'queued') await new Promise(resolve => setTimeout(resolve, 300));
    const final = store.run(run.id);
    const result = { agent, state: final.state, resumed: !!run.session_id, sessionCaptured: !!final.session_id, expectedOutput: final.summary.includes(check), summary: final.summary.slice(-1500) };
    results.push(result); console.log(JSON.stringify(result));
    if (final.state !== 'completed') { console.log('Skipping further live runs for this provider after failure.'); failedAgents.add(agent); }
  }
} finally { await runner.close(); store.close(); }
console.log(JSON.stringify({ root, results }));
if (results.length !== 4 || results.some(result => result.state !== 'completed' || !result.expectedOutput)) process.exitCode = 1;
