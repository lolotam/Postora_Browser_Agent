import fs from 'node:fs';
import path from 'node:path';

const PINNED = Object.freeze({
  transcribe: 'node_modules/transcribe-cpp',
  platform: 'node_modules/@transcribe-cpp/win32-x64-cpu-vulkan',
  koffi: 'node_modules/koffi',
});

function walk(dir, root, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in runtime files: ${rel}`);
    if (entry.isDirectory()) walk(full, root, out);
    else if (entry.isFile()) out.push(rel);
  }
}

function includePrefix(files, prefix) {
  return files.filter((file) => file === prefix || file.startsWith(`${prefix}/`));
}

function transcribeFiles(root) {
  const base = PINNED.transcribe;
  const dir = path.join(root, base);
  if (!fs.existsSync(dir)) return [];
  const all = [];
  walk(dir, root, all);
  return all.filter((file) =>
    file === `${base}/package.json` ||
    file === `${base}/LICENSE` ||
    file === `${base}/README.md` ||
    file.startsWith(`${base}/dist/`) ||
    file.startsWith(`${base}/scripts/`));
}

function platformFiles(root) {
  const base = PINNED.platform;
  const dir = path.join(root, base);
  if (!fs.existsSync(dir)) return [];
  const all = [];
  walk(dir, root, all);
  return all;
}

function koffiFiles(root) {
  const base = PINNED.koffi;
  const dir = path.join(root, base);
  if (!fs.existsSync(dir)) return [];
  const all = [];
  walk(dir, root, all);
  return all.filter((file) =>
    file === `${base}/package.json` ||
    file === `${base}/LICENSE.txt` ||
    file === `${base}/README.md` ||
    file === `${base}/index.cjs` ||
    file === `${base}/index.js` ||
    file === `${base}/index.d.ts` ||
    file === `${base}/indirect.cjs` ||
    file === `${base}/indirect.js` ||
    file === `${base}/cnoke.cjs` ||
    file.startsWith(`${base}/build/`) ||
    file.startsWith(`${base}/lib/`) ||
    file.startsWith(`${base}/src/koffi/src/`) ||
    file.startsWith(`${base}/src/koffi/index`) ||
    file.startsWith(`${base}/src/koffi/indirect`) ||
    file.startsWith(`${base}/src/koffi/CMakeLists.txt`) ||
    file.startsWith(`${base}/vendor/`));
}

export function runtimeFiles(root) {
  const files = [...transcribeFiles(root), ...platformFiles(root), ...koffiFiles(root)];
  const unique = [...new Set(files)].sort();
  for (const file of unique) {
    if (file.startsWith('../') || file.includes('/../') || path.isAbsolute(file)) throw new Error(`Runtime file escapes root: ${file}`);
  }
  return unique;
}

export function runtimePackageRoots() {
  return { ...PINNED };
}
