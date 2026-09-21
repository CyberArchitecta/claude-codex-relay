import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { findProvider } from './providers.mjs';

export function normalizeLimits(result) {
  const groups = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : result?.rateLimits ? [result.rateLimits] : [];
  return groups.flatMap(group => ['primary', 'secondary'].flatMap(key => {
    const w = group[key];
    if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return [];
    const mins = w.windowDurationMins;
    const name = mins === 10080 ? 'Weekly' : mins === 300 ? '5-hour' : mins ? `${mins} minutes` : key;
    return [{ name: `${group.limitName || group.limitId || 'Codex'} · ${name}`, usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
      resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null }];
  }));
}
export function readCodexLimits(resolveProvider = findProvider) {
  return new Promise((resolve, reject) => {
    let child, lines, timer, done = false, bytes = 0;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer); lines?.close();
      if (child) { child.stdin.end(); child.kill(); }
      error ? reject(error) : resolve({ windows: normalizeLimits(result), checkedAt: new Date().toISOString() });
    };
    try {
      const bin = resolveProvider('codex');
      child = spawn(bin.command, [...bin.prefix, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
      const send = value => child.stdin.write(JSON.stringify(value) + '\n');
      timer = setTimeout(() => finish(new Error('Codex limit check timed out. Try again later.')), 15_000);
      child.once('error', () => finish(new Error('Could not start the Codex limit check.')));
      child.once('close', () => finish(new Error('Codex closed before returning plan limits.')));
      child.stdin.on('error', () => {});
      child.stderr.resume();
      lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        bytes += line.length;
        if (bytes > 2_000_000) return finish(new Error('Unexpectedly large Codex response.'));
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.id === 1) {
          if (event.error) return finish(new Error('This Codex CLI does not support the limit check.'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (event.id === 2) {
          if (event.error) return finish(new Error('Plan limits are unavailable. Check that the Codex CLI is signed in with ChatGPT.'));
          finish(null, event.result);
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_relay', title: 'Agent Relay', version: '0.2.1' } } });
    } catch (error) { finish(error); }
  });
}
