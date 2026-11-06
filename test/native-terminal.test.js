import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frame, validateCommand } from '../native/host.mjs';
import { runNativeCommand } from '../src/native/client.js';
import { AccessAuthority, FULL_ACCESS } from '../src/permissions/policy.js';
import { createToolExecutor } from '../src/agent/tools.js';

function mockRuntime() {
  const messages = [], replies = [], disconnects = [];
  let closed = 0;
  const port = {
    postMessage: (value) => messages.push(value),
    disconnect: () => { closed += 1; },
    onMessage: { addListener: (fn) => replies.push(fn) },
    onDisconnect: { addListener: (fn) => disconnects.push(fn) },
  };
  return { connectNative: () => port, messages, replies, disconnects, get closed() { return closed; } };
}

test('native client sends an exact command and disconnects after the result', async () => {
  const runtime = mockRuntime();
  const args = { command: "Write-Output 'fixture-only'" };
  const result = runNativeCommand(args, { runtime });
  assert.deepEqual(runtime.messages, [{ type: 'run', ...args }]);
  runtime.replies[0]({ exitCode: 0, output: 'fixture-only' });
  assert.equal((await result).exitCode, 0);
  assert.equal(runtime.closed, 1);
});

test('Stop disconnects the native command; late responses cannot complete it', async () => {
  const runtime = mockRuntime();
  const abort = new AbortController();
  const result = runNativeCommand({ command: 'Start-Sleep 30' }, { runtime, signal: abort.signal });
  abort.abort();
  runtime.replies[0]({ exitCode: 0, output: 'late' });
  await assert.rejects(result, /stopped/);
  assert.equal(runtime.closed, 1);
});

test('a missing native host produces an actionable error', async () => {
  const runtime = mockRuntime();
  const result = runNativeCommand({ command: 'Get-Date' }, { runtime });
  runtime.disconnects[0]();
  await assert.rejects(result, /node native\/install.mjs/);
});

test('terminal commands require authority and respect denial before connecting', async () => {
  const access = new AccessAuthority({ sessionId: 'native-denied', onRequest: (request) => {
    access.respondApproval({ id: request.id, sessionId: request.sessionId, revision: request.revision, decision: 'deny' });
  } });
  for (const authority of [null, access]) {
    const execute = createToolExecutor({}, { access: authority });
    const result = await execute('run_terminal', { command: 'Write-Output fixture' });
    assert.equal(result.isError, true);
    assert.match(result.output, /no access authority|not allow/);
  }
});

test('Full access executes native commands without an approval prompt', async () => {
  const runtime = mockRuntime();
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime };
  const access = new AccessAuthority({ sessionId: 'native-full', onRequest: () => assert.fail('Unexpected approval') });
  access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });
  try {
    const result = createToolExecutor({}, { access })('run_terminal', { command: 'Write-Output fixture' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.messages.length, 1);
    runtime.replies[0]({ exitCode: 0, output: 'fixture' });
    assert.equal((await result).isError, undefined);
  } finally {
    globalThis.chrome = previous;
  }
});

test('native command validation rejects invalid limits, directories and empty commands', () => {
  for (const value of [{}, { type: 'run', command: '' }, { type: 'run', command: 'x', timeout_ms: 60001 }, { type: 'run', command: 'x', cwd: 'relative' }]) {
    assert.throws(() => validateCommand(value));
  }
});

// Exercise the actual binary framing and PowerShell process with synthetic data,
// without reading personal files, clipboard contents, credentials, or accounts.
test('Windows native host executes framed commands, reports failures, and times out', { skip: process.platform !== 'win32' }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'postora-host-test-'));
  const origin = `chrome-extension://${'a'.repeat(32)}/`;
  fs.copyFileSync(new URL('../native/host.mjs', import.meta.url), path.join(temporary, 'host.mjs'));
  fs.copyFileSync(new URL('../native/project.mjs', import.meta.url), path.join(temporary, 'project.mjs'));
  fs.copyFileSync(new URL('../native/speech.mjs', import.meta.url), path.join(temporary, 'speech.mjs'));
  fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify({ origin }));
  const run = (message, caller = origin) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(temporary, 'host.mjs'), caller], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = Buffer.alloc(0);
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Native host test timed out')); }, 15000);
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length < 4 || output.length < 4 + output.readUInt32LE(0)) return;
      clearTimeout(timeout);
      resolve(JSON.parse(output.subarray(4).toString()));
      child.stdin.end();
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (!output.length) resolve({ rejected: code !== 0 });
    });
    child.stdin.on('error', () => {});
    // Send the header in pieces, like a real pipe is allowed to do.
    const bytes = frame(message);
    child.stdin.write(bytes.subarray(0, 2));
    child.stdin.write(bytes.subarray(2));
  });
  try {
    const success = await run({ type: 'run', command: "Write-Output 'fixture-secret-123'; Write-Output 'اختبار'" });
    assert.equal(success.exitCode, 0);
    assert.match(success.output, /fixture-secret-123/);
    assert.match(success.output, /اختبار/);
    assert.notEqual((await run({ type: 'run', command: "throw 'fixture-error'" })).exitCode, 0);
    assert.equal((await run({ type: 'run', command: 'Start-Sleep 10', timeout_ms: 1000 })).timedOut, true);
    assert.equal((await run({ type: 'run', command: "Write-Output ('x' * 70000)" })).truncated, true);
    assert.equal((await run({ type: 'run', command: 'Write-Output never' }, `chrome-extension://${'b'.repeat(32)}/`)).rejected, true);
    const child = spawn(process.execPath, [path.join(temporary, 'host.mjs'), origin], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.stdin.write(frame({ type: 'run', command: 'Set-Content -LiteralPath command-pid.txt -Value $PID; Start-Sleep 10', cwd: temporary }));
    const pidFile = path.join(temporary, 'command-pid.txt');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    // Always close the pipe, including a failed startup, so the fixture cannot
    // leave a native command running after the test.
    child.stdin.end();
    await closed;
    assert.ok(fs.existsSync(pidFile), 'PowerShell did not start');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    fs.unlinkSync(pidFile);
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'Closing the native port left PowerShell running');
  } finally {
    // Only known files from this test; never recursively delete a computed path.
    fs.unlinkSync(path.join(temporary, 'host.mjs'));
    fs.unlinkSync(path.join(temporary, 'project.mjs'));
    fs.unlinkSync(path.join(temporary, 'speech.mjs'));
    fs.unlinkSync(path.join(temporary, 'config.json'));
    fs.rmdirSync(temporary);
  }
});
