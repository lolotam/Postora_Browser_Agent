import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The policy module has to stand on its own: no browser, no network, no
// storage and no dynamic code. Anything it reaches for fails loudly, so the
// tests below prove it never asked for any of them.
const forbidden = ['chrome', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'XMLHttpRequest', 'WebSocket', 'eval'];
for (const name of forbidden) {
  const trap = () => {
    throw new Error(`the policy module must not use ${name}`);
  };
  try {
    Object.defineProperty(globalThis, name, { configurable: true, get: trap, set: trap });
  } catch {
    // A property we cannot replace cannot be used by the module either.
  }
}

const {
  ASK_FIRST,
  FULL_ACCESS,
  MODES,
  OBSERVE,
  INTERACT,
  SENSITIVE,
  AccessAuthority,
  classifyAction,
  normalizeMode,
  requiresApproval,
} = await import('../src/permissions/policy.js');

/** Lets the promises that are already settled run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** An authority that records the questions it asks. */
function authorityFor(sessionId = 'session-a', extra = {}) {
  const asked = [];
  const changed = [];
  const authority = new AccessAuthority({
    sessionId,
    onRequest: (request) => asked.push(request),
    onChange: (state) => changed.push(state),
    ...extra,
  });
  return { authority, asked, changed };
}

/** Raises a session to Full access the way the UI has to. */
function elevate(authority, revision = authority.revision) {
  return authority.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: revision });
}

// --- the classification helpers that everything else relies on -----------

test('a known observation stays an observation and a known field read stays sensitive', () => {
  assert.equal(classifyAction('read_page'), OBSERVE);
  assert.equal(classifyAction('screenshot'), OBSERVE);
  assert.equal(classifyAction('read_field'), SENSITIVE);
  assert.equal(classifyAction('click'), INTERACT);
});

test('a tool nobody classified counts as an interaction', () => {
  assert.equal(classifyAction('a_tool_that_does_not_exist'), INTERACT);
  assert.equal(classifyAction(''), INTERACT);
});

test('anything but the exact Full-access name is Ask first', () => {
  assert.equal(normalizeMode(FULL_ACCESS), FULL_ACCESS);
  assert.equal(normalizeMode('full_access'), ASK_FIRST);
  assert.equal(normalizeMode('FULL-ACCESS'), ASK_FIRST);
  assert.equal(normalizeMode(undefined), ASK_FIRST);
  assert.deepEqual(MODES, [ASK_FIRST, FULL_ACCESS]);
});

test('only Full access lets an interaction run without a question', () => {
  assert.equal(requiresApproval(ASK_FIRST, OBSERVE), false);
  assert.equal(requiresApproval(FULL_ACCESS, OBSERVE), false);
  assert.equal(requiresApproval(ASK_FIRST, INTERACT), true);
  assert.equal(requiresApproval(ASK_FIRST, SENSITIVE), true);
  assert.equal(requiresApproval(FULL_ACCESS, INTERACT), false);
  assert.equal(requiresApproval(FULL_ACCESS, SENSITIVE), false);
  assert.equal(requiresApproval('something else', INTERACT), true);
});

// --- the authority starts where every session must start ------------------

test('a new authority starts at Ask first, bound to its session', () => {
  const { authority } = authorityFor('session-a');
  const state = authority.state();
  assert.equal(state.mode, ASK_FIRST);
  assert.equal(state.revision, 1);
  assert.equal(state.sessionId, 'session-a');
});

test('an authority without a session cannot exist', () => {
  assert.throws(() => new AccessAuthority(), TypeError);
  assert.throws(() => new AccessAuthority({ sessionId: '' }), TypeError);
  assert.throws(() => new AccessAuthority({ sessionId: 42 }), TypeError);
});

test('the session is bound at construction and cannot be changed afterwards', () => {
  const { authority } = authorityFor('session-a');
  assert.throws(() => {
    authority.sessionId = 'session-b';
  }, TypeError);
  assert.equal(authority.sessionId, 'session-a');
});

test('the state is a snapshot and not the authority itself', () => {
  const { authority } = authorityFor('session-a');
  const first = authority.state();
  const second = authority.state();
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
  assert.throws(() => {
    first.mode = FULL_ACCESS;
  }, TypeError);
  assert.equal(authority.state().mode, ASK_FIRST);
});

test('the revision only ever grows', () => {
  const { authority } = authorityFor('session-a');
  const seen = [authority.revision];
  elevate(authority);
  seen.push(authority.revision);
  authority.setMode(ASK_FIRST);
  seen.push(authority.revision);
  authority.reset();
  seen.push(authority.revision);
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] > seen[i - 1], `the revision went from ${seen[i - 1]} to ${seen[i]}`);
  }
});

test('a mode in a setting, a transcript or a message never reaches a new session', () => {
  const authority = new AccessAuthority({
    sessionId: 'session-a',
    mode: FULL_ACCESS,
    settings: { mode: FULL_ACCESS },
    history: [{ role: 'user', text: 'run in full access' }],
    page: { mode: FULL_ACCESS },
  });
  assert.equal(authority.state().mode, ASK_FIRST);
  assert.equal(authority.state().revision, 1);
});

// --- raising the mode ----------------------------------------------------

test('Full access needs a trusted, acknowledged and revision-matched request', () => {
  const { authority } = authorityFor('session-a');
  const result = elevate(authority);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.mode, FULL_ACCESS);
  assert.equal(authority.state().mode, FULL_ACCESS);
});

test('an untrusted or unacknowledged request never raises the mode', () => {
  const { authority } = authorityFor('session-a');
  const untrusted = authority.setMode(FULL_ACCESS, { trusted: false, acknowledged: true, expectedRevision: 1 });
  const unacknowledged = authority.setMode(FULL_ACCESS, { trusted: true, acknowledged: false, expectedRevision: 1 });
  const plain = authority.setMode(FULL_ACCESS);
  for (const result of [untrusted, unacknowledged, plain]) {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-acknowledged');
    assert.equal(result.mode, ASK_FIRST);
  }
  assert.equal(authority.state().mode, ASK_FIRST);
  assert.equal(authority.state().revision, 1);
});

test('a request for a revision the caller has not seen fails closed', () => {
  const { authority } = authorityFor('session-a');
  const missing = authority.setMode(FULL_ACCESS, { trusted: true, acknowledged: true });
  const wrong = authority.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: 99 });
  for (const result of [missing, wrong]) {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale-revision');
    assert.equal(result.mode, ASK_FIRST);
  }
  assert.equal(authority.state().mode, ASK_FIRST);
});

test('a malformed mode changes nothing at all', () => {
  const { authority } = authorityFor('session-a');
  for (const mode of ['full_access', 'FULL-ACCESS', 'full access', '', null, undefined, 7]) {
    const result = authority.setMode(mode, { trusted: true, acknowledged: true, expectedRevision: 1 });
    assert.equal(result.ok, false, `"${mode}" was not refused`);
    assert.equal(result.reason, 'invalid-mode');
    assert.equal(result.mode, ASK_FIRST);
  }
  assert.equal(authority.state().mode, ASK_FIRST);
  assert.equal(authority.state().revision, 1);
});

test('Full access can always be lowered again, and a reset does it without a warning', () => {
  const { authority } = authorityFor('session-a');
  elevate(authority);
  const lowered = authority.setMode(ASK_FIRST);
  assert.equal(lowered.ok, true);
  assert.equal(lowered.changed, true);
  assert.equal(authority.state().mode, ASK_FIRST);

  elevate(authority);
  const reset = authority.reset('worker-restarted');
  assert.equal(reset.mode, ASK_FIRST);
  assert.equal(authority.state().mode, ASK_FIRST);
});

test('a mode change is told to the UI once, with the new revision', () => {
  const { authority, changed } = authorityFor('session-a');
  elevate(authority);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].mode, FULL_ACCESS);
  assert.equal(changed[0].revision, authority.state().revision);
});

// --- asking the user -----------------------------------------------------

test('every question gets its own id that says nothing about the action', async () => {
  const { authority, asked } = authorityFor('session-a');
  const ids = new Set();
  for (let i = 0; i < 25; i += 1) {
    authority.requestApproval({ action: 'click', args: { n: i } });
  }
  for (const request of asked) {
    ids.add(request.id);
    assert.ok(request.id.length >= 16, 'the id is too short to be unguessable');
    assert.ok(!request.id.includes('click'), 'the id gives the action away');
    assert.ok(!request.id.includes('session-a'), 'the id gives the session away');
  }
  assert.equal(ids.size, 25);
});

test('a question binds the session, the revision, the action, the tab and the target', () => {
  const { authority, asked } = authorityFor('session-a');
  const { request } = authority.requestApproval({
    action: 'click',
    args: { selector: '#go' },
    tabId: 7,
    target: { index: 3, documentId: 'doc-1' },
    describe: 'click the button',
  });
  assert.equal(asked.length, 1);
  assert.equal(request.sessionId, 'session-a');
  assert.equal(request.revision, authority.state().revision);
  assert.equal(request.action, 'click');
  assert.equal(request.kind, INTERACT);
  assert.equal(request.tabId, 7);
  assert.deepEqual(request.target, { index: 3, documentId: 'doc-1' });
  assert.deepEqual(request.args, { selector: '#go' });
});

test('the question keeps its own copy of the arguments and the target', () => {
  const { authority } = authorityFor('session-a');
  const args = { text: 'hello', nested: { value: 1 } };
  const target = { index: 2 };
  const { request } = authority.requestApproval({ action: 'type', args, tabId: 1, target });
  args.text = 'changed';
  args.nested.value = 99;
  target.index = 42;
  assert.equal(request.args.text, 'hello');
  assert.equal(request.args.nested.value, 1);
  assert.equal(request.target.index, 2);
});

test('a question cannot be answered by another session', async () => {
  const { authority } = authorityFor('session-a');
  const { id, request, promise } = authority.requestApproval({ action: 'click' });
  let settled = null;
  promise.then((value) => { settled = value; });
  const result = authority.respondApproval({ id, decision: 'allow', revision: request.revision, sessionId: 'session-b' });
  await tick();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong-session');
  assert.equal(settled, null, 'the question was answered by the wrong session');
  assert.equal(authority.pendingCount, 1);
});

test('a missing session or revision does not bypass the checks', async () => {
  const { authority } = authorityFor('session-a');
  const { id, request, promise } = authority.requestApproval({ action: 'click' });
  let settled = null;
  promise.then((value) => { settled = value; });

  const noSession = authority.respondApproval({ id, decision: 'allow', revision: request.revision });
  const noRevision = authority.respondApproval({ id, decision: 'allow', sessionId: 'session-a' });
  const wrongRevision = authority.respondApproval({ id, decision: 'allow', revision: request.revision + 5, sessionId: 'session-a' });
  await tick();

  assert.equal(noSession.ok, false);
  assert.equal(noSession.reason, 'wrong-session');
  assert.equal(noRevision.ok, false);
  assert.equal(noRevision.reason, 'stale-revision');
  assert.equal(wrongRevision.ok, false);
  assert.equal(wrongRevision.reason, 'stale-revision');
  assert.equal(settled, null, 'a broken answer still settled the question');
  assert.equal(authority.pendingCount, 1);
});

test('an answer that is not allow or deny answers nothing', async () => {
  const { authority } = authorityFor('session-a');
  const { id, request, promise } = authority.requestApproval({ action: 'click' });
  let settled = null;
  promise.then((value) => { settled = value; });
  for (const decision of ['maybe', 'ALLOW', 'yes', '', null, undefined, 1]) {
    const result = authority.respondApproval({ id, decision, revision: request.revision, sessionId: 'session-a' });
    assert.equal(result.ok, false, `"${decision}" was not refused`);
    assert.equal(result.reason, 'malformed-decision');
  }
  await tick();
  assert.equal(settled, null);
  assert.equal(authority.pendingCount, 1);
});

test('an unknown id answers nothing', () => {
  const { authority } = authorityFor('session-a');
  const result = authority.respondApproval({ id: 'req-not-real', decision: 'allow', revision: 1, sessionId: 'session-a' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-request');
});

test('the first answer counts and a second one finds nothing left to answer', async () => {
  const { authority } = authorityFor('session-a');
  const { id, request, promise } = authority.requestApproval({ action: 'click' });
  const first = authority.respondApproval({ id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  const second = authority.respondApproval({ id, decision: 'deny', revision: request.revision, sessionId: 'session-a' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'unknown-request');
  const answer = await promise;
  assert.equal(answer.approved, true);
  assert.equal(authority.pendingCount, 0);
});

test('a denial is final for that action', async () => {
  const { authority } = authorityFor('session-a');
  const { id, request, promise } = authority.requestApproval({ action: 'click' });
  const result = authority.respondApproval({ id, decision: 'deny', revision: request.revision, sessionId: 'session-a' });
  assert.equal(result.ok, true);
  const answer = await promise;
  assert.equal(answer.approved, false);
});

test('a mode change withdraws the questions of the old mode', async () => {
  const { authority } = authorityFor('session-a');
  const { promise } = authority.requestApproval({ action: 'click' });
  let settled = null;
  promise.then((value) => { settled = value; });
  elevate(authority);
  await tick();
  assert.equal(settled.approved, false);
  assert.equal(settled.reason, 'mode-changed');
  assert.equal(authority.pendingCount, 0);
});

// --- permits -------------------------------------------------------------

test('a grant that was never issued is not valid', () => {
  const { authority } = authorityFor('session-a');
  assert.equal(authority.grantValid(null), false);
  assert.equal(authority.grantValid(undefined), false);
  assert.equal(authority.grantValid({}), false);
  assert.equal(authority.grantValid({ sessionId: 'session-a', revision: 1 }), false);
  assert.equal(authority.grantValid({ id: 'permit-made-up', sessionId: 'session-a', revision: 1, action: 'click' }), false);
});

test('a permit is valid, and only for the operation it was issued for', async () => {
  const { authority } = authorityFor('session-a');
  const operation = { action: 'read_page', args: { url: 'https://example.com' }, tabId: 7, target: { index: 3 } };
  const { permit } = await authority.authorize(operation);
  assert.ok(permit, 'the observation was not allowed');
  assert.equal(authority.grantValid(permit), true);
  assert.equal(authority.grantValid(permit, operation), true);
  assert.equal(authority.grantValid(permit, { ...operation, tabId: 8 }), false);
  assert.equal(authority.grantValid(permit, { ...operation, args: { url: 'https://other.example' } }), false);
  assert.equal(authority.grantValid(permit, { ...operation, target: { index: 4 } }), false);
  assert.equal(authority.grantValid(permit, { action: 'get_text', args: { url: 'https://example.com' }, tabId: 7, target: { index: 3 } }), false);
});

test('a permit for an operation without arguments is valid for that same operation', async () => {
  const { authority } = authorityFor('session-a');
  const { permit } = await authority.authorize({ action: 'list_tabs' });
  assert.equal(authority.grantValid(permit, { action: 'list_tabs' }), true);
  assert.equal(authority.grantValid(permit, { action: 'list_tabs', args: null }), true);
  assert.equal(authority.grantValid(permit, { action: 'list_tabs', args: { any: 'thing' } }), false);
});

test('a permit of an approved interaction is bound to that action', async () => {
  const { authority, asked } = authorityFor('session-a');
  const operation = { action: 'click', args: { selector: '#go' }, tabId: 7, target: { index: 3 } };
  const pending = authority.authorize(operation);
  await tick();
  const request = asked[0];
  authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  const { permit } = await pending;
  assert.ok(permit);
  assert.equal(authority.grantValid(permit, operation), true);
  assert.equal(authority.grantValid(permit, { ...operation, args: { selector: '#other' } }), false);
});

test('a permit stops being valid when the mode moves', async () => {
  const { authority } = authorityFor('session-a');
  const { permit } = await authority.authorize({ action: 'read_page' });
  assert.equal(authority.grantValid(permit), true);
  elevate(authority);
  assert.equal(authority.grantValid(permit), false);
});

test('a permit stops being valid when the run is cancelled or ends', async () => {
  const { authority } = authorityFor('session-a');
  const { permit } = await authority.authorize({ action: 'read_page' });
  authority.cancel('stopped');
  assert.equal(authority.grantValid(permit), false);

  const second = authorityFor('session-a');
  const another = await second.authority.authorize({ action: 'read_page' });
  second.authority.finish('finished');
  assert.equal(second.authority.grantValid(another.permit), false);
});

test('a permit of another session is not valid here', async () => {
  const one = authorityFor('session-a');
  const two = authorityFor('session-b');
  const { permit } = await one.authority.authorize({ action: 'read_page' });
  assert.equal(two.authority.grantValid(permit), false);
  assert.equal(one.authority.grantValid(permit), true);
});

// --- the one call an executor makes --------------------------------------

test('an observation is allowed without a question in Ask first', async () => {
  const { authority, asked } = authorityFor('session-a');
  const result = await authority.authorize({ action: 'read_page', args: { url: 'https://example.com' } });
  assert.ok(result.permit);
  assert.equal(result.source, 'observation');
  assert.equal(asked.length, 0, 'an observation must not ask the user');
  assert.equal(authority.pendingCount, 0);
});

test('an interaction in Ask first waits for the user and runs on their yes', async () => {
  const { authority, asked } = authorityFor('session-a');
  const operation = { action: 'click', args: { selector: '#go' }, tabId: 7, target: { index: 3 } };
  const pending = authority.authorize(operation);
  await tick();
  assert.equal(asked.length, 1);
  assert.equal(authority.pendingCount, 1);

  const request = asked[0];
  const answer = authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  assert.equal(answer.ok, true);

  const result = await pending;
  assert.ok(result.permit);
  assert.equal(result.source, 'user-approval');
  assert.equal(authority.grantValid(result.permit, operation), true);
});

test('a denial leaves no permit at all', async () => {
  const { authority, asked } = authorityFor('session-a');
  const pending = authority.authorize({ action: 'click', args: { selector: '#go' } });
  await tick();
  const request = asked[0];
  authority.respondApproval({ id: request.id, decision: 'deny', revision: request.revision, sessionId: 'session-a' });
  const result = await pending;
  assert.equal(result.permit, null);
  assert.equal(result.reason, 'denied');
  assert.equal(authority.pendingCount, 0);
});

test('a withdrawn question leaves no permit at all', async () => {
  const { authority, asked } = authorityFor('session-a');
  const pending = authority.authorize({ action: 'click' });
  await tick();
  assert.equal(asked.length, 1);
  authority.cancelPending('stopped');
  const result = await pending;
  assert.equal(result.permit, null);
  assert.equal(result.reason, 'stopped');
});

test('a mode change while the question waits withdraws the answer', async () => {
  const { authority, asked } = authorityFor('session-a');
  const pending = authority.authorize({ action: 'click' });
  await tick();
  const request = asked[0];
  elevate(authority);
  const result = await pending;
  assert.equal(result.permit, null);
  assert.equal(result.reason, 'mode-changed');
  const answer = authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  assert.equal(answer.ok, false, 'the late answer still counted');
});

test('Full access asks nothing and allows the supported actions', async () => {
  const { authority, asked } = authorityFor('session-a');
  elevate(authority);
  const result = await authority.authorize({ action: 'click', args: { selector: '#go' } });
  assert.ok(result.permit);
  assert.equal(result.source, 'full-access');
  assert.equal(asked.length, 0);
});

test('a sensitive read needs the user in Ask first and not in Full access', async () => {
  const { authority, asked } = authorityFor('session-a');
  const pending = authority.authorize({ action: 'read_field', args: { index: 4 } });
  await tick();
  assert.equal(asked.length, 1);
  const request = asked[0];
  assert.equal(request.kind, SENSITIVE);
  authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  const allowed = await pending;
  assert.ok(allowed.permit);

  elevate(authority);
  const second = await authority.authorize({ action: 'read_field', args: { index: 4 } });
  assert.ok(second.permit);
  assert.equal(second.source, 'full-access');
  assert.equal(asked.length, 1, 'Full access asked the user again');
});

// --- stopping ------------------------------------------------------------

test('a stop settles every waiting question and leaves nothing behind', async () => {
  const { authority } = authorityFor('session-a');
  const answers = [];
  authority.requestApproval({ action: 'click' }).promise.then((value) => answers.push(value));
  authority.requestApproval({ action: 'type' }).promise.then((value) => answers.push(value));
  await tick();
  assert.equal(authority.pendingCount, 2);
  const stopped = authority.cancel('stopped');
  await tick();
  assert.equal(stopped.pending, 2);
  assert.equal(answers.length, 2);
  for (const answer of answers) {
    assert.equal(answer.approved, false);
    assert.equal(answer.reason, 'stopped');
  }
  assert.equal(authority.pendingCount, 0);
});

test('an aborted question settles and leaves no listener behind', async () => {
  const { authority } = authorityFor('session-a');
  const controller = new AbortController();
  const signal = controller.signal;
  let added = 0;
  let removed = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, fn, options) => {
    added += 1;
    return add(type, fn, options);
  };
  signal.removeEventListener = (type, fn, options) => {
    removed += 1;
    return remove(type, fn, options);
  };

  const { promise } = authority.requestApproval({ action: 'click', signal });
  let settled = null;
  promise.then((value) => { settled = value; });
  await tick();
  assert.equal(added, 1);

  controller.abort();
  await tick();
  assert.equal(settled.approved, false);
  assert.equal(settled.reason, 'aborted');
  assert.equal(removed, 1, 'the abort listener was left behind');
  assert.equal(authority.pendingCount, 0);
});

test('a question that is asked after the work was aborted asks nobody', async () => {
  const { authority, asked } = authorityFor('session-a');
  const controller = new AbortController();
  controller.abort();
  const { promise } = authority.requestApproval({ action: 'click', signal: controller.signal });
  let settled = null;
  promise.then((value) => { settled = value; });
  await tick();
  assert.equal(settled.approved, false);
  assert.equal(settled.reason, 'aborted');
  assert.equal(asked.length, 0, 'a withdrawn question was shown to the user');
  assert.equal(authority.pendingCount, 0);
});

// --- what the authority decides by itself --------------------------------

test('a caller cannot call a mutating action an observation', async () => {
  const { authority, asked } = authorityFor('session-a');
  const pending = authority.authorize({ action: 'click', kind: 'observe', args: { index: 1 } });
  await tick();
  assert.equal(asked.length, 1, 'the click ran without asking');
  assert.equal(asked[0].kind, INTERACT);
  authority.respondApproval({ id: asked[0].id, decision: 'deny', revision: asked[0].revision, sessionId: 'session-a' });
  assert.equal((await pending).permit, null);
});

test('a caller cannot call a field read a harmless one', async () => {
  const { authority, asked } = authorityFor('session-a');
  const pending = authority.authorize({ action: 'read_field', kind: 'observe', args: { index: 4 } });
  await tick();
  assert.equal(asked.length, 1, 'the field read ran without asking');
  assert.equal(asked[0].kind, SENSITIVE);
  authority.respondApproval({ id: asked[0].id, decision: 'deny', revision: asked[0].revision, sessionId: 'session-a' });
  assert.equal((await pending).permit, null);
});

test('a caller may only ask for more than the authority decides', async () => {
  const { authority, asked } = authorityFor('session-a');
  const pending = authority.authorize({ action: 'read_page', kind: 'sensitive' });
  await tick();
  assert.equal(asked.length, 1, 'the observation ran unattended');
  assert.equal(asked[0].kind, SENSITIVE);
  authority.respondApproval({ id: asked[0].id, decision: 'deny', revision: asked[0].revision, sessionId: 'session-a' });
  assert.equal((await pending).permit, null);
});

test('an observation that nobody reclassifies still runs without a question', async () => {
  const { authority, asked } = authorityFor('session-a');
  const result = await authority.authorize({ action: 'read_page' });
  assert.ok(result.permit);
  assert.equal(asked.length, 0);
});

// --- the command that asked for the action --------------------------------

test('a command that was aborted before it started gets no permit in any mode', async () => {
  const controller = new AbortController();
  controller.abort();

  const full = authorityFor('session-a');
  elevate(full.authority);
  const inFull = await full.authority.authorize({ action: 'click' }, { signal: controller.signal });
  assert.equal(inFull.permit, null);
  assert.equal(inFull.reason, 'aborted');

  const asking = authorityFor('session-a');
  const observation = await asking.authority.authorize({ action: 'read_page' }, { signal: controller.signal });
  assert.equal(observation.permit, null);
  assert.equal(observation.reason, 'aborted');

  const interaction = asking.authority.authorize({ action: 'click' }, { signal: controller.signal });
  await tick();
  assert.equal(asking.asked.length, 0, 'an aborted command still asked the user');
  assert.equal((await interaction).permit, null);
});

test('aborting a command withdraws the permit it was given', async () => {
  const { authority } = authorityFor('session-a');
  elevate(authority);
  const controller = new AbortController();
  const operation = { action: 'type_text', args: { index: 1, text: 'synthetic text' } };
  const { permit } = await authority.authorize(operation, { signal: controller.signal });
  assert.equal(authority.grantValid(permit, operation), true);
  controller.abort();
  assert.equal(authority.grantValid(permit, operation), false);
});

test('aborting a command withdraws the permit of an approved action too', async () => {
  const { authority, asked } = authorityFor('session-a');
  const controller = new AbortController();
  const operation = { action: 'click', args: { index: 1 } };
  const pending = authority.authorize(operation, { signal: controller.signal });
  await tick();
  const request = asked[0];
  authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  const { permit } = await pending;
  assert.equal(authority.grantValid(permit, operation), true);
  controller.abort();
  assert.equal(authority.grantValid(permit, operation), false);
});

test('a withdrawn permit lets go of the listener of its command', async () => {
  const { authority } = authorityFor('session-a');
  const controller = new AbortController();
  const signal = controller.signal;
  let added = 0;
  let removed = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, fn, options) => {
    added += 1;
    return add(type, fn, options);
  };
  signal.removeEventListener = (type, fn, options) => {
    removed += 1;
    return remove(type, fn, options);
  };
  const { permit } = await authority.authorize({ action: 'read_page' }, { signal });
  assert.equal(added, 1);
  authority.finish('finished');
  assert.equal(removed, 1, 'the listener of the command was left behind');
  assert.equal(authority.grantValid(permit), false);
});

// --- a stop that lands between the answer and the action ------------------

test('a stop between the answer and the continuation cannot mint a permit', async () => {
  const { authority, asked } = authorityFor('session-a');
  const pending = authority.authorize({ action: 'click', args: { index: 1 } });
  await tick();
  const request = asked[0];
  authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  authority.cancel('stopped');
  const result = await pending;
  assert.equal(result.permit, null);
});

test('the end of the run between the answer and the continuation cannot mint a permit', async () => {
  const { authority, asked } = authorityFor('session-a');
  const pending = authority.authorize({ action: 'read_field', args: { index: 1 } });
  await tick();
  const request = asked[0];
  authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  authority.finish('finished');
  assert.equal((await pending).permit, null);
});

test('a stop leaves the mode alone and a new task may still use it', async () => {
  const { authority } = authorityFor('session-a');
  elevate(authority);
  authority.cancel('stopped');
  assert.equal(authority.state().mode, FULL_ACCESS);
  const result = await authority.authorize({ action: 'click', args: { index: 1 } });
  assert.ok(result.permit, 'a new task could not use the mode that is still in force');
});

// --- what the metadata may be --------------------------------------------

test('a key named __proto__ stays data', async () => {
  const { authority } = authorityFor('session-a');
  elevate(authority);
  const args = JSON.parse('{"__proto__":{"tag":"first"},"text":"value"}');
  const { permit } = await authority.authorize({ action: 'insert_text', args });
  assert.equal(Object.hasOwn(permit.args, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(permit.args), Object.prototype);
  assert.deepEqual(permit.args.__proto__, { tag: 'first' });
  const different = JSON.parse('{"__proto__":{"tag":"second"},"text":"value"}');
  assert.equal(authority.grantValid(permit, { action: 'insert_text', args: different }), false);
  assert.equal(authority.grantValid(permit, { action: 'insert_text', args }), true);
});

test('approved metadata cannot be changed after the user said yes', async () => {
  const { authority } = authorityFor('session-a');
  elevate(authority);
  const args = { text: 'value' };
  const { permit } = await authority.authorize({ action: 'insert_text', args });
  args.text = 'changed';
  assert.equal(permit.args.text, 'value');
  assert.throws(() => {
    permit.args.text = 'changed again';
  }, TypeError);
});

test('plain JSON metadata is bound exactly', async () => {
  const { authority } = authorityFor('session-a');
  elevate(authority);
  const args = { list: [1, 'two', { three: [true, null] }], flag: false, count: 3 };
  const { permit } = await authority.authorize({ action: 'click', args });
  assert.deepEqual(permit.args, args);
  assert.equal(authority.grantValid(permit, { action: 'click', args }), true);
  const other = { ...args, list: [1, 'two', { three: [true, 'null'] }] };
  assert.equal(authority.grantValid(permit, { action: 'click', args: other }), false);
});

test('metadata that is not plain JSON is refused', async () => {
  const { authority } = authorityFor('session-a');
  elevate(authority);
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const unsupported = [
    new Map([['target', 'first']]),
    new Set(['first']),
    new Date(0),
    { when: new Date(0) },
    cyclic,
    { run: () => true },
    { count: Number.NaN },
    { size: Infinity },
  ];
  for (const args of unsupported) {
    await assert.rejects(
      () => authority.authorize({ action: 'click', args }),
      TypeError,
      'the metadata was not refused',
    );
  }
  assert.throws(() => authority.requestApproval({ action: 'click', args: new Map() }), TypeError);
});

test('a grant whose operation cannot be bound is never valid', async () => {
  const { authority } = authorityFor('session-a');
  elevate(authority);
  const { permit } = await authority.authorize({ action: 'click', args: { index: 1 } });
  assert.equal(authority.grantValid(permit, { action: 'click', args: new Map([['target', 'other']]) }), false);
});

// --- what the module may lean on -----------------------------------------

test('the module needs no browser, no network, no storage and no dynamic code', () => {
  const source = readFileSync(new URL('../src/permissions/policy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m, 'the policy module must not import anything');
  assert.doesNotMatch(source, /\beval\s*\(/, 'the policy module must not use dynamic code');
  assert.doesNotMatch(source, /new\s+Function\s*\(/, 'the policy module must not use dynamic code');
});

// --- what the observer of a question is told ------------------------------
//
// The observer only watches. It never grants anything, it is told what
// happened to a question exactly once, and it never sees what the question
// was about.

test('an allowed question is reported once, with its outcome', async () => {
  const settled = [];
  const { authority, asked } = authorityFor('session-a', { onRequestSettled: (event) => settled.push(event) });
  const pending = authority.authorize({ action: 'click', args: { index: 1 } });
  await tick();
  const request = asked[0];

  authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  const answer = await pending;

  assert.ok(answer.permit, 'the answer was not honoured');
  assert.equal(settled.length, 1, 'the question was not reported exactly once');
  assert.deepEqual({ ...settled[0] }, {
    id: request.id,
    sessionId: 'session-a',
    revision: request.revision,
    approved: true,
    reason: 'allowed',
  });
});

test('a refused question is reported once, as a refusal', async () => {
  const settled = [];
  const { authority, asked } = authorityFor('session-a', { onRequestSettled: (event) => settled.push(event) });
  const pending = authority.authorize({ action: 'click', args: { index: 1 } });
  await tick();
  const request = asked[0];

  authority.respondApproval({ id: request.id, decision: 'deny', revision: request.revision, sessionId: 'session-a' });
  const answer = await pending;

  assert.equal(answer.permit, null);
  assert.equal(answer.reason, 'denied');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].approved, false);
  assert.equal(settled[0].reason, 'denied');
});

test('an answer that is wrong, late or repeated reports nothing and consumes nothing', async () => {
  const settled = [];
  const { authority, asked } = authorityFor('session-a', { onRequestSettled: (event) => settled.push(event) });
  const pending = authority.authorize({ action: 'click', args: { index: 1 } });
  await tick();
  const request = asked[0];

  const refused = [
    ['an unknown question', { id: 'req-nobody-asked', decision: 'allow', revision: request.revision, sessionId: 'session-a' }],
    ['another session', { id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-b' }],
    ['a stale revision', { id: request.id, decision: 'allow', revision: request.revision + 5, sessionId: 'session-a' }],
    ['a missing revision', { id: request.id, decision: 'allow', sessionId: 'session-a' }],
    ['a decision that is not one', { id: request.id, decision: 'maybe', revision: request.revision, sessionId: 'session-a' }],
    ['no decision at all', { id: request.id, revision: request.revision, sessionId: 'session-a' }],
  ];
  for (const [what, answer] of refused) {
    assert.equal(authority.respondApproval(answer).ok, false, `${what} was accepted`);
  }
  assert.equal(settled.length, 0, 'a refused answer reported a settlement');
  assert.equal(authority.pendingCount, 1, 'a refused answer consumed the question');

  // The answer that fits is the one that counts.
  authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  await pending;
  assert.equal(settled.length, 1);

  // A repeated answer finds nothing left to answer and reports nothing.
  assert.equal(authority.respondApproval({ id: request.id, decision: 'deny', revision: request.revision, sessionId: 'session-a' }).ok, false);
  assert.equal(settled.length, 1, 'a repeated answer reported a second settlement');
});

test('an aborted command settles its question once', async () => {
  const settled = [];
  const { authority } = authorityFor('session-a', { onRequestSettled: (event) => settled.push(event) });
  const controller = new AbortController();
  const pending = authority.authorize({ action: 'click' }, { signal: controller.signal });
  await tick();

  controller.abort();
  const answer = await pending;

  assert.equal(answer.permit, null);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].approved, false);
  assert.equal(settled[0].reason, 'aborted');
});

test('a stop, a mode change and the end of the run each settle a waiting question once', async () => {
  const cases = [
    ['a stop', (authority) => authority.cancel('stopped'), 'stopped'],
    ['a mode change', (authority) => authority.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: authority.revision }), 'mode-changed'],
    ['the end of the run', (authority) => authority.finish('finished'), 'finished'],
  ];
  for (const [what, end, reason] of cases) {
    const settled = [];
    const { authority } = authorityFor('session-a', { onRequestSettled: (event) => settled.push(event) });
    const pending = authority.authorize({ action: 'click' });
    await tick();

    end(authority);
    const answer = await pending;

    assert.equal(answer.permit, null, `${what} allowed the action`);
    assert.equal(settled.length, 1, `${what} did not settle the question exactly once`);
    assert.equal(settled[0].approved, false, `${what} reported an approval`);
    assert.equal(settled[0].reason, reason);
  }
});

test('the report names the question and its outcome, and nothing else', async () => {
  const settled = [];
  const { authority, asked } = authorityFor('session-a', { onRequestSettled: (event) => settled.push(event) });
  const pending = authority.authorize({
    action: 'insert_text',
    args: { text: 'a value to keep to ourselves' },
    target: { url: 'https://shop.test/pay?token=abc123', element: { label: 'Card number' } },
    describe: 'Type text into the focused field',
  });
  await tick();
  const request = asked[0];

  authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  await pending;

  assert.deepEqual(Object.keys(settled[0]).sort(), ['approved', 'id', 'reason', 'revision', 'sessionId']);
  const report = JSON.stringify(settled[0]);
  assert.equal(report.includes('a value to keep to ourselves'), false, 'the report carried the text');
  assert.equal(report.includes('token=abc123'), false, 'the report carried the url of the target');
  assert.equal(report.includes('Card number'), false, 'the report carried the target');
  assert.equal(report.includes('permit'), false, 'the report carried a permit');
});

test('the report is frozen, so what the observer saw cannot change afterwards', async () => {
  const settled = [];
  const { authority, asked } = authorityFor('session-a', { onRequestSettled: (event) => settled.push(event) });
  const pending = authority.authorize({ action: 'click' });
  await tick();
  const request = asked[0];

  authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  await pending;

  assert.equal(Object.isFrozen(settled[0]), true);
  assert.throws(() => {
    settled[0].approved = false;
  }, TypeError);
  assert.equal(settled[0].approved, true);
});

test('an observer that throws changes nothing', async () => {
  const { authority, asked } = authorityFor('session-a', {
    onRequestSettled: () => {
      throw new Error('the observer is broken');
    },
  });
  const pending = authority.authorize({ action: 'click', args: { index: 1 } });
  await tick();
  const request = asked[0];

  const result = authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  assert.equal(result.ok, true, 'a broken observer refused the answer');

  const answer = await pending;
  assert.ok(answer.permit, 'a broken observer took the answer away');
  assert.equal(authority.grantValid(answer.permit, { action: 'click', args: { index: 1 } }), true);
});

test('a cancellation from the observer still stops the action', async () => {
  let authority = null;
  let request = null;
  authority = new AccessAuthority({
    sessionId: 'session-a',
    onRequest: (value) => {
      request = value;
    },
    onRequestSettled: () => {
      authority.cancel('stopped');
    },
  });
  const pending = authority.authorize({ action: 'click', args: { index: 1 } });
  await tick();

  authority.respondApproval({ id: request.id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  const answer = await pending;

  assert.equal(answer.permit, null, 'the action ran after the observer cancelled the work');
  assert.equal(answer.reason, 'cancelled');
});

test('a command that was already aborted never asks and never reports', async () => {
  const settled = [];
  const { authority, asked } = authorityFor('session-a', { onRequestSettled: (event) => settled.push(event) });
  const controller = new AbortController();
  controller.abort();

  const answer = await authority.authorize({ action: 'click' }, { signal: controller.signal });

  assert.equal(answer.permit, null);
  assert.equal(asked.length, 0, 'an aborted command still asked the user');
  assert.equal(settled.length, 0, 'a question that was never asked was reported');
});

test('an authority without an observer still asks and still answers', async () => {
  const authority = new AccessAuthority({ sessionId: 'session-a' });
  const { id, request, promise } = authority.requestApproval({ action: 'click', args: { index: 1 } });
  assert.equal(authority.pendingCount, 1);

  const result = authority.respondApproval({ id, decision: 'allow', revision: request.revision, sessionId: 'session-a' });
  assert.equal(result.ok, true);

  const answer = await promise;
  assert.equal(answer.approved, true);
  assert.equal(answer.request.id, id);
});
