// The worker's own side of the action approvals.
//
// The authority here is the real one (src/permissions/policy.js) and the
// executor is the real one (src/agent/tools.js): the tests answer the
// authority's questions the way the panel will, so nothing here is proved by
// a mock that always says yes. The browser is a small fake that behaves like
// the controller: it asks the guard before every effect and it keeps the
// elements the executor approved.
//
// What these tests are about: what the panels are told, what they may answer,
// what the worker does with the answer, and what the authority really does
// with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXTENSION_ID = 'access-runtime-extension';
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/src/sidepanel/index.html`;
const records = {};

// The runtime of the extension under test: the panel opens its port from its
// own page, so the sender of a port says which page it was.
globalThis.chrome = {
  runtime: {
    id: EXTENSION_ID,
    getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
    getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64' }),
  },
  debugger: { onDetach: { addListener() {} }, detach: async () => {} },
  tabs: {
    onRemoved: { addListener() {} },
    get: async (id) => ({ id, url: 'https://shop.test/checkout', title: 'Checkout' }),
    query: async () => [],
  },
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
const { loadSettings } = await import('../src/lib/settings.js');

/** Lets everything that is already waiting run, until the condition holds. */
async function waitFor(condition, { tries = 500 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

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
    requests: () => messages.filter((message) => message.type === 'access-request'),
    settled: () => messages.filter((message) => message.type === 'access-request-settled'),
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
async function newRunner(title = 'Access runtime') {
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

/** The answer the panel sends for one question. */
const approval = (runner, request, decision = 'allow', overrides = {}) => ({
  type: 'access-approval',
  id: request.id,
  sessionId: runner.id,
  revision: request.revision,
  decision,
  ...overrides,
});

/** A target as the browser captured it: the site, the document and the element. */
const checkoutTarget = (overrides = {}) => ({
  scope: 'element',
  kind: 'element',
  tabId: 7,
  url: 'https://shop.test/checkout',
  documentId: 'doc-1',
  element: {
    kind: 'element',
    token: 't2',
    index: 2,
    x: 120,
    y: 180,
    tag: 'button',
    editable: false,
    secret: false,
    focused: false,
    body: false,
    label: 'Send message',
  },
  capturedAt: 1_700_000_000_000,
  ...overrides,
});

test('a navigation preview identifies its destination without disclosing URL secrets', async () => {
  const runner = await newRunner('Navigation preview');
  const panel = attachPanel(runner);
  try {
    const pending = runner.access.authorize({
      action: 'navigate', args: { url: 'https://destination.test/private?token=TEST_URL_SECRET#private' },
      tabId: 7, target: checkoutTarget(),
    });
    const shown = panel.requests().at(-1).request;
    assert.equal(shown.origin, 'https://destination.test');
    assert.doesNotMatch(JSON.stringify(shown), /TEST_URL_SECRET|private/);
    panel.send(approval(runner, shown, 'deny'));
    assert.equal((await pending).permit, null);
  } finally {
    runner.dispose();
  }
});

/** A browser that behaves like the controller, for one page and one button. */
function fakeBrowser() {
  const calls = [];
  const button = { index: 2, tag: 'button', label: 'Send message', secret: false, editable: false, x: 120, y: 180 };
  return {
    calls,
    tabId: null,
    groupId: null,
    overlay: {
      begin: async () => {},
      end: async () => {},
      pointTo: async () => {},
      say: async () => {},
    },
    startOn: async () => ({ id: 7, url: 'https://shop.test/checkout', title: 'Checkout' }),
    closeDisposableTabs: async () => {},
    detachAll: async () => {},
    rename: async () => {},
    ownsTab: () => false,
    currentTab: async () => ({ id: 7, url: 'https://shop.test/checkout' }),
    documentId: async () => 'doc-1',
    snapshot: async () => ({
      url: 'https://shop.test/checkout',
      title: 'Checkout',
      scroll: { y: 0, viewport: 100, height: 100 },
      elements: ['[2] button "Send message"'],
      offscreen: 0,
      text: 'A checkout page.',
    }),
    captureTarget: async ({ kind = 'focus', index = null, tabId = null } = {}) => {
      if (kind === 'tab') {
        return { scope: 'tab', kind: 'tab', tabId: tabId ?? 7, url: 'https://shop.test/checkout', documentId: 'doc-1', element: null, capturedAt: 1_700_000_000_000 };
      }
      if (kind === 'element' && index === button.index) {
        return { ...checkoutTarget(), tabId: tabId ?? 7 };
      }
      return { scope: 'element', kind, tabId: tabId ?? 7, url: 'https://shop.test/checkout', documentId: 'doc-1', element: null, capturedAt: 1_700_000_000_000 };
    },
    validateTarget: async () => ({ ok: true }),
    element: async (index) => {
      calls.push({ name: 'element', index });
      return { x: button.x, y: button.y, tag: button.tag, label: button.label };
    },
    clickAt: async (x, y) => {
      calls.push({ name: 'clickAt', x, y });
    },
  };
}

/** A model session that asks for one tool call and then reports. */
function installFakeSession(runner, call = { name: 'click', args: { index: 2 } }) {
  const session = {
    model: 'fake',
    log: { task: null, notes: [], steps: [], last: null },
    switched: false,
    turns: 0,
    addUserMessage(text) { this.log.task = text; },
    addToolResult() {},
    async next() {
      this.turns += 1;
      if (this.turns === 1) return { text: '', toolCalls: [{ id: 'call-1', name: call.name, args: call.args }] };
      return { text: 'The message was sent.', toolCalls: [] };
    },
  };
  runner.prepareModelSession = () => {
    runner.session = session;
    runner.sessionKey = 'fake-session';
  };
  return session;
}

/** The system prompt the model session was built with. */
const promptOf = (runner) => runner.session?.active?.messages?.[0]?.content ?? '';

/**
 * Settings a model session can really be built with.
 *
 * The stored settings of a fresh install name no model, and a session
 * without a model cannot be built at all. This is a test setting: no key,
 * no network, no provider.
 */
async function modelSettings() {
  const settings = await loadSettings();
  return {
    ...settings,
    provider: 'compatible',
    compatible: { ...settings.compatible, model: 'test-model', apiKey: 'test-key' },
  };
}

// --- what the panels are told ---------------------------------------------

test('a question under Ask first is shown to the panels', async () => {
  const runner = await newRunner('Public request');
  try {
    const panel = attachPanel(runner);
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    await waitFor(() => panel.requests().length > 0);

    const request = panel.requests()[0].request;
    assert.deepEqual(Object.keys(request).sort(), ['action', 'id', 'kind', 'label', 'origin', 'revision', 'sessionId']);
    assert.equal(request.sessionId, runner.id);
    assert.equal(request.revision, runner.access.revision);
    assert.equal(request.action, 'click');
    assert.equal(request.kind, 'interact');
    assert.equal(request.origin, 'https://shop.test');
    assert.equal(request.label, 'Send message');
    assert.equal(runner.access.pendingCount, 1);

    panel.send(approval(runner, request, 'allow'));
    const answer = await pending;
    assert.ok(answer.permit, 'the answer did not allow the action');
  } finally {
    runner.dispose();
  }
});

test('the preview of a question carries no text, no value and no query', async () => {
  const runner = await newRunner('Safe preview');
  try {
    const panel = attachPanel(runner);
    const target = checkoutTarget({
      url: 'https://shop.test/pay?token=abc123&session=xyz',
      element: { ...checkoutTarget().element, label: 'Card number', secret: true },
    });
    const pending = runner.access.authorize({
      action: 'type_text',
      args: { index: 2, text: '4111 1111 1111 1111' },
      target,
      describe: 'Type text into element [2]',
    });
    await waitFor(() => panel.requests().length > 0);

    const request = panel.requests()[0].request;
    const shown = JSON.stringify(request);
    assert.equal(shown.includes('4111'), false, 'the preview carried the text that was going to be typed');
    assert.equal(shown.includes('abc123'), false, 'the preview carried the query of the page');
    assert.equal(shown.includes('/pay'), false, 'the preview carried the path of the page');
    assert.equal(request.origin, 'https://shop.test');
    // The name of the field is what identifies the target; its value is not
    // in the preview, and neither is the text that was going to be typed.
    assert.equal(request.label, 'Card number');
    assert.equal(Object.hasOwn(request, 'args'), false);
    assert.equal(Object.hasOwn(request, 'target'), false);
    assert.equal(Object.hasOwn(request, 'describe'), false);
    assert.equal(Object.hasOwn(request, 'permit'), false);

    panel.send(approval(runner, request, 'deny'));
    await pending;
  } finally {
    runner.dispose();
  }
});

test('a question that was answered is gone from what the panels may show', async () => {
  const runner = await newRunner('Settled');
  try {
    const panel = attachPanel(runner);
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    await waitFor(() => panel.requests().length > 0);
    const request = panel.requests()[0].request;

    panel.send(approval(runner, request, 'allow'));
    await pending;

    const settled = panel.settled();
    assert.equal(settled.length, 1, 'the question was not settled exactly once');
    assert.equal(settled[0].id, request.id);
    assert.equal(settled[0].sessionId, runner.id);
    assert.equal(settled[0].revision, request.revision);
    assert.equal(settled[0].approved, true);
    assert.equal(settled[0].reason, 'allowed');
    assert.deepEqual(runner.currentPermissions(), [], 'the question stayed in the live list');
  } finally {
    runner.dispose();
  }
});

test('a refused question is settled as a refusal and allows nothing', async () => {
  const runner = await newRunner('Denied');
  try {
    const panel = attachPanel(runner);
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    await waitFor(() => panel.requests().length > 0);
    const request = panel.requests()[0].request;

    panel.send(approval(runner, request, 'deny'));
    const answer = await pending;

    assert.equal(answer.permit, null);
    assert.equal(answer.reason, 'denied');
    const settled = panel.settled();
    assert.equal(settled.length, 1);
    assert.equal(settled[0].approved, false);
    assert.equal(settled[0].reason, 'denied');
  } finally {
    runner.dispose();
  }
});

test('a question is never a moment of the conversation', async () => {
  const runner = await newRunner('Not stored');
  try {
    const panel = attachPanel(runner);
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    await waitFor(() => panel.requests().length > 0);
    const request = panel.requests()[0].request;
    panel.send(approval(runner, request, 'allow'));
    await pending;

    assert.equal(runner.transcript.some((event) => event.type === 'access-request'), false);
    assert.equal(runner.transcript.some((event) => event.type === 'access-request-settled'), false);

    await runner.save();
    const stored = records[`session:${runner.id}`];
    assert.equal((stored.transcript ?? []).some((event) => event.type === 'access-request'), false);
    assert.equal((stored.transcript ?? []).some((event) => event.type === 'access-request-settled'), false);
  } finally {
    runner.dispose();
  }
});

// --- what a panel may answer ----------------------------------------------

test('a wrong session, a wrong id, a wrong revision or a wrong decision grants nothing', async () => {
  const runner = await newRunner('Wrong answers');
  try {
    const panel = attachPanel(runner);
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    await waitFor(() => panel.requests().length > 0);
    const request = panel.requests()[0].request;

    const wrong = [
      ['another session', { sessionId: 'another-chat' }],
      ['no session', { sessionId: undefined }],
      ['another question', { id: 'req-nobody-asked' }],
      ['no question', { id: undefined }],
      ['a stale revision', { revision: request.revision + 5 }],
      ['no revision', { revision: undefined }],
      ['a decision that is not one', { decision: 'maybe' }],
      ['no decision', { decision: undefined }],
    ];
    for (const [what, overrides] of wrong) {
      panel.send({ ...approval(runner, request, 'allow'), ...overrides });
    }

    assert.equal(runner.access.pendingCount, 1, 'a wrong answer consumed the question');
    assert.equal(panel.settled().length, 0, 'a wrong answer settled the question');

    // The answer that fits still works.
    panel.send(approval(runner, request, 'allow'));
    const answer = await pending;
    assert.ok(answer.permit, 'the right answer did not allow the action');
    assert.equal(panel.settled().length, 1);
  } finally {
    runner.dispose();
  }
});

test('only the side panel of this extension may answer', async () => {
  const runner = await newRunner('Untrusted answers');
  try {
    const panel = attachPanel(runner);
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    await waitFor(() => panel.requests().length > 0);
    const request = panel.requests()[0].request;

    const others = [
      ['the microphone window', { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/src/sidepanel/mic.html` }],
      ['the background page', { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/src/background/service-worker.js` }],
      ['a page that only looks like the panel', { id: EXTENSION_ID, url: `${PANEL_URL}.untrusted` }],
      ['a page of another extension', { id: 'another-extension', url: PANEL_URL }],
      ['a website', { id: EXTENSION_ID, url: 'https://example.test/' }],
      ['no sender at all', null],
    ];
    for (const [label, sender] of others) {
      const other = attachPanel(runner, { sender });
      other.send(approval(runner, request, 'allow'));
      assert.equal(runner.access.pendingCount, 1, `${label} answered the question`);
      other.disconnect();
    }

    // A port that names another session is not this session's panel.
    const elsewhere = attachPanel(runner, { name: `panel:another-chat:test-panel` });
    elsewhere.send(approval(runner, request, 'allow'));
    assert.equal(runner.access.pendingCount, 1, 'a port of another session answered the question');

    panel.send(approval(runner, request, 'allow'));
    const answer = await pending;
    assert.ok(answer.permit, 'the panel of this session could not answer');
  } finally {
    runner.dispose();
  }
});

test('a panel that left cannot answer any more', async () => {
  const runner = await newRunner('Detached');
  try {
    const panel = attachPanel(runner);
    const other = attachPanel(runner);
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    await waitFor(() => panel.requests().length > 0);
    const request = panel.requests()[0].request;

    other.disconnect();
    other.send(approval(runner, request, 'allow'));
    assert.equal(runner.access.pendingCount, 1, 'a panel that left answered the question');
    assert.equal(panel.settled().length, 0);

    panel.send(approval(runner, request, 'allow'));
    const answer = await pending;
    assert.ok(answer.permit);
  } finally {
    runner.dispose();
  }
});

test('two panels share one question and the first answer that fits is the one that counts', async () => {
  const runner = await newRunner('Two panels');
  try {
    const first = attachPanel(runner);
    const second = attachPanel(runner);
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    await waitFor(() => first.requests().length > 0);
    const request = first.requests()[0].request;
    assert.equal(second.requests().length, 1, 'the second panel did not see the question');

    first.send(approval(runner, request, 'allow'));
    const answer = await pending;
    assert.ok(answer.permit, 'the first answer did not count');

    // The second panel is too late: the question is answered.
    second.send(approval(runner, request, 'deny'));
    assert.equal(runner.access.pendingCount, 0);
    assert.equal(second.settled().length, 1, 'the late answer settled the question a second time');
    assert.equal(second.settled()[0].approved, true);
  } finally {
    runner.dispose();
  }
});

test('without a panel there is nobody to answer, so the question is refused at once', async () => {
  const runner = await newRunner('No panel');
  try {
    const answer = await runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    assert.equal(answer.permit, null, 'a question nobody could see was allowed');
    assert.equal(answer.reason, 'no-panel');
    assert.equal(runner.access.pendingCount, 0, 'the question kept waiting');
    assert.deepEqual(runner.currentPermissions(), []);
  } finally {
    runner.dispose();
  }
});

test('a panel that is not our side panel cannot answer either', async () => {
  const runner = await newRunner('Foreign panel');
  try {
    const foreign = attachPanel(runner, { sender: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/src/sidepanel/mic.html` } });
    const answer = await runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    assert.equal(answer.permit, null, 'a foreign panel could answer a question');
    assert.equal(runner.access.pendingCount, 0);
    assert.equal(foreign.requests().length, 1, 'the question was not shown at all');
  } finally {
    runner.dispose();
  }
});

// --- what ends a question -------------------------------------------------

test('a stop, a mode change, a lost panel and the end of the task each settle the question once', async () => {
  const cases = [
    ['a stop', (runner) => runner.stop(), 'stopped'],
    ['a mode change', (runner) => {
      const panel = attachPanel(runner);
      panel.send(elevation(runner));
      return panel;
    }, 'mode-changed'],
    ['the end of the task', (runner) => runner.access.finish('finished'), 'finished'],
  ];
  for (const [what, end, reason] of cases) {
    const runner = await newRunner(`Ended by ${what}`);
    try {
      const panel = attachPanel(runner);
      const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
      await waitFor(() => panel.requests().length > 0);
      const request = panel.requests()[0].request;

      end(runner);
      const answer = await pending;

      assert.equal(answer.permit, null, `${what} allowed the action`);
      const settled = panel.settled();
      assert.equal(settled.length, 1, `${what} did not settle the question exactly once`);
      assert.equal(settled[0].id, request.id);
      assert.equal(settled[0].approved, false);
      assert.equal(settled[0].reason, reason);
      assert.deepEqual(runner.currentPermissions(), [], `${what} left the question in the live list`);
    } finally {
      runner.dispose();
    }
  }
});

test('the last panel that leaves settles the question it cannot answer', async () => {
  const runner = await newRunner('Panel lost');
  try {
    const panel = attachPanel(runner);
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    await waitFor(() => panel.requests().length > 0);

    panel.disconnect();
    const answer = await pending;

    assert.equal(answer.permit, null, 'a question nobody could answer was allowed');
    assert.equal(answer.reason, 'panel-lost');
    assert.deepEqual(runner.currentPermissions(), [], 'the question stayed in the live list');
    // A panel that comes back sees no question waiting: it was withdrawn.
    const later = attachPanel(runner);
    assert.deepEqual(later.replay().permissions, []);
  } finally {
    runner.dispose();
  }
});

test('an aborted command settles the question it was waiting for', async () => {
  const runner = await newRunner('Aborted');
  try {
    const panel = attachPanel(runner);
    const abort = new AbortController();
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() }, { signal: abort.signal });
    await waitFor(() => panel.requests().length > 0);
    const request = panel.requests()[0].request;

    abort.abort();
    const answer = await pending;

    assert.equal(answer.permit, null);
    const settled = panel.settled();
    assert.equal(settled.length, 1);
    assert.equal(settled[0].reason, 'aborted');
    assert.deepEqual(runner.currentPermissions(), []);
  } finally {
    runner.dispose();
  }
});

// --- what the panels may see when they come back ---------------------------

test('the replay carries the questions that are waiting now, and only those', async () => {
  const runner = await newRunner('Replay');
  try {
    const panel = attachPanel(runner);
    const pending = runner.access.authorize({ action: 'click', args: { index: 2 }, target: checkoutTarget() });
    await waitFor(() => panel.requests().length > 0);
    const request = panel.requests()[0].request;

    const later = attachPanel(runner);
    const replay = later.replay();
    assert.equal(replay.permissions.length, 1, 'the live question was not in the replay');
    assert.equal(replay.permissions[0].id, request.id);
    assert.equal(replay.permissions[0].action, 'click');
    assert.equal(Object.hasOwn(replay.permissions[0], 'args'), false);

    panel.send(approval(runner, request, 'allow'));
    await pending;

    const after = attachPanel(runner);
    assert.deepEqual(after.replay().permissions, [], 'an answered question came back with the replay');
  } finally {
    runner.dispose();
  }
});

test('a rebuilt worker has no question waiting, whatever the transcript says', async () => {
  const runner = await newRunner('Rebuilt');
  const body = await sessions.loadSession(runner.id);
  const historical = {
    type: 'access-request',
    request: { id: 'req-from-another-life', sessionId: runner.id, revision: 1, action: 'click', kind: 'interact', origin: 'https://shop.test', label: 'Send message' },
  };
  const rebuilt = new SessionRunner({
    meta: { id: runner.id, title: 'Rebuilt' },
    body: { ...body, transcript: [...(body.transcript ?? []), historical] },
    color: 'cyan',
    isTakenByOther: () => null,
    onSessionsChanged: () => {},
  });
  try {
    const panel = attachPanel(rebuilt);
    const replay = panel.replay();
    assert.deepEqual(replay.permissions, [], 'a stored question came back as a live one');
    assert.equal(replay.events.some((event) => event.type === 'access-request'), false, 'a stored question was replayed as chat');
    assert.equal(rebuilt.access.mode, 'ask-first');
    assert.equal(rebuilt.access.pendingCount, 0);
  } finally {
    rebuilt.dispose();
    runner.dispose();
  }
});

// --- what the executor of the task really does ---------------------------

test('the task asks the authority before it changes the page, and only the allowed action runs', async () => {
  const runner = await newRunner('Executor');
  try {
    const panel = attachPanel(runner);
    const browser = fakeBrowser();
    runner.browser = browser;
    installFakeSession(runner, { name: 'click', args: { index: 2 } });

    const task = runner.start('send the message');
    const asked = await waitFor(() => panel.requests().length > 0);
    assert.equal(asked, true, 'the task never asked the user');
    assert.equal(browser.calls.some((call) => call.name === 'clickAt'), false, 'the page changed before the answer');

    const request = panel.requests()[0].request;
    assert.equal(request.action, 'click');
    assert.equal(request.origin, 'https://shop.test');
    assert.equal(request.label, 'Send message');

    panel.send(approval(runner, request, 'allow'));
    await task;

    assert.equal(browser.calls.some((call) => call.name === 'clickAt'), true, 'the allowed action did not run');
    assert.equal(panel.settled().length, 1);
    assert.equal(runner.currentPermissions().length, 0);
  } finally {
    runner.dispose();
  }
});

test('a refused action changes nothing', async () => {
  const runner = await newRunner('Executor refused');
  try {
    const panel = attachPanel(runner);
    const browser = fakeBrowser();
    runner.browser = browser;
    installFakeSession(runner, { name: 'click', args: { index: 2 } });

    const task = runner.start('send the message');
    const asked = await waitFor(() => panel.requests().length > 0);
    assert.equal(asked, true, 'the task never asked the user');

    const request = panel.requests()[0].request;
    panel.send(approval(runner, request, 'deny'));
    await task;

    assert.equal(browser.calls.some((call) => call.name === 'clickAt'), false, 'a refused action changed the page');
  } finally {
    runner.dispose();
  }
});

test('Full access asks nothing and the action runs straight away', async () => {
  const runner = await newRunner('Executor in full access');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner));
    assert.equal(runner.access.mode, 'full-access');

    const browser = fakeBrowser();
    runner.browser = browser;
    installFakeSession(runner, { name: 'click', args: { index: 2 } });

    await runner.start('send the message');

    assert.equal(panel.requests().length, 0, 'Full access asked the user anyway');
    assert.equal(browser.calls.some((call) => call.name === 'clickAt'), true, 'the action did not run');
  } finally {
    runner.dispose();
  }
});

// --- what the model session is told ---------------------------------------

test('the model session of the next task describes the mode that is in force', async () => {
  const runner = await newRunner('Context');
  try {
    const panel = attachPanel(runner);
    const settings = await modelSettings();

    runner.prepareModelSession(settings);
    const askPrompt = promptOf(runner);
    const askKey = runner.sessionKey;
    assert.match(askPrompt, /ask\s*first/i, 'the model was not told the mode that is in force');

    panel.send(elevation(runner));
    runner.prepareModelSession(settings);
    const fullPrompt = promptOf(runner);

    assert.match(fullPrompt, /full\s*access/i, 'the model was not told the new mode');
    assert.notEqual(fullPrompt, askPrompt, 'the mode in force did not change the prompt');
    assert.notEqual(runner.sessionKey, askKey, 'the mode in force did not change the session');
  } finally {
    runner.dispose();
  }
});

test('a setting that names a mode does not give one', async () => {
  const runner = await newRunner('Settings are not a mode');
  try {
    const settings = await modelSettings();
    runner.prepareModelSession(settings);
    const askPrompt = promptOf(runner);

    runner.prepareModelSession({ ...settings, accessMode: 'full-access', mode: 'full-access' });
    assert.equal(promptOf(runner), askPrompt, 'a setting named the mode');
    assert.equal(runner.access.mode, 'ask-first');
  } finally {
    runner.dispose();
  }
});

test('a new worker for the same chat starts at Ask first', async () => {
  const runner = await newRunner('New worker');
  try {
    const panel = attachPanel(runner);
    panel.send(elevation(runner));
    assert.equal(runner.access.mode, 'full-access');
  } finally {
    runner.dispose();
  }

  const body = await sessions.loadSession((await sessions.listSessions()).find((s) => s.title === 'New worker').id);
  const rebuilt = new SessionRunner({
    meta: { id: body.meta.id, title: 'New worker' },
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
    assert.equal(panel.replay().access.mode, 'ask-first');
    assert.deepEqual(panel.replay().permissions, []);
  } finally {
    rebuilt.dispose();
  }
});
