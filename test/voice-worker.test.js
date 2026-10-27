import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BrowserController } from '../src/browser/controller.js';
import * as claims from '../src/sessions/voice-claims.js';
import { pageError, pageErrorKey, selectAllChord } from '../src/voice/voice-input.js';
import * as page from '../src/voice/voice-page.js';

// The worker's side of the voice path: the claim, the real input and the
// release of the tab. The functions are read out of the worker and run with a
// mocked browser, so the code that runs in the extension is the code that is
// tested.

const source = fs.readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const voiceInputSource = source.slice(source.indexOf('async function voiceInput('), source.indexOf('\nfunction sessionForTab('));
const releaseSource = source.slice(source.indexOf('async function releaseVoiceClaim('), source.indexOf('async function voiceInput('));
const takenByOtherSource = source.slice(source.indexOf('function isTakenByOther('), source.indexOf('\nfunction broadcastSessions('));
const voiceClaimSource = source.slice(source.indexOf('async function voiceClaim('), source.indexOf('\n/**\n * Gives one lease back'));

/** The worker's voice functions with a browser that only records what it did. */
function worker({ gate = null, calls = [], attached = new Set(), inject = null } = {}) {
  const context = vm.createContext({
    voiceClaims: claims,
    page,
    pageError,
    pageErrorKey,
    selectAllChord,
    withVoiceBrowser: async (task) => {
      if (gate) await gate;
      return task();
    },
    voiceBrowser: {
      borrowTab: async () => {},
      detachTab: async (tabId) => { attached.delete(tabId); },
      clickAt: async () => calls.push('click'),
      insertText: async () => calls.push('text'),
      pressKey: async (key) => calls.push(`key:${key}`),
      inject: inject ?? (async () => ({ ok: true })),
    },
  });
  vm.runInContext(`${voiceInputSource}\n${releaseSource}`, context);
  return context;
}

test('a claim that was given back while the input was waiting does not click or type', async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const calls = [];
  const app = worker({ gate, calls });
  claims.claimTab(21, { panelId: 'panel-a', sessionId: 'session-a' });

  const pending = app.voiceInput({ tabId: 21, panelId: 'panel-a', steps: [{ op: 'click', x: 10, y: 10 }, { op: 'text', text: 'must not type' }] });
  claims.revokePanel('panel-a');
  open();
  const result = await pending;

  assert.deepEqual(calls, [], 'nothing was clicked and nothing was typed');
  assert.equal(result.ok, false, 'the input is refused');
});

test('a claim that is still held lets the input through', async () => {
  const calls = [];
  const app = worker({ calls });
  claims.claimTab(22, { panelId: 'panel-a', sessionId: 'session-a' });

  const result = await app.voiceInput({ tabId: 22, panelId: 'panel-a', steps: [{ op: 'click', x: 10, y: 10 }, { op: 'text', text: 'hello' }] });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['click', 'text']);
});

test('another panel cannot use a claim it does not hold', async () => {
  const calls = [];
  const app = worker({ calls });
  claims.claimTab(23, { panelId: 'panel-a', sessionId: 'session-a' });

  const result = await app.voiceInput({ tabId: 23, panelId: 'panel-b', steps: [{ op: 'click', x: 10, y: 10 }] });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test('the input names the lease it belongs to, and an old lease may not send anything', async () => {
  const calls = [];
  const app = worker({ calls });
  const { token } = claims.claimTab(30, { panelId: 'panel-a', sessionId: 'session-a' });

  const wrong = await app.voiceInput({ tabId: 30, panelId: 'panel-a', token: 'another-lease', steps: [{ op: 'click' }] });
  assert.equal(wrong.ok, false, 'a request under a lease that is not the one may not act');
  assert.deepEqual(calls, []);

  const right = await app.voiceInput({ tabId: 30, panelId: 'panel-a', token, steps: [{ op: 'click' }] });
  assert.equal(right.ok, true);
  assert.deepEqual(calls, ['click']);
});

test('a lease whose authorization was withdrawn may not send anything', async () => {
  const calls = [];
  const app = worker({ calls });
  const { token } = claims.claimTab(31, { panelId: 'panel-a', sessionId: 'session-a' });
  claims.revokeTab(31, { panelId: 'panel-a', token });

  const result = await app.voiceInput({ tabId: 31, panelId: 'panel-a', token, steps: [{ op: 'click' }, { op: 'text', text: 'no' }] });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], 'nothing was clicked and nothing was typed');
});

test('the approved element is resolved after the queue, and the focus is checked again', async () => {
  const calls = [];
  const asked = [];
  const app = worker({
    calls,
    inject: async (func, args) => {
      asked.push(args[0]);
      if (args[0] === 'resolve') return { ok: true, x: 12, y: 24 };
      if (args[0] === 'focus') return { ok: true };
      return { ok: true };
    },
  });
  const { token } = claims.claimTab(32, { panelId: 'panel-a', sessionId: 'session-a' });

  const result = await app.voiceInput({
    tabId: 32,
    panelId: 'panel-a',
    token,
    element: 'v1',
    expected: { kind: 'text input', label: 'Email' },
    rule: { tokens: [], words: [], fragments: [] },
    steps: [{ op: 'click', element: 'v1' }, { op: 'selectAll' }, { op: 'text', text: 'hello' }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(asked, ['resolve', 'focus', 'focus'], 'the element is resolved and the focus is checked before every input');
  assert.deepEqual(calls, ['click', 'key:Control+A', 'text']);
});

test('a page that moved the focus away stops the input before anything is typed', async () => {
  const calls = [];
  const app = worker({
    calls,
    inject: async (func, args) => {
      if (args[0] === 'resolve') return { ok: true, x: 12, y: 24 };
      if (args[0] === 'focus') return { ok: false, errorKey: 'voice.pageFocusLost' };
      return { ok: true };
    },
  });
  const { token } = claims.claimTab(33, { panelId: 'panel-a', sessionId: 'session-a' });

  const result = await app.voiceInput({
    tabId: 33,
    panelId: 'panel-a',
    token,
    element: 'v1',
    rule: { tokens: [], words: [], fragments: [] },
    steps: [{ op: 'click', element: 'v1' }, { op: 'selectAll' }, { op: 'text', text: 'hello' }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'voice.pageFocusLost');
  assert.deepEqual(calls, ['click'], 'the click happened, but nothing was typed');
});

test('an element that is gone stops the input before the click', async () => {
  const calls = [];
  const app = worker({
    calls,
    inject: async (func, args) => {
      if (args[0] === 'resolve') return { ok: false, errorKey: 'voice.pageGone' };
      return { ok: true };
    },
  });
  const { token } = claims.claimTab(34, { panelId: 'panel-a', sessionId: 'session-a' });

  const result = await app.voiceInput({
    tabId: 34,
    panelId: 'panel-a',
    token,
    element: 'v1',
    rule: { tokens: [], words: [], fragments: [] },
    steps: [{ op: 'click', element: 'v1' }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'voice.pageGone');
  assert.deepEqual(calls, [], 'nothing was clicked');
});

test('giving the claim back lets the tab go, and the debugger is detached from it', async () => {
  const attached = new Set([24]);
  const app = worker({ attached });
  const { token } = claims.claimTab(24, { panelId: 'panel-a', sessionId: 'session-a' });

  await app.releaseVoiceClaim(24, 'panel-a', token);

  assert.equal(claims.claimOf(24), null, 'the claim is given back');
  assert.equal(attached.has(24), false, 'the debugger is detached from the tab');
});

test('a panel that goes away detaches the debugger from every tab it held', async () => {
  const attached = new Set([50, 51]);
  const app = worker({ attached });
  claims.claimTab(50, { panelId: 'panel-a', sessionId: 'session-a' });
  claims.claimTab(51, { panelId: 'panel-a', sessionId: 'session-a' });

  // This is what the worker does when the port of the panel closes.
  await app.releaseVoiceClaims('panel-a');

  assert.equal(attached.has(50), false, 'the debugger is detached from the first tab');
  assert.equal(attached.has(51), false, 'the debugger is detached from the second tab');
  assert.equal(claims.claimOf(50), null, 'the first tab is free');
  assert.equal(claims.claimOf(51), null, 'the second tab is free');
});

test('a lease that is given back keeps the tab busy until the debugger is detached', async () => {
  const attached = new Set([25]);
  let detach;
  const waiting = new Promise((resolve) => { detach = resolve; });
  const app = worker({ attached });
  const { token } = claims.claimTab(25, { panelId: 'panel-a', sessionId: 'session-a' });
  app.voiceBrowser.detachTab = async () => { await waiting; attached.delete(25); };

  const pending = app.releaseVoiceClaim(25, 'panel-a', token);
  // The authorization is gone at once: the tab is busy, but nothing may be
  // sent under it any more.
  assert.equal(claims.isAuthorized(25, { panelId: 'panel-a', token }), false);
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

/** The worker's claim, with the running sessions of the worker mocked. */
function claimWorker({ runners = [], tab = { id: 40, groupId: -1, url: 'https://example.test/' } } = {}) {
  const context = vm.createContext({
    voiceClaims: claims,
    runners: new Map(runners.map((runner) => [runner.id, runner])),
    chrome: { tabs: { get: async (id) => ({ ...tab, id }) } },
  });
  vm.runInContext(`${takenByOtherSource}\n${voiceClaimSource}`, context);
  return context;
}

const runningSession = (id, title, tabId, groupId = -1) => ({
  id,
  title,
  running: true,
  browser: { tabId, groupId, ownsTab: (tab) => tab.groupId === groupId },
});

test('a tab that a running task works in is refused, even when it is not in a group', async () => {
  const app = claimWorker({ runners: [runningSession('regular-session', 'Normal task', 40)] });

  const result = await app.voiceClaim({ tabId: 40, sessionId: 'voice-session', panelId: 'voice-panel' });

  assert.equal(result.ok, false, 'the voice path may not take the tab of a running task');
  assert.equal(result.owner, 'Normal task', 'the task that holds it is named');
  assert.equal(claims.claimOf(40), null, 'no lease was left behind');
});

test('a tab in the group of a running task is refused', async () => {
  const app = claimWorker({
    runners: [runningSession('regular-session', 'Normal task', 41, 7)],
    tab: { id: 40, groupId: 7, url: 'https://example.test/' },
  });

  const result = await app.voiceClaim({ tabId: 40, sessionId: 'voice-session', panelId: 'voice-panel' });

  assert.equal(result.ok, false);
  assert.equal(result.owner, 'Normal task');
});

test('a tab of a task that is not running is free', async () => {
  const idle = { ...runningSession('regular-session', 'Normal task', 40), running: false };
  const app = claimWorker({ runners: [idle] });

  const result = await app.voiceClaim({ tabId: 40, sessionId: 'voice-session', panelId: 'voice-panel' });

  assert.equal(result.ok, true, 'the tab is free');
  assert.ok(result.token, 'the lease has a token');
  claims.releaseTab(40, { panelId: 'voice-panel', token: result.token });
});
