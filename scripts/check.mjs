import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const files = ['bin', 'src', 'public', 'test', 'scripts'].flatMap(walk);
for (const file of files.filter(file => /\.(mjs|js)$/.test(file))) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (manifest.dependencies || manifest.devDependencies) throw new Error('Review dependency changes before publishing.');
console.log(`Syntax checked ${files.filter(file => /\.(mjs|js)$/.test(file)).length} JavaScript files. Zero external runtime dependencies.`);
