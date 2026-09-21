import path from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { Store } from '../../src/store.mjs';
const [root, taskId, worker] = process.argv.slice(2);
const store = new Store(path.join(root, 'data'));
writeFileSync(path.join(root, `ready-${worker}`), '');
const deadline = Date.now() + 20_000;
while (!existsSync(path.join(root, 'go'))) {
  if (Date.now() > deadline) throw new Error('Timed out waiting for concurrent append start');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
for (let i = 0; i < 10; i++) store.appendContext(taskId, `worker-${worker}-note-${i}`);
store.close();
