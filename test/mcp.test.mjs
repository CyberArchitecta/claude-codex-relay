import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('MCP stdio initializes and exchanges a real round-trip across two processes', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-mcp-')); const children = [];
  function client(agent) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/relay.mjs', import.meta.url)), 'mcp', '--agent', agent, '--data-dir', path.join(root, 'state'), '--bridge-dir', path.join(root, 'bridge')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const pending = new Map(); let id = 0; const lines = readline.createInterface({ input: child.stdout }); children.push(child);
    lines.on('line', line => { const value = JSON.parse(line); const entry = pending.get(value.id); if (entry) { clearTimeout(entry.timer); pending.delete(value.id); entry.resolve(value); } });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`MCP exited (${code}): ${stderr}`)); } pending.clear(); });
    return (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id; const timer = setTimeout(() => reject(new Error(`MCP timed out: ${method}`)), 5000);
      pending.set(requestId, { resolve, reject, timer }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  }
  t.after(async () => { await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode) return resolve(); child.once('close', resolve); child.stdin.end(); }))); rmSync(root, { recursive: true, force: true }); });
  const claude = client('claude'), codex = client('codex');
  assert.equal((await codex('initialize', {})).result.serverInfo.name, 'claude-codex-relay');
  assert.equal((await claude('tools/list', {})).result.tools.length, 8);
  const sent = await claude('tools/call', { name: 'bridge_send', arguments: { channel: 'test', message: 'Review the fixture.' } }); assert(!sent.result.isError);
  const inbox = await codex('tools/call', { name: 'bridge_inbox', arguments: { channel: 'test' } }); assert.equal(inbox.result.structuredContent.messages[0].body, 'Review the fixture.');
  await codex('tools/call', { name: 'bridge_send', arguments: { channel: 'test', message: 'Reviewed.', reply_to: sent.result.structuredContent.id } });
  assert.equal((await claude('tools/call', { name: 'bridge_inbox', arguments: {} })).result.structuredContent.messages[0].body, 'Reviewed.');
  assert.equal((await claude('unknown', {})).error.code, -32601);
  assert.equal((await codex('tools/call', { name: 'bridge_send', arguments: { message: 'oops', channel: '../bad' } })).result.isError, true);
});
