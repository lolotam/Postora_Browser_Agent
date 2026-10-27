import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASK_FIRST, FULL_ACCESS } from '../src/permissions/policy.js';
import { ACCESS_CHANGE, accessRequest, accessView, createAccessUi } from '../src/sidepanel/access.js';

// A panel element with just enough of the DOM to drive the control. It is
// deliberately plainer than a browser: the control may only use what a real
// element offers.
class FakeElement {
  constructor(name = 'element') {
    this.name = name;
    this.value = '';
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.focusCount = 0;
    this.handlers = new Map();
    this.classes = new Map();
    this.classList = { toggle: (className, on) => { this.classes.set(className, Boolean(on)); } };
  }

  addEventListener(name, handler) {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }

  async dispatch(name, event = {}) {
    for (const handler of [...(this.handlers.get(name) ?? [])]) {
      await handler({ target: this, preventDefault() {}, ...event });
    }
  }

  emit(name) {
    for (const handler of [...(this.handlers.get(name) ?? [])]) {
      handler({ target: this, preventDefault() {} });
    }
  }

  showModal() { this.open = true; }

  close() {
    this.open = false;
    // The browser says the dialog closed in a task of its own.
    queueMicrotask(() => { this.emit('close'); });
  }

  focus() { this.focusCount += 1; }
}

/** A panel with one chat bound and one worker state confirmed. */
function makeScene({ sessionId = 'session-a', request, t } = {}) {
  let current = sessionId;
  const sent = [];
  const elements = {};
  for (const name of ['select', 'state', 'risk', 'voice', 'warning', 'acknowledge', 'confirm', 'cancel']) {
    elements[name] = new FakeElement(name);
  }
  const ui = createAccessUi({
    elements,
    t: t ?? ((key) => key),
    request: request ?? (async (message) => { sent.push(message); return true; }),
    getSessionId: () => current,
  });
  ui.apply({ sessionId: current, mode: ASK_FIRST, revision: 1 });
  return {
    ui,
    elements,
    sent,
    get session() { return current; },
    setSession(value) { current = value; },
    async pickFull() { elements.select.value = FULL_ACCESS; await elements.select.dispatch('change'); },
    async pickAskFirst() { elements.select.value = ASK_FIRST; await elements.select.dispatch('change'); },
    async acknowledge() { elements.acknowledge.checked = true; await elements.acknowledge.dispatch('change'); },
    async confirm() { await elements.confirm.dispatch('click'); },
    async cancel() { await elements.cancel.dispatch('click'); },
    async pressEscape() { await elements.warning.dispatch('cancel'); },
    async browserClose() { elements.warning.open = false; elements.warning.emit('close'); },
  };
}

test('a Full request without a chat and a policy revision is not an elevation', () => {
  assert.equal(accessRequest(FULL_ACCESS), null, 'no metadata at all');
  assert.equal(accessRequest(FULL_ACCESS, { acknowledged: true }), null, 'no chat');
  assert.equal(accessRequest(FULL_ACCESS, { acknowledged: true, sessionId: 'session-a' }), null, 'no revision');
  assert.equal(accessRequest(FULL_ACCESS, { acknowledged: true, expectedRevision: 3 }), null, 'no chat');
  assert.equal(accessRequest(FULL_ACCESS, { sessionId: 'session-a', expectedRevision: 3 }), null, 'not acknowledged');
  assert.equal(accessRequest(FULL_ACCESS, { acknowledged: true, sessionId: '   ', expectedRevision: 3 }), null, 'a blank chat');
  assert.equal(accessRequest(FULL_ACCESS, { acknowledged: true, sessionId: 'session-a', expectedRevision: 0 }), null, 'no current revision');
  assert.equal(accessRequest(FULL_ACCESS, { acknowledged: true, sessionId: 'session-a', expectedRevision: '3' }), null, 'a revision that is not a number');
});

test('an acknowledged warning asks for Full access for that chat and that revision', () => {
  const message = accessRequest(FULL_ACCESS, { acknowledged: true, sessionId: 'session-a', expectedRevision: 3 });
  assert.deepEqual(message, {
    type: ACCESS_CHANGE,
    mode: FULL_ACCESS,
    acknowledged: true,
    sessionId: 'session-a',
    expectedRevision: 3,
  });
});

test('a mode the panel does not know is no message and no downgrade', () => {
  assert.equal(accessRequest('full-everything', { acknowledged: true, sessionId: 'session-a', expectedRevision: 3 }), null);
  assert.equal(accessRequest('full-everything'), null);
  assert.equal(accessView({ mode: 'full-everything', revision: 3 }, (key) => key), null);
});

test('asking first is allowed without any of that', () => {
  const message = accessRequest(ASK_FIRST);
  assert.equal(message.type, ACCESS_CHANGE);
  assert.equal(message.mode, ASK_FIRST);
  assert.equal(message.acknowledged, false);
});

test('the view of a confirmed mode says the risk in words', () => {
  const full = accessView({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 3 }, (key) => key);
  assert.equal(full.mode, FULL_ACCESS);
  assert.equal(full.revision, 3);
  assert.equal(full.sessionId, 'session-a');
  assert.equal(full.risk, 'access.state.fullRisk', 'the risk is written down, not only coloured');
  assert.equal(full.selectValue, FULL_ACCESS);

  const ask = accessView({ sessionId: 'session-a', mode: ASK_FIRST, revision: 4 }, (key) => key);
  assert.equal(ask.mode, ASK_FIRST);
  assert.equal(ask.risk, '', 'Ask first carries no risk to show');
});

test('state for another chat does not change this chat', () => {
  const scene = makeScene();
  scene.ui.apply({ sessionId: 'session-b', mode: FULL_ACCESS, revision: 9 });
  assert.equal(scene.elements.select.value, ASK_FIRST);
  assert.equal(scene.elements.risk.hidden, true);
  assert.equal(scene.elements.voice.textContent, 'access.askFirst');
});

test('a state that is not a snapshot is ignored', () => {
  const scene = makeScene();
  const ignored = [
    { sessionId: 'session-a', mode: FULL_ACCESS, revision: 0 },
    { sessionId: 'session-a', mode: FULL_ACCESS, revision: 1.5 },
    { sessionId: 'session-a', mode: FULL_ACCESS },
    { mode: FULL_ACCESS, revision: 2 },
    { sessionId: 'session-a', mode: 'full-everything', revision: 2 },
    { sessionId: '', mode: FULL_ACCESS, revision: 2 },
    null,
    undefined,
  ];
  for (const state of ignored) scene.ui.apply(state);
  assert.equal(scene.elements.select.value, ASK_FIRST);
  assert.equal(scene.elements.risk.hidden, true);
});

test('a late state does not undo the state the worker already gave', () => {
  const scene = makeScene();
  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 5 });
  scene.ui.apply({ sessionId: 'session-a', mode: ASK_FIRST, revision: 4 });
  assert.equal(scene.elements.select.value, FULL_ACCESS);
  assert.equal(scene.elements.risk.hidden, false);
});

test('the same state again changes nothing', () => {
  const scene = makeScene();
  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 5 });
  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 5 });
  assert.equal(scene.elements.select.value, FULL_ACCESS);
  assert.deepEqual(scene.sent, [], 'a replay is not a request');
  assert.equal(scene.ui.confirmed.revision, 5);
});

test('choosing Full access goes back to the confirmed mode and opens a fresh warning', async () => {
  const scene = makeScene();
  await scene.pickFull();
  assert.equal(scene.elements.select.value, ASK_FIRST, 'the control does not show Full access on its own');
  assert.equal(scene.elements.warning.open, true);
  assert.equal(scene.elements.acknowledge.checked, false, 'the warning starts unchecked');
  assert.equal(scene.elements.confirm.disabled, true, 'the warning starts with nothing to confirm');
  assert.deepEqual(scene.sent, []);
});

test('the warning sends nothing until it is acknowledged', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.confirm();
  assert.deepEqual(scene.sent, [], 'an unacknowledged warning is not an elevation');
  assert.equal(scene.elements.select.value, ASK_FIRST);
});

test('an acknowledged warning asks the worker for that chat and revision', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  await scene.confirm();
  assert.deepEqual(scene.sent, [{
    type: ACCESS_CHANGE,
    mode: FULL_ACCESS,
    acknowledged: true,
    sessionId: 'session-a',
    expectedRevision: 1,
  }]);
});

test('Full access appears only when the worker confirms it', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  await scene.confirm();
  assert.equal(scene.elements.select.value, ASK_FIRST, 'the badge waits for the worker');
  assert.equal(scene.elements.risk.hidden, true);

  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 2 });
  assert.equal(scene.elements.select.value, FULL_ACCESS);
  assert.equal(scene.elements.risk.hidden, false);
});

test('the warning of one chat cannot elevate the chat chosen later', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  assert.equal(scene.elements.acknowledge.checked, true);

  scene.setSession('session-b');
  scene.ui.apply({ sessionId: 'session-b', mode: ASK_FIRST, revision: 1 });

  assert.equal(scene.elements.acknowledge.checked, false, 'the acknowledgement belonged to the old chat');
  assert.equal(scene.elements.confirm.disabled, true);
  assert.equal(scene.elements.warning.open, false, 'the warning of the old chat is gone');

  await scene.confirm();
  assert.deepEqual(scene.sent, [], 'nothing is asked for the chat that was chosen later');
  assert.equal(scene.elements.warning.open, false, 'no warning is rebuilt for the new chat');
});

test('a policy that moved on invalidates the warning', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  scene.ui.apply({ sessionId: 'session-a', mode: ASK_FIRST, revision: 2 });
  assert.equal(scene.elements.acknowledge.checked, false, 'the acknowledgement was read against another revision');
  assert.equal(scene.elements.confirm.disabled, true);
  assert.equal(scene.elements.warning.open, false, 'the obsolete warning is gone, not left open');

  await scene.acknowledge();
  assert.equal(scene.elements.acknowledge.checked, false, 'there is no warning left to read');
  assert.equal(scene.elements.confirm.disabled, true);

  await scene.confirm();
  assert.deepEqual(scene.sent, [], 'a stale warning asks for nothing');
});

test('the same state again keeps the warning that is still current', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  scene.ui.apply({ sessionId: 'session-a', mode: ASK_FIRST, revision: 1 });
  assert.equal(scene.elements.warning.open, true, 'a replay is not a policy change');
  assert.equal(scene.elements.acknowledge.checked, true, 'the acknowledgement is still live');
  assert.equal(scene.elements.confirm.disabled, false);

  scene.ui.updateLanguage((key) => `ar:${key}`);
  assert.equal(scene.elements.warning.open, true, 'a translation is not a policy change');
  assert.equal(scene.elements.acknowledge.checked, true);

  await scene.confirm();
  assert.equal(scene.sent.length, 1, 'the warning that was still current still works');
});

test('a disconnect invalidates the warning', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  scene.ui.reset();
  assert.equal(scene.elements.acknowledge.checked, false);
  assert.equal(scene.elements.confirm.disabled, true);

  await scene.confirm();
  assert.deepEqual(scene.sent, [], 'a disconnected worker is asked for nothing');
});

test('cancelling the warning sends nothing and leaves the confirmed mode', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  await scene.cancel();
  assert.deepEqual(scene.sent, []);
  assert.equal(scene.elements.select.value, ASK_FIRST);
  assert.equal(scene.elements.warning.open, false);
  assert.ok(scene.elements.select.focusCount > 0, 'the focus goes back to the select');
});

test('escape closes the warning without sending anything', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  await scene.pressEscape();
  assert.deepEqual(scene.sent, [], 'escape is a refusal');
  assert.equal(scene.elements.select.value, ASK_FIRST);
  assert.equal(scene.elements.risk.hidden, true);
});

test('a dialog the browser closes sends nothing', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  await scene.browserClose();
  assert.deepEqual(scene.sent, []);
  assert.equal(scene.elements.select.value, ASK_FIRST);
  assert.ok(scene.elements.select.focusCount > 0, 'the focus goes back to the select');
  await scene.confirm();
  assert.deepEqual(scene.sent, [], 'a closed warning asks for nothing');
});

test('confirming twice asks only once', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  await scene.confirm();
  await scene.confirm();
  assert.equal(scene.sent.length, 1);
});

test('a request that fails changes nothing and raises nothing', async () => {
  const raised = [];
  const onUnhandled = (reason) => raised.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const attempted = [];
    const scene = makeScene({
      request: async (message) => { attempted.push(message); throw new Error('the worker is gone'); },
    });
    await scene.pickFull();
    await scene.acknowledge();
    await scene.confirm();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    assert.equal(attempted.length, 1, 'the message was tried');
    assert.deepEqual(raised, [], 'a failed request is not an unhandled rejection');
    assert.equal(scene.elements.select.value, ASK_FIRST, 'no badge the worker never gave');
    assert.equal(scene.elements.risk.hidden, true);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a reset waits for the worker to replay the state', () => {
  const scene = makeScene();
  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 2 });
  assert.equal(scene.elements.select.value, FULL_ACCESS);

  scene.ui.reset();
  assert.equal(scene.elements.select.value, ASK_FIRST, 'the panel waits instead of guessing');
  assert.equal(scene.elements.risk.hidden, true);
  assert.equal(scene.elements.warning.open, false);

  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 1 });
  assert.equal(scene.elements.select.value, FULL_ACCESS, 'the replayed state is shown');
});

test('a reconnect does not send the elevation again', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  await scene.confirm();
  assert.equal(scene.sent.length, 1);

  scene.ui.reset();
  scene.ui.reconnect();
  assert.equal(scene.sent.length, 1, 'the elevation is not sent twice');
  assert.equal(scene.elements.select.value, ASK_FIRST, 'the panel waits for the replay');
});

test('a redraw keeps the confirmed Full access', () => {
  const scene = makeScene();
  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 2 });
  scene.ui.render();
  scene.ui.updateLanguage((key) => `ar:${key}`);
  assert.equal(scene.elements.select.value, FULL_ACCESS);
  assert.equal(scene.elements.state.textContent, 'ar:access.state.full');
  assert.equal(scene.elements.risk.hidden, false);
});

test('a redraw or a new language keeps a live acknowledgment', async () => {
  const scene = makeScene();
  await scene.pickFull();
  await scene.acknowledge();
  scene.ui.render();
  assert.equal(scene.elements.acknowledge.checked, true, 'the acknowledgement is still live');
  assert.equal(scene.elements.confirm.disabled, false);
  scene.ui.updateLanguage((key) => `ar:${key}`);
  assert.equal(scene.elements.acknowledge.checked, true);
  assert.equal(scene.elements.confirm.disabled, false);
  assert.equal(scene.elements.warning.open, true);
});

test('the risk text and the voice status describe the same worker mode', () => {
  const scene = makeScene();
  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 2 });
  assert.equal(scene.elements.risk.hidden, false);
  assert.equal(scene.elements.risk.textContent, 'access.state.fullRisk');
  assert.equal(scene.elements.voice.textContent, 'access.full');
  assert.equal(scene.elements.voice.title, scene.elements.state.textContent);
  assert.equal(scene.elements.voice.classes.get('risk'), true);

  scene.ui.apply({ sessionId: 'session-a', mode: ASK_FIRST, revision: 3 });
  assert.equal(scene.elements.risk.hidden, true);
  assert.equal(scene.elements.risk.textContent, '');
  assert.equal(scene.elements.voice.textContent, 'access.askFirst');
  assert.equal(scene.elements.voice.title, scene.elements.state.textContent);
  assert.equal(scene.elements.voice.classes.get('risk'), false);
});

test('the control asks about the chat that is selected now', () => {
  const scene = makeScene({ sessionId: 'session-a' });
  scene.setSession('session-b');
  scene.ui.apply({ sessionId: 'session-b', mode: FULL_ACCESS, revision: 1 });
  assert.equal(scene.elements.select.value, FULL_ACCESS, 'the state of the chat chosen now is shown');
});

test('an elevation for a chat that is not bound is not sent', async () => {
  const scene = makeScene();
  scene.setSession('');
  await scene.pickFull();
  await scene.acknowledge();
  await scene.confirm();
  assert.deepEqual(scene.sent, [], 'there is no chat to elevate');
});

test('state for a chat that is not selected is not shown', () => {
  const scene = makeScene();
  scene.setSession(''); // no chat is selected any more
  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 9 });
  assert.equal(scene.elements.select.value, ASK_FIRST, 'the panel shows no mode for no chat');
  assert.equal(scene.elements.risk.hidden, true);
  assert.equal(scene.elements.voice.textContent, 'access.askFirst');
});

test('state for a chat that is not selected is not shown after a reset either', () => {
  const scene = makeScene();
  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 2 });
  assert.equal(scene.elements.select.value, FULL_ACCESS);

  scene.ui.reset();
  scene.setSession('');
  scene.ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 9 });
  assert.equal(scene.elements.select.value, ASK_FIRST, 'a late state of the old chat is not the state now');
  assert.equal(scene.elements.risk.hidden, true);
});

test('without a getter the panel still follows what the worker says', () => {
  const elements = {};
  for (const name of ['select', 'state', 'risk', 'voice', 'warning', 'acknowledge', 'confirm', 'cancel']) {
    elements[name] = new FakeElement(name);
  }
  const ui = createAccessUi({
    elements,
    t: (key) => key,
    request: async () => true,
  });
  ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 2 });
  assert.equal(elements.select.value, FULL_ACCESS, 'a panel without a chat getter is not left behind');
});
