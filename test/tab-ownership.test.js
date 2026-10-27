import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as claims from '../src/sessions/voice-claims.js';

// In-memory tabs and groups with the parts of chrome.tabs / chrome.tabGroups the controller uses.
let tabs;
let groups;
let nextGroup;
let activations;
globalThis.chrome = {
  debugger: { onDetach: { addListener() {} } },
  tabs: {
    onRemoved: { addListener() {} },
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
    update: async (id, props) => {
      if (props.active) activations.push(id);
      Object.assign(tabs[id], props);
      return { ...tabs[id] };
    },
    remove: async (id) => {
      delete tabs[id];
    },
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

beforeEach(() => {
  tabs = {
    1: { id: 1, url: 'https://a.test', active: true, groupId: -1, windowId: 1, title: 'A' },
    2: { id: 2, url: 'https://b.test', active: false, groupId: -1, windowId: 1, title: 'B' },
  };
  groups = {};
  nextGroup = 100;
  activations = [];
});

test('a session starts on the active tab and puts it in its own titled group', async () => {
  const browser = new BrowserController({ title: 'Laptops', color: 'cyan', isTakenByOther: () => null });
  const tab = await browser.startOn();
  assert.equal(tab.id, 1);
  assert.equal(tabs[1].groupId, 100);
  assert.deepEqual({ title: groups[100].title, color: groups[100].color }, { title: 'Laptops', color: 'cyan' });

  await browser.useTab(2);
  assert.equal(tabs[2].groupId, 100, 'later tabs join the same group');
  assert.deepEqual(activations, [], 'agents never bring a tab to the front');
});

test('a tab in another running session is refused, naming that session', async () => {
  tabs[2].groupId = 555;
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: (tab) => (tab.groupId === 555 ? 'Flights' : null) });
  await browser.startOn();
  await assert.rejects(browser.useTab(2), /Tab 2 is used by session "Flights"/);
  assert.equal(tabs[2].groupId, 555);
});

test('new tabs open in the background inside the group', async () => {
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null });
  await browser.startOn();
  const tab = await browser.openTab('https://c.test');
  assert.equal(tabs[tab.id].active, false);
  assert.equal(tabs[tab.id].groupId, browser.groupId);
  assert.equal(browser.tabId, tab.id);
});

test('a tab opened for reading closes when the next one opens, and the tab the task started on stays', async () => {
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null });
  await browser.startOn();
  const first = await browser.openTab('https://c.test');
  assert.equal(browser.takeClosedNote(), '', 'leaving the starting tab does not close it');
  assert.ok(tabs[1], 'the tab the task started on is still open');

  const second = await browser.openTab('https://d.test');
  assert.equal(tabs[first.id], undefined, 'the page just read is closed');
  assert.equal(browser.takeClosedNote(), ` Closed tab ${first.id} after reading it.`);
  assert.ok(tabs[1]);
  assert.equal(tabs[second.id].groupId, browser.groupId);

  await browser.useTab(2);
  assert.ok(tabs[2], 'a tab the user already had is not closed');
  assert.equal(tabs[second.id], undefined, 'leaving the research tab closes it');

  const third = await browser.openTab('https://e.test');
  await browser.closeDisposableTabs();
  assert.equal(tabs[third.id], undefined, 'research tabs close when the task ends');
  assert.ok(tabs[1]);
  assert.ok(tabs[2]);
});

test('when the group is gone (all its tabs closed) the next claim makes a new one', async () => {
  const browser = new BrowserController({ title: 'Mine', isTakenByOther: () => null });
  await browser.startOn();
  delete groups[100];
  await browser.useTab(2);
  assert.equal(tabs[2].groupId, 101);
  assert.equal(groups[101].title, 'Mine');
});

test('the voice path may not take a tab while a session is grouping it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const realGroup = chrome.tabs.group;
  chrome.tabs.group = async (options) => { await gate; return realGroup(options); };
  try {
    const browser = new BrowserController({
      title: 'Mine',
      isTakenByOther: () => null,
      reservation: claims.tabReservation({ sessionId: 'session-a', controllerId: 'session-a', owner: 'Mine' }),
    });
    const pending = browser.startOn();
    // The grouping is under way: the tab is reserved, and the voice path may
    // not take it while the session is taking it.
    await new Promise((resolve) => setImmediate(resolve));
    const voice = claims.claimTab(1, { panelId: 'panel-a', sessionId: 'session-b' });
    assert.equal(voice.ok, false, 'the voice path is refused while the tab is being grouped');
    assert.equal(voice.owner, 'Mine');

    release();
    await pending;

    // The group is published now: the ordinary ownership holds the tab, and
    // the reservation is over.
    assert.equal(claims.claimOf(1), null, 'the reservation is given back once the group is published');
    assert.equal(tabs[1].groupId, browser.groupId, 'the tab belongs to the group of the session');
  } finally {
    chrome.tabs.group = realGroup;
  }
});

test('a tab that is reserved is not free for a regular task either', async () => {
  const reserved = claims.reserveTab(9, { sessionId: 'session-a', controllerId: 'session-a', owner: 'Mine' });
  assert.equal(reserved.ok, true);
  assert.equal(claims.holderOf(9), 'Mine', 'the tab is busy');
  assert.equal(claims.claimTab(9, { panelId: 'panel-a', sessionId: 'session-b' }).ok, false, 'the voice path may not take it');
  assert.equal(claims.releaseReservation(9, reserved.token), true);
  assert.equal(claims.holderOf(9), null, 'the tab is free again');
});
