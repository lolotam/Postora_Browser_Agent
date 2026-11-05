// Local distribution only. No network, store transformations, or publishing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageFiles, zip } from './package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const names = [...packageFiles(root), 'native/host.mjs', 'native/project.mjs', 'native/speech.mjs', 'native/install.mjs', 'docs/PRIVATE-ACCESS.md'];
const entries = names.map((name) => ({ name, data: fs.readFileSync(path.join(root, name)) }));
const out = path.join(root, 'dist', `postora-private-v${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zip(entries));
console.log(`${out}: ${entries.length} files. Private build; nothing uploaded.`);
