import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectOperation, projectPath } from '../native/project.mjs';

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
