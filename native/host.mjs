import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { projectOperation } from './project.mjs';
import { speechOperation } from './speech.mjs';

const MAX_MESSAGE = 2 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;

export function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export function validateCommand(message) {
  if (message?.type !== 'run' || typeof message.command !== 'string' || !message.command.trim() || message.command.length > 16000) {
    throw new Error('Expected a nonempty PowerShell command (maximum 16000 characters).');
  }
  if (message.cwd !== undefined && (typeof message.cwd !== 'string' || !path.isAbsolute(message.cwd) || !fs.statSync(message.cwd).isDirectory())) {
    throw new Error('cwd must be an existing absolute directory.');
  }
  const timeout = message.timeout_ms ?? 30000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) throw new Error('timeout_ms must be an integer from 1000 to 60000.');
  return { command: message.command, cwd: message.cwd, timeout };
}

export function startHost(origin) {
  const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  if (origin !== config.origin || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)) {
    process.stderr.write('Postora native host: unauthorized extension origin.\n');
    process.exitCode = 1;
    return;
  }
  let input = Buffer.alloc(0);
  let child = null;
  let accepted = false;
  let ended = false;
  let timedOut = false;
  let output = '';
  let outputBytes = 0;
  let truncated = false;
  let timer;
  let killing = null;
  let replied = false;
  const abort = new AbortController();
  let speechTask;
  const kill = () => {
    if (killing) return killing;
    if (!child?.pid) return Promise.resolve();
    const command = child;
    killing = new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(command.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { command.kill(); resolve(); });
      killer.once('close', resolve);
    });
    return killing;
  };
  const reply = (value) => {
    clearTimeout(timer);
    if (!ended && !replied) {
      replied = true;
      process.stdout.write(frame(value));
    }
  };
  const capture = (chunk, decoder) => {
    const room = MAX_OUTPUT - outputBytes;
    if (chunk.length > room) truncated = true;
    if (room > 0) {
      const part = chunk.subarray(0, room);
      output += decoder.write(part);
      outputBytes += part.length;
    }
  };
  process.stdin.on('data', async (chunk) => {
    if (accepted) return;
    input = Buffer.concat([input, chunk]);
    if (input.length < 4) return;
    const length = input.readUInt32LE(0);
    if (!length || length > MAX_MESSAGE) {
      accepted = true;
      reply({ error: 'Invalid native message length.' });
      return;
    }
    if (input.length < 4 + length) return;
    accepted = true;
    try {
      const message = JSON.parse(input.subarray(4, 4 + length).toString('utf8'));
      if (String(message.type).startsWith('speech-')) {
        input = Buffer.alloc(0);
        speechTask = speechOperation(message, { signal: abort.signal, onChild: (value) => { child = value; },
          onProgress: (value) => { if (!ended) process.stdout.write(frame(value)); } });
        const result = await speechTask;
        reply({ exitCode: 0, result });
        return;
      }
      if (String(message.type).startsWith('project-')) {
        const result = await projectOperation(message);
        reply({ exitCode: 0, result });
        return;
      }
      const args = validateCommand(message);
      input = Buffer.alloc(0);
      const command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop';\n${args.command}`;
      child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { cwd: args.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      child.stdout.on('data', (chunk) => capture(chunk, stdoutDecoder));
      child.stderr.on('data', (chunk) => capture(chunk, stderrDecoder));
      child.once('error', (error) => reply({ error: error.message }));
      child.once('close', (code) => {
        child = null;
        output += stdoutDecoder.end() + stderrDecoder.end();
        reply({ exitCode: timedOut ? -1 : (code ?? -1), output, truncated, timedOut });
      });
      timer = setTimeout(() => { timedOut = true; void kill(); }, args.timeout);
    } catch (error) {
      reply({ error: error.message });
    }
  });
  // Chrome closes this pipe when the command is cancelled or the worker dies.
  process.stdin.once('end', async () => {
    ended = true;
    abort.abort();
    clearTimeout(timer);
    await kill();
    await speechTask?.catch(() => {});
    process.exit();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startHost(process.argv[2]);
