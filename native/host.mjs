import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { projectOperation } from './project.mjs';
import { speechOperation } from './speech.mjs';

const MAX_MESSAGE = 2 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_STREAM_QUEUE = 4 * 1024 * 1024;
// A stream frame carries one chunk of audio: a few kilobytes, never a file.
const MAX_STREAM_MESSAGE = 32 * 1024;

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
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) {
    throw new Error('timeout_ms must be an integer from 1000 to 60000.');
  }
  return { command: message.command, cwd: message.cwd, timeout };
}

export function killTree(pid) {
  if (!pid) return Promise.resolve();
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => { try { process.kill(pid); } catch {} resolve(); });
    killer.once('close', () => resolve());
  });
}

export function createFrameParser(onMessage, { maxMessage = MAX_MESSAGE, maxBuffered = MAX_MESSAGE * 2, sync = false } = {}) {
  let buffer = Buffer.alloc(0);
  let queued = Promise.resolve();

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxBuffered) throw new Error('Native message buffer exceeded limit.');
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > maxMessage) throw new Error('Native message exceeds maximum size.');
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);
      const message = JSON.parse(body);
      if (sync) {
        onMessage(message);
      } else {
        queued = queued.then(() => onMessage(message), () => onMessage(message));
      }
    }
  };
}

async function defaultLoadNemotronModel(options = {}) {
  const { loadNemotronModel, NEMOTRON_LANGUAGE, NEMOTRON_STREAM_FAMILY } = await import('./nemotron.mjs');
  const model = await loadNemotronModel(options);
  return { model, streamOptions: { family: NEMOTRON_STREAM_FAMILY, language: NEMOTRON_LANGUAGE } };
}

async function startStreamMode(firstMessage, { stdin = process.stdin, stdout = process.stdout, loadModel = defaultLoadNemotronModel, rest = Buffer.alloc(0) } = {}) {
  const { createSpeechStream } = await import('./speech-stream.mjs');
  const send = (value) => stdout.write(frame(value));
  let streamOptions = {};
  let stream = null;
  let loading = null;
  const streamFor = async () => {
    if (stream) return stream;
    // The model is loaded once: a load that failed is the same failure for
    // every frame that follows it.
    if (!loading) {
      loading = (async () => {
        const loaded = await loadModel();
        const model = loaded?.model ?? loaded;
        streamOptions = loaded?.streamOptions ?? {};
        stream = createSpeechStream({ loadModel: async () => model, send, streamOptions });
        return stream;
      })();
    }
    return loading;
  };
  let queueBytes = 0;
  const runMessage = async (message) => {
    const size = Buffer.byteLength(JSON.stringify(message));
    queueBytes += size;
    if (queueBytes > MAX_STREAM_QUEUE) throw new Error('Speech stream input queue exceeded limit.');
    try {
      const target = await streamFor();
      await target.handle(message);
    } catch (error) {
      send({ type: 'error', error: error?.message || String(error), captureId: message?.captureId, phraseId: message?.phraseId });
      await stream?.cancel?.();
    } finally {
      queueBytes -= size;
    }
  };

  // Input can end while the model is still loading: the stream does not exist
  // yet, so the end is recorded and acted on as soon as it does.
  let inputEnded = false;
  const onInputEnd = () => { inputEnded = true; void stream?.cancel?.(); };
  stdin.on('end', onInputEnd);
  stdin.on('error', onInputEnd);
  await runMessage(firstMessage);
  if (inputEnded) await stream?.cancel?.();
  const parser = createFrameParser((message) => { void runMessage(message); }, { maxBuffered: MAX_STREAM_QUEUE, maxMessage: MAX_STREAM_MESSAGE });
  // The first chunk can carry more than the frame that opened the stream.
  if (rest.length) {
    try { parser(rest); }
    catch (error) {
      send({ type: 'error', error: error?.message || String(error) });
      void stream?.cancel?.();
    }
  }
  stdin.on('data', (chunk) => {
    try { parser(chunk); }
    catch (error) {
      send({ type: 'error', error: error?.message || String(error) });
      void stream?.cancel?.();
    }
  });
}

function isAuthorizedOrigin(origin, configOrigin) {
  return origin === configOrigin && /^chrome-extension:\/\/[a-p]{32}\/$/.test(origin);
}

export function startHost(origin, options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const configPath = options.configPath ?? new URL('./config.json', import.meta.url);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!isAuthorizedOrigin(origin, config.origin)) {
    process.stderr.write('Postora native host: unauthorized extension origin.\n');
    process.exitCode = 1;
    return;
  }

  let input = Buffer.alloc(0);
  let child = null;
  let accepted = false;
  let ended = false;
  let timedOut = false;
  let cancelled = false;
  let output = '';
  let outputBytes = 0;
  let truncated = false;
  let timer;
  let replied = false;
  let streamMode = false;
  const abort = new AbortController();
  let speechTask;
  let projectTask;
  let killing = null;
  let currentType = '';

  const kill = () => {
    if (killing) return killing;
    killing = killTree(child?.pid);
    return killing;
  };

  const reply = (value) => {
    clearTimeout(timer);
    if (!ended && !replied) {
      replied = true;
      stdout.write(frame(value));
    }
  };

  const replyProjectCancellation = (err) => {
    const confirmedPreCommit = err?.preCommitAbort === true && !err?.committed;
    if (confirmedPreCommit) {
      reply({ cancelled: true, outcome: 'stopped' });
      return;
    }
    reply({
      cancelled: true,
      outcome: 'unknown',
      ...(err?.message ? { error: err.message } : {}),
    });
  };

  const stopWork = async () => {
    if (cancelled) return;
    cancelled = true;
    abort.abort();
    clearTimeout(timer);
    const hadChild = Boolean(child);
    await kill();
    if (projectTask) {
      try {
        const result = await projectTask;
        reply({ exitCode: 0, result });
        return;
      } catch (err) {
        replyProjectCancellation(err);
        return;
      }
    }
    if (speechTask) {
      await speechTask.catch(() => {});
      reply({ cancelled: true, outcome: 'stopped' });
      return;
    }
    if (!hadChild) {
      reply({ cancelled: true, outcome: 'stopped' });
      return;
    }
    reply({
      cancelled: true,
      outcome: 'unknown',
      exitCode: -1,
      output,
      truncated,
    });
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

  const handleControlFrame = (message) => {
    if (message?.type === 'cancel') {
      void stopWork();
    }
  };

  let controlParser = null;

  stdin.on('data', async (chunk) => {
    if (accepted) {
      if (!streamMode && controlParser) {
        try { controlParser(chunk); } catch { /* Ignore malformed trailing control bytes. */ }
      }
      return;
    }
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
    const rest = input.subarray(4 + length);
    try {
      const message = JSON.parse(input.subarray(4, 4 + length).toString('utf8'));
      currentType = String(message?.type ?? '');

      if (message?.type === 'speech-stream-open') {
        streamMode = true;
        // The chunk that carried the opening frame can carry more frames.
        input = Buffer.alloc(0);
        await startStreamMode(message, { stdin, stdout, rest });
        return;
      }

      controlParser = createFrameParser(handleControlFrame, { maxBuffered: MAX_MESSAGE * 2, maxMessage: MAX_MESSAGE, sync: true });
      input = Buffer.alloc(0);
      if (rest.length) {
        try { controlParser(rest); } catch { /* Ignore malformed control bytes. */ }
      }
      if (cancelled) return;

      if (message?.type === 'cancel') {
        await stopWork();
        return;
      }

      if (String(message.type).startsWith('speech-')) {
        speechTask = speechOperation(message, {
          signal: abort.signal,
          onChild: (value) => { child = value; },
          onProgress: (value) => { if (!ended && !replied) stdout.write(frame(value)); },
        });
        const result = await speechTask;
        child = null;
        reply({ exitCode: 0, result });
        return;
      }

      if (String(message.type).startsWith('project-')) {
        const allowedRoots = Array.isArray(config.allowedRoots) ? config.allowedRoots : null;
        projectTask = projectOperation(message, { signal: abort.signal, allowedRoots });
        const result = await projectTask;
        reply({ exitCode: 0, result });
        return;
      }

      const args = validateCommand(message);
      const command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop';\n${args.command}`;
      child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { cwd: args.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      child.stdout.on('data', (data) => capture(data, stdoutDecoder));
      child.stderr.on('data', (data) => capture(data, stderrDecoder));
      child.once('error', (error) => { if (!cancelled) reply({ error: error.message }); });
      child.once('close', (code) => {
        child = null;
        output += stdoutDecoder.end() + stderrDecoder.end();
        if (cancelled) return;
        reply({ exitCode: timedOut ? -1 : (code ?? -1), output, truncated, timedOut });
      });
      timer = setTimeout(() => { timedOut = true; void kill(); }, args.timeout);
    } catch (error) {
      if (cancelled) {
        if (currentType.startsWith('project-')) {
          replyProjectCancellation(error);
        } else {
          reply({ cancelled: true, outcome: 'stopped' });
        }
      } else {
        reply({ error: error.message });
      }
    }
  });

  // Chrome closes this pipe when the command is cancelled or the worker dies.
  stdin.once('end', async () => {
    if (streamMode) return;
    ended = true;
    abort.abort();
    clearTimeout(timer);
    await kill();
    await speechTask?.catch(() => {});
    await projectTask?.catch(() => {});
    process.exit();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startHost(process.argv[2]);
