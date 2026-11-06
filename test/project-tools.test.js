import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor } from '../src/agent/tools.js';
import { AccessAuthority, FULL_ACCESS } from '../src/permissions/policy.js';

test('project tools bind root and operation in the worker, ignoring model overrides', async () => {
  const previous = globalThis.chrome;
  const sent = [];
  globalThis.chrome = { runtime: { connectNative: () => {
    let receive;
    return { onMessage: { addListener(fn) { receive = fn; } }, onDisconnect: { addListener() {} }, disconnect() {},
      postMessage(message) { sent.push(message); queueMicrotask(() => receive({ exitCode: 0, result: { entries: [] } })); } };
  } } };
  const access = new AccessAuthority({ sessionId: 'project-tools' });
  access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });
  try {
    const execute = createToolExecutor({}, { access, getProject: () => ({ root: 'C:\\chosen', name: 'chosen' }) });
    assert.equal((await execute('project_list', { path: '.', root: 'C:\\other', type: 'project-write', text: 'forged' })).isError, undefined);
    assert.equal(sent[0].root, 'C:\\chosen');
    assert.equal(sent[0].type, 'project-list');
    const missing = await createToolExecutor({}, { access })('project_read', { path: 'README.md' });
    assert.equal(missing.isError, true);
    assert.equal(sent.length, 1);
  } finally { globalThis.chrome = previous; }
});

test('a denied project write never reaches the native host', async () => {
  const access = new AccessAuthority({ sessionId: 'project-denied', onRequest(request) {
    access.respondApproval({ id: request.id, sessionId: request.sessionId, revision: request.revision, decision: 'deny' });
  } });
  const result = await createToolExecutor({}, { access, getProject: () => ({ root: 'C:\\project' }) })('project_write', { path: 'file.txt', expected_hash: 'new', text: 'test' });
  assert.equal(result.isError, true);
  assert.match(result.output, /not allow/);
});
