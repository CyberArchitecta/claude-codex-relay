import readline from 'node:readline';
import { Bridge } from './bridge.mjs';
import { Store, textValue } from './store.mjs';

const channel = { type: 'string' }, limit = { type: 'integer', minimum: 1, maximum: 100 };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const toolDefinitions = [
  { name: 'bridge_send', description: 'Send a local message to the other agent at its next turn. Does not wake it. Never send secrets.', inputSchema: schema({ message: { type: 'string', maxLength: 20_000 }, channel, reply_to: { type: 'integer', minimum: 1 } }, ['message']) },
  { name: 'bridge_inbox', description: 'Read your inbox; defaults to unread messages and marks them read.', inputSchema: schema({ channel, limit, unread_only: { type: 'boolean' }, mark_read: { type: 'boolean' } }) },
  { name: 'bridge_history', description: 'Read both agents’ messages without changing unread state.', inputSchema: schema({ channel, limit }) },
  { name: 'bridge_status', description: 'Inspect bridge identity and unread counts.', inputSchema: schema({}) },
  { name: 'bridge_wait', description: 'Wait up to 55 seconds for your next message.', inputSchema: schema({ channel, timeout_seconds: { type: 'integer', minimum: 1, maximum: 55 } }) },
  { name: 'relay_tasks', description: 'List tasks recorded in the local Relay workspace.', inputSchema: schema({}) },
  { name: 'relay_context', description: 'Read a task’s original request, shared context, and recorded run summaries.', inputSchema: schema({ task_id: { type: 'string' } }, ['task_id']) },
  { name: 'relay_note', description: 'Append a factual note to the shared task context. Does not start an agent.', inputSchema: schema({ task_id: { type: 'string' }, note: { type: 'string', maxLength: 5000 } }, ['task_id', 'note']) }
];
export function startMcp({ dataDir, bridgeDir, agent, input = process.stdin, output = process.stdout }) {
  const bridge = new Bridge(bridgeDir, agent), store = new Store(dataDir);
  let closing = false; let pending = 0;
  async function call(name, args) {
    const definition = toolDefinitions.find(t => t.name === name);
    if (!definition) throw new Error('Unknown tool.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
    for (const key of Object.keys(args)) if (!(key in definition.inputSchema.properties)) throw new Error(`Unexpected argument: ${key}`);
    if (name === 'bridge_send') return bridge.send(args);
    if (name === 'bridge_inbox') return bridge.inbox(args);
    if (name === 'bridge_history') return bridge.history(args);
    if (name === 'bridge_status') return bridge.status();
    if (name === 'bridge_wait') {
      const timeout = args.timeout_seconds ?? 30;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 55) throw new Error('Invalid wait timeout.');
      const deadline = Date.now() + timeout * 1000;
      do {
        const result = bridge.inbox({ channel: args.channel, limit: 100 });
        if (result.messages.length) return { ...result, timed_out: false };
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (!closing && Date.now() < deadline);
      return { agent, timed_out: true, messages: [] };
    }
    if (name === 'relay_tasks') return { tasks: store.tasks().map(({ id, title, project, state, agent: owner }) => ({ id, title, project, state, agent: owner })) };
    textValue(args.task_id, 'Task ID', 160);
    const task = store.task(args.task_id);
    if (name === 'relay_note') {
      const note = textValue(args.note, 'Note', 5000);
      store.setContext(task.id, `${task.context}\n\n[${agent}] ${note}`.trim());
      return { task_id: task.id, saved: true };
    }
    return { task, runs: store.runs(task.id).map(({ id, agent, state, summary }) => ({ id, agent, state, summary })) };
  }
  const send = payload => { if (!closing) output.write(`${JSON.stringify(payload)}\n`); };
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', async line => {
    if (!line.trim()) return;
    let request; pending++;
    try {
      if (line.length > 100_000) throw new Error('Request too large.');
      request = JSON.parse(line);
      if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); return;
      }
      if (request.id == null) return;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'claude-codex-relay', version: '0.1.0' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: toolDefinitions };
      else if (request.method === 'tools/call') {
        try { const value = await call(request.params?.name, request.params?.arguments ?? {});
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
        } catch (error) { result = { content: [{ type: 'text', text: error.message }], isError: true }; }
      } else if (request.method === 'resources/list') result = { resources: [] };
      else if (request.method === 'prompts/list') result = { prompts: [] };
      else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return; }
      send({ jsonrpc: '2.0', id: request.id, result });
    } catch { send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32700, message: 'Parse error' } }); }
    finally { pending--; }
  });
  lines.on('close', async () => { closing = true; while (pending) await new Promise(resolve => setTimeout(resolve, 20)); bridge.close(); store.close(); });
  return { close: () => { closing = true; lines.close(); } };
}
