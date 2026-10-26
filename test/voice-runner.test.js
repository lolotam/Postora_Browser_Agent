import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFastCommand } from '../src/voice/voice-runner.js';
import { approvalText } from '../src/voice/voice-approval.js';
import { candidateSpans } from '../src/voice/voice-brain.js';
import { createFastAsk } from '../src/fast/clients.js';
import { createChromeBrowser } from '../src/voice/voice-browser.js';

// What the page scripts answer when the runner asks them. The page is only
// read: a click, a keystroke and Enter are real input, sent as input steps.
const CLICK_ELEMENTS = [{ id: '1', kind: 'button', label: 'Sign in', href: null, inView: true, top: 0, left: 0, secret: false }];
const TYPE_FIELDS = [{ id: '2', kind: 'text input', label: 'Search', href: null, inView: true, top: 0, left: 0, secret: false }];

const PAGE_ANSWERS = {
  scrollPage: () => ({ ok: true }),
  mediaControl: () => ({ ok: true, state: 'playing' }),
  findText: () => ({ ok: true }),
};

/** The answer of the one page script that knows about secrets. */
function pageAnswer(kind, arg) {
  if (kind === 'collect') return arg?.purpose === 'type' ? TYPE_FIELDS : CLICK_ELEMENTS;
  if (kind === 'focused') return { editable: false, secret: false };
  if (kind === 'locate') return { ok: true, x: 12, y: 24, rect: { left: 2, top: 14, width: 20, height: 20 }, secret: false };
  return { ok: true };
}

const choice = (picked, probabilities = { [picked]: 0.95 }, confidence = 0.9) => ({ type: 'choice', choice: picked, confidence, probabilities });

/** An ask that answers by question name; an answer may be a function of the question. */
function scriptedAsk(answers) {
  const seen = [];
  const ask = async ({ state, questions }) => {
    seen.push({ state, questions });
    const out = {};
    for (const [name, question] of Object.entries(questions)) {
      const answer = answers[name];
      out[name] = typeof answer === 'function' ? answer(question, state) : answer;
    }
    return { answers: out, model: 'mock-model' };
  };
  ask.seen = seen;
  return ask;
}

/** The first span of the command, which is what the argument question offers first. */
const firstSpan = (question) => choice(Object.keys(question.criteria).find((key) => key !== 'none'));

function mockBrowser(overrides = {}) {
  const tabs = [
    { id: 1, windowId: 7, url: 'https://example.test/', title: 'Example', active: true },
    { id: 2, windowId: 7, url: 'https://secret.test/inbox', title: 'Private', active: false },
  ];
  const calls = [];
  const claims = [];
  const released = [];
  // The order of what happened, so a test can see that one thing came before
  // another one.
  const order = [];
  const browser = {
    calls,
    claims,
    released,
    order,
    tabs,
    async currentTab() { return tabs[0]; },
    async tabsInWindow() { return tabs; },
    async getTab(id) { return tabs.find((tab) => tab.id === id); },
    async openTab({ url, windowId }) {
      const tab = { id: 3, windowId, url: url || 'about:blank', title: 'New', active: true };
      tabs.push(tab);
      calls.push(['openTab', tab.id]);
      order.push(`openTab:${tab.id}`);
      return tab;
    },
    async updateTab(id, changes) {
      calls.push(['updateTab', id, changes]);
      Object.assign(tabs.find((tab) => tab.id === id) ?? {}, changes);
    },
    async activateTab(id) { calls.push(['activateTab', id]); order.push(`activateTab:${id}`); },
    async bindSession(id) { calls.push(['bindSession', id]); order.push(`bindSession:${id}`); return { ok: true }; },
    async removeTab(id) { calls.push(['removeTab', id]); },
    async goBack(id) { calls.push(['goBack', id]); },
    async goForward(id) { calls.push(['goForward', id]); },
    async reload(id) { calls.push(['reload', id]); },
    async getZoom() { return 1; },
    async setZoom(id, level) { calls.push(['setZoom', id, level]); },
    async inject(tabId, func, args = []) {
      calls.push(['inject', tabId, func.name, args]);
      order.push('inject');
      if (func.name === 'pageProbe') return pageAnswer(args[0], args[1]);
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
    async input(tabId, steps) { calls.push(['input', tabId, steps]); return { ok: true }; },
    async waitForLoad(tabId) { calls.push(['waitForLoad', tabId]); },
    async ownerOf() { return null; },
    async claim(tabId) { claims.push(tabId); order.push(`claim:${tabId}`); return { ok: true }; },
    async release(tabId) { released.push(tabId); },
  };
  return Object.assign(browser, overrides);
}

test('abort revokes every claimed tab before waiting for queued debugger cleanup', { timeout: 3000 }, async () => {
  const browser = mockBrowser();
  const abort = new AbortController();
  let inputStarted;
  let finishInput;
  let finishFirstRelease;
  const started = new Promise((resolve) => { inputStarted = resolve; });
  const firstReleased = new Promise((resolve) => { finishFirstRelease = resolve; });
  browser.input = async () => {
    inputStarted();
    await new Promise((resolve) => { finishInput = resolve; });
    return { ok: true };
  };
  browser.release = async (id) => {
    browser.released.push(id);
    if (id === 1) await firstReleased;
    if (id === 3) {
      finishFirstRelease();
      finishInput();
    }
  };
  const ask = scriptedAsk({
    split_0: { type: 'noul', noul: 0.99 },
    action: (_question, state) => choice(state.spoken_command.startsWith('open') ? 'new_tab' : 'click'),
    argument: firstSpan, site: choice('none'), element: choice('e0'),
  });
  const pending = runFastCommand({ ask, browser, command: 'open new tab and click sign in', approve: async () => true, signal: abort.signal });
  await started;
  abort.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.deepEqual(browser.released, [1, 3], 'both leases are revoked even if the first detach is still queued');
});

test('a chained tab switch retains its final target after a following scroll', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({
    split_0: { type: 'noul', noul: 0.99 },
    action: (_question, state) => choice(state.spoken_command.startsWith('switch') ? 'switch_tab' : 'scroll_down'),
    argument: firstSpan, site: choice('none'), tab: choice('t1'),
  });
  const result = await runFastCommand({ ask, browser, command: 'switch to Private and scroll down', approve: async () => true });
  assert.equal(result.ok, true);
  assert.equal(result.target.id, 2, 'the panel can persist the new target across later utterances');
});

const approves = (answer = true) => {
  const asked = [];
  const approve = async (what) => { asked.push(what); return answer; };
  approve.asked = asked;
  return approve;
};

// The runner speaks in message keys; the panel turns them into sentences.
const t = (key) => key;

test('a click that navigates refreshes the pinned context before a chained search', async () => {
  const browser = mockBrowser();
  browser.inject = async (tabId, func, args = []) => {
    browser.calls.push(['inject', tabId, func.name, args]);
    if (func.name === 'pageProbe') return pageAnswer(args[0], args[1]);
    return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
  };
  // The click is real input: the page it lands on is the one the next step
  // reads.
  browser.input = async (tabId, steps) => {
    browser.calls.push(['input', tabId, steps]);
    browser.tabs[0].url = 'https://www.youtube.com/';
    return { ok: true };
  };
  // Return copies like Chrome does, rather than sharing mutable tab objects.
  browser.currentTab = async () => ({ ...browser.tabs[0] });
  browser.getTab = async (id) => ({ ...browser.tabs.find((tab) => tab.id === id) });
  const ask = scriptedAsk({
    split_0: { type: 'noul', noul: 0.99 },
    action: (_question, state) => choice(state.spoken_command.startsWith('click') ? 'click' : 'web_search'),
    argument: firstSpan,
    site: choice('current_site'),
    element: choice('e0'),
  });
  await runFastCommand({ ask, browser, command: 'click YouTube and search cats', approve: approves(true), t });
  assert.ok(browser.calls.some(([kind, id, changes]) => kind === 'updateTab' && id === 1 && changes.url.includes('youtube.com/results')));
  assert.equal(ask.seen.filter((req) => req.questions.action).at(-1).state.current_tab.url, 'https://www.youtube.com/');
});

test('an explicitly unavailable pinned target never falls back to another active tab', async () => {
  const saved = globalThis.chrome;
  let queries = 0;
  globalThis.chrome = { tabs: { query: async () => { queries += 1; return [{ id: 99, url: 'https://other.test/' }]; } } };
  try {
    const browser = createChromeBrowser({ target: async () => null });
    assert.equal(await browser.currentTab(), null);
    assert.equal(queries, 0);
  } finally {
    globalThis.chrome = saved;
  }
});

test('a click asks the user first, and nothing happens when the answer is no', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('click'), argument: firstSpan, element: choice('e0') });
  const approve = approves(false);

  const result = await runFastCommand({ ask, browser, command: 'click sign in', approve, secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayCancelled');
  assert.equal(approve.asked.length, 1);
  assert.equal(approve.asked[0].action, 'click');
  assert.equal(browser.calls.filter((call) => call[0] === 'inject').length, 1, 'only the elements were read');
  assert.equal(browser.calls.some((call) => call[0] === 'input'), false, 'nothing was clicked');
});

test('a click runs on the tab the command started on once the user says yes', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('click'), argument: firstSpan, element: choice('e0') });

  const result = await runFastCommand({ ask, browser, command: 'click sign in', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, true);
  const click = browser.calls.find((call) => call[0] === 'input');
  assert.equal(click[1], 1, 'the click lands on the tab the command started on');
  assert.deepEqual(click[2], [{ op: 'click', x: 12, y: 24 }], 'the click is real input at the place of the element');
});

test('a command that is cancelled while it waits for the user does not click', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('click'), argument: firstSpan, element: choice('e0') });
  const controller = new AbortController();
  const approve = async () => {
    controller.abort();
    return true;
  };

  const result = await runFastCommand({ ask, browser, command: 'click sign in', approve, signal: controller.signal, secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayCancelled');
  assert.equal(browser.calls.some((call) => call[0] === 'input'), false, 'nothing was clicked');
});

test('a command that was cancelled while the model was thinking changes nothing', async () => {
  const browser = mockBrowser();
  const controller = new AbortController();
  const ask = scriptedAsk({
    action: (question, state) => {
      controller.abort(); // the user cancels while the model is still answering
      return choice('scroll_down');
    },
    argument: firstSpan,
    site: choice('none'),
  });

  const result = await runFastCommand({ ask, browser, command: 'scroll down', approve: approves(true), signal: controller.signal, secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(browser.calls.length, 0);
});

test('a malformed answer is refused and nothing happens', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: undefined, argument: firstSpan, element: choice('e0') });

  const result = await runFastCommand({ ask, browser, command: 'click sign in', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayUnclear');
  assert.equal(browser.calls.length, 0);
});

test('an answer that is not confident enough is refused', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: { type: 'choice', choice: 'click', confidence: 0.05, probabilities: { click: 0.05 } }, argument: firstSpan, element: choice('e0') });

  const result = await runFastCommand({ ask, browser, command: 'click sign in', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(browser.calls.length, 0);
});

test('an action that was never offered is refused', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('fly'), argument: firstSpan, element: choice('e0') });

  const result = await runFastCommand({ ask, browser, command: 'fly away', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(browser.calls.length, 0);
});

test('a decision that contradicts itself is refused', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: { type: 'choice', choice: 'click', confidence: 0.9, probabilities: { click: 0.2, scroll_down: 0.8 } }, argument: firstSpan, element: choice('e0') });

  const result = await runFastCommand({ ask, browser, command: 'click sign in', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(browser.calls.length, 0);
});

test('the other tabs are named by their title only, never by their address', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('scroll_down'), argument: firstSpan, site: choice('none') });

  await runFastCommand({ ask, browser, command: 'scroll down', approve: approves(true), secretTokens: ['password'], t });

  const state = ask.seen[0].state;
  assert.match(state.open_tabs[0], /Example/);
  assert.doesNotMatch(JSON.stringify(state), /secret\.test/);
});

test('a tab another session is working in is refused', async () => {
  const browser = mockBrowser({ ownerOf: async () => 'another session' });
  const ask = scriptedAsk({ action: choice('scroll_down'), argument: firstSpan, site: choice('none') });

  const result = await runFastCommand({ ask, browser, command: 'scroll down', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayTabTaken');
  assert.equal(browser.calls.length, 0);
});

test('a tab that cannot be checked is not acted on', async () => {
  const browser = mockBrowser({ ownerOf: async () => { throw new Error('the worker cannot answer'); } });
  const ask = scriptedAsk({ action: choice('scroll_down'), argument: firstSpan, site: choice('none') });

  const result = await runFastCommand({ ask, browser, command: 'scroll down', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayOwnerUnknown');
  assert.equal(browser.calls.length, 0);
});

test('a named tab that belongs to another session is not closed', async () => {
  const browser = mockBrowser({ ownerOf: async (id) => (id === 2 ? 'busy-session' : null) });
  const ask = scriptedAsk({ action: choice('close_tab'), argument: firstSpan, tab: choice('t1') });

  const result = await runFastCommand({ ask, browser, command: 'close the other tab', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayTabTaken');
  assert.equal(browser.calls.some((call) => call[0] === 'removeTab'), false, 'the other session keeps its tab');
});

test('a tab whose owner changed while the question was open is not closed', async () => {
  let asked = false;
  const browser = mockBrowser({
    ownerOf: async (id) => {
      // The tab is free when the question opens and taken when it is answered.
      if (asked) return 'busy-session';
      asked = true;
      return null;
    },
  });
  const ask = scriptedAsk({ action: choice('close_tab'), argument: firstSpan, tab: choice('t1') });

  const result = await runFastCommand({ ask, browser, command: 'close the other tab', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayTabTaken');
  assert.equal(browser.calls.some((call) => call[0] === 'removeTab'), false);
});

test('a tab that could not be named is not closed, and the open tab is not closed either', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({
    action: choice('close_tab'),
    argument: firstSpan,
    tab: { type: 'choice', choice: 'none', confidence: 0.05 }, // not sure enough
  });

  const result = await runFastCommand({ ask, browser, command: 'close the other tab', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayNoTabMeaning');
  assert.equal(browser.calls.some((call) => call[0] === 'removeTab'), false);
});

test('the tab that is zoomed is checked again right before the change', async () => {
  const checks = [];
  const browser = mockBrowser({
    ownerOf: async (id) => { checks.push(id); return null; },
    getZoom: async () => { checks.push('zoom'); return 1; },
  });
  const ask = scriptedAsk({ action: choice('zoom_in'), argument: firstSpan, site: choice('none') });

  await runFastCommand({ ask, browser, command: 'zoom in', approve: approves(true), secretTokens: ['password'], t });

  assert.ok(checks.indexOf(1) < checks.indexOf('zoom'), 'the tab is checked before it is read');
  assert.ok(checks.indexOf('zoom') < checks.lastIndexOf(1), 'the tab is checked again before it is changed');
  assert.ok(browser.calls.some((call) => call[0] === 'setZoom'));
});

test('the tab that is switched to is checked before it is made active', async () => {
  const browser = mockBrowser({ ownerOf: async (id) => (id === 2 ? 'busy-session' : null) });
  const ask = scriptedAsk({ action: choice('switch_tab'), argument: firstSpan, tab: choice('t1') });

  const result = await runFastCommand({ ask, browser, command: 'switch to the other tab', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(browser.calls.some((call) => call[0] === 'activateTab'), false, 'the tab of another session is left alone');
});

test('a tab that changes hands while the model is thinking is not acted on', async () => {
  let checks = 0;
  const browser = mockBrowser({
    ownerOf: async () => {
      checks += 1;
      return checks > 1 ? 'busy-session' : null; // it changes hands after the first check
    },
  });
  const ask = scriptedAsk({ action: choice('scroll_down'), argument: firstSpan, site: choice('none') });

  const result = await runFastCommand({ ask, browser, command: 'scroll down', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayTabTaken');
  assert.equal(browser.calls.length, 0, 'the tab was not touched');
});

test('a field that holds a secret is never typed into', async () => {
  const browser = mockBrowser({
    inject: async (tabId, func, args = []) => {
      browser.calls.push(['inject', tabId, func.name, args]);
      if (func.name === 'pageProbe' && args[0] === 'collect') {
        return [{ id: '1', kind: 'password input', label: 'Password', href: null, inView: true, top: 0, left: 0, secret: true }];
      }
      if (func.name === 'pageProbe') return pageAnswer(args[0], args[1]);
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
  });
  const ask = scriptedAsk({ action: choice('type_text'), argument: firstSpan, element: choice('e0'), submit: { type: 'noul', noul: 0.9 } });

  const result = await runFastCommand({ ask, browser, command: 'type hello', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.saySecretField');
  assert.equal(browser.calls.some((call) => call[0] === 'input'), false);
});

test('a field that has the focus and holds a secret is refused, not written into some other field', async () => {
  const browser = mockBrowser({
    inject: async (tabId, func, args = []) => {
      browser.calls.push(['inject', tabId, func.name, args]);
      if (func.name === 'pageProbe' && args[0] === 'focused') return { editable: true, secret: true };
      if (func.name === 'pageProbe') return pageAnswer(args[0], args[1]);
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
  });
  const ask = scriptedAsk({ action: choice('type_text'), argument: firstSpan, submit: { type: 'noul', noul: 0.9 } });

  const result = await runFastCommand({ ask, browser, command: 'type hello', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.saySecretField');
  assert.equal(browser.calls.some((call) => call[0] === 'input'), false, 'the text did not go into another field');
});

test('Enter is refused in a field that holds a secret, and a refusal by the page is reported', async () => {
  const secretBrowser = mockBrowser({
    inject: async (tabId, func, args = []) => {
      secretBrowser.calls.push(['inject', tabId, func.name, args]);
      if (func.name === 'pageProbe' && args[0] === 'focused') return { editable: true, secret: true };
      if (func.name === 'pageProbe') return pageAnswer(args[0], args[1]);
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
  });
  const ask = scriptedAsk({ action: choice('press_enter'), argument: firstSpan });
  const refused = await runFastCommand({ ask, browser: secretBrowser, command: 'press enter', approve: approves(true), secretTokens: ['password'], t });
  assert.equal(refused.ok, false);
  assert.equal(refused.say, 'voice.saySecretField');
  assert.equal(secretBrowser.calls.some((call) => call[0] === 'input'), false);

  // The target is looked at again right before the key is pressed: a field
  // that turned secret in the meantime is left alone, and the page says why.
  const pageRefuses = mockBrowser({
    inject: async (tabId, func, args = []) => {
      pageRefuses.calls.push(['inject', tabId, func.name, args]);
      if (func.name === 'pageProbe' && args[0] === 'locate') return { ok: false, errorKey: 'voice.pageSecret' };
      if (func.name === 'pageProbe') return pageAnswer(args[0], args[1]);
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
  });
  const again = await runFastCommand({ ask, browser: pageRefuses, command: 'press enter', approve: approves(true), secretTokens: ['password'], t });
  assert.equal(again.ok, false);
  assert.equal(again.say, 'voice.pageSecret', 'the refusal of the page is reported');
  assert.equal(pageRefuses.calls.some((call) => call[0] === 'input'), false);
});

test('the approval says what is written and whether it is sent', () => {
  const translate = (key, params) => `${key}:${JSON.stringify(params)}`;
  assert.match(approvalText({ action: 'type_text', label: 'Search', text: 'hello', submit: false }, translate), /voice\.approveType/);
  assert.match(approvalText({ action: 'type_text', label: 'Search', text: 'hello', submit: true }, translate), /voice\.approveTypeSubmit/);
  assert.match(approvalText({ action: 'type_text', label: 'Search', text: 'hello', submit: true }, translate), /hello/);
  assert.match(approvalText({ action: 'click', label: 'Sign in' }, translate), /voice\.approveClick/);
  assert.match(approvalText({ action: 'press_enter', label: 'the field' }, translate), /voice\.approveEnter/);
  assert.match(approvalText({ action: 'close_tab', label: 'Private' }, translate), /voice\.approveClose/);
});

test('the runner asks for the approval with the text and the submit', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('type_text'), argument: firstSpan, element: choice('e0'), submit: { type: 'noul', noul: 0.9 } });
  const approve = approves(true);

  await runFastCommand({ ask, browser, command: 'type hello world', approve, secretTokens: ['password'], t });

  assert.equal(approve.asked.length, 1);
  assert.equal(approve.asked[0].action, 'type_text');
  assert.equal(approve.asked[0].text, 'type hello world');
  assert.equal(approve.asked[0].submit, true);
});

test('a chained command keeps one tab, and a new tab becomes the target of the next step', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({
    split_0: { type: 'noul', noul: 0.9 },
    action: (question, state) => (state.spoken_command.includes('new tab') ? choice('new_tab') : choice('scroll_down')),
    argument: firstSpan,
    site: choice('none'),
  });

  const result = await runFastCommand({ ask, browser, command: 'open youtube in a new tab and scroll down', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, true);
  const opened = browser.calls.find((call) => call[0] === 'openTab');
  assert.ok(opened, 'the first step opened a tab');
  const scrolled = browser.calls.find((call) => call[2] === 'scrollPage');
  assert.equal(scrolled[1], opened[1], 'the second step ran in the tab that was opened');
});

test('a step that navigates tells the next step where it is', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({
    split_0: { type: 'noul', noul: 0.9 },
    action: (question, state) => (state.spoken_command.startsWith('open') ? choice('navigate') : choice('web_search')),
    argument: firstSpan,
    site: (question, state) => choice(state.spoken_command.startsWith('open') ? 'youtube' : 'current_site'),
  });

  await runFastCommand({ ask, browser, command: 'open youtube and search cats', approve: approves(true), secretTokens: ['password'], t });

  const navigations = browser.calls.filter((call) => call[0] === 'updateTab');
  assert.equal(navigations.length, 2);
  assert.match(navigations[0][2].url, /youtube\.com/);
  assert.match(navigations[1][2].url, /youtube\.com\/results/, 'the second step searched on the site it was on');
  const second = ask.seen[ask.seen.length - 1].state;
  assert.match(second.current_tab.url, /youtube\.com/);
});

test('the tab list of the next step holds the tab that was opened', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({
    split_0: { type: 'noul', noul: 0.9 },
    action: (question, state) => (state.spoken_command.startsWith('open') ? choice('new_tab') : choice('scroll_down')),
    argument: firstSpan,
    site: choice('none'),
  });

  await runFastCommand({ ask, browser, command: 'open youtube in a new tab and scroll down', approve: approves(true), secretTokens: ['password'], t });

  const second = ask.seen[ask.seen.length - 1].state;
  assert.equal(second.open_tabs.length, 3, 'the tab that was opened is in the list');
});

test('the next tab is taken from the tab the command is on', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('next_tab'), argument: firstSpan, site: choice('none') });

  const result = await runFastCommand({ ask, browser, command: 'next tab', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, true);
  const switched = browser.calls.find((call) => call[0] === 'activateTab');
  assert.equal(switched[1], 2, 'the tab after the one the command was on');
});

test('the fast ask goes to the configured provider, model and endpoint', async () => {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/chat/completions')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: { probabilities: { scroll_down: 0.9 } } }) } }] }),
        text: async () => '',
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers: { action: choice('scroll_down') } }),
      text: async () => '',
    };
  };
  try {
    const ask = createFastAsk({ provider: 'typesafe', baseUrl: 'https://api.typesafe.ai', apiKey: 'k', model: 'jev-latest' });
    await ask({ state: {}, questions: { action: { type: 'choice', instructions: 'x', criteria: { scroll_down: 's' } } } });
    assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.match(calls[0].options.body, /"model":"jev-latest"/);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer k');

    calls.length = 0;
    const gateway = createFastAsk({ provider: 'vercel', decision: true, baseUrl: 'https://gateway.test/v1', apiKey: 'g', model: 'typesafe-ai/jev' });
    await gateway({ state: {}, questions: { action: { type: 'choice', instructions: 'x', criteria: { scroll_down: 's' } } } });
    assert.equal(calls[0].url, 'https://gateway.test/v4/ai/decision-model');
    assert.equal(calls[0].options.headers['ai-model-id'], 'typesafe-ai/jev');

    calls.length = 0;
    const chat = createFastAsk({ provider: 'custom', baseUrl: 'https://chat.test/v1', apiKey: 'c', model: 'mock-judge' });
    await chat({ state: {}, questions: { action: { type: 'choice', instructions: 'x', criteria: { scroll_down: 's' } } } });
    assert.equal(calls[0].url, 'https://chat.test/v1/chat/completions');
    assert.match(calls[0].options.body, /"model":"mock-judge"/);
  } finally {
    globalThis.fetch = saved;
  }
});

test('a failing fast provider falls back to the configured backup provider', async () => {  const calls = [];
  const notices = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('primary')) return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ answers: { action: choice('scroll_down') } }), text: async () => '' };
  };
  try {
    const ask = createFastAsk({
      provider: 'typesafe',
      baseUrl: 'https://primary.test',
      apiKey: 'k',
      model: 'jev-latest',
      fallback: { enabled: true, provider: 'vercel', decision: true, baseUrl: 'https://backup.test', apiKey: 'k2', model: 'typesafe-ai/jev' },
    }, (notice) => notices.push(notice));
    const reply = await ask({ state: {}, questions: { action: { type: 'choice', instructions: 'x', criteria: { scroll_down: 's' } } } });
    assert.equal(reply.answers.action.choice, 'scroll_down');
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /backup\.test/);
    assert.equal(notices.length, 1, 'the switch to the backup is reported');
  } finally {
    globalThis.fetch = saved;
  }
});

test('the page is only read after the claim on the tab is taken', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('click'), argument: firstSpan, element: choice('e0') });

  await runFastCommand({ ask, browser, command: 'click sign in', approve: approves(true), secretTokens: ['password'], t });

  assert.ok(browser.claims.includes(1), 'the tab was claimed');
  assert.ok(browser.order.indexOf('claim:1') < browser.order.indexOf('inject'), 'the claim came before the page was read');
});

test('a tab another panel holds is refused, and nothing is read from it', async () => {
  const browser = mockBrowser({ claim: async () => ({ ok: false, owner: 'voice control' }) });
  const ask = scriptedAsk({ action: choice('click'), argument: firstSpan, element: choice('e0') });

  const result = await runFastCommand({ ask, browser, command: 'click sign in', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayTabTaken');
  assert.equal(browser.calls.some((call) => call[0] === 'inject'), false, 'the page was not read');
});

test('a claim that cannot be taken fails closed', async () => {
  const browser = mockBrowser({ claim: async () => { throw new Error('the worker cannot answer'); } });
  const ask = scriptedAsk({ action: choice('scroll_down'), argument: firstSpan, site: choice('none') });

  const result = await runFastCommand({ ask, browser, command: 'scroll down', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.sayOwnerUnknown');
  assert.equal(browser.calls.length, 0, 'nothing was touched');
});

test('the claim is given back when the command ends, and when it is cancelled', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('scroll_down'), argument: firstSpan, site: choice('none') });

  await runFastCommand({ ask, browser, command: 'scroll down', approve: approves(true), secretTokens: ['password'], t });
  assert.deepEqual(browser.released, [1]);

  const cancelled = mockBrowser();
  const controller = new AbortController();
  const ask2 = scriptedAsk({
    action: () => { controller.abort(); return choice('scroll_down'); },
    argument: firstSpan,
    site: choice('none'),
  });
  await runFastCommand({ ask: ask2, browser: cancelled, command: 'scroll down', approve: approves(true), signal: controller.signal, secretTokens: ['password'], t });
  assert.deepEqual(cancelled.released, [1], 'a cancelled command gives the claim back');
});

test('a command that names a field does not type into the field that has the focus', async () => {
  const browser = mockBrowser({
    inject: async (tabId, func, args = []) => {
      browser.calls.push(['inject', tabId, func.name, args]);
      if (func.name === 'pageProbe' && args[0] === 'collect') {
        return [
          { id: '1', kind: 'text input', label: 'Search', href: null, inView: true, top: 0, left: 0, secret: false, focused: true },
          { id: '2', kind: 'text input', label: 'Email', href: null, inView: true, top: 20, left: 0, secret: false, focused: false },
        ];
      }
      if (func.name === 'pageProbe' && args[0] === 'focused') return { editable: true, secret: false };
      if (func.name === 'pageProbe') return pageAnswer(args[0], args[1]);
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
  });
  const command = 'type my address in the email field';
  const span = candidateSpans(command).indexOf('my address');
  const ask = scriptedAsk({
    action: choice('type_text'),
    argument: choice(`s${span}`),
    element: choice('e1'),
    submit: { type: 'noul', noul: 0.2 },
  });
  const approve = approves(true);

  const result = await runFastCommand({ ask, browser, command, approve, secretTokens: ['password'], t });

  assert.equal(result.ok, true);
  assert.equal(approve.asked[0].label, 'Email', 'the field the command named was used');
  const input = browser.calls.find((call) => call[0] === 'input');
  assert.ok(input, 'the text was typed');
  assert.equal(input[2][2].text, 'my address', 'the text is exactly the span that was chosen');
});

test('a tab that is opened is claimed and bound before it is shown', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('new_tab'), argument: firstSpan, site: choice('none') });

  await runFastCommand({ ask, browser, command: 'open a new tab', approve: approves(true), secretTokens: ['password'], t });

  const shown = browser.order.indexOf('activateTab:3');
  assert.ok(shown > 0, 'the tab was shown');
  assert.ok(browser.order.indexOf('claim:3') < shown, 'the tab was claimed before it was shown');
  assert.ok(browser.order.indexOf('bindSession:3') < shown, 'the tab was bound before it was shown');
});

test('closing the tab the command is on ends the chain, and no other tab is taken up', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({
    split_0: { type: 'noul', noul: 0.9 },
    action: (question, state) => (state.spoken_command.startsWith('close') ? choice('close_tab') : choice('scroll_down')),
    argument: firstSpan,
    site: choice('none'),
    tab: choice('none'),
  });

  const result = await runFastCommand({ ask, browser, command: 'close this tab and scroll down', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, true);
  assert.equal(result.closedTarget, true, 'the tab the command was on is gone');
  assert.equal(browser.calls.some((call) => call[2] === 'scrollPage'), false, 'the chain stopped');
});

test('closing another tab lets the chain go on', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({
    split_0: { type: 'noul', noul: 0.9 },
    action: (question, state) => (state.spoken_command.startsWith('close') ? choice('close_tab') : choice('scroll_down')),
    argument: firstSpan,
    site: choice('none'),
    tab: choice('t1'),
  });
  const events = [];

  const result = await runFastCommand({ ask, browser, command: 'close the other tab and scroll down', approve: approves(true), emit: (event) => events.push(event), secretTokens: ['password'], t });

  assert.equal(result.ok, true);
  const closed = events.find((event) => event.kind === 'result' && event.action === 'close_tab');
  assert.equal(closed.closedTarget, false, 'the tab the command was on is still there');
  assert.ok(browser.calls.some((call) => call[2] === 'scrollPage'), 'the chain went on in the tab it was on');
});

test('a tab that is gone ends the chain, and no other tab is looked at', async () => {
  const browser = mockBrowser({
    getTab: async () => { throw new Error('No tab with id: 1.'); },
  });
  const ask = scriptedAsk({ action: choice('scroll_down'), argument: firstSpan, site: choice('none') });

  const result = await runFastCommand({ ask, browser, command: 'scroll down', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.closedTarget, true);
  assert.equal(browser.calls.some((call) => call[0] === 'inject'), false, 'no other tab was read');
});
