import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A fake Chrome with only what notifications touch.
const state = {};
function resetChrome({ granted = true, focusedTab = 99, focusedGroup = -1, tabs = { 7: { id: 7, windowId: 3 } }, panelOpens = true } = {}) {
  Object.assign(state, { created: [], cleared: [], focused: [], activated: [], panels: [], session: {}, granted, tabs });
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://x/${p}` },
    i18n: { getUILanguage: () => 'en-US' },
    permissions: { contains: async () => state.granted },
    notifications: {
      create: async (id, options) => { state.created.push({ id, ...options }); return id; },
      clear: async (id) => { state.cleared.push(id); return true; },
    },
    windows: {
      getLastFocused: async () => ({ id: 1, focused: true }),
      update: async (id) => { state.focused.push(id); },
    },
    tabs: {
      query: async () => [{ id: focusedTab, groupId: focusedGroup }],
      get: async (id) => { if (!state.tabs[id]) throw new Error('No tab'); return state.tabs[id]; },
      update: async (id) => { state.activated.push(id); },
      onRemoved: { addListener() {} },
    },
    sidePanel: { setOptions: async () => {}, open: async ({ tabId }) => { if (!panelOpens) throw new Error('needs a user gesture'); state.panels.push(tabId); } },
    debugger: { onDetach: { addListener() {} }, detach: async () => {} },
    storage: {
      session: {
        get: async (key) => (key in state.session ? { [key]: structuredClone(state.session[key]) } : {}),
        set: async (obj) => {
          await new Promise((r) => setTimeout(r, 5)); // writes land later, as in Chrome
          Object.assign(state.session, structuredClone(obj));
        },
        remove: async (key) => { delete state.session[key]; },
      },
    },
  };
}

const { notifyTransition, openFromNotification, forgetNotification } = await import('../src/background/notifications.js');
const on = { notify: true, uiLanguage: 'auto' };
beforeEach(() => resetChrome());

test('the text is generic: no task, page or report text', async () => {
  const id = await notifyTransition({ kind: 'finished', sessionId: 's1', tabId: 7, settings: on });
  assert.ok(id);
  assert.deepEqual(state.created.map((n) => [n.title, n.message]), [['Postora', 'A task finished']]);
  await notifyTransition({ kind: 'ask', sessionId: 's1', tabId: 7, settings: { ...on, uiLanguage: 'ar' } });
  assert.equal(state.created[1].message, 'مهمة محتاجة ردك');
});

test('nothing when the switch is off, the permission was refused or revoked, or the user is on that tab', async () => {
  assert.equal(await notifyTransition({ kind: 'finished', sessionId: 's1', tabId: 7, settings: { ...on, notify: false } }), null);
  resetChrome({ granted: false });
  assert.equal(await notifyTransition({ kind: 'finished', sessionId: 's1', tabId: 7, settings: on }), null);
  resetChrome({ focusedTab: 7 });
  assert.equal(await notifyTransition({ kind: 'finished', sessionId: 's1', tabId: 7, settings: on }), null);
  assert.equal(state.created.length, 0);
});

test('a click after a worker restart still finds the tab, brings it forward and opens the panel', async () => {
  const id = await notifyTransition({ kind: 'ask', sessionId: 's1', tabId: 7, settings: on });
  // A restarted worker keeps nothing in memory; the route is in storage.session.
  const bound = [];
  const outcome = await openFromNotification(id, { sessionExists: async () => true, bindTab: async (tabId, sessionId) => bound.push([tabId, sessionId, state.activated.length]) });
  assert.equal(outcome, 'opened');
  assert.deepEqual(state.focused, [3]);
  assert.deepEqual(state.activated, [7]);
  assert.deepEqual(bound, [[7, 's1', 0]]); // bound before the tab was activated
  assert.deepEqual(state.panels, [7]);
  assert.equal(await openFromNotification(id, { sessionExists: async () => true, bindTab: async () => {} }), 'gone'); // used once
});

test('a panel Chrome refuses to open still leaves the tab in front', async () => {
  resetChrome({ panelOpens: false });
  const id = await notifyTransition({ kind: 'finished', sessionId: 's1', tabId: 7, settings: on });
  assert.equal(await openFromNotification(id, { sessionExists: async () => true, bindTab: async () => {} }), 'focused');
  assert.deepEqual(state.activated, [7]);
});

test('a closed tab or a deleted session claims nothing', async () => {
  const closed = await notifyTransition({ kind: 'finished', sessionId: 's1', tabId: 7, settings: on });
  delete state.tabs[7];
  assert.equal(await openFromNotification(closed, { sessionExists: async () => true, bindTab: async () => assert.fail('bound') }), 'tab-closed');
  state.tabs[7] = { id: 7, windowId: 3 };
  const deleted = await notifyTransition({ kind: 'finished', sessionId: 's2', tabId: 7, settings: on });
  assert.equal(await openFromNotification(deleted, { sessionExists: async () => false, bindTab: async () => assert.fail('bound') }), 'gone');
  assert.deepEqual(state.activated, []);
});

test('a dismissed notification forgets its route', async () => {
  const id = await notifyTransition({ kind: 'failed', sessionId: 's1', tabId: 7, settings: on });
  await forgetNotification(id);
  assert.deepEqual(state.session, {});
});

test('two sessions notifying at once both keep their routes', async () => {
  const [a, b] = await Promise.all([
    notifyTransition({ kind: 'finished', sessionId: 'a', tabId: 7, settings: on }),
    notifyTransition({ kind: 'ask', sessionId: 'b', tabId: 7, settings: on }),
  ]);
  const opened = [];
  for (const id of [a, b]) await openFromNotification(id, { sessionExists: async () => true, bindTab: async (_tab, sessionId) => opened.push(sessionId) });
  assert.deepEqual(opened, ['a', 'b']);
});

test('a failing notifications API never reaches the task', async () => {
  chrome.notifications.create = async () => { throw new Error('boom'); };
  assert.equal(await notifyTransition({ kind: 'finished', sessionId: 's1', tabId: 7, settings: on }), null);
  assert.deepEqual(state.session, {}); // and leaves no route behind
});

test('the runner notifies each transition of a task once', async () => {
  const local = {};
  chrome.storage.local = {
    get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in local).map((k) => [k, structuredClone(local[k])])),
    set: async (obj) => Object.assign(local, structuredClone(obj)),
    remove: async () => {},
  };
  const { SessionRunner } = await import('../src/background/session-runner.js');
  const sessions = await import('../src/sessions/store.js');
  const meta = await sessions.createStoredSession('Notified');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  runner.settings = on;
  runner.browser.tabId = 7;
  runner.emit({ type: 'ask', question: 'Pay?' });
  runner.emit({ type: 'ask', question: 'Really?' }); // a second question is a new transition
  runner.emit({ type: 'final', report: 'ok', success: true });
  runner.emit({ type: 'final', report: 'ok', success: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(state.created.map((n) => n.message), ['A task needs your answer', 'A task needs your answer', 'A task finished']);
  runner.dispose();
});

test('an answered question withdraws its notification', async () => {
  const local = {};
  chrome.storage.local = {
    get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in local).map((k) => [k, structuredClone(local[k])])),
    set: async (obj) => Object.assign(local, structuredClone(obj)),
    remove: async () => {},
  };
  const { SessionRunner } = await import('../src/background/session-runner.js');
  const sessions = await import('../src/sessions/store.js');
  const meta = await sessions.createStoredSession('Asked');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  runner.settings = on;
  runner.browser.tabId = 7;
  const stop = new AbortController();
  const answered = runner.askUser('Pay?', stop.signal);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(state.created.length, 1);
  runner.answer('yes');
  assert.equal(await answered, 'yes');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(state.cleared, [state.created[0].id]);
  runner.dispose();
});

test('no notification while the user is on another tab of the same session', async () => {
  // The agent works in a background tab (7) it opened; the user watches tab 12 of the same group.
  resetChrome({ focusedTab: 12, focusedGroup: 4 });
  assert.equal(await notifyTransition({ kind: 'finished', sessionId: 's1', tabId: 7, groupId: 4, settings: on }), null);
  // A tab of another group still counts as away.
  resetChrome({ focusedTab: 12, focusedGroup: 9 });
  assert.ok(await notifyTransition({ kind: 'finished', sessionId: 's1', tabId: 7, groupId: 4, settings: on }));
});
