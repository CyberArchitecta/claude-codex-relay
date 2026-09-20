#!/usr/bin/env node
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const usage = `Agent Relay — Claude Code + Codex in one local workspace

agent-relay [serve] [--port 4317] [--concurrency 2] [--data-dir PATH]
agent-relay doctor
agent-relay mcp --agent claude|codex [--data-dir PATH] [--bridge-dir PATH]
agent-relay config --agent claude|codex

Open the private localhost URL printed by serve. Ctrl+C stops Relay and its runs.
Node.js 24.13+ required. Install and authenticate each provider CLI separately.
`;
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 13)) throw new Error('Node.js 24.13 or newer is required.');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    port: { type: 'string', default: '4317' }, concurrency: { type: 'string', default: '2' },
    'data-dir': { type: 'string' }, 'bridge-dir': { type: 'string' }, agent: { type: 'string' }, help: { type: 'boolean' }
  } });
  const command = positionals[0] || 'serve';
  const dataDir = path.resolve(values['data-dir'] || process.env.RELAY_DATA_DIR || path.join(homedir(), '.claude-codex-relay'));
  const bridgeDir = path.resolve(values['bridge-dir'] || process.env.AI_BRIDGE_DATA_DIR || path.join(homedir(), '.ai-bridge'));
  if (values.help) console.log(usage);
  else if (command === 'doctor') {
    const { doctor } = await import('../src/providers.mjs'); const providers = await doctor();
    console.log(JSON.stringify({ node: process.versions.node, providers, dataDir, bridgeDir }, null, 2));
    if (providers.every(p => !p.available)) process.exitCode = 1;
  } else if (command === 'config' || command === 'mcp') {
    if (!['claude', 'codex'].includes(values.agent)) throw new Error('--agent must be claude or codex.');
    if (command === 'config') {
      const args = [fileURLToPath(import.meta.url), 'mcp', '--agent', values.agent, '--data-dir', dataDir, '--bridge-dir', bridgeDir];
      console.log(JSON.stringify({ mcpServers: { 'ai-bridge': { command: process.execPath, args } } }, null, 2));
      if (values.agent === 'codex') console.log(`\n# Equivalent Codex config.toml entry:\n[mcp_servers.ai-bridge]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}`);
    } else {
      const { startMcp } = await import('../src/mcp.mjs'); startMcp({ dataDir, bridgeDir, agent: values.agent });
    }
  } else if (command === 'serve') {
    const port = Number(values.port), concurrency = Number(values.concurrency);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0-65535.');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Concurrency must be 1-4.');
    const { startServer } = await import('../src/server.mjs');
    const app = await startServer({ dataDir, port, concurrency });
    console.log(`\nAgent Relay is running. Open this private URL:\n\n  ${app.url}\n\nData: ${dataDir}\nCtrl+C stops Relay and its agents.\n`);
    let closing = false;
    const stop = async () => { if (closing) return; closing = true;
      try { await app.close(); process.exitCode = 0; } catch (error) { console.error(error.message); process.exitCode = 1; }
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } else throw new Error(usage);
} catch (error) { console.error(error.message); process.exitCode = 1; }
