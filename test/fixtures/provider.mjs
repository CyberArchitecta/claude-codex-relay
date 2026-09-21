import { readFileSync, appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('fixture-cli 1.0'); process.exit(0); }
const agent = process.argv[2] === 'exec' ? 'codex' : 'claude';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
let settings = {}; try { settings = JSON.parse(readFileSync('fixture.json', 'utf8')); } catch {}
appendFileSync('received.jsonl', `${JSON.stringify({ agent, prompt, args: process.argv.slice(2), time: Date.now(), pid: process.pid })}\n`);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const session = `${agent}-fixture-session`;
emit(agent === 'codex' ? { type: 'thread.started', thread_id: session } : { type: 'system', subtype: 'init', session_id: session });
if (settings.mode === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
if (settings.delay) await new Promise(resolve => setTimeout(resolve, settings.delay));
if (settings.mode === 'missing') process.exit(0);
if (settings.mode === 'startup_error') {
  emit({ type: 'error', message: 'The configured model requires a newer version of Codex.' });
  process.stderr.write('Unrelated startup warning\\n'); process.exit(1);
}
if (settings.mode === 'rate') {
  if (agent === 'codex') emit({ type: 'turn.failed', error: { message: 'Usage limit reached' } });
  else emit({ type: 'result', is_error: true, errors: ['Usage limit reached'] });
  process.exit(1);
}
const message = `Verified fixture response: café 🛰️. ${prompt.includes('secret-fixture-context') ? 'context received' : 'ready'}`;
// Split a UTF-8 character across chunks to exercise stream decoding.
const response = Buffer.from(`${JSON.stringify(agent === 'codex' ? { type: 'item.completed', item: { type: 'agent_message', text: message } } : { type: 'assistant', message: { content: [{ type: 'text', text: message }] } })}\n`);
const cut = response.indexOf(Buffer.from('🛰️')) + 1;
process.stdout.write(response.subarray(0, cut)); await new Promise(resolve => setTimeout(resolve, 10)); process.stdout.write(response.subarray(cut));
if (agent === 'codex') emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 } });
else emit({ type: 'result', result: message, usage: { input_tokens: 10, output_tokens: 15, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }, total_cost_usd: 0.03, is_error: false, session_id: session, permission_denials: settings.mode === 'permission' ? [{ tool_name: 'Bash' }] : [] });
