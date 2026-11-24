// A2: local execution must never ride the Full-access shortcut, and the card
// must say exactly what would run locally.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ASK_FIRST, FULL_ACCESS, DENY, LOCAL_EXECUTION, AccessAuthority, classifyAction, requiresApproval } = await import('../src/permissions/policy.js');
const { SessionRunner } = await import('../src/background/session-runner.js');
const { createPermissionUi } = await import('../src/sidepanel/permissions.js');
const { MESSAGES } = await import('../src/sidepanel/messages.js');

const LOCAL_ACTIONS = ['run_terminal', 'project_run', 'run_javascript', 'project_write'];
const SESSION = 'session-local';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeAuthority({ mode = ASK_FIRST, extra = {} } = {}) {
  const asked = [];
  const authority = new AccessAuthority({
    sessionId: SESSION,
    onRequest: (request) => asked.push(request),
    ...extra,
  });
  if (mode === FULL_ACCESS) {
    const result = authority.setMode(FULL_ACCESS, {
      trusted: true,
      acknowledged: true,
      expectedRevision: authority.revision,
    });
    assert.equal(result.ok, true);
  }
  return { authority, asked };
}

async function refuse(request, pending, authority) {
  const settled = authority.respondApproval({
    id: request.id,
    sessionId: SESSION,
    revision: request.revision,
    decision: DENY,
  });
  assert.equal(settled.ok, true);
  const answer = await pending;
  assert.equal(answer.permit, null);
  assert.equal(answer.reason, 'denied');
  return answer;
}

test('the result kinds used for trimming are unchanged for the four tools', async () => {
  const { kindOf } = await import('../src/agent/tool-kinds.js');
  // The access kind lives in the policy; the trimming kinds stay as they were.
  for (const action of LOCAL_ACTIONS) assert.notEqual(kindOf(action), LOCAL_EXECUTION, action);
});

test('local execution is classified and still requires approval in Full access', () => {
  assert.equal(LOCAL_EXECUTION, 'local-execution');
  for (const action of LOCAL_ACTIONS) {
    assert.equal(classifyAction(action), LOCAL_EXECUTION, `${action} is not classified as local execution`);
  }
  assert.equal(requiresApproval(ASK_FIRST, LOCAL_EXECUTION), true);
  assert.equal(requiresApproval(FULL_ACCESS, LOCAL_EXECUTION), true);
});

test('local execution asks and stays blocked when denied in Ask first', async () => {
  for (const action of LOCAL_ACTIONS) {
    const { authority, asked } = makeAuthority();
    const pending = authority.authorize({ action, args: {} });
    await tick();
    assert.equal(asked.length, 1, `${action} did not ask in Ask first`);
    assert.equal(asked[0].kind, 'local-execution', `${action} lost its kind`);
    await refuse(asked[0], pending, authority);
  }
});

test('local execution still asks in Full access and a denial grants nothing', async () => {
  for (const action of LOCAL_ACTIONS) {
    const { authority, asked } = makeAuthority({ mode: FULL_ACCESS });
    const pending = authority.authorize({ action, args: {} });
    await tick();
    assert.equal(asked.length, 1, `${action} used the Full-access shortcut`);
    assert.equal(asked[0].kind, 'local-execution', `${action} lost its kind`);
    await refuse(asked[0], pending, authority);
  }
});

test('a click still gets a permit in Full access without a card', async () => {
  const { authority, asked } = makeAuthority({ mode: FULL_ACCESS });
  const answer = await authority.authorize({ action: 'click', args: { index: 1 } });
  assert.ok(answer.permit);
  assert.equal(answer.source, 'full-access');
  assert.equal(asked.length, 0);
});

test('a stored localExecution flag cannot grant local execution', async () => {
  const { authority, asked } = makeAuthority({
    mode: FULL_ACCESS,
    extra: { settings: { localExecution: true }, localExecution: true },
  });
  const pending = authority.authorize({ action: 'run_terminal', args: { command: 'echo fixture' } });
  await tick();
  assert.equal(asked.length, 1);
  await refuse(asked[0], pending, authority);
});

test('the worker publishes the full command and working directory', () => {
  const call = SessionRunner.prototype.publicRequest;
  const command = 'echo ' + 'x'.repeat(17000);
  const request = {
    id: 'req-command',
    sessionId: SESSION,
    revision: 1,
    action: 'run_terminal',
    kind: 'local-execution',
    args: { command, cwd: 'C:\\fixture' },
  };
  const shown = call.call({ project: { name: 'fixture' } }, request);
  assert.equal(shown.execDetail.command, command);
  assert.equal(shown.execDetail.cwd, 'C:\\fixture');
  const project = call.call({}, { ...request, action: 'project_run' });
  assert.equal(project.execDetail.command, command);
});

test('the worker publishes the exact JavaScript expression', () => {
  const expression = 'document.title + "' + 'y'.repeat(17000) + '"';
  const shown = SessionRunner.prototype.publicRequest.call({}, {
    id: 'req-js',
    sessionId: SESSION,
    revision: 1,
    action: 'run_javascript',
    kind: 'local-execution',
    args: { expression },
  });
  assert.equal(shown.execDetail.expression, expression);
});

test('the worker publishes the write target and content size, but not the content', () => {
  const shown = SessionRunner.prototype.publicRequest.call({}, {
    id: 'req-write',
    sessionId: SESSION,
    revision: 1,
    action: 'project_write',
    kind: 'local-execution',
    args: { path: 'notes/secret.md', text: 'a'.repeat(4321), expected_hash: 'hash-fixture' },
  });
  assert.equal(shown.execDetail.path, 'notes/secret.md');
  assert.equal(shown.execDetail.size, 4321);
  assert.equal('text' in shown, false);
  assert.equal('expected_hash' in shown, false);
});

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = null;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.className = '';
    this.id = '';
    this.type = '';
    this.hidden = false;
    this.disabled = false;
    this.dir = '';
    this._text = '';
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = value === null || value === undefined ? '' : String(value);
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener() {}

  all() {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

class FakeDocument {
  createElement(tag) {
    const node = new FakeNode(tag);
    node.ownerDocument = this;
    return node;
  }
}

function cardFor(request) {
  const doc = new FakeDocument();
  const container = doc.createElement('div');
  const t = (key, vars) => (vars ? `${key}:${Object.values(vars).join('|')}` : key);
  const ui = createPermissionUi({
    container,
    t,
    getSessionId: () => SESSION,
    getConnection: () => ({ name: 'port-local' }),
    getRevision: () => 1,
    send: () => true,
  });
  assert.equal(ui.apply({ type: 'access-request', request: { id: 'req', sessionId: SESSION, revision: 1, ...request } }), true);
  return container.all();
}

test('the card shows a long command in full, without cutting it off', () => {
  const command = 'Write-Output "' + 'z'.repeat(17000) + '"';
  const nodes = cardFor({
    action: 'run_terminal',
    kind: 'local-execution',
    execDetail: { command, cwd: 'C:\\fixture' },
  });
  const detail = nodes.find((node) => node.className === 'permission-exec-detail');
  assert.ok(detail, 'the card has a local-execution detail block');
  assert.ok(detail.textContent.includes(command), 'the whole command is shown');
  assert.ok(detail.textContent.includes('C:\\fixture'), 'the working directory is shown');
});

test('the card names the expression, write target and content size', () => {
  const expression = cardFor({
    action: 'run_javascript',
    kind: 'local-execution',
    execDetail: { expression: 'document.title' },
  }).map((node) => node.textContent).join('\n');
  assert.ok(expression.includes('access.approval.exec.expression'));
  assert.ok(expression.includes('document.title'));

  const write = cardFor({
    action: 'project_write',
    kind: 'local-execution',
    execDetail: { path: 'notes/secret.md', size: 4321 },
  }).map((node) => node.textContent).join('\n');
  assert.ok(write.includes('access.approval.exec.target'));
  assert.ok(write.includes('notes/secret.md'));
  assert.ok(write.includes('access.approval.exec.size'));
  assert.ok(write.includes('4321'));
});

test('both languages name every local-execution detail', () => {
  const keys = [
    'access.approval.exec.command',
    'access.approval.exec.workingDirectory',
    'access.approval.exec.expression',
    'access.approval.exec.target',
    'access.approval.exec.size',
  ];
  for (const language of ['ar', 'en']) {
    for (const key of keys) {
      assert.ok(MESSAGES[language]?.[key], `${language} is missing ${key}`);
    }
  }
});
