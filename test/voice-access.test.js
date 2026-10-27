import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// The worker's voice path with the real authority of the session.
//
// The authority here is the real one (src/permissions/policy.js) and the
// session is a real one: the questions are answered the way the panel answers
// them, through the same Allow/Deny card the chat uses. Nothing here is
// proved by a mock that always says yes.
//
// What these tests are about: what the voice path asks about, what it does
// without asking, what it refuses, and what happens when the world moves
// while the question is open.

const EXTENSION_ID = 'voice-access-extension';
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/src/sidepanel/index.html`;

const records = {};
const tabCalls = [];
const debuggerCalls = [];
const probes = [];
let pageAnswer = () => ({ ok: true, x: 12, y: 24, kind: 'button', label: 'Send', documentId: 'doc-1' });
let worlds = 0;

globalThis.chrome = {
  runtime: {
    id: EXTENSION_ID,
    getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
    getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64' }),
  },
  debugger: {
    onDetach: { addListener() {} },
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_target, method, params) => { debuggerCalls.push({ method, ...params }); },
  },
  scripting: {
    executeScript: async ({ args }) => [{ result: await pageAnswer(args[0], args[1]) }],
  },
  tabs: {
    onRemoved: { addListener() {} },
    get: async (id) => ({ id, windowId: 1, url: 'https://shop.test/checkout', title: 'Checkout', status: 'complete' }),
    query: async () => [],
    create: async ({ url, windowId, active }) => {
      tabCalls.push({ what: 'create', url, windowId, active });
      return { id: 9, windowId, url, title: '', active };
    },
    update: async (id, changes) => { tabCalls.push({ what: 'update', id, changes }); },
    remove: async (id) => { tabCalls.push({ what: 'remove', id }); },
    getZoom: async () => 1,
    setZoom: async (id, level) => { tabCalls.push({ what: 'zoom', id, level }); },
    goBack: async (id) => { tabCalls.push({ what: 'back', id }); },
    goForward: async (id) => { tabCalls.push({ what: 'forward', id }); },
    reload: async (id) => { tabCalls.push({ what: 'reload', id }); },
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
const { createVoiceAccess } = await import('../src/background/voice-access.js');
const { createChromeBrowser } = await import('../src/voice/voice-browser.js');
const sessions = await import('../src/sessions/store.js');

const SENDER = { id: EXTENSION_ID, url: PANEL_URL };

// The worlds of the tests that are running: every one of them gives its
// leases back, so a tab of one test is free for the next.
const open = [];
afterEach(async () => {
  for (const world of open.splice(0)) {
    await world.access.releasePanel(world.panelId).catch(() => {});
    world.runner.dispose();
  }
});

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
  };
}

/** A session with a runner of its own. */
async function newRunner(title = 'Voice access') {
  const meta = await sessions.createStoredSession(title);
  const body = await sessions.loadSession(meta.id);
  const runner = new SessionRunner({ meta, body, color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  return runner;
}

/**
 * The worker of one session, with the panel of that session attached.
 */
async function newWorld({ title = 'Voice access', mode = 'ask-first', page = null } = {}) {
  tabCalls.length = 0;
  debuggerCalls.length = 0;
  probes.length = 0;
  pageAnswer = page ?? (async (kind) => {
    if (kind === 'document') return { ok: true, documentId: 'doc-1' };
    if (kind === 'focus') return { ok: true, body: false, writable: true, secret: false, documentId: 'doc-1' };
    if (kind === 'focused') return { editable: true, writable: true, secret: false, body: false, id: 'focused-1', label: 'Terminal' };
    return { ok: true, x: 12, y: 24, kind: 'button', label: 'Send', documentId: 'doc-1' };
  });
  const runner = await newRunner(title);
  // Every panel is a panel of its own, as it is in the extension, and every
  // one of them works on a tab of its own.
  const panelId = `voice-panel-${(worlds += 1)}`;
  const tabId = 100 + worlds;
  const panel = makePort({ name: `panel:${runner.id}:${panelId}`, sender: SENDER });
  runner.attach(panel.port);
  if (mode === 'full-access') {
    runner.access.setMode('full-access', { trusted: true, acknowledged: true, expectedRevision: runner.access.revision });
  }
  const panelPorts = new Map([[panel.port.name, panel.port]]);
  const access = createVoiceAccess({
    getRunner: async () => runner,
    panelPorts,
    voiceBrowser: {
      borrowTab: async () => {},
      detachTab: async () => {},
      clickAt: async (x, y) => { debuggerCalls.push({ method: 'click', x, y }); },
      insertText: async (text) => { debuggerCalls.push({ method: 'insertText', text }); },
      pressKey: async (key) => { debuggerCalls.push({ method: 'pressKey', key }); },
      inject: async (func, args) => {
        probes.push(args[0]);
        return pageAnswer(args[0], args[1]);
      },
    },
    withVoiceBrowser: (task) => task(),
    ownerOfTab: () => null,
  });
  const claimed = await access.handleClaim({ tabId, panelId, sessionId: runner.id }, SENDER);
  assert.equal(claimed.ok, true, `the claim failed: ${JSON.stringify(claimed)}`);
  /** One action of the voice path, as the panel asks for it. */
  const act = (action, extra = {}) => access.handleAction({
    action,
    tabId,
    panelId,
    sessionId: runner.id,
    commandId: claimed.command?.id,
    token: claimed.token,
    ...extra,
  }, SENDER);
  const world = { runner, panel, panelId, tabId, access, claimed, act };
  open.push(world);
  return world;
}
/** The answer the panel sends for one question. */
const approval = (runner, request, decision = 'allow') => ({
  type: 'access-approval',
  id: request.id,
  sessionId: runner.id,
  revision: request.revision,
  decision,
});

/** The click of one element, as the panel asks for it. */
const clickAction = { action: 'click', element: 'v1', expected: { kind: 'button', label: 'Send' }, steps: [{ op: 'click', element: 'v1' }] };

test('Ask first asks the user about a click, and the click runs only after the answer', async () => {
  const world = await newWorld({ title: 'Ask allows' });
  try {
    const pending = world.act('click', clickAction);
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;
    assert.equal(request.action, 'click');
    assert.equal(request.sessionId, world.runner.id);
    assert.equal(request.origin, 'https://shop.test');
    assert.equal(request.label, 'Send');
    assert.equal(request.args, undefined, 'the arguments never travel');

    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await pending;
    assert.equal(result.ok, true, 'the allowed action ran');
    assert.ok(debuggerCalls.some((call) => call.method === 'click'), 'the click went out');
    assert.equal(world.panel.settled().length, 1);
  } finally {
    world.runner.dispose();
  }
});

test('a refused action changes nothing', async () => {
  const world = await newWorld({ title: 'Ask denies' });
  try {
    const pending = world.act('click', clickAction);
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;

    world.panel.send(approval(world.runner, request, 'deny'));
    const result = await pending;

    assert.equal(result.ok, false);
    assert.equal(debuggerCalls.length, 0, 'nothing was clicked');
    assert.equal(world.panel.settled()[0].approved, false);
  } finally {
    world.runner.dispose();
  }
});

test('Stop during target capture cannot create another approval afterwards', { timeout: 1000 }, async () => {
  const world = await newWorld({ title: 'Stop during capture' });
  const original = pageAnswer;
  let stopped = false;
  pageAnswer = async (kind, args) => {
    if (kind === 'resolve' && !stopped) {
      stopped = true;
      world.runner.access.cancel('stopped');
    }
    return original(kind, args);
  };
  try {
    const result = await world.act('click', clickAction);
    assert.equal(result.ok, false);
    assert.equal(world.panel.requests().length, 0, 'no question is announced after Stop');
    assert.equal(debuggerCalls.length, 0);
  } finally {
    world.runner.dispose();
  }
});

test('a new command after Stop gets a fresh generation, never the old command context', async () => {
  const world = await newWorld({ title: 'Fresh command after Stop' });
  try {
    world.runner.access.cancel('stopped');
    await world.access.releaseClaim(world.tabId, world.panelId, world.claimed.token);
    const next = await world.access.handleClaim({ tabId: world.tabId, panelId: world.panelId, sessionId: world.runner.id }, SENDER);
    assert.equal(next.ok, true);
    assert.notEqual(next.command.id, world.claimed.command.id);
    assert.equal((await world.act('probe', { script: 'pageProbe', args: { kind: 'collect', arg: { purpose: 'click' } } })).ok, false);
  } finally {
    world.runner.dispose();
  }
});

test('native blank-tab management does not grant scripting of protected Chrome pages', async () => {
  const world = await newWorld({ title: 'Blank tab management', mode: 'full-access' });
  const get = chrome.tabs.get;
  chrome.tabs.get = async (id) => ({ id, windowId: 1, url: 'chrome://newtab/', title: 'New tab', status: 'complete' });
  try {
    const shown = await world.act('switch_tab', { args: { tabId: world.tabId } });
    assert.equal(shown.ok, true, 'a newly created blank tab can be shown');
    assert.equal((await world.act('scroll_down', { args: { direction: 'down' } })).ok, false, 'protected content remains unavailable');
    assert.equal((await world.act('navigate', { args: { url: 'https://example.test/' } })).ok, true, 'the user can navigate away from a blank tab');
    for (const url of ['javascript:alert(1)', 'file:///private', 'chrome://settings', 'data:text/html,private']) {
      const before = tabCalls.length;
      assert.equal((await world.act('navigate', { args: { url } })).ok, false);
      assert.equal(tabCalls.length, before, 'non-web destinations never reach native navigation');
    }
  } finally {
    chrome.tabs.get = get;
    world.runner.dispose();
  }
});

test('Full access asks nothing and the action runs straight away', async () => {
  const world = await newWorld({ title: 'Full access', mode: 'full-access' });
  try {
    const result = await world.act('click', clickAction);
    assert.equal(result.ok, true);
    assert.equal(world.panel.requests().length, 0, 'Full access asked the user anyway');
    assert.ok(debuggerCalls.some((call) => call.method === 'click'), 'the click went out');
  } finally {
    world.runner.dispose();
  }
});

test('every interaction asks the user, one question at a time', async () => {
  const cases = [
    ['click', clickAction],
    ['type_text', { action: 'type_text', element: 'v1', expected: { kind: 'text input', label: 'Email' }, args: { text: 'hello', submit: false }, steps: [{ op: 'click', element: 'v1' }, { op: 'selectAll' }, { op: 'text', text: 'hello' }] }],
    ['press_key', { action: 'press_key', element: 'v1', steps: [{ op: 'key', key: 'Enter' }] }],
    ['navigate', { action: 'navigate', args: { url: 'https://example.test/' } }],
    ['open_tab', { action: 'open_tab', args: { url: 'https://example.test/', windowId: 1 } }],
    ['web_search', { action: 'web_search', args: { url: 'https://www.google.com/search?q=cats' } }],
    ['switch_tab', { action: 'switch_tab', args: { tabId: 3 } }],
    ['close_tab', { action: 'close_tab', args: { tabId: 3 } }],
    ['history', { action: 'history', args: { action: 'back' } }],
    ['reload', { action: 'history', args: { action: 'reload' } }],
    ['scroll_down', { action: 'scroll_down', args: { direction: 'down' } }],
    ['zoom_in', { action: 'zoom_in', args: {} }],
    ['media_play_pause', { action: 'media_play_pause', args: {} }],
    ['media_mute', { action: 'media_mute', args: {} }],
    ['find_on_page', { action: 'find_on_page', args: { text: 'cats' } }],
    ['read_field', { action: 'read_field', element: 'v1', expected: { kind: 'text input', label: 'Password' } }],
    ['insert_text', { action: 'insert_text', args: { text: 'ls -la' }, steps: [{ op: 'text', text: 'ls -la' }] }],
  ];
  for (const [name, extra] of cases) {
    const world = await newWorld({ title: `Ask every ${name}` });
    try {
      const pending = world.act(name, extra);
      const asked = await waitFor(() => world.panel.requests().length > 0);
      assert.equal(asked, true, `${name} never asked the user`);
      const request = world.panel.requests()[0].request;
      assert.notEqual(request.kind, 'observe', `${name} is not an observation`);
      world.panel.send(approval(world.runner, request, 'deny'));
      const result = await pending;
      assert.equal(result.ok, false, `${name} ran without an answer`);
    } finally {
      world.runner.dispose();
    }
  }
});

test('a read of a field is a question of its own', async () => {
  const world = await newWorld({
    title: 'Read asks',
    page: async (kind) => {
      if (kind === 'resolve') return { ok: true, x: 12, y: 24, kind: 'text input', label: 'Password', secret: true, documentId: 'doc-1' };
      if (kind === 'document') return { ok: true, documentId: 'doc-1' };
      return { ok: true };
    },
  });
  try {
    const pending = world.act('read_field', { action: 'read_field', element: 'v1', expected: { kind: 'text input', label: 'Password' } });
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;
    assert.equal(request.kind, 'sensitive', 'a read of a value is not an ordinary interaction');
    assert.equal(request.label, 'Password');
    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await pending;
    assert.equal(result.ok, true);
  } finally {
    world.runner.dispose();
  }
});

test('a request of another session, of another panel or from another page is refused', async () => {
  const world = await newWorld({ title: 'Wrong sender' });
  try {
    const others = [
      ['another session', { sessionId: 'another-chat' }, SENDER],
      ['another panel', { panelId: 'another-panel' }, SENDER],
      ['the microphone window', {}, { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/src/sidepanel/mic.html` }],
      ['a website', {}, { id: EXTENSION_ID, url: 'https://example.test/' }],
      ['another extension', {}, { id: 'another-extension', url: PANEL_URL }],
      ['no sender at all', {}, null],
    ];
    for (const [label, extra, sender] of others) {
      const result = await world.access.handleAction({
        action: 'click', tabId: world.tabId, panelId: world.panelId, sessionId: world.runner.id,
        commandId: world.claimed.command?.id, token: world.claimed.token, ...clickAction, ...extra,
      }, sender);
      assert.equal(result.ok, false, `${label} was allowed to act`);
      assert.equal(world.panel.requests().length, 0, `${label} was asked about anything`);
    }
    assert.equal(debuggerCalls.length, 0, 'nothing was clicked');
  } finally {
    world.runner.dispose();
  }
});

test('a request of a panel that is not connected is refused', async () => {
  const world = await newWorld({ title: 'No panel' });
  try {
    world.panel.disconnect();
    const result = await world.act('click', clickAction);
    assert.equal(result.ok, false, 'a panel that left may not act');
    assert.equal(debuggerCalls.length, 0, 'nothing was clicked');
  } finally {
    world.runner.dispose();
  }
});

test('a request without the lease of the tab is refused', async () => {
  const world = await newWorld({ title: 'No lease' });
  try {
    const result = await world.access.handleAction({
      action: 'click', tabId: world.tabId, panelId: world.panelId, sessionId: world.runner.id,
      commandId: world.claimed.command?.id, ...clickAction,
    }, SENDER);
    assert.equal(result.ok, false, 'a request without the token may not act');
    assert.equal(world.panel.requests().length, 0, 'nobody was asked');
  } finally {
    world.runner.dispose();
  }
});

test('a request of another command is refused', async () => {
  const world = await newWorld({ title: 'Another command' });
  try {
    const result = await world.access.handleAction({
      action: 'click', tabId: world.tabId, panelId: world.panelId, sessionId: world.runner.id,
      commandId: 'cmd-somewhere-else', token: world.claimed.token, ...clickAction,
    }, SENDER);
    assert.equal(result.ok, false, 'a command that is not live may not act');
    assert.equal(world.panel.requests().length, 0, 'nobody was asked');
  } finally {
    world.runner.dispose();
  }
});

test('a panel cannot raise the mode by itself', async () => {
  const world = await newWorld({ title: 'Forged mode' });
  try {
    const pending = world.access.handleAction({
      action: 'click', tabId: world.tabId, panelId: world.panelId, sessionId: world.runner.id,
      commandId: world.claimed.command?.id, token: world.claimed.token,
      mode: 'full-access', acknowledged: true, permit: { id: 'forged' }, ...clickAction,
    }, SENDER);
    await waitFor(() => world.panel.requests().length === 1);
    assert.equal(world.runner.access.mode, 'ask-first', 'the mode was raised by a message');
    const request = world.panel.requests()[0].request;
    world.panel.send(approval(world.runner, request, 'deny'));
    const result = await pending;
    assert.equal(result.ok, false, 'the action was allowed without a question');
    assert.equal(debuggerCalls.length, 0, 'nothing was clicked');
  } finally {
    world.runner.dispose();
  }
});

test('a mode change while the question is open withdraws it, and nothing runs', async () => {
  const world = await newWorld({ title: 'Mode changed' });
  try {
    const pending = world.act('click', clickAction);
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;

    // The user turns Full access on while the question is open.
    world.runner.access.setMode('full-access', { trusted: true, acknowledged: true, expectedRevision: world.runner.access.revision });
    const result = await pending;

    assert.equal(result.ok, false, 'the action ran under the new mode');
    assert.equal(debuggerCalls.length, 0, 'nothing was clicked');
    assert.ok(world.panel.settled().some((settled) => settled.id === request.id), 'the question was settled');
  } finally {
    world.runner.dispose();
  }
});

test('a stop while the question is open withdraws it, and nothing runs', async () => {
  const world = await newWorld({ title: 'Stopped' });
  try {
    const pending = world.act('click', clickAction);
    await waitFor(() => world.panel.requests().length > 0);

    world.runner.stop();
    const result = await pending;

    assert.equal(result.ok, false, 'the action ran after the stop');
    assert.equal(debuggerCalls.length, 0, 'nothing was clicked');
  } finally {
    world.runner.dispose();
  }
});

test('a command that was planned under an older mode does not run under a new one', async () => {
  const world = await newWorld({ title: 'Old context' });
  try {
    // The mode moves after the command was claimed.
    world.runner.access.setMode('full-access', { trusted: true, acknowledged: true, expectedRevision: world.runner.access.revision });

    const result = await world.act('click', clickAction);
    assert.equal(result.ok, false, 'the queued step ran under the new mode');
    assert.equal(debuggerCalls.length, 0, 'nothing was clicked');
    assert.equal(world.panel.requests().length, 0, 'the step was not even asked about: the command is over');
  } finally {
    world.runner.dispose();
  }
});

test('a release while a question waits does not wait for the question', async () => {
  const world = await newWorld({ title: 'Release while waiting' });
  try {
    const pending = world.act('click', clickAction);
    await waitFor(() => world.panel.requests().length > 0);

    // The command is given back while the question is still open.
    const released = world.access.releasePanel(world.panelId);
    const result = await pending;
    await released;

    assert.equal(result.ok, false, 'the action ran after the release');
    assert.equal(debuggerCalls.length, 0, 'nothing was clicked');
    assert.ok(world.panel.settled().some((settled) => ['released', 'cancelled', 'aborted'].includes(settled.reason)),
      'the question was settled when the command was given back');
  } finally {
    world.runner.dispose();
  }
});

test('a cancel while a question waits withdraws it at once', async () => {
  const world = await newWorld({ title: 'Cancel while waiting' });
  try {
    const pending = world.act('click', clickAction);
    await waitFor(() => world.panel.requests().length > 0);

    await world.access.cancelCommand({ panelId: world.panelId, sessionId: world.runner.id, commandId: world.claimed.command?.id }, SENDER);
    const result = await pending;

    assert.equal(result.ok, false, 'the action ran after the cancel');
    assert.equal(debuggerCalls.length, 0, 'nothing was clicked');
    assert.equal(world.panel.settled().length, 1, 'the question was settled');
  } finally {
    world.runner.dispose();
  }
});

test('a cancel of another panel or another session changes nothing', async () => {
  const world = await newWorld({ title: 'Cancel of another panel' });
  const other = await newWorld({ title: 'Cancel of another session' });
  try {
    const commandId = other.claimed.command?.id;
    const refused = await world.access.cancelCommand({ panelId: other.panelId, sessionId: other.runner.id, commandId }, SENDER);
    assert.equal(refused, false, 'a panel may not end the command of another panel');
    assert.ok(other.access.commandOf(other.panelId), 'the command of the other panel is still there');

    const refusedSession = await world.access.cancelCommand({ panelId: world.panelId, sessionId: 'another-chat', commandId: world.claimed.command?.id }, SENDER);
    assert.equal(refusedSession, false, 'a panel may not end a command of another session');
    assert.ok(world.access.commandOf(world.panelId), 'the command of this session is still there');
  } finally {
    world.runner.dispose();
    other.runner.dispose();
  }
});

test('the value of a secret field is read only after the user allowed that read', async () => {
  const world = await newWorld({
    title: 'Secret read',
    page: async (kind) => {
      if (kind === 'resolve') return { ok: true, x: 12, y: 24, kind: 'text input', label: 'Password', secret: true, documentId: 'doc-1' };
      if (kind === 'read') return { ok: true, value: 'synthetic-secret', secret: true, documentId: 'doc-1' };
      if (kind === 'document') return { ok: true, documentId: 'doc-1' };
      return { ok: true };
    },
  });
  try {
    const pending = world.act('read_field', { action: 'read_field', element: 'v1', expected: { kind: 'text input', label: 'Password' } });
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;
    assert.equal(request.kind, 'sensitive');
    assert.doesNotMatch(JSON.stringify(request), /synthetic-secret/, 'the value never travels in the question');

    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.value, 'synthetic-secret', 'the value the user allowed was read');
    assert.equal(result.secret, true);
  } finally {
    world.runner.dispose();
  }
});

test('a value is never read without an answer', async () => {
  const world = await newWorld({
    title: 'Secret read refused',
    page: async (kind) => {
      if (kind === 'resolve') return { ok: true, x: 12, y: 24, kind: 'text input', label: 'Password', secret: true, documentId: 'doc-1' };
      if (kind === 'read') return { ok: true, value: 'synthetic-secret', secret: true, documentId: 'doc-1' };
      if (kind === 'document') return { ok: true, documentId: 'doc-1' };
      return { ok: true };
    },
  });
  try {
    const pending = world.act('read_field', { action: 'read_field', element: 'v1', expected: { kind: 'text input', label: 'Password' } });
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;
    world.panel.send(approval(world.runner, request, 'deny'));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.value, undefined, 'the value was read anyway');
  } finally {
    world.runner.dispose();
  }
});

test('a page that was replaced while the question was open does not give its value', async () => {
  const world = await newWorld({
    title: 'Replaced document',
    page: async (kind) => {
      if (kind === 'resolve') return { ok: true, x: 12, y: 24, kind: 'text input', label: 'Password', secret: true, documentId: 'doc-1' };
      if (kind === 'read') return { ok: true, value: 'synthetic-secret', secret: true, documentId: 'doc-1' };
      if (kind === 'document') return { ok: true, documentId: 'doc-1' };
      return { ok: true };
    },
  });
  try {
    const pending = world.act('read_field', { action: 'read_field', element: 'v1', expected: { kind: 'text input', label: 'Password' } });
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;

    // The page replaces its document while the question is open: the same
    // address, a new document.
    pageAnswer = async (kind) => {
      if (kind === 'resolve') return { ok: true, x: 12, y: 24, kind: 'text input', label: 'Password', secret: true, documentId: 'doc-2' };
      if (kind === 'read') return { ok: true, value: 'synthetic-secret', secret: true, documentId: 'doc-2' };
      if (kind === 'document') return { ok: true, documentId: 'doc-2' };
      return { ok: true };
    };

    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await pending;
    assert.equal(result.ok, false, 'the read followed the replaced document');
    assert.equal(result.value, undefined, 'no value came back');
  } finally {
    world.runner.dispose();
  }
});

test('a page that was replaced while the question was open is not touched', async () => {
  let document = 'doc-1';
  const world = await newWorld({
    title: 'Replaced document, scroll',
    page: async (kind) => {
      if (kind === 'document') return { ok: true, documentId: document };
      return { ok: true, x: 12, y: 24, documentId: document };
    },
  });
  try {
    const pending = world.act('scroll_down', { action: 'scroll_down', args: { direction: 'down' } });
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;

    // The same address, a new document.
    document = 'doc-2';

    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await pending;
    assert.equal(result.ok, false, 'the scroll followed the replaced document');
    assert.equal(probes.filter((kind) => kind === 'down').length, 0, 'the page was not scrolled');
  } finally {
    world.runner.dispose();
  }
});

test('the capture of a target changes nothing on the page', async () => {
  const world = await newWorld({ title: 'Capture without a change' });
  try {
    const pending = world.act('click', clickAction);
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;

    // The question is open: the page has not been touched yet.
    assert.equal(probes.includes('locate'), false, 'the element was brought into view before the answer');
    assert.equal(probes.includes('focus'), false, 'the focus was asked for before the answer');

    world.panel.send(approval(world.runner, request, 'deny'));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(probes.includes('locate'), false, 'a refused action leaves the page alone');
  } finally {
    world.runner.dispose();
  }
});

test('the candidates of a page never carry a value, and the secret ones are only named', async () => {
  const world = await newWorld({
    title: 'Redacted candidates',
    page: async (kind) => {
      if (kind === 'collect') {
        return [{
          id: 'v1', kind: 'password input', label: 'Password', identityLabel: 'Password',
          href: null, inView: true, top: 0, left: 0, secret: true, focused: false,
        }];
      }
      return { ok: true };
    },
  });
  try {
    const result = await world.act('probe', { script: 'pageProbe', args: { kind: 'collect', arg: { purpose: 'type' } } });
    assert.equal(result.ok, true);
    const shown = JSON.stringify(result.result);
    assert.doesNotMatch(shown, /synthetic-secret/, 'no value travels with the candidates');
    assert.equal(result.result[0].secret, true, 'the field that holds a secret is marked as one');
    assert.equal(result.result[0].label, 'Password', 'it is named by what the page calls it');
  } finally {
    world.runner.dispose();
  }
});

test('the page may only be read with the kinds that read', async () => {
  const world = await newWorld({ title: 'Only reading' });
  try {
    for (const kind of ['read', 'resolve', 'focus', 'locate']) {
      const result = await world.act('probe', { script: 'pageProbe', args: { kind, arg: { id: 'v1' } } });
      assert.equal(result.ok, false, `the panel may not ask for the ${kind} probe`);
    }
    const ok = await world.act('probe', { script: 'pageProbe', args: { kind: 'collect', arg: { purpose: 'click' } } });
    assert.equal(ok.ok, true, 'the panel may ask for the elements of the page');
  } finally {
    world.runner.dispose();
  }
});

test('a script of the panel\'s own is refused', async () => {
  const world = await newWorld({ title: 'No own scripts' });
  try {
    const result = await world.act('probe', { script: 'myOwnScript', args: { kind: 'collect', arg: {} } });
    assert.equal(result.ok, false, 'a script of the panel may not run in a page');
    assert.equal(world.panel.requests().length, 0, 'nothing was asked about it');
  } finally {
    world.runner.dispose();
  }

  const full = await newWorld({ title: 'No own scripts, full access', mode: 'full-access' });
  try {
    // The script of the panel is never used: the worker runs the one it holds.
    const res = await full.act('scroll_down', { script: 'myOwnScript', args: { direction: 'down' } });
    assert.equal(res.ok, true, 'the scroll ran with the script of the worker');
  } finally {
    full.runner.dispose();
  }
});

test('a trusted terminal field takes the text and the Enter', async () => {
  const world = await newWorld({
    title: 'Terminal',
    page: async (kind) => {
      if (kind === 'focused') return { editable: true, writable: true, secret: false, body: false, id: 'terminal-1', label: 'Terminal' };
      if (kind === 'resolve') return { ok: true, x: 12, y: 24, kind: 'text area', label: 'Terminal', documentId: 'doc-1' };
      if (kind === 'focus') return { ok: true, body: false, writable: true, secret: false, label: 'Terminal', documentId: 'doc-1' };
      if (kind === 'document') return { ok: true, documentId: 'doc-1' };
      return { ok: true };
    },
  });
  try {
    const typed = world.act('insert_text', { action: 'insert_text', args: { text: 'ls -la' }, steps: [{ op: 'text', text: 'ls -la' }] });
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;
    assert.equal(request.action, 'insert_text');
    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await typed;
    assert.equal(result.ok, true, 'the text went into the focused field');
    assert.ok(debuggerCalls.some((call) => call.method === 'insertText' && call.text === 'ls -la'), 'the text was typed');

    const pressed = world.act('press_key', { action: 'press_key', element: 'terminal-1', steps: [{ op: 'key', key: 'Enter' }] });
    await waitFor(() => world.panel.requests().length > 1);
    const second = world.panel.requests()[1].request;
    world.panel.send(approval(world.runner, second, 'allow'));
    const key = await pressed;
    assert.equal(key.ok, true, 'the Enter went out');
    assert.ok(debuggerCalls.some((call) => call.method === 'pressKey' && call.key === 'Enter'), 'the Enter was pressed');
  } finally {
    world.runner.dispose();
  }
});

test('a field that cannot be written to takes nothing', async () => {
  const world = await newWorld({
    title: 'Not writable',
    page: async (kind) => {
      if (kind === 'focused') return { editable: true, writable: false, secret: false, body: false, id: 'role-1', label: 'Fake field' };
      if (kind === 'resolve') return { ok: true, x: 12, y: 24, kind: 'text box', label: 'Fake field', documentId: 'doc-1' };
      if (kind === 'document') return { ok: true, documentId: 'doc-1' };
      return { ok: true };
    },
  });
  try {
    const pending = world.act('insert_text', { action: 'insert_text', args: { text: 'hello' }, steps: [{ op: 'text', text: 'hello' }] });
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;
    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await pending;
    assert.equal(result.ok, false, 'a field that only claims to be one takes nothing');
    assert.equal(debuggerCalls.filter((call) => call.method === 'insertText').length, 0, 'nothing was typed');
  } finally {
    world.runner.dispose();
  }
});

test('the navigation and the other effects of the browser happen only after the answer', async () => {
  const world = await newWorld({ title: 'Navigation' });
  try {
    const pending = world.act('navigate', { action: 'navigate', args: { url: 'https://example.test/' } });
    await waitFor(() => world.panel.requests().length > 0);
    assert.equal(tabCalls.length, 0, 'the tab changed before the answer');
    const request = world.panel.requests()[0].request;
    assert.equal(request.origin, 'https://example.test', 'the preview names the site it goes to');
    assert.doesNotMatch(JSON.stringify(request), /example\.test\//, 'the path of the address never travels');

    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await pending;
    assert.equal(result.ok, true);
    assert.ok(tabCalls.some((call) => call.what === 'update'), 'the tab went to the address');
  } finally {
    world.runner.dispose();
  }
});

test('a refused navigation leaves the tab where it was', async () => {
  const world = await newWorld({ title: 'Navigation refused' });
  try {
    const pending = world.act('navigate', { action: 'navigate', args: { url: 'https://example.test/' } });
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;
    world.panel.send(approval(world.runner, request, 'deny'));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(tabCalls.length, 0, 'the tab did not move');
  } finally {
    world.runner.dispose();
  }
});

test('the media of the page is only touched after the answer', async () => {
  const world = await newWorld({
    title: 'Media',
    page: async (kind) => {
      if (kind === 'document') return { ok: true, documentId: 'doc-1' };
      if (kind === 'resolve') return { ok: true, x: 12, y: 24, documentId: 'doc-1' };
      return { ok: true, state: 'playing', documentId: 'doc-1' };
    },
  });
  try {
    const pending = world.act('media_play_pause', { action: 'media_play_pause', args: {} });
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;
    assert.equal(request.action, 'media_play_pause');
    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.state, 'playing');
  } finally {
    world.runner.dispose();
  }
});

test('a tab that this command opened and never showed is closed again, without a question', async () => {
  const world = await newWorld({ title: 'Orphan tab' });
  try {
    const pending = world.act('open_tab', { action: 'open_tab', args: { url: 'https://example.test/', windowId: 1 } });
    await waitFor(() => world.panel.requests().length === 1);
    const request = world.panel.requests()[0].request;
    assert.equal(request.action, 'open_tab');
    world.panel.send(approval(world.runner, request, 'allow'));
    const opened = await pending;
    assert.equal(opened.ok, true);
    assert.equal(opened.tab.id, 9);
    assert.ok(tabCalls.some((call) => call.what === 'create' && call.active === false), 'the tab waits until it is bound');

    const discarded = await world.act('discard_tab', { action: 'discard_tab', tabId: 9 });
    assert.equal(discarded.ok, true);
    assert.ok(tabCalls.some((call) => call.what === 'remove' && call.id === 9), 'the orphan is closed again');
    assert.equal(world.panel.requests().length, 1, 'the orphan is not a question: only the opening was');
  } finally {
    world.runner.dispose();
  }
});

test('a tab that this command did not open may not be discarded', async () => {
  const world = await newWorld({ title: 'Not an orphan' });
  try {
    const result = await world.act('discard_tab', { action: 'discard_tab', tabId: 42 });
    assert.equal(result.ok, false, 'a tab of somebody else may not be closed');
    assert.equal(tabCalls.filter((call) => call.what === 'remove').length, 0);
  } finally {
    world.runner.dispose();
  }
});

test('an action that is not on the list is refused', async () => {
  const world = await newWorld({ title: 'Unknown action' });
  try {
    for (const action of ['run_javascript', '__proto__', 'constructor', 'toString']) {
      const result = await world.act(action, { action, args: { expression: 'alert(1)' } });
      assert.equal(result.ok, false);
    }
    assert.equal(world.panel.requests().length, 0, 'nothing was asked');
  } finally {
    world.runner.dispose();
  }
});

test('the steps of an input must be the steps that were approved', async () => {
  const world = await newWorld({ title: 'Smuggled steps' });
  try {
    const result = await world.act('click', {
      action: 'click', element: 'v1', expected: { kind: 'button', label: 'Send' },
      steps: [{ op: 'click', element: 'v1' }, { op: 'text', text: 'sneaky' }],
    });
    assert.equal(result.ok, false, 'a panel may not add steps of its own');
    assert.equal(world.panel.requests().length, 0, 'a malformed request is not a question');
    assert.equal(debuggerCalls.length, 0, 'nothing was typed');
  } finally {
    world.runner.dispose();
  }
});

test('a withdrawal during the last check of the page stops the action', async () => {
  let resolves = 0;
  const world = await newWorld({
    title: 'Withdrawn at the last check',
    page: async (kind) => {
      if (kind === 'resolve') {
        resolves += 1;
        // The session is stopped while the page is looked at the last time,
        // after the capture and after the question was answered.
        if (resolves > 1) world.runner.access.cancel('stopped');
        return { ok: true, x: 12, y: 24, kind: 'button', label: 'Send', documentId: 'doc-1' };
      }
      if (kind === 'document') return { ok: true, documentId: 'doc-1' };
      return { ok: true };
    },
  });
  try {
    const pending = world.act('click', clickAction);
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;
    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await pending;
    assert.equal(result.ok, false, 'the click went out although the command was withdrawn');
    assert.equal(debuggerCalls.length, 0, 'nothing was clicked');
    assert.equal(probes.includes('locate'), false, 'the page was not even brought into view');
  } finally {
    world.runner.dispose();
  }
});

test('the browser of the panel and the worker speak the same language', async () => {
  const world = await newWorld({ title: 'Same language' });
  try {
    // The panel's browser talks to the real worker: the payload of the panel
    // and the contract of the worker are the same thing.
    globalThis.chrome.runtime.sendMessage = async (message) => {
      let result = null;
      if (message.type === 'voice-claim') result = await world.access.handleClaim(message, SENDER);
      else if (message.type === 'voice-action') result = await world.access.handleAction(message, SENDER);
      else if (message.type === 'voice-release') {
        await world.access.releaseClaim(message.tabId, message.panelId, message.token);
      } else if (message.type === 'voice-release-all') {
        await world.access.releasePanel(message.panelId);
      } else if (message.type === 'voice-cancel') {
        await world.access.cancelCommand(message, SENDER);
      } else if (message.type === 'tab-owner') result = { taken: false, owner: null };
      else if (message.type === 'bind-tab') result = { ok: true };
      else result = null;
      return { ok: true, result };
    };

    const browser = createChromeBrowser({
      sessionId: world.runner.id,
      panelId: world.panelId,
      target: async () => ({ id: world.tabId }),
    });
    const claimed = await browser.claim(world.tabId);
    assert.equal(claimed.ok, true, 'the panel took the lease through the worker');
    assert.ok(claimed.command?.id, 'the command came with the claim');

    // The click travels as the worker expects it.
    const pending = browser.input(world.tabId, [{ op: 'click', element: 'v1' }], {
      element: 'v1', expected: { kind: 'button', label: 'Send' }, action: 'click',
    });
    await waitFor(() => world.panel.requests().length > 0);
    const request = world.panel.requests()[0].request;
    assert.equal(request.action, 'click');
    world.panel.send(approval(world.runner, request, 'allow'));
    const result = await pending;
    assert.equal(result.ok, true, 'the click went through the real payload');
    assert.ok(debuggerCalls.some((call) => call.method === 'click'), 'the click went out');

    // A navigation travels with its address under the arguments, and the name
    // of the action is not taken from them.
    const navigating = browser.updateTab(world.tabId, { url: 'https://example.test/' });
    await waitFor(() => world.panel.requests().length === 2);
    world.panel.send(approval(world.runner, world.panel.requests()[1].request, 'allow'));
    const navigated = await navigating;
    assert.equal(navigated.ok, true);
    assert.ok(tabCalls.some((call) => call.what === 'update' && call.changes.url === 'https://example.test/'), 'the tab went to the address');

    // The history travels as the action of the history, not as the name of the
    // action itself.
    const goingBack = browser.goBack(world.tabId);
    await waitFor(() => world.panel.requests().length === 3);
    world.panel.send(approval(world.runner, world.panel.requests()[2].request, 'allow'));
    const history = await goingBack;
    assert.equal(history.ok, true);
    assert.ok(tabCalls.some((call) => call.what === 'back'), 'the tab went back');
  } finally {
    delete globalThis.chrome.runtime.sendMessage;
    world.runner.dispose();
  }
});
