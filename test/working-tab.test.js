// The tab a task works on. When it is closed, the task ends: it does not go on
// in the tab the user happens to be looking at, and it does not hand over to
// the model, which would decide on its own what to do next.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// In-memory tabs and groups with the parts of chrome.tabs the controller uses.
let tabs;
let groups;
let nextGroup;
let onRemoved;
globalThis.chrome = {
  debugger: { onDetach: { addListener() {} }, detach: async () => {} },
  tabs: {
    onRemoved: { addListener: (fn) => { onRemoved = fn; } },
    get: async (id) => {
      if (!tabs[id]) throw new Error(`No tab with id: ${id}.`);
      return { ...tabs[id] };
    },
    query: async () => Object.values(tabs).filter((t) => t.active),
    create: async ({ url, active }) => {
      const id = Math.max(0, ...Object.keys(tabs).map(Number)) + 1;
      tabs[id] = { id, url, active: Boolean(active), groupId: -1, windowId: 1, title: '' };
      return { ...tabs[id] };
    },
    update: async (id, props) => Object.assign(tabs[id], props),
    remove: async (id) => { delete tabs[id]; },
    group: async ({ tabIds, groupId }) => {
      if (groupId !== undefined && !groups[groupId]) throw new Error(`No group with id: ${groupId}.`);
      const id = groupId ?? nextGroup++;
      groups[id] ??= { id, title: '', color: 'grey' };
      for (const t of tabIds) tabs[t].groupId = id;
      return id;
    },
  },
  tabGroups: { update: async (id, props) => Object.assign(groups[id], props) },
  windows: { update: async () => {} },
};

const { BrowserController } = await import('../src/browser/controller.js');
const { WorkingTabClosedError } = await import('../src/browser/working-tab.js');
const { runAgent } = await import('../src/agent/agent.js');
const { createFastLayer } = await import('../src/fast/fast-layer.js');
const { createToolExecutor } = await import('../src/agent/tools.js');
const { AccessAuthority, FULL_ACCESS } = await import('../src/permissions/policy.js');

/** The same three tabs for every test: the one the task starts on, a second one, and one of the user. */
function resetTabs() {
  tabs = {
    1: { id: 1, url: 'https://a.test', active: true, groupId: -1, windowId: 1, title: 'A' },
    2: { id: 2, url: 'https://b.test', active: false, groupId: -1, windowId: 1, title: 'B' },
    3: { id: 3, url: 'https://c.test', active: false, groupId: -1, windowId: 1, title: 'C' },
  };
  groups = {};
  nextGroup = 100;
}

/**
 * A tab is closed: it is gone, Chrome says so, and — as Chrome does — another
 * tab takes its place. That other tab is the one the user is looking at.
 */
function closeTab(id) {
  delete tabs[id];
  for (const tab of Object.values(tabs)) tab.active = false;
  const next = Object.values(tabs)[0];
  if (next) next.active = true;
  onRemoved(id);
}

/** A browser that behaves like the controller, for the tools that need one. */
function fakeBrowser({ owned = [1], disposable = [2] } = {}) {
  const closed = [];
  return {
    closed,
    ownsTab: (tab) => owned.includes(tab.id),
    disposable: new Set(disposable),
    isTakenByOther: () => null,
    currentTab: async () => ({ id: 1, url: 'https://a.test' }),
    captureTarget: async ({ kind, tabId }) => ({
      scope: 'tab', kind: 'tab', tabId, url: 'https://a.test', documentId: null, element: null, capturedAt: Date.now(),
    }),
    validateTarget: async () => ({ ok: true }),
    closeOwnedTab: async (id) => { closed.push(id); },
    overlay: { pointTo: async () => {}, say: async () => {} },
  };
}

/** The worker's own authority, with the answers the test gives it. */
function fullAccess() {
  const access = new AccessAuthority({
    sessionId: 'working-tab-test',
    onRequest: (request) => access.respondApproval({
      id: request.id, sessionId: request.sessionId, revision: request.revision, decision: 'allow',
    }),
  });
  access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });
  return access;
}

test('the tab the task works on is closed: the task ends instead of taking the tab the user looks at', async () => {
  resetTabs();
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null });
  await browser.startOn(); // the task starts on tab 1
  closeTab(1); // the user closes it

  await assert.rejects(browser.currentTab(), { name: 'WorkingTabClosedError' });
  assert.equal(browser.tabId, null);
});

test('before the task starts the controller may still claim the active tab', async () => {
  resetTabs();
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null });

  const tab = await browser.currentTab();

  assert.equal(tab.id, 1, 'the active tab was claimed');
});

test('the agent closing the tab it works on ends the task too', async () => {
  resetTabs();
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null });
  await browser.startOn();
  await browser.closeOwnedTab(1);

  await assert.rejects(browser.currentTab(), { name: 'WorkingTabClosedError' });
});

test('the task does not move to another tab after its own tab was closed', async () => {
  resetTabs();
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null });
  await browser.startOn();
  closeTab(1);

  await assert.rejects(browser.useTab(2), { name: 'WorkingTabClosedError' });
  assert.equal(tabs[2].groupId, -1, 'the other tab was not taken');
});

test('a new task may work on a new tab after the previous one was closed', async () => {
  resetTabs();
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null });
  await browser.startOn();
  closeTab(1);

  const tab = await browser.startOn(2);

  assert.equal(tab.id, 2, 'the next task starts on the tab it was given');
});

test('the main loop ends the task when the working tab is gone: no further turn, no further tool', async () => {
  let turns = 0;
  const executed = [];
  const session = {
    users: [],
    results: [],
    addUserMessage: (text) => session.users.push(text),
    addToolResult: (id, output) => session.results.push({ id, output }),
    next: async () => {
      turns += 1;
      return turns === 1
        ? { text: '', toolCalls: [{ id: '1', name: 'click', args: { index: 1 } }] }
        : { text: '', toolCalls: [{ id: '2', name: 'done', args: { report: 'ok', success: true } }] };
    },
  };

  await assert.rejects(runAgent({
    session,
    task: 't',
    maxSteps: 5,
    emit: () => {},
    execute: async (name) => {
      executed.push(name);
      throw new WorkingTabClosedError(1);
    },
  }), { name: 'WorkingTabClosedError' });

  assert.deepEqual(executed, ['click'], 'no tool ran after the loss');
  assert.equal(turns, 1, 'the model was not asked again');
  assert.deepEqual(session.results.map((r) => r.id), ['1'], 'the failed call still got a result');
});

test('the fast layer ends the task when the working tab is gone instead of handing over', async () => {
  const layer = createFastLayer({
    config: { mode: 'auto' },
    task: 't',
    execute: async () => ({ output: '' }),
    ask: async () => ({ answers: {} }),
    browser: {
      snapshot: async () => { throw new WorkingTabClosedError(1); },
      currentTab: async () => { throw new WorkingTabClosedError(1); },
    },
  });

  await assert.rejects(layer.step(), { name: 'WorkingTabClosedError' });
});

test('the fast layer loss ends the task before any model turn', async () => {
  let turns = 0;
  const executed = [];
  const fastLayer = {
    step: async () => { throw new WorkingTabClosedError(1); },
    recordLlmAction: () => {},
  };
  const session = {
    addUserMessage() {},
    addToolResult() {},
    next: async () => { turns += 1; return { text: '', toolCalls: [] }; },
  };

  await assert.rejects(runAgent({
    session, task: 't', maxSteps: 5, emit: () => {},
    execute: async (name) => { executed.push(name); return { output: '' }; },
    fastLayer,
  }), { name: 'WorkingTabClosedError' });

  assert.equal(turns, 0, 'the model was not asked');
  assert.deepEqual(executed, [], 'no tool ran');
});

test('no tool of the task runs after the working tab is gone', async () => {
  const browser = { ...fakeBrowser(), workingTabLost: () => true };
  const execute = createToolExecutor(browser, { askUser: async () => '', access: fullAccess() });

  await assert.rejects(execute('read_page', {}), { name: 'WorkingTabClosedError' });
  assert.deepEqual(browser.closed, [], 'nothing was closed');
});

test('close_tab closes a tab of this session and refuses a tab of somebody else', async () => {
  resetTabs();
  const browser = fakeBrowser();
  const execute = createToolExecutor(browser, { askUser: async () => '', access: fullAccess() });

  const own = await execute('close_tab', { tab_id: 1 });
  assert.equal(own.isError, undefined, own.output);
  assert.deepEqual(browser.closed, [1], 'the tab of the session was closed');

  const disposable = await execute('close_tab', { tab_id: 2 });
  assert.equal(disposable.isError, undefined, disposable.output);
  assert.deepEqual(browser.closed, [1, 2], 'the tab the session opened was closed');

  const foreign = await execute('close_tab', { tab_id: 3 });
  assert.equal(foreign.isError, true);
  assert.match(foreign.output, /not one of your tabs/);
  assert.deepEqual(browser.closed, [1, 2], 'the tab of the user was not closed');
});

test('the loss of the working tab is told once, at the moment the tab goes', async () => {
  resetTabs();
  let told = 0;
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null, onLost: () => { told += 1; } });
  await browser.startOn();
  closeTab(1);
  await assert.rejects(browser.currentTab(), { name: 'WorkingTabClosedError' });
  assert.equal(told, 1, 'the runner is told at once, and only once');
});

test('a tab claimed while the working tab closes does not hide the loss', async () => {
  resetTabs();
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null });
  await browser.startOn();
  const publish = browser.publishTab.bind(browser);
  browser.publishTab = (id) => {
    closeTab(1); // the working tab goes while the new one is being taken, before it is published
    publish(id);
  };
  await assert.rejects(browser.useTab(2), { name: 'WorkingTabClosedError' });
  assert.notEqual(browser.tabId, 2, 'the new tab did not become the working tab');
});

test('an approved action does not run once the working tab is gone', async () => {
  const browser = { ...fakeBrowser({ owned: [1, 2], disposable: [] }), workingTabLost: () => false };
  let lost = false;
  browser.workingTabLost = () => lost;
  browser.closeOwnedTab = async (id, { guard }) => {
    lost = true; // the working tab goes while the action is on its way
    await guard();
    browser.closed.push(id);
  };
  tabs = { 1: { id: 1 }, 2: { id: 2 } };
  const execute = createToolExecutor(browser, { access: fullAccess() });
  await assert.rejects(execute('close_tab', { tab_id: 2 }), { name: 'WorkingTabClosedError' });
  assert.deepEqual(browser.closed, []);
});

test('close_tab checks again after approval that the tab is still of this session', async () => {
  const owned = [1, 2];
  const browser = fakeBrowser({ owned, disposable: [] });
  browser.closeOwnedTab = async (id, { guard }) => {
    owned.splice(owned.indexOf(2), 1); // the tab left the session while the card was open
    await guard();
    browser.closed.push(id);
  };
  tabs = { 1: { id: 1 }, 2: { id: 2 } };
  const execute = createToolExecutor(browser, { access: fullAccess() });
  const result = await execute('close_tab', { tab_id: 2 });
  assert.equal(result.isError, true);
  assert.match(result.output, /not one of your tabs/);
  assert.deepEqual(browser.closed, []);
});

test('a finished task\'s tab closing later is no loss and ends nothing', async () => {
  resetTabs();
  let told = 0;
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null, onLost: () => { told += 1; } });
  await browser.startOn();
  browser.finishTask();
  closeTab(1);
  assert.equal(told, 0);
  assert.equal(browser.workingTabLost(), false);
});
