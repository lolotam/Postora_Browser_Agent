import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { projectOperation, projectPath } from '../native/project.mjs';

test('initial project context descends into folders, reads text and omits common secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-context-'));
  try {
    await fs.mkdir(path.join(root, 'nested', 'deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), 'ROOT-CONTEXT');
    await fs.writeFile(path.join(root, 'nested', 'deep', 'prompt.md'), 'NESTED-CONTEXT');
    await fs.writeFile(path.join(root, 'auth.json'), 'SYNTHETIC-SECRET');
    const result = await projectOperation({ type: 'project-context', root });
    assert.ok(result.paths.some((entry) => entry.path === 'nested/deep/prompt.md'));
    assert.ok(result.documents.some((entry) => entry.text === 'NESTED-CONTEXT'));
    assert.ok(result.documents.some((entry) => entry.text === 'ROOT-CONTEXT'));
    assert.equal(JSON.stringify(result).includes('SYNTHETIC-SECRET'), false);
    await fs.writeFile(path.join(root, 'large.md'), 'x'.repeat(9000));
    const bounded = await projectOperation({ type: 'project-context', root });
    assert.equal(bounded.documents.find((doc) => doc.path === 'large.md').truncated, true);
    assert.ok(bounded.characters <= 48000);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a secret file with a dot in front of its name stays out of the project context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-dot-secret-'));
  try {
    await fs.mkdir(path.join(root, '.secrets'), { recursive: true });
    await fs.writeFile(path.join(root, '.secrets.json'), '{"token":"SYNTHETIC-DOT-SECRET"}');
    await fs.writeFile(path.join(root, '.secrets', 'service.json'), '{"key":"SYNTHETIC-DOT-SECRET"}');
    await fs.writeFile(path.join(root, '.token'), 'SYNTHETIC-DOT-SECRET');
    await fs.writeFile(path.join(root, 'README.md'), 'ROOT-CONTEXT');

    const result = await projectOperation({ type: 'project-context', root });

    assert.equal(JSON.stringify(result).includes('SYNTHETIC-DOT-SECRET'), false, 'the secret files are not in the context');
    assert.equal(result.paths.some((entry) => entry.path === '.secrets.json'), false);
    assert.equal(result.paths.some((entry) => entry.path === '.secrets'), false);
    assert.equal(result.paths.some((entry) => entry.path === '.token'), false);
    assert.ok(result.documents.some((entry) => entry.text === 'ROOT-CONTEXT'), 'the other files are still there');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('concurrent native processes cannot both replace the same file revision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-write-race-'));
  try {
    await fs.writeFile(path.join(root, 'shared.txt'), 'original');
    const { hash } = await projectOperation({ type: 'project-read', root, path: 'shared.txt' });
    const script = `import { projectOperation } from ${JSON.stringify(new URL('../native/project.mjs', import.meta.url).href)};
      const message = JSON.parse(process.argv[1]);
      process.stdin.once('data', async () => {
        try { await projectOperation(message); process.stdout.write('ok'); }
        catch (error) { process.stdout.write('rejected: ' + error.message); }
        process.stdin.destroy();
      }); process.stdout.write('ready\\n');`;
    const writers = ['one', 'two'].map((text) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ type: 'project-write', root, path: 'shared.txt', expected_hash: hash, text })], { windowsHide: true });
      let output = '';
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      child.stdout.on('data', (data) => { output += data; if (output.includes('ready\n')) ready(); });
      const finished = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(output.slice(6)) : reject(new Error('Writer failed'))); });
      return { child, started, finished };
    });
    await Promise.all(writers.map((writer) => writer.started));
    writers.forEach((writer) => writer.child.stdin.end('start'));
    const results = await Promise.all(writers.map((writer) => writer.finished));
    assert.equal(results.filter((result) => result === 'ok').length, 1);
    assert.equal(results.filter((result) => result.startsWith('rejected:')).length, 1);
    assert.deepEqual(await fs.readdir(root), ['shared.txt']);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project files stay under the root and writes detect changed files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-project-test-'));
  try {
    await fs.writeFile(path.join(root, 'README.md'), 'مرحبا project');
    await fs.writeFile(path.join(root, '.env'), 'synthetic-key');
    await fs.mkdir(path.join(root, 'node_modules'));
    const list = await projectOperation({ type: 'project-list', root });
    assert.deepEqual(list.entries.map((entry) => entry.name), ['README.md']);
    const read = await projectOperation({ type: 'project-read', root, path: 'README.md' });
    assert.equal(read.text, 'مرحبا project');
    await assert.rejects(projectPath(root, '../outside.txt'), /outside/);
    await assert.rejects(projectPath(root, path.resolve(root, 'README.md')), /relative/);
    await assert.rejects(projectOperation({ type: 'project-write', root, path: 'README.md', text: 'wrong', expected_hash: 'old' }), /changed/);
    await projectOperation({ type: 'project-write', root, path: 'README.md', text: 'new text', expected_hash: read.hash });
    assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'new text');
    await projectOperation({ type: 'project-write', root, path: 'new.txt', text: 'new file', expected_hash: 'new' });
    await assert.rejects(projectOperation({ type: 'project-write', root, path: 'new.txt', text: 'overwrite', expected_hash: 'new' }), /changed/);
    await fs.symlink(os.tmpdir(), path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(projectPath(root, 'outside'), /outside/);
    await assert.rejects(projectOperation({ type: 'project-write', root, path: 'outside/no.txt', text: '', expected_hash: 'new' }), /outside/);
  } finally {
    // This unique fixture is verified before recursive cleanup.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
