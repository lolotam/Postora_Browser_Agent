// Register only for this Windows user and this unpacked extension's stable ID.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimeFiles } from './runtime-files.mjs';
import { checkRuntime } from './runtime-check.mjs';

if (process.platform !== 'win32') throw new Error('The private native host currently supports Windows only.');
const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(source, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (!manifest.key) throw new Error('Install from the private build, which retains manifest.key.');
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const origin = `chrome-extension://${id}/`;
const directory = path.join(process.env.LOCALAPPDATA, 'Postora', 'native');
const launcher = path.join(directory, 'host.cmd');
// These characters have special meaning even inside a quoted batch argument.
if ([directory, process.execPath].some((value) => /[%!"\r\n]/.test(value))) throw new Error('Unsupported special characters in the native host or Node path.');

fs.mkdirSync(directory, { recursive: true });
for (const name of fs.readdirSync(source)) {
  if (name.endsWith('.mjs')) fs.copyFileSync(path.join(source, name), path.join(directory, name));
}
for (const rel of runtimeFiles(root)) {
  const from = path.join(root, rel);
  const to = path.join(directory, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ origin }));
fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${path.join(directory, 'host.mjs')}" %*\r\n`);
const hostManifest = path.join(directory, 'com.postora.private_terminal.json');
fs.writeFileSync(hostManifest, JSON.stringify({ name: 'com.postora.private_terminal', description: 'Private Postora PowerShell bridge', path: launcher, type: 'stdio', allowed_origins: [origin] }, null, 2));
for (const browser of ['Google\\Chrome', 'Microsoft\\Edge', 'Chromium', 'Comet']) {
  const result = spawnSync('reg.exe', ['ADD', `HKCU\\Software\\${browser}\\NativeMessagingHosts\\com.postora.private_terminal`, '/ve', '/t', 'REG_SZ', '/d', hostManifest, '/f'], { windowsHide: true, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Native host registration failed.');
}
// The local speech runtime is a native library and needs a Visual C++ runtime
// this installer does not install: a machine-wide redistributable is the
// user's decision. The check runs in a child process, so an old runtime is a
// message here and not a crash of the installer.
const runtime = await checkRuntime();

console.log(`Private host installed for ${origin}\n${hostManifest}\nReload the unpacked extension. Select Full access in the chat to run commands without per-command approval.`);
if (runtime.ok) {
  console.log(`Local speech runtime ready${runtime.version ? ` (Visual C++ ${runtime.version})` : ''}.`);
} else {
  console.log(`Local speech (Nemotron) is not ready: ${runtime.reason}\n${runtime.instruction}`);
}
