// SQLite journal-mode changes can return BUSY immediately despite busy_timeout.
// Retry only lock contention during idempotent initialization, never arbitrary SQL failures.
export function retryBusy(operation, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return operation(); }
    catch (error) {
      const primaryCode = Number(error.errcode) & 0xff;
      const busy = primaryCode === 5 || primaryCode === 6 || /database (?:table |schema )?is locked/i.test(error.message);
      if (!busy || Date.now() >= deadline) throw error;
      Atomics.wait(sleeper, 0, 0, 40);
    }
  }
}
