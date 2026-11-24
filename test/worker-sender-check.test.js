// A worker request or a panel port is accepted only from this extension's side
// panel. The overlay's Stop button is the one deliberate exception.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const EXTENSION_ID = 'worker-sender-check-extension';
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/src/sidepanel/index.html`;
const SESSION_ID = 'session-1';
const TAB_ID = 42;

const listeners = new Map();
const records = {
  sessions: [{ id: SESSION_ID, title: 'Chat', titled: true, createdAt: 1, updatedAt: 1, groupId: -1 }],
  [`session:${SESSION_ID}`]: { transcript: [], log: null, groupId: -1, notebook: null, pending: [], project: null, continuation: null },
  settings: {},
};
let storageGets = [];
let storageSets = [];

function event(name) {
  return {
    addListener(fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    removeListener(fn) {
      const all = listeners.get(name) ?? [];
      const at = all.indexOf(fn);
      if (at >= 0) all.splice(at, 1);
    },
  };
}

globalThis.chrome = {
  runtime: {
    id: EXTENSION_ID,
    getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
    getManifest: () => ({ version: '0.0.0' }),
    onInstalled: event('runtime.onInstalled'),
    onStartup: event('runtime.onStartup'),
    onConnect: event('runtime.onConnect'),
    onMessage: event('runtime.onMessage'),
    sendMessage: async () => {},
  },
  tabs: {
    onRemoved: event('tabs.onRemoved'),
    onCreated: event('tabs.onCreated'),
    get: async () => ({ id: TAB_ID }),
    query: async () => [],
  },
  sidePanel: { setOptions: async () => {}, setPanelBehavior: async () => {}, open: async () => {} },
  action: { onClicked: event('action.onClicked') },
  debugger: { onDetach: event('debugger.onDetach'), detach: async () => {} },
  storage: {
    onChanged: event('storage.onChanged'),
    local: {
      get: async (keys) => {
        storageGets.push(keys);
        const wanted = [].concat(keys);
        return Object.fromEntries(wanted.filter((key) => key in records).map((key) => [key, structuredClone(records[key])]));
      },
      set: async (changes) => {
        storageSets.push(structuredClone(changes));
        Object.assign(records, structuredClone(changes));
      },
      remove: async (key) => { delete records[key]; },
      setAccessLevel: async () => {},
    },
    session: { get: async () => ({}), set: async () => {} },
  },
  permissions: { onAdded: event('permissions.onAdded') },
  declarativeNetRequest: { updateDynamicRules: async () => {} },
  windows: { getLastFocused: async () => ({ id: 1 }) },
  i18n: { getUILanguage: () => 'en-US' },
};

const { SessionRunner } = await import('../src/background/session-runner.js');
await import('../src/background/service-worker.js');

const onConnect = listeners.get('runtime.onConnect')[0];
const onMessage = listeners.get('runtime.onMessage')[0];
assert.ok(onConnect && onMessage, 'the worker registers both listeners');

// A task would call the model; the boundary is replaced, the runner is real.
const started = [];
const originalStart = SessionRunner.prototype.start;
SessionRunner.prototype.start = function (text, options) {
  started.push({ runner: this, text, options });
  return Promise.resolve();
};

beforeEach(() => {
  started.length = 0;
  storageGets = [];
  storageSets = [];
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function panelSender() {
  return { id: EXTENSION_ID, url: PANEL_URL };
}

function untrustedSenders() {
  return [
    ['a content script', { id: EXTENSION_ID, tab: { id: TAB_ID }, url: 'https://example.test/page' }],
    ['another extension', { id: 'foreign-extension', url: `chrome-extension://foreign-extension/src/sidepanel/index.html` }],
    ['a panel-like URL with extra query', { id: EXTENSION_ID, url: `${PANEL_URL}?tabId=1&extra=2` }],
  ];
}

function fakePort({ name = `panel:${SESSION_ID}`, sender = panelSender() } = {}) {
  const port = {
    name,
    sender,
    posted: [],
    disconnected: false,
    messageListeners: [],
    disconnectListeners: [],
    postMessage(message) { this.posted.push(message); },
    disconnect() { this.disconnected = true; },
    onMessage: {
      addListener(fn) { port.messageListeners.push(fn); },
      removeListener(fn) {
        const at = port.messageListeners.indexOf(fn);
        if (at >= 0) port.messageListeners.splice(at, 1);
      },
    },
    onDisconnect: {
      addListener(fn) { port.disconnectListeners.push(fn); },
      removeListener(fn) {
        const at = port.disconnectListeners.indexOf(fn);
        if (at >= 0) port.disconnectListeners.splice(at, 1);
      },
    },
  };
  return port;
}

async function request(message, sender) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const sync = onMessage(message, sender, (response) => { answered = true; resolve(response); });
    if (sync !== true) reject(new Error(`onMessage returned ${sync}`));
    if (!answered) setTimeout(() => reject(new Error('no answer')), 1000).unref?.();
  });
}

for (const [label, sender] of untrustedSenders()) {
  for (const message of [
    { type: 'backup-export' },
    { type: 'save-settings', settings: { autoCompact: { enabled: true } } },
    { type: 'run', text: 'do something' },
  ]) {
    test(`${message.type} from ${label} gets no answer and no side effects`, async () => {
      const answer = await request(message, sender);
      assert.equal(answer.ok, false);
      assert.equal(answer.error, 'untrusted sender');
      assert.deepEqual(storageGets, []);
      assert.deepEqual(storageSets, []);
      assert.deepEqual(started, []);
    });
  }

  test(`a port from ${label} is disconnected before attach, replay or queued dispatch`, async () => {
    const port = fakePort({ sender });
    onConnect(port);
    for (const hold of [...port.messageListeners]) hold({ type: 'run', text: 'do something' });
    await flush();
    assert.equal(port.disconnected, true);
    assert.deepEqual(port.posted, []);
    assert.deepEqual(port.messageListeners, []);
    assert.deepEqual(port.disconnectListeners, []);
    assert.deepEqual(started, []);
  });
}

test('overlay-stop from a content script still stops the working tab', async () => {
  const port = fakePort();
  onConnect(port);
  for (const hold of [...port.messageListeners]) hold({ type: 'run', text: 'prime the runner' });
  await flush();
  assert.equal(started.length, 1);
  const runner = started[0].runner;
  runner.abort = new AbortController();
  runner.browser.tabId = TAB_ID;

  const answer = await request({ type: 'overlay-stop' }, { id: EXTENSION_ID, tab: { id: TAB_ID }, url: 'https://example.test/page' });
  assert.deepEqual(answer, { ok: true, result: null });
  assert.equal(runner.abort.signal.aborted, true);
});

test('the real side panel can send requests and use a port', async () => {
  const saved = await request({ type: 'save-settings', settings: { autoCompact: { enabled: true } } }, panelSender());
  assert.equal(saved.ok, true);
  assert.ok(storageSets.length > 0);

  const backup = await request({ type: 'backup-export' }, panelSender());
  assert.equal(backup.ok, true);
  assert.equal(backup.result.format, 'browser-agent-backup');

  const port = fakePort();
  onConnect(port);
  for (const hold of [...port.messageListeners]) hold({ type: 'run', text: 'do something' });
  await flush();
  assert.equal(port.disconnected, false);
  assert.ok(port.posted.some((message) => message.type === 'replay'));
  assert.equal(started.length, 1);
});

// ---------- the remembered access mode ----------

for (const [label, sender] of untrustedSenders()) {
  for (const message of [
    { type: 'get-access-preference' },
    { type: 'set-access-remember', remember: false },
  ]) {
    test(`${message.type} from ${label} gets no answer and writes nothing`, async () => {
      const answer = await request(message, sender);
      assert.equal(answer.ok, false);
      assert.equal(answer.error, 'untrusted sender');
      assert.deepEqual(storageSets, []);
    });
  }
}

test('the side panel is told what the profile remembers, and a Full access choice is stored before it is applied', async () => {
  const first = await request({ type: 'get-access-preference' }, panelSender());
  assert.equal(first.ok, true);
  assert.equal(first.result.remember, true);
  assert.equal(first.result.protected, true);
  assert.equal(first.result.mode, 'ask-first');

  const port = fakePort();
  onConnect(port);
  await flush();
  const replay = port.posted.find((message) => message.type === 'replay');
  assert.equal(replay.accessPreference.profileRevision, first.result.profileRevision);
  assert.equal(replay.access.mode, 'ask-first');

  for (const hold of [...port.messageListeners]) {
    hold({ type: 'access-mode', mode: 'full-access', acknowledged: true, sessionId: SESSION_ID, expectedRevision: replay.access.revision, expectedProfileRevision: replay.accessPreference.profileRevision });
  }
  await flush();
  const stored = storageSets.find((change) => change.accessPreference)?.accessPreference;
  assert.equal(stored?.mode, 'full-access');
  assert.equal(stored?.remember, true);
  const state = port.posted.filter((message) => message.type === 'access-state').at(-1);
  assert.equal(state.mode, 'full-access');
  assert.equal(state.accessPreference.mode, 'full-access');

  // A request made against a profile that has moved on is refused.
  for (const hold of [...port.messageListeners]) {
    hold({ type: 'access-mode', mode: 'ask-first', sessionId: SESSION_ID, expectedRevision: state.revision, expectedProfileRevision: 1 });
  }
  await flush();
  assert.equal(port.posted.filter((message) => message.type === 'access-state').at(-1).mode, 'full-access');
  assert.ok(port.posted.some((message) => message.type === 'access-preference-notice' && message.reason === 'stale-profile-revision'));

  // Turning "remember" off takes Full access away from every live chat at once.
  const current = (await request({ type: 'get-access-preference' }, panelSender())).result;
  const off = await request({ type: 'set-access-remember', remember: false, expectedProfileRevision: current.profileRevision }, panelSender());
  assert.equal(off.ok, true);
  assert.equal(off.result.ok, true);
  assert.equal(records.accessPreference.remember, false);
  assert.equal(records.accessPreference.mode, 'ask-first');
  assert.equal(port.posted.filter((message) => message.type === 'access-state').at(-1).mode, 'ask-first');
  assert.ok(port.posted.some((message) => message.type === 'access-preference-state' && message.accessPreference.remember === false));
});
