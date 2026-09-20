import path from 'node:path';
import { Store } from '../../src/store.mjs';
import { Bridge } from '../../src/bridge.mjs';
const root = process.argv[2];
const bridge = new Bridge(path.join(root, 'bridge'), 'claude');
const store = new Store(path.join(root, 'state'));
bridge.send({ channel: 'concurrent', message: 'Opened successfully.' });
store.close(); bridge.close();
