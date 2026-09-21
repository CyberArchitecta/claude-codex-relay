import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, usageTotals } from '../src/usage.mjs';
import { normalizeLimits } from '../src/limits.mjs';
test('usage counts cache once, includes Claude model totals, and keeps missing data unknown', () => {
  const codex = parseUsage('codex', { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 } });
  assert.equal(codex.input + codex.output, 120); assert.equal(codex.costUsd, null);
  const claude = parseUsage('claude', { type: 'result', total_cost_usd: 0.03, modelUsage: { model: { inputTokens: 10, outputTokens: 15, cacheReadInputTokens: 20, cacheCreationInputTokens: 30 } } });
  assert.equal(claude.input, 60); assert.equal(claude.output, 15); assert.equal(claude.costUsd, 0.03);
  assert.equal(claude.includesSubagents, true);
  assert.equal(parseUsage('codex', { type: 'turn.completed' }), null);
  assert.equal(parseUsage('claude', { type: 'result' }), null);
  const totals = usageTotals([
    { id: 'a', agent: 'codex', session_id: 'one', usage: codex },
    { id: 'b', agent: 'codex', session_id: 'one', usage: { ...codex, input: 180, output: 40 } },
    { id: 'c', agent: 'claude', usage: claude },
    { id: 'd', agent: 'claude', usage: claude },
    { id: 'e', agent: 'claude', state: 'cancelled', usage: null }
  ]);
  assert.equal(totals[1].total, 220); assert.equal(totals[0].total, 150); assert.equal(totals[0].unreported, 1);
});
test('plan windows distinguish usage percentages from remaining amounts', () => {
  assert.deepEqual(normalizeLimits({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 123 }, secondary: null } } }),
    [{ name: 'codex · 5-hour', usedPercent: 6, resetsAt: 123 }]);
  assert.deepEqual(normalizeLimits({}), []);
});
