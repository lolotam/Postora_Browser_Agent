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

test('project_write aborted before rename or link leaves the target file unchanged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-project-abort-'));
  try {
    const existingPath = path.join(root, 'existing.txt');
    await fs.writeFile(existingPath, 'original content');
    const { hash } = await projectOperation({ type: 'project-read', root, path: 'existing.txt' });

    // Pause an existing-file write right before fs.rename and abort the signal.
    const abortExisting = new AbortController();
    await assert.rejects(
      projectOperation(
        { type: 'project-write', root, path: 'existing.txt', text: 'replaced content', expected_hash: hash },
        {
          signal: abortExisting.signal,
          beforeCommit: async () => {
            abortExisting.abort();
          },
        },
      ),
      /AbortError|aborted/i,
    );
    assert.equal(await fs.readFile(existingPath, 'utf8'), 'original content', 'existing file is untouched');
    assert.deepEqual(await fs.readdir(root), ['existing.txt'], 'temporary file was cleaned up');

    // Pause a new-file write right before fs.link and abort the signal.
    const abortNew = new AbortController();
    await assert.rejects(
      projectOperation(
        { type: 'project-write', root, path: 'created.txt', text: 'new content', expected_hash: 'new' },
        {
          signal: abortNew.signal,
          beforeCommit: async () => {
            abortNew.abort();
          },
        },
      ),
      /AbortError|aborted/i,
    );
    assert.deepEqual(await fs.readdir(root), ['existing.txt'], 'new file was not linked and temp file was cleaned up');
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('secret and hidden filters apply case-insensitively across list, read and write, and .git is never writable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-project-filters-'));
  try {
    await fs.mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
    await fs.mkdir(path.join(root, 'NODE_MODULES', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(root, 'nested', '.SECRETS'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'config'), '[core]');
    await fs.writeFile(path.join(root, 'NODE_MODULES', 'pkg', 'index.js'), 'module.exports = 1;');
    await fs.writeFile(path.join(root, '.ENV.local'), 'SECRET=1');
    await fs.writeFile(path.join(root, 'AUTH.JSON'), '{"token":"secret"}');
    await fs.writeFile(path.join(root, 'nested', '.SECRETS', 'api.key'), 'KEY-DATA');
    await fs.writeFile(path.join(root, 'nested', 'safe.txt'), 'safe text');

    const rootList = await projectOperation({ type: 'project-list', root });
    assert.deepEqual(rootList.entries.map((e) => e.name), ['nested'], 'case-insensitive protected dirs/files are omitted from listing');

    const nestedList = await projectOperation({ type: 'project-list', root, path: 'nested' });
    assert.deepEqual(nestedList.entries.map((e) => e.name), ['safe.txt']);

    for (const blockedDir of ['.git', '.GIT', 'node_modules', 'NODE_MODULES', 'nested/.secrets', 'nested/.SECRETS']) {
      await assert.rejects(
        projectOperation({ type: 'project-list', root, path: blockedDir }),
        /not allowed/i,
        `project-list must refuse ${blockedDir}`,
      );
    }

    for (const blockedRead of ['.git/config', '.GIT/config', '.env.local', '.ENV.local', 'auth.json', 'AUTH.JSON', 'NODE_MODULES/pkg/index.js', 'nested/.SECRETS/api.key']) {
      await assert.rejects(
        projectOperation({ type: 'project-read', root, path: blockedRead }),
        /not allowed/i,
        `project-read must refuse ${blockedRead}`,
      );
    }

    for (const blockedWrite of ['.git/config', '.GIT/hooks/pre-commit', '.git/new-file', '.env', '.ENV.production', 'auth.json', 'CREDENTIALS.json', 'private.PEM', 'nested/.secrets/token.txt', 'dist/out.js']) {
      await assert.rejects(
        projectOperation({ type: 'project-write', root, path: blockedWrite, text: 'x', expected_hash: 'new' }),
        /not allowed/i,
        `project-write must refuse ${blockedWrite}`,
      );
    }
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('canonical path component checks block symlinks to secret or .git paths inside the project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-project-canonical-'));
  try {
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'config'), '[core]');
    await fs.writeFile(path.join(root, '.env'), 'SECRET=1');
    let symlinkSupported = true;
    try {
      await fs.symlink(path.join(root, '.git'), path.join(root, 'innocent-dir'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      symlinkSupported = false;
    }
    if (symlinkSupported) {
      await assert.rejects(
        projectOperation({ type: 'project-read', root, path: 'innocent-dir/config' }),
        /not allowed/i,
      );
      await assert.rejects(
        projectOperation({ type: 'project-write', root, path: 'innocent-dir/hooks', text: 'bad', expected_hash: 'new' }),
        /not allowed/i,
      );
      await assert.rejects(
        projectOperation({ type: 'project-list', root, path: 'innocent-dir' }),
        /not allowed/i,
      );
    }
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pinned allowedRoots in host configuration restricts project operations to configured roots', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'postora-pinned-roots-'));
  const allowedDir = path.join(workspace, 'allowed');
  const subProject = path.join(allowedDir, 'app');
  const forbiddenDir = path.join(workspace, 'forbidden');
  try {
    await fs.mkdir(subProject, { recursive: true });
    await fs.mkdir(forbiddenDir, { recursive: true });
    await fs.writeFile(path.join(subProject, 'README.md'), 'allowed app');
    await fs.writeFile(path.join(forbiddenDir, 'README.md'), 'forbidden app');

    const okRead = await projectOperation(
      { type: 'project-read', root: subProject, path: 'README.md' },
      { allowedRoots: [allowedDir] },
    );
    assert.equal(okRead.text, 'allowed app');

    await assert.rejects(
      projectOperation(
        { type: 'project-read', root: forbiddenDir, path: 'README.md' },
        { allowedRoots: [allowedDir] },
      ),
      /allowedRoots/i,
    );

    await assert.rejects(
      projectOperation(
        { type: 'project-info', root: subProject },
        { allowedRoots: [] },
      ),
      /not allowed/i,
    );
  } finally {
    assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()));
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
