// Private Windows offline transcription. Downloads are pinned and verified before
// execution; microphone bytes are never sent to a network service by this module.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const SPEECH_ASSETS = [
  { name: 'runtime.zip', size: 8194445, sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a', url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip' },
  { name: 'model.bin', size: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin' },
  { name: 'vclibs.appx', size: 6764349, sha256: 'b56a9101f706f9d95f815f5b7fa6efbac972e86573d378b96a07cff5540c5961', url: 'https://download.microsoft.com/download/4/7/c/47c6134b-d61f-4024-83bd-b9c9ea951c25/Microsoft.VCLibs.x64.14.00.Desktop.appx' },
];
const root = () => path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Postora', 'speech');
const installedPath = () => path.join(root(), 'whisper-base-1.9.2-r2');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function validateWav(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid local audio payload.');
  const wav = Buffer.from(encoded, 'base64');
  if (wav.length < 46 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE'
    || wav.toString('ascii', 12, 16) !== 'fmt ' || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1
    || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(34) !== 16
    || wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== wav.length - 44 || wav.length > 1024044) {
    throw new Error('Expected mono 16 kHz PCM WAV, at most 32 seconds.');
  }
  return wav;
}

async function status(verify = false) {
  try {
    const directory = installedPath();
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'installed.json'), 'utf8'));
    if (manifest.model !== 'base' || manifest.version !== '1.9.2-r2' || !manifest.files?.['whisper-cli.exe'] || !manifest.files?.['model.bin'] || !manifest.files?.['vcomp140.dll']) return { installed: false };
    for (const [name, record] of Object.entries(manifest.files)) {
      if (path.basename(name) !== name || !/^(model\.bin|[\w.-]+\.(exe|dll))$/.test(name)) return { installed: false };
      const file = path.join(directory, name);
      if ((await fs.stat(file)).size !== record.size) return { installed: false };
      if (verify && sha(await fs.readFile(file)) !== record.sha256) return { installed: false };
    }
    if (manifest.files['model.bin'].sha256 !== SPEECH_ASSETS[1].sha256) return { installed: false };
    return { installed: true, model: 'base' };
  } catch { return { installed: false }; }
}

function run(file, args, { signal, onChild, cwd, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(child);
    let output = '', settled = false, stoppedError;
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); onChild?.(null); error ? reject(error) : resolve(output); };
    const stop = () => { stoppedError = new Error('Local speech operation cancelled.'); child.kill(); };
    const timer = setTimeout(() => { stoppedError = new Error('Local speech operation timed out.'); child.kill(); }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (data) => { if (output.length < 64000) output += data.toString(); });
    child.once('error', finish);
    child.once('close', (code) => finish(stoppedError || (code === 0 ? null : new Error(`Local speech process failed (${code}).`))));
  });
}

export async function downloadAsset(asset, target, { signal, fetcher = fetch, onBytes = () => {} } = {}) {
  const response = await fetcher(asset.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status}).`);
  const file = await fs.open(target, 'wx');
  const hash = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      if (bytes > asset.size) throw new Error('Downloaded file exceeds its expected size.');
      hash.update(chunk); await file.writeFile(chunk); onBytes(chunk.length);
    }
    if (bytes !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('Downloaded file failed SHA-256 verification.');
  } finally { await file.close(); }
}

async function install(options) {
  if ((await status(true)).installed) return { installed: true, model: 'base' };
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Local Whisper currently requires 64-bit Windows.');
  await fs.mkdir(root(), { recursive: true });
  // Each attempt owns its staging directory. Cancellation never removes another
  // attempt's files; the final directory appears only after all checks pass.
  const staging = await fs.mkdtemp(path.join(root(), '.download-'));
  const total = SPEECH_ASSETS.reduce((sum, item) => sum + item.size, 0);
  let received = 0;
  try {
    for (const asset of SPEECH_ASSETS) await downloadAsset(asset, path.join(staging, asset.name), {
      ...options, onBytes: (bytes) => { received += bytes; options.onProgress?.({ type: 'progress', phase: 'download', received, total, percent: Math.min(99, Math.floor(received * 100 / total)) }); },
    });
    options.onProgress?.({ type: 'progress', phase: 'install', percent: 99, received, total });
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($args[0]); try { foreach ($e in $z.Entries) { if ($e.Name -match '^[\\w.-]+\\.(exe|dll)$') { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, [IO.Path]::Combine($args[1], $e.Name), $false) } } } finally { $z.Dispose() }`;
    // A script file keeps argument paths separate from PowerShell source.
    await fs.writeFile(path.join(staging, 'extract.ps1'), script);
    await run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(staging, 'extract.ps1'), path.join(staging, 'runtime.zip'), staging], options);
    // App-local Microsoft runtime: no admin prompt or machine-wide installation.
    const runtimeScript = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($args[0]); try { foreach ($e in $z.Entries) { if ($e.Name -match '^(msvcp140[\\w_]*|vcruntime140[\\w_]*|vcomp140)\\.dll$') { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, [IO.Path]::Combine($args[1], $e.Name), $false) } } } finally { $z.Dispose() }`;
    await fs.writeFile(path.join(staging, 'extract.ps1'), runtimeScript);
    await run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(staging, 'extract.ps1'), path.join(staging, 'vclibs.appx'), staging], options);
    await fs.stat(path.join(staging, 'whisper-cli.exe'));
    // Download completion is not readiness: exercise the executable and its DLLs.
    await run(path.join(staging, 'whisper-cli.exe'), ['--help'], options);
    const files = {};
    for (const name of await fs.readdir(staging)) if (/^(model\.bin|[\w.-]+\.(exe|dll))$/.test(name)) {
      const data = await fs.readFile(path.join(staging, name)); files[name] = { size: data.length, sha256: sha(data) };
    }
    await fs.unlink(path.join(staging, 'runtime.zip')); await fs.unlink(path.join(staging, 'vclibs.appx')); await fs.unlink(path.join(staging, 'extract.ps1'));
    await fs.writeFile(path.join(staging, 'installed.json'), JSON.stringify({ version: '1.9.2-r2', model: 'base', files }));
    options.signal?.throwIfAborted();
    try { await fs.rename(staging, installedPath()); }
    catch (error) { if (!(await status(true)).installed) throw new Error(`Local installation could not be committed: ${error.code}.`); }
    return await status(true);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

export async function speechOperation(message, options = {}) {
  if (message.type === 'speech-status') return status();
  if (message.type === 'speech-install') return install(options);
  if (message.type !== 'speech-transcribe') throw new Error('Unknown speech operation.');
  const wav = validateWav(message.audio);
  if (!(await status(true)).installed) throw new Error('Download the local model in Settings → Voice first.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-audio-'));
  try {
    await fs.writeFile(path.join(directory, 'input.wav'), wav);
    await run(path.join(installedPath(), 'whisper-cli.exe'), ['-m', path.join(installedPath(), 'model.bin'), '-f', path.join(directory, 'input.wav'), '-l', 'auto', '-otxt', '-of', path.join(directory, 'transcript'), '-nt', '-t', String(Math.max(1, Math.min(8, os.cpus().length - 2)))], options);
    const text = (await fs.readFile(path.join(directory, 'transcript.txt'), 'utf8')).trim();
    return { text };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
