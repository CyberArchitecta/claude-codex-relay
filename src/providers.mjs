import { existsSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
export function findProvider(agent, env = process.env, platform = process.platform) {
  if (!['claude', 'codex'].includes(agent)) throw new Error('Agent must be claude or codex.');
  const override = env[`RELAY_${agent.toUpperCase()}_BIN`];
  const folders = (env.PATH || env.Path || '').split(path.delimiter);
  const candidates = override ? [override] : folders.flatMap(folder =>
    platform === 'win32' ? [path.join(folder, `${agent}.exe`), path.join(folder, `${agent}.cmd`)] : [path.join(folder, agent)]);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    if (platform === 'win32' && /\.(cmd|ps1|bat)$/i.test(resolved)) {
      const entry = path.join(path.dirname(resolved), 'node_modules',
        agent === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js');
      if (existsSync(entry)) return { command: process.execPath, prefix: [entry], path: entry };
      continue; // Never pass prompts through cmd.exe or PowerShell shims.
    }
    return /\.[cm]?js$/i.test(resolved)
      ? { command: process.execPath, prefix: [resolved], path: resolved }
      : { command: resolved, prefix: [], path: resolved };
  }
  throw new Error(`${agent} was not found. Install and sign in to its CLI, then restart Relay. RELAY_${agent.toUpperCase()}_BIN can point to a native executable or JS entry point.`);
}

export function providerArgs({ agent, permission = 'read-only', model = '', session_id = null }) {
  if (!['read-only', 'workspace-write'].includes(permission)) throw new Error('Invalid permission mode.');
  if (session_id && !/^[a-zA-Z0-9_-]{1,160}$/.test(session_id)) throw new Error('Invalid provider session ID.');
  if (model && !/^[a-zA-Z0-9._:/-]{1,120}$/.test(model)) throw new Error('Invalid model name.');
  if (agent === 'codex') {
    return ['exec', '-c', `sandbox_mode="${permission}"`, '-c', 'approval_policy="never"',
      ...(session_id ? ['resume', session_id] : []), '--json',
      ...(model ? ['--model', model] : []), '-'];
  }
  if (agent !== 'claude') throw new Error('Invalid agent.');
  return ['-p', '--output-format', 'stream-json', '--verbose',
    ...(permission === 'read-only'
      ? ['--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
      : ['--permission-mode', 'acceptEdits']),
    ...(session_id ? ['--resume', session_id] : []), ...(model ? ['--model', model] : [])];
}

export async function doctor() {
  return Promise.all(['claude', 'codex'].map(async agent => {
    try {
      const bin = findProvider(agent);
      const { stdout } = await exec(bin.command, [...bin.prefix, '--version'], { timeout: 12_000, windowsHide: true });
      let authenticated = null;
      try {
        const status = await exec(bin.command, [...bin.prefix, ...(agent === 'claude' ? ['auth', 'status'] : ['login', 'status'])], { timeout: 8000, windowsHide: true });
        if (agent === 'claude') authenticated = JSON.parse(status.stdout).loggedIn ?? null;
        else if (/logged in/i.test(status.stdout + status.stderr)) authenticated = true;
      } catch (error) {
        const output = String(error.stdout || '') + String(error.stderr || '');
        if (/not logged in|"loggedIn"\s*:\s*false/i.test(output)) authenticated = false;
      }
      return { agent, available: true, authenticated, version: stdout.trim(), path: bin.path };
    } catch (error) { return { agent, available: false, error: error.message }; }
  }));
}

export function failureState(message) {
  if (/usage limit|rate.?limit|quota|too many requests|limit reached|hit your limit|insufficient_quota/i.test(message)) return 'limited';
  if (/permission|approval|not authorized|login|log in|sign in|authentication|requires a newer version|model.*not supported/i.test(message)) return 'needs_attention';
  return 'failed';
}

export function parseEvent(agent, event) {
  const out = { events: [] };
  const add = (kind, text) => { if (text) out.events.push({ kind, text: String(text) }); };
  if (agent === 'codex') {
    if (event.type === 'thread.started') out.sessionId = event.thread_id;
    if (event.type === 'item.completed' || event.type === 'item.started') {
      const item = event.item || {};
      if (item.type === 'agent_message') { add('message', item.text); out.summary = item.text; }
      else if (item.type === 'command_execution') add('command', `${item.command || ''}\n${item.aggregated_output || ''}${item.exit_code != null ? `\nExit: ${item.exit_code}` : ''}`);
      else if (item.type === 'file_change') add('files', JSON.stringify(item.changes || []));
      else add('step', item.text || `${item.type || 'item'}: ${item.status || event.type}`);
    }
    if (event.type === 'turn.completed') out.terminal = 'completed';
    if (event.type === 'turn.failed') {
      const message = event.error?.message || JSON.stringify(event.error || event);
      add('error', message); out.summary = message; out.terminal = failureState(message);
    }
    if (event.type === 'error') { out.error = event.message || JSON.stringify(event); add('error', out.error); }
  } else {
    if (event.session_id) out.sessionId = event.session_id;
    if (event.type === 'assistant') for (const block of event.message?.content || []) {
      if (block.type === 'text') { add('message', block.text); out.summary = block.text; }
      if (block.type === 'tool_use') add('step', `${block.name}: ${JSON.stringify(block.input || {})}`);
    }
    if (event.type === 'user') for (const block of event.message?.content || []) {
      if (block.type === 'tool_result') add(block.is_error ? 'error' : 'tool_result', typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
    }
    if (event.type === 'system' && event.subtype === 'permission_denied') out.attention = true;
    if (event.type === 'result') {
      const summary = event.result || (event.errors || []).join('\n') || event.subtype || '';
      add(event.is_error ? 'error' : 'result', summary); out.summary = summary;
      out.terminal = event.is_error ? failureState(summary) : 'completed';
      if (event.permission_denials?.length) {
        out.terminal = 'needs_attention'; add('permission', JSON.stringify(event.permission_denials));
      }
    }
  }
  return out;
}
