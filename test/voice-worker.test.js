import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserController } from '../src/browser/controller.js';
import { createVoiceAccess } from '../src/background/voice-access.js';
import * as claims from '../src/sessions/voice-claims.js';
import { SessionRunner } from '../src/background/session-runner.js';
import * as sessions from '../src/sessions/store.js';

// The worker's side of the voice path: the claim, the real input and the
// release of the tab. The module that runs in the extension is the module that
// is tested here.
//
// The authority is the real one: the session has Full access in these tests,
// so the input is allowed without a question and everything that is left to
// check is the lease, the queue, the element and the focus.

const EXTENSION_ID = 'voice-worker-extension';
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/src/sidepanel/index.html`;

const records = {};
globalThis.chrome = {
  runtime: {
    id: EXTENSION_ID,
    getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
    getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64' }),
  },
  debugger: { onDetach: { addListener() {} }, detach: async () => {}, attach: async () => {}, sendCommand: async () => ({}) },
  scripting: { executeScript: async () => [] },
  tabs: {
    onRemoved: { addListener() {} },
    get: async (id) => ({ id, windowId: 1, url: 'https://example.test/', title: 'Example' }),
    query: async () => [],
    create: async ({ url, windowId, active }) => ({ id: 9, windowId, url, title: '', active }),
    update: async (id, changes) => ({ id, ...changes }),
    remove: async () => {},
    getZoom: async () => 1,
    setZoom: async () => {},
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
  },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in records).map((k) => [k, structuredClone(records[k])])),
      set: async (obj) => Object.assign(records, structuredClone(obj)),
      remove: async (keys) => [].concat(keys).forEach((k) => delete records[k]),
    },
  },
};

/** The sender of a message from our own side panel. */
const SENDER = { id: EXTENSION_ID, url: PANEL_URL };

/** A panel connection of the worker. */
function makePort(name) {
  return { name, sender: SENDER, postMessage() {}, onMessage: { addListener() {}, removeListener() {} }, onDisconnect: { addListener() {} } };
}

/** A session with a runner of its own, in Full access. */
async function newRunner(title = 'Voice worker') {
  const meta = await sessions.createStoredSession(title);
  const body = await sessions.loadSession(meta.id);
  const runner = new SessionRunner({ meta, body, color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  runner.access.setMode('full-access', { trusted: true, acknowledged: true, expectedRevision: runner.access.revision });
  return runner;
}

/**
 * The worker's voice path, with a browser that only records what it did.
 */
function worker({ runner, calls = [], attached = new Set(), inject = null, owner = null, gate = null, detachGate = null } = {}) {
  const panelPorts = new Map([[`panel:${runner.id}:panel-a`, makePort(`panel:${runner.id}:panel-a`)]]);
  const access = createVoiceAccess({
    getRunner: async () => runner,
    panelPorts,
    voiceBrowser: {
      borrowTab: async () => {},
      detachTab: async (tabId) => { if (detachGate) await detachGate; attached.delete(tabId); },
      clickAt: async () => calls.push('click'),
      insertText: async () => calls.push('text'),
      pressKey: async (key) => calls.push(`key:${key}`),
      inject: inject ?? (async (func, args) => {
        if (args[0] === 'document') return { ok: true, documentId: 'doc-1' };
        if (args[0] === 'resolve' || args[0] === 'locate') {
          return { ok: true, x: 12, y: 24, kind: 'text input', label: 'Email', documentId: 'doc-1' };
        }
        if (args[0] === 'focus') return { ok: true, documentId: 'doc-1' };
        return { ok: true };
      }),
    },
    withVoiceBrowser: async (task) => {
      if (gate) await gate;
      return task();
    },
    ownerOfTab: () => owner,
  });
  return { access, panelPorts, runner };
}

/** The claim of a panel on a tab, and the command that came with it. */
async function claim(app, tabId, { panelId = 'panel-a' } = {}) {
  const res = await app.access.handleClaim({ tabId, panelId, sessionId: app.runner.id }, SENDER);
  return res;
}

test('a claim that was given back while the input was waiting does not click or type', async () => {
  const runner = await newRunner('Lease withdrawn');
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const calls = [];
  const app = worker({ runner, calls, gate });

  const held = await claim(app, 21);
  assert.equal(held.ok, true);
  const token = held.token;

  const pending = app.access.handleAction({
    action: 'click', tabId: 21, panelId: 'panel-a', sessionId: runner.id, commandId: held.command.id,
    token, element: 'v1', expected: { kind: 'button' }, steps: [{ op: 'click', element: 'v1' }],
  }, SENDER);
  claims.revokePanel('panel-a');
  open();
  const result = await pending;

  assert.deepEqual(calls, [], 'nothing was clicked and nothing was typed');
  assert.equal(result.ok, false, 'the input is refused');
});

test('a claim that is still held lets the input through', async () => {
  const runner = await newRunner('Lease held');
  const calls = [];
  const app = worker({ runner, calls });
  const held = await claim(app, 22);

  const result = await app.access.handleAction({
    action: 'click', tabId: 22, panelId: 'panel-a', sessionId: runner.id, commandId: held.command.id,
    token: held.token, element: 'v1', expected: { kind: 'button' }, steps: [{ op: 'click', element: 'v1' }],
  }, SENDER);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['click']);
});

test('another panel cannot use a claim it does not hold', async () => {
  const runner = await newRunner('Another panel');
  const calls = [];
  const app = worker({ runner, calls });
  const held = await claim(app, 23);

  const result = await app.access.handleAction({
    action: 'click', tabId: 23, panelId: 'panel-b', sessionId: runner.id, commandId: held.command.id,
    token: held.token, element: 'v1', expected: { kind: 'button' }, steps: [{ op: 'click', element: 'v1' }],
  }, SENDER);

  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test('an input without the token of the lease may not act', async () => {
  const runner = await newRunner('No token');
  const calls = [];
  const app = worker({ runner, calls });
  const held = await claim(app, 29);

  const result = await app.access.handleAction({
    action: 'click', tabId: 29, panelId: 'panel-a', sessionId: runner.id, commandId: held.command.id,
    element: 'v1', expected: { kind: 'button' }, steps: [{ op: 'click', element: 'v1' }],
  }, SENDER);

  assert.equal(result.ok, false, 'a message that lost its token does nothing');
  assert.deepEqual(calls, []);
});

test('the input names the lease it belongs to, and an old lease may not send anything', async () => {
  const runner = await newRunner('Old lease');
  const calls = [];
  const app = worker({ runner, calls });
  const held = await claim(app, 30);

  const wrong = await app.access.handleAction({
    action: 'click', tabId: 30, panelId: 'panel-a', sessionId: runner.id, commandId: held.command.id,
    token: 'another-lease', element: 'v1', expected: { kind: 'button' }, steps: [{ op: 'click', element: 'v1' }],
  }, SENDER);
  assert.equal(wrong.ok, false, 'a request under a lease that is not the one may not act');
  assert.deepEqual(calls, []);

  const right = await app.access.handleAction({
    action: 'click', tabId: 30, panelId: 'panel-a', sessionId: runner.id, commandId: held.command.id,
    token: held.token, element: 'v1', expected: { kind: 'button' }, steps: [{ op: 'click', element: 'v1' }],
  }, SENDER);
  assert.equal(right.ok, true);
  assert.deepEqual(calls, ['click']);
});

test('a lease whose authorization was withdrawn may not send anything', async () => {
  const runner = await newRunner('Revoked lease');
  const calls = [];
  const app = worker({ runner, calls });
  const held = await claim(app, 31);
  claims.revokeTab(31, { panelId: 'panel-a', token: held.token });

  const result = await app.access.handleAction({
    action: 'click', tabId: 31, panelId: 'panel-a', sessionId: runner.id, commandId: held.command.id,
    token: held.token, element: 'v1', expected: { kind: 'button' }, steps: [{ op: 'click', element: 'v1' }],
  }, SENDER);

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], 'nothing was clicked and nothing was typed');
});

test('the approved element is resolved after the queue, and the focus is checked again', async () => {
  const runner = await newRunner('Resolve and focus');
  const calls = [];
  const asked = [];
  const app = worker({
    runner,
    calls,
    inject: async (func, args) => {
      asked.push(args[0]);
      if (args[0] === 'resolve') return { ok: true, x: 12, y: 24, kind: 'text input', label: 'Email', documentId: 'doc-1' };
      if (args[0] === 'locate') return { ok: true, x: 12, y: 24, kind: 'text input', label: 'Email', documentId: 'doc-1' };
      if (args[0] === 'document') return { ok: true, documentId: 'doc-1' };
      if (args[0] === 'focus') return { ok: true, documentId: 'doc-1' };
      return { ok: true };
    },
  });
  const held = await claim(app, 32);

  const result = await app.access.handleAction({
    action: 'type_text', tabId: 32, panelId: 'panel-a', sessionId: runner.id, commandId: held.command.id,
    token: held.token, element: 'v1', expected: { kind: 'text input', label: 'Email' },
    args: { text: 'hello', submit: false },
    steps: [{ op: 'click', element: 'v1' }, { op: 'selectAll' }, { op: 'text', text: 'hello' }],
  }, SENDER);

  assert.equal(result.ok, true);
  assert.ok(asked.includes('resolve'), 'the element is resolved again');
  assert.ok(asked.includes('focus'), 'the focus is checked before every input');
  assert.deepEqual(calls, ['click', 'key:Control+A', 'text']);
});

test('a page that moved the focus away stops the input before anything is typed', async () => {
  const runner = await newRunner('Focus moved');
  const calls = [];
  const app = worker({
    runner,
    calls,
    inject: async (func, args) => {
      if (args[0] === 'resolve') return { ok: true, x: 12, y: 24, kind: 'text input', label: 'Email', documentId: 'doc-1' };
      if (args[0] === 'locate') return { ok: true, x: 12, y: 24, kind: 'text input', label: 'Email', documentId: 'doc-1' };
      if (args[0] === 'document') return { ok: true, documentId: 'doc-1' };
      if (args[0] === 'focus') return { ok: false, errorKey: 'voice.pageFocusLost' };
      return { ok: true };
    },
  });
  const held = await claim(app, 33);

  const result = await app.access.handleAction({
    action: 'type_text', tabId: 33, panelId: 'panel-a', sessionId: runner.id, commandId: held.command.id,
    token: held.token, element: 'v1', expected: { kind: 'text input', label: 'Email' },
    args: { text: 'hello', submit: false },
    steps: [{ op: 'click', element: 'v1' }, { op: 'selectAll' }, { op: 'text', text: 'hello' }],
  }, SENDER);

  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'voice.pageFocusLost');
  assert.deepEqual(calls, ['click'], 'the click happened, but nothing was typed');
});

test('an element that is gone stops the input before the click', async () => {
  const runner = await newRunner('Element gone');
  const calls = [];
  const app = worker({
    runner,
    calls,
    inject: async (func, args) => {
      if (args[0] === 'resolve' || args[0] === 'locate') return { ok: false, errorKey: 'voice.pageGone' };
      if (args[0] === 'document') return { ok: true, documentId: 'doc-1' };
      return { ok: true };
    },
  });
  const held = await claim(app, 34);

  const result = await app.access.handleAction({
    action: 'click', tabId: 34, panelId: 'panel-a', sessionId: runner.id, commandId: held.command.id,
    token: held.token, element: 'v1', expected: { kind: 'button' }, steps: [{ op: 'click', element: 'v1' }],
  }, SENDER);

  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'voice.pageGone');
  assert.deepEqual(calls, [], 'nothing was clicked');
});

test('giving the claim back lets the tab go, and the debugger is detached from it', async () => {
  const runner = await newRunner('Release');
  const attached = new Set([24]);
  const app = worker({ runner, attached });
  const held = await claim(app, 24);

  await app.access.releaseClaim(24, 'panel-a', held.token);

  assert.equal(claims.claimOf(24), null, 'the claim is given back');
  assert.equal(attached.has(24), false, 'the debugger is detached from the tab');
});

test('a panel that goes away detaches the debugger from every tab it held', async () => {
  const runner = await newRunner('Panel gone');
  const attached = new Set([50, 51]);
  const app = worker({ runner, attached });
  await claim(app, 50);
  await claim(app, 51);

  // This is what the worker does when the port of the panel closes.
  await app.access.releasePanel('panel-a');

  assert.equal(attached.has(50), false, 'the debugger is detached from the first tab');
  assert.equal(attached.has(51), false, 'the debugger is detached from the second tab');
  assert.equal(claims.claimOf(50), null, 'the first tab is free');
  assert.equal(claims.claimOf(51), null, 'the second tab is free');
});

test('a lease that is given back keeps the tab busy until the debugger is detached', async () => {
  const runner = await newRunner('Busy until detached');
  const attached = new Set([25]);
  let detach;
  const waiting = new Promise((resolve) => { detach = resolve; });
  const app = worker({ runner, attached, detachGate: waiting });
  const held = await claim(app, 25);

  const pending = app.access.releaseClaim(25, 'panel-a', held.token);
  // The authorization is gone at once: the tab is busy, but nothing may be
  // sent under it any more.
  assert.equal(claims.isAuthorized(25, { panelId: 'panel-a', token: held.token }), false);
  assert.equal(claims.holderOf(25), 'voice control', 'the tab is still busy');
  assert.equal(claims.claimTab(25, { panelId: 'panel-b' }).ok, false, 'nobody else may take it yet');

  detach();
  await pending;
  assert.equal(claims.claimOf(25), null, 'the tab is free once the cleanup is over');
  assert.equal(attached.has(25), false);
});

test('a session that is working in a tab is refused, even in its own group', async () => {
  const saved = globalThis.chrome;
  globalThis.chrome = {
    debugger: { onDetach: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, get: async (id) => ({ id, groupId: 7 }) },
  };
  try {
    const controller = new BrowserController({ isTakenByOther: () => 'voice control' });
    controller.groupId = 7;
    await assert.rejects(controller.claimTab(1), /voice control/);
  } finally {
    globalThis.chrome = saved;
  }
});

test('a tab that a running task works in is refused, even when it is not in a group', async () => {
  const runner = await newRunner('Taken by a task');
  const app = worker({ runner, owner: 'Normal task' });

  const result = await claim(app, 40);

  assert.equal(result.ok, false, 'the voice path may not take the tab of a running task');
  assert.equal(result.owner, 'Normal task', 'the task that holds it is named');
  assert.equal(claims.claimOf(40), null, 'no lease was left behind');
});

test('a tab of a task that is not running is free', async () => {
  const runner = await newRunner('Free tab');
  const app = worker({ runner });

  const result = await claim(app, 40);

  assert.equal(result.ok, true, 'the tab is free');
  assert.ok(result.token, 'the lease has a token');
  assert.ok(result.command?.id, 'the command comes with the claim');
  claims.releaseTab(40, { panelId: 'panel-a', token: result.token });
});

test('a tab that is gone fails the claim closed, and no lease is left behind', async () => {
  const runner = await newRunner('Gone tab');
  let lookups = 0;
  const saved = globalThis.chrome;
  globalThis.chrome = {
    ...globalThis.chrome,
    tabs: {
      ...globalThis.chrome.tabs,
      get: async (id) => {
        lookups += 1;
        if (lookups > 1) throw new Error('No tab with id: 40.');
        return { id, windowId: 1, url: 'https://example.test/', title: 'Example' };
      },
    },
  };
  try {
    const app = worker({ runner });
    const result = await claim(app, 40);

    assert.equal(result.ok, false, 'a missing tab is not a claim');
    assert.equal(result.errorKey, 'voice.sayTabGone');
    assert.equal(claims.claimOf(40), null, 'no lease was left behind');
  } finally {
    globalThis.chrome = saved;
  }
});
