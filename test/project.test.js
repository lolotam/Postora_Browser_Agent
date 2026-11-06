import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { projectOperation, projectPath } from '../native/project.mjs';

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
