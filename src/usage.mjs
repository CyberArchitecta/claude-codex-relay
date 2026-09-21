const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function parseUsage(agent, event) {
  if (agent === 'codex' && event.type === 'turn.completed' && event.usage) {
    const u = event.usage, input = count(u.input_tokens), output = count(u.output_tokens);
    if (input === null || output === null) return null;
    return { input, output, cached: count(u.cached_input_tokens), cacheWrite: count(u.cache_write_input_tokens),
      reasoning: count(u.reasoning_output_tokens), costUsd: null, scope: 'session', source: 'codex-cli' };
  }
  if (agent === 'claude' && event.type === 'result') {
    const models = Object.values(event.modelUsage || {});
    const u = event.usage;
    if (!models.length && (!u || count(u.input_tokens) === null || count(u.output_tokens) === null)) return null;
    const rows = models.length ? models.map(m => ({ input: count(m.inputTokens), output: count(m.outputTokens),
      cached: count(m.cacheReadInputTokens) ?? 0, cacheWrite: count(m.cacheCreationInputTokens) ?? 0 }))
      : [{ input: u.input_tokens, output: u.output_tokens, cached: count(u.cache_read_input_tokens) ?? 0, cacheWrite: count(u.cache_creation_input_tokens) ?? 0 }];
    if (rows.some(r => r.input === null || r.output === null)) return null;
    const sum = key => rows.reduce((n, r) => n + r[key], 0);
    return { input: sum('input') + sum('cached') + sum('cacheWrite'), output: sum('output'),
      cached: sum('cached'), cacheWrite: sum('cacheWrite'), reasoning: null,
      costUsd: amount(event.total_cost_usd), scope: 'turn', source: 'claude-cli', includesSubagents: !!models.length };
  }
  return null;
}
export function usageTotals(runs) {
  return ['claude', 'codex'].map(agent => {
    const rows = runs.filter(r => r.agent === agent), sessions = new Map(), measured = [];
    for (const r of rows) {
      if (!r.usage) continue;
      if (r.usage.scope === 'session') sessions.set(r.session_id || r.id, r.usage);
      else measured.push(r.usage);
    }
    measured.push(...sessions.values());
    const sum = key => measured.reduce((n, u) => n + (u[key] ?? 0), 0);
    return { agent, input: sum('input'), output: sum('output'), cached: sum('cached'), cacheWrite: sum('cacheWrite'),
      total: sum('input') + sum('output'), costUsd: measured.some(u => u.costUsd !== null) ? sum('costUsd') : null,
      reported: measured.length, unreported: rows.filter(r => !r.usage && !['queued','running'].includes(r.state) && !sessions.has(r.session_id)).length };
  });
}
