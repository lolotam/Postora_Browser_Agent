import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserController } from '../src/browser/controller.js';
import { createVoiceAccess } from '../src/background/voice-access.js';
import * as claims from '../src/sessions/voice-claims.js';
import { SessionRunner } from '../src/background/session-runner.js';
import * as sessions from '../src/sessions/store.js';

// The moment the input leaves for the page. Everything before it may still be
// prepared: the debugger attaches, the overlay is drawn, the page is read
// again. The guard is asked at the last possible moment, and it looks at the
// page as well as at the lease: a field that lost the focus, an element that
// was replaced and an element that moved must not receive what was approved.
//
// The worker runs the real voice path with a real controller and a mocked
// Chrome, so the code that runs in the extension is the code that is tested.
// The session is in Full access, so the input is allowed without a question and
// everything that is left to check is the lease, the element and the focus.

const EXTENSION_ID = 'voice-dispatch-extension';
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/src/sidepanel/index.html`;
const SENDER = { id: EXTENSION_ID, url: PANEL_URL };

const records = {};
let nextTab = 81000;

/** A session with a runner of its own, in Full access. */
async function newRunner(title = 'Voice dispatch') {
  const meta = await sessions.createStoredSession(title);
  const body = await sessions.loadSession(meta.id);
  const runner = new SessionRunner({ meta, body, color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  runner.access.setMode('full-access', { trusted: true, acknowledged: true, expectedRevision: runner.access.revision });
  return runner;
}

/**
 * The worker, a controller and a page that may change while the input is
 * prepared. `hooks` decides what the page does and when.
 */
async function scene(hooks = {}) {
  const tabId = ++nextTab;
  const panelId = `panel-${tabId}`;
  const state = { focus: true, identity: true, x: 12, y: 24 };
  const calls = [];
  const saved = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
      getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64' }),
    },
    debugger: {
      onDetach: { addListener() {} },
      attach: async () => hooks.attach?.(state),
      sendCommand: async (_target, method, params) => {
        calls.push({ method, ...params });
        await hooks.dispatch?.(method, params, state);
      },
      detach: async () => {},
    },
    scripting: {
      executeScript: async ({ args }) => {
        const kind = args[0];
        if (kind === 'hit') {
          // The point that was approved: the element has to lie under it still.
          const wanted = args[1] ?? {};
          const moved = wanted.x !== state.x || wanted.y !== state.y;
          return [{ result: state.identity && !moved ? { ok: true, x: state.x, y: state.y, documentId: 'doc-1' } : { ok: false, errorKey: 'voice.pageMoved' } }];
        }
        if (kind === 'resolve' || kind === 'locate') {
          return [{ result: state.identity ? { ok: true, x: state.x, y: state.y, documentId: 'doc-1' } : { ok: false, errorKey: 'voice.pageGone' } }];
        }
        if (kind === 'focus') {
          return [{ result: state.focus ? { ok: true, documentId: 'doc-1' } : { ok: false, errorKey: 'voice.pageFocusLost' } }];
        }
        if (kind === 'document') return [{ result: { ok: true, documentId: 'doc-1' } }];
        throw new Error(`Unexpected probe: ${kind}`);
      },
    },
    tabs: {
      get: async (id) => ({ id, url: 'https://qa.invalid/', status: 'complete', windowId: 1 }),
      query: async () => [],
      onRemoved: { addListener() {} },
      update: async () => {},
      remove: async () => {},
      getZoom: async () => 1,
      setZoom: async () => {},
    },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in records).map((k) => [k, structuredClone(records[k])])),
        set: async (obj) => Object.assign(records, structuredClone(obj)),
        remove: async (keys) => [].concat(keys).forEach((k) => delete records[k]),
      },
    },
  };
  const voiceBrowser = new BrowserController();
  voiceBrowser.overlay.click = async () => hooks.overlay?.(state);
  const runner = await newRunner();
  const panelPorts = new Map([[`panel:${runner.id}:${panelId}`, { name: `panel:${runner.id}:${panelId}`, sender: SENDER }]]);
  const access = createVoiceAccess({
    getRunner: async () => runner,
    panelPorts,
    voiceBrowser,
    withVoiceBrowser: (task) => task(),
    ownerOfTab: () => null,
  });
  const claimed = await access.handleClaim({ tabId, panelId, sessionId: runner.id }, SENDER);
  return {
    tabId,
    panelId,
    runner,
    token: claimed.token,
    commandId: claimed.command?.id,
    calls,
    state,
    /** One action of the voice path, as the panel asks for it. */
    run: (action, extra = {}) => access.handleAction({
      action,
      tabId,
      panelId,
      sessionId: runner.id,
      commandId: claimed.command?.id,
      token: claimed.token,
      element: 'approved',
      expected: { label: 'Email' },
      ...extra,
    }, SENDER),
    revoke: () => claims.revokeTab(tabId, { panelId, token: claimed.token }),
    restore: () => {
      claims.releaseTab(tabId, { panelId, token: claimed.token });
      globalThis.chrome = saved;
    },
  };
}

const mutating = (calls, type) => calls.filter((call) => call.type === type);

test('a text that is inserted after the focus moved away never reaches the page', async () => {
  const app = await scene({ attach: (state) => { state.focus = false; } });
  try {
    const result = await app.run('type_text', {
      args: { text: 'private approved text', submit: false },
      steps: [{ op: 'click', element: 'approved' }, { op: 'selectAll' }, { op: 'text', text: 'private approved text' }],
    });
    assert.equal(result.ok, false, 'the input is refused');
    assert.equal(app.calls.filter((call) => call.method === 'Input.insertText').length, 0, 'nothing was typed');
  } finally {
    app.restore();
  }
});

test('a lease that is withdrawn while the page is read stops the text', async () => {
  const tabId = ++nextTab;
  const panelId = `panel-${tabId}`;
  const calls = [];
  const saved = globalThis.chrome;
  let revoke = () => {};
  globalThis.chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
      getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64' }),
    },
    tabs: { get: async (id) => ({ id, url: 'https://qa.invalid/', status: 'complete', windowId: 1 }), onRemoved: { addListener() {} } },
    debugger: {
      onDetach: { addListener() {} },
      attach: async () => {},
      sendCommand: async (_target, method, params) => { calls.push({ method, ...params }); },
      detach: async () => {},
    },
    scripting: {
      // The page is read again right before the text goes out, and the lease
      // is withdrawn while that read is under way.
      executeScript: async ({ args }) => {
        revoke();
        if (args[0] === 'document') return [{ result: { ok: true, documentId: 'doc-1' } }];
        return [{ result: args[0] === 'focus' ? { ok: true, documentId: 'doc-1' } : { ok: true, x: 12, y: 24, documentId: 'doc-1' } }];
      },
    },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in records).map((k) => [k, structuredClone(records[k])])),
        set: async (obj) => Object.assign(records, structuredClone(obj)),
        remove: async (keys) => [].concat(keys).forEach((k) => delete records[k]),
      },
    },
  };
  const voiceBrowser = new BrowserController();
  voiceBrowser.overlay.click = async () => {};
  const runner = await newRunner('Lease withdrawn while reading');
  const panelPorts = new Map([[`panel:${runner.id}:${panelId}`, { name: `panel:${runner.id}:${panelId}`, sender: SENDER }]]);
  const access = createVoiceAccess({
    getRunner: async () => runner,
    panelPorts,
    voiceBrowser,
    withVoiceBrowser: (task) => task(),
    ownerOfTab: () => null,
  });
  const claimed = await access.handleClaim({ tabId, panelId, sessionId: runner.id }, SENDER);
  revoke = () => claims.revokeTab(tabId, { panelId, token: claimed.token });
  try {
    const result = await access.handleAction({
      action: 'type_text',
      tabId,
      panelId,
      sessionId: runner.id,
      commandId: claimed.command?.id,
      token: claimed.token,
      element: 'approved',
      expected: { label: 'Email' },
      args: { text: 'private approved text', submit: false },
      steps: [{ op: 'click', element: 'approved' }, { op: 'selectAll' }, { op: 'text', text: 'private approved text' }],
    }, SENDER);
    assert.equal(result.ok, false, 'the input is refused');
    assert.equal(calls.filter((call) => call.method === 'Input.insertText').length, 0, 'nothing was typed');
  } finally {
    claims.releaseTab(tabId, { panelId, token: claimed.token });
    globalThis.chrome = saved;
  }
});

test('a selection that is made after the focus moved away never reaches the page', async () => {
  const app = await scene({ attach: (state) => { state.focus = false; } });
  try {
    const result = await app.run('type_text', {
      args: { text: 'private approved text', submit: false },
      steps: [{ op: 'click', element: 'approved' }, { op: 'selectAll' }, { op: 'text', text: 'private approved text' }],
    });
    assert.equal(result.ok, false, 'the input is refused');
    assert.equal(app.calls.filter((call) => /keydown/i.test(call.type ?? '')).length, 0, 'no key went down');
  } finally {
    app.restore();
  }
});

test('an element that was replaced while the overlay was drawn does not get the click', async () => {
  const app = await scene({ overlay: (state) => { state.identity = false; } });
  try {
    const result = await app.run('click', { steps: [{ op: 'click', element: 'approved' }] });
    assert.equal(result.ok, false, 'the input is refused');
    assert.equal(mutating(app.calls, 'mousePressed').length, 0, 'the button was never pressed');
  } finally {
    app.restore();
  }
});

test('an element that moved while the overlay was drawn does not get the click', async () => {
  const app = await scene({ overlay: (state) => { state.x = 900; state.y = 900; } });
  try {
    const result = await app.run('click', { steps: [{ op: 'click', element: 'approved' }] });
    assert.equal(result.ok, false, 'the input is refused');
    assert.equal(mutating(app.calls, 'mousePressed').length, 0, 'the button was never pressed');
  } finally {
    app.restore();
  }
});

test('the button is let go even when the lease is withdrawn after the press', async () => {
  let revoke = () => {};
  const app = await scene({ dispatch: (method, params) => { if (params.type === 'mousePressed') revoke(); } });
  revoke = app.revoke;
  try {
    await app.run('click', { steps: [{ op: 'click', element: 'approved' }] });
    assert.equal(mutating(app.calls, 'mousePressed').length, 1, 'the button was pressed');
    assert.equal(mutating(app.calls, 'mouseReleased').length, 1, 'and it was let go again');
  } finally {
    app.restore();
  }
});

test('the key is let go even when the lease is withdrawn after it went down', async () => {
  let revoke = () => {};
  const app = await scene({ dispatch: (method, params) => { if (params.type === 'keyDown') revoke(); } });
  revoke = app.revoke;
  try {
    await app.run('press_key', { steps: [{ op: 'key', key: 'Enter' }] });
    assert.equal(app.calls.filter((call) => /keydown/i.test(call.type ?? '')).length, 1, 'the key went down');
    assert.equal(app.calls.filter((call) => /keyup/i.test(call.type ?? '')).length, 1, 'and it was let go again');
  } finally {
    app.restore();
  }
});
