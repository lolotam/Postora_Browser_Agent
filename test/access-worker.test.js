// The worker's side of the access-mode consent.
//
// The panel asks; the worker decides. These tests are about the worker's
// answer: who may ask, what a request has to carry, what the worker tells
// the panels afterwards, and what a mode change does to the task that was
// running under the old one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXTENSION_ID = 'access-worker-extension';
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/src/sidepanel/index.html`;
const records = {};

// The runtime of the extension under test: the panel opens its port from its
// own page, so the sender of a port says which page it was.
globalThis.chrome = {
  runtime: {
    id: EXTENSION_ID,
    getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
  },
  debugger: { onDetach: { addListener() {} }, detach: async () => {} },
  tabs: { onRemoved: { addListener() {} } },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in records).map((k) => [k, structuredClone(records[k])])),
      set: async (obj) => Object.assign(records, structuredClone(obj)),
      remove: async (keys) => [].concat(keys).forEach((k) => delete records[k]),
    },
  },
};

const { SessionRunner } = await import('../src/background/session-runner.js');
const sessions = await import('../src/sessions/store.js');

/** A port like the one a panel opens, with the sender metadata of its page. */
function makePort({ name, sender } = {}) {
  const messages = [];
  const listeners = new Set();
  const disconnects = new Set();
  const port = {
    name,
    sender,
    postMessage: (message) => messages.push(message),
    onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    onDisconnect: { addListener: (fn) => disconnects.add(fn) },
  };
  return {
    port,
    messages,
    send: (msg) => { for (const fn of [...listeners]) fn(msg); },
    disconnect: () => { for (const fn of [...disconnects]) fn(); },
    states: () => messages.filter((message) => message.type === 'access-state'),
    replay: () => messages.find((message) => message.type === 'replay') ?? null,
  };
}

/** The side panel of this extension, attached to the session. */
function attachPanel(runner, overrides = {}) {
  const panel = makePort({
    name: `panel:${runner.id}:test-panel`,
    sender: { id: EXTENSION_ID, url: PANEL_URL },
    ...overrides,
  });
  runner.attach(panel.port);
  return panel;
}

/** A session with a runner of its own. */
async function newRunner(title = 'Access worker') {
  const meta = await sessions.createStoredSession(title);
  const body = await sessions.loadSession(meta.id);
  return new SessionRunner({ meta, body, color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
}

/** The request the panel sends for Full access, with the revision it saw. */
const elevation = (runner, overrides = {}) => ({
  type: 'access-mode',
  mode: 'full-access',
  acknowledged: true,
  sessionId: runner.id,
  expectedRevision: runner.access.revision,
  ...overrides,
});

test('only the side panel of this extension may raise the mode', async () => {
  const runner = await newRunner('Untrusted senders');
  try {
    const others = [
      ['the microphone window', { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/src/sidepanel/mic.html` }],
      ['the background page', { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/src/background/service-worker.js` }],
      ['a page that only looks like the panel', { id: EXTENSION_ID, url: `${PANEL_URL}.untrusted` }],
      ['a page of another extension', { id: 'another-extension', url: PANEL_URL }],
      ['a website', { id: EXTENSION_ID, url: 'https://example.test/' }],
      ['a page without a sender', null],
    ];
    for (const [label, sender] of others) {
      const panel = attachPanel(runner, { sender });
      panel.send(elevation(runner));
      assert.equal(runner.access.mode, 'ask-first', `${label} must not raise the mode`);
      assert.equal(panel.states().some((state) => state.mode === 'full-access'), false);
      panel.disconnect();
    }
    assert.equal(runner.access.mode, 'ask-first');
  } finally {
    runner.dispose();
  }
});

test('a request has to name the session it is for', async () => {
  const runner = await newRunner('Session names');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner, { sessionId: undefined }));
    assert.equal(runner.access.mode, 'ask-first');
    panel.send(elevation(runner, { sessionId: 'another-chat' }));
    assert.equal(runner.access.mode, 'ask-first');
    panel.send(elevation(runner, { sessionId: null }));
    assert.equal(runner.access.mode, 'ask-first');
    // The panel of this session asks properly: that one goes through.
    panel.send(elevation(runner));
    assert.equal(runner.access.mode, 'full-access');
  } finally {
    runner.dispose();
  }
});

test('Full access needs the acknowledged warning and the revision the panel saw', async () => {
  const runner = await newRunner('Full access');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner, { acknowledged: undefined }));
    assert.equal(runner.access.mode, 'ask-first');
    panel.send(elevation(runner, { acknowledged: false }));
    assert.equal(runner.access.mode, 'ask-first');
    panel.send(elevation(runner, { expectedRevision: undefined }));
    assert.equal(runner.access.mode, 'ask-first');
    panel.send(elevation(runner, { expectedRevision: 0 }));
    assert.equal(runner.access.mode, 'ask-first');
    panel.send(elevation(runner, { expectedRevision: runner.access.revision + 1 }));
    assert.equal(runner.access.mode, 'ask-first');

    panel.send(elevation(runner));
    assert.equal(runner.access.mode, 'full-access');
    assert.equal(runner.access.revision, 2); // the mode moved, so the revision moved
  } finally {
    runner.dispose();
  }
});

test('a mode that is not a mode is refused, not turned into another one', async () => {
  const runner = await newRunner('Unknown modes');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner));
    assert.equal(runner.access.mode, 'full-access');

    for (const mode of ['root-access', 'FULL-ACCESS', '', null, undefined, 7]) {
      panel.send(elevation(runner, { mode }));
      assert.equal(runner.access.mode, 'full-access', `"${mode}" is not a mode and must change nothing`);
    }
  } finally {
    runner.dispose();
  }
});

test('every panel of the session is told what is really in force', async () => {
  const runner = await newRunner('Broadcast');
  try {
    const first = attachPanel(runner);
    const second = attachPanel(runner);
    first.send(elevation(runner));

    for (const panel of [first, second]) {
      const states = panel.states();
      const last = states[states.length - 1];
      assert.equal(last.sessionId, runner.id);
      assert.equal(last.mode, 'full-access');
      assert.equal(last.revision, runner.access.revision);
    }
  } finally {
    runner.dispose();
  }
});

test('a refused request leaves the panel with the state that is really in force', async () => {
  const runner = await newRunner('Refused');
  try {
    const panel = attachPanel(runner);
    const refused = runner.setAccessMode(elevation(runner, { expectedRevision: 0 }), panel.port); // refused
    assert.equal(refused.ok, false);
    assert.equal(refused.mode, 'ask-first'); // the state that is really in force
    assert.equal(refused.sessionId, runner.id);

    const states = panel.states();
    assert.ok(states.length > 0, 'the panel is told what is in force');
    const last = states[states.length - 1];
    assert.equal(last.mode, 'ask-first');
    assert.equal(last.sessionId, runner.id);
  } finally {
    runner.dispose();
  }
});

test('a port of another session may not change this one', async () => {
  const runner = await newRunner('Port names');
  try {
    const elsewhere = attachPanel(runner, { name: 'panel:another-chat:test-panel' });
    elsewhere.send(elevation(runner));
    assert.equal(runner.access.mode, 'ask-first');

    // A port that names no session belongs to the runner it attached to.
    const unnamed = attachPanel(runner, { name: undefined });
    unnamed.send(elevation(runner));
    assert.equal(runner.access.mode, 'full-access');
  } finally {
    runner.dispose();
  }
});

test('a mode that moves stops the task and withdraws what it allowed', async () => {
  const runner = await newRunner('Downgrade');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner));
    const operation = { action: 'click', args: { index: 1 } };
    const { permit } = await runner.access.authorize(operation);
    assert.equal(runner.access.grantValid(permit, operation), true);

    runner.abort = new AbortController();
    const abort = runner.abort;
    panel.send({ type: 'access-mode', mode: 'ask-first', sessionId: runner.id, expectedRevision: runner.access.revision });

    assert.equal(runner.access.mode, 'ask-first');
    assert.equal(abort.signal.aborted, true);
    assert.equal(runner.access.grantValid(permit, operation), false);
  } finally {
    runner.dispose();
  }
});

test('the same mode again changes nothing', async () => {
  const runner = await newRunner('Unchanged');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner));
    const operation = { action: 'click', args: { index: 1 } };
    const { permit } = await runner.access.authorize(operation);

    runner.abort = new AbortController();
    const abort = runner.abort;
    panel.send(elevation(runner)); // the same mode, with the revision it now has

    assert.equal(runner.access.mode, 'full-access');
    assert.equal(abort.signal.aborted, false, 'an unchanged mode does not stop the task');
    assert.equal(runner.access.grantValid(permit, operation), true, 'an unchanged mode withdraws nothing');
  } finally {
    runner.dispose();
  }
});

test('a port that left cannot change the mode any more', async () => {
  const runner = await newRunner('Detached');
  try {
    const old = attachPanel(runner);
    old.disconnect();
    assert.equal(runner.ports.size, 0);

    old.send(elevation(runner));
    assert.equal(runner.access.mode, 'ask-first');

    // A panel that comes back may ask.
    const fresh = attachPanel(runner);
    fresh.send(elevation(runner));
    assert.equal(runner.access.mode, 'full-access');
  } finally {
    runner.dispose();
  }
});

test('the last panel that leaves withdraws what was approved, and keeps the mode', async () => {
  const runner = await newRunner('Panel lost');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner));
    const operation = { action: 'click', args: { index: 1 } };
    const { permit } = await runner.access.authorize(operation);
    runner.access.requestApproval({ action: 'click', args: { index: 2 } });
    assert.equal(runner.access.pendingCount, 1);

    panel.disconnect();

    assert.equal(runner.access.grantValid(permit, operation), false, 'the permit is withdrawn');
    assert.equal(runner.access.pendingCount, 0, 'the question is withdrawn');
    assert.equal(runner.access.mode, 'full-access', 'the mode the user chose stays');
  } finally {
    runner.dispose();
  }
});

test('the mode survives the end of a task and a panel that comes back', async () => {
  const runner = await newRunner('Reconnect');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner));

    await runner.start('a task that cannot run here'); // it ends at once, with an error
    assert.equal(runner.access.mode, 'full-access', 'a finished task keeps the mode');

    const again = attachPanel(runner);
    const replay = again.replay();
    assert.equal(replay.access.mode, 'full-access');
    assert.equal(replay.access.sessionId, runner.id);
  } finally {
    runner.dispose();
  }
});

test('a new runner for the same chat starts at Ask first', async () => {
  const runner = await newRunner('Rebuilt');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner));
    assert.equal(runner.access.mode, 'full-access');
  } finally {
    runner.dispose();
  }

  const body = await sessions.loadSession((await sessions.listSessions()).find((s) => s.title === 'Rebuilt').id);
  const rebuilt = new SessionRunner({
    meta: { id: body.meta.id, title: 'Rebuilt' },
    body: {
      ...body,
      access: { mode: 'full-access', revision: 99 },
      settings: { accessMode: 'full-access' },
      transcript: [...(body.transcript ?? []), { type: 'access-state', sessionId: body.meta.id, mode: 'full-access', revision: 99 }],
    },
    color: 'cyan',
    isTakenByOther: () => null,
    onSessionsChanged: () => {},
  });
  try {
    assert.equal(rebuilt.access.mode, 'ask-first');
    const panel = attachPanel(rebuilt);
    const replay = panel.replay();
    assert.equal(replay.access.mode, 'ask-first');
    assert.equal(replay.events.some((event) => event.type === 'access-state'), false, 'a stored mode is never replayed');
  } finally {
    rebuilt.dispose();
  }
});

test('the access mode is not stored with the session', async () => {
  const runner = await newRunner('Not stored');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner));
    assert.equal(runner.transcript.some((event) => event.type === 'access-state'), false);

    await runner.save();
    const stored = records[`session:${runner.id}`];
    assert.equal(stored.access, undefined);
    assert.equal(stored.settings, undefined);
    assert.equal((stored.transcript ?? []).some((event) => event.type === 'access-state'), false);
  } finally {
    runner.dispose();
  }
});

test('a disposed session answers nothing', async () => {
  const runner = await newRunner('Disposed');
  const panel = attachPanel(runner);
  runner.dispose();

  panel.send(elevation(runner));
  assert.equal(runner.access.mode, 'ask-first');
  assert.equal(runner.ports.size, 0);
});
