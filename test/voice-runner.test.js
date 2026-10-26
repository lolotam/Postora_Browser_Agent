import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFastCommand } from '../src/voice/voice-runner.js';
import { approvalText } from '../src/voice/voice-approval.js';
import { createFastAsk } from '../src/fast/clients.js';
import { createChromeBrowser } from '../src/voice/voice-browser.js';

// What the page scripts answer when the runner asks them.
const PAGE_ANSWERS = {
  collectElements: () => [{ id: '1', kind: 'button', label: 'Sign in', href: null, inView: true, top: 0, left: 0, secret: false }],
  focusedIsEditable: () => ({ editable: false, secret: false }),
  clickElement: () => ({ ok: true }),
  typeInto: () => ({ ok: true }),
  pressEnter: () => ({ ok: true }),
  scrollPage: () => ({ ok: true }),
  mediaControl: () => ({ ok: true, state: 'playing' }),
  findText: () => ({ ok: true }),
};

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
  const browser = {
    calls,
    tabs,
    async currentTab() { return tabs[0]; },
    async tabsInWindow() { return tabs; },
    async getTab(id) { return tabs.find((tab) => tab.id === id); },
    async openTab({ url, windowId }) {
      const tab = { id: 3, windowId, url: url || 'about:blank', title: 'New', active: true };
      tabs.push(tab);
      calls.push(['openTab', tab.id]);
      return tab;
    },
    async updateTab(id, changes) {
      calls.push(['updateTab', id, changes]);
      Object.assign(tabs.find((tab) => tab.id === id) ?? {}, changes);
    },
    async removeTab(id) { calls.push(['removeTab', id]); },
    async goBack(id) { calls.push(['goBack', id]); },
    async goForward(id) { calls.push(['goForward', id]); },
    async reload(id) { calls.push(['reload', id]); },
    async getZoom() { return 1; },
    async setZoom(id, level) { calls.push(['setZoom', id, level]); },
    async inject(tabId, func, args = []) {
      calls.push(['inject', tabId, func.name, args]);
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
    async waitForLoad(tabId) { calls.push(['waitForLoad', tabId]); },
    async ownerOf() { return null; },
  };
  return Object.assign(browser, overrides);
}

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
    if (func.name === 'clickElement') browser.tabs[0].url = 'https://www.youtube.com/';
    return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
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
});

test('a click runs on the tab the command started on once the user says yes', async () => {
  const browser = mockBrowser();
  const ask = scriptedAsk({ action: choice('click'), argument: firstSpan, element: choice('e0') });

  const result = await runFastCommand({ ask, browser, command: 'click sign in', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, true);
  const click = browser.calls.find((call) => call[2] === 'clickElement');
  assert.equal(click[1], 1, 'the click lands on the tab the command started on');
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
  assert.equal(browser.calls.some((call) => call[2] === 'clickElement'), false);
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
  assert.equal(browser.calls.some((call) => call[0] === 'updateTab'), false, 'the tab of another session is left alone');
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
      if (func.name === 'collectElements') return [{ id: '1', kind: 'password input', label: 'Password', href: null, inView: true, top: 0, left: 0, secret: true }];
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
  });
  const ask = scriptedAsk({ action: choice('type_text'), argument: firstSpan, element: choice('e0'), submit: { type: 'noul', noul: 0.9 } });

  const result = await runFastCommand({ ask, browser, command: 'type hello', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.saySecretField');
  assert.equal(browser.calls.some((call) => call[2] === 'typeInto'), false);
});

test('a field that has the focus and holds a secret is refused, not written into some other field', async () => {
  const browser = mockBrowser({
    inject: async (tabId, func, args = []) => {
      browser.calls.push(['inject', tabId, func.name, args]);
      if (func.name === 'focusedIsEditable') return { editable: true, secret: true };
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
  });
  const ask = scriptedAsk({ action: choice('type_text'), argument: firstSpan, submit: { type: 'noul', noul: 0.9 } });

  const result = await runFastCommand({ ask, browser, command: 'type hello', approve: approves(true), secretTokens: ['password'], t });

  assert.equal(result.ok, false);
  assert.equal(result.say, 'voice.saySecretField');
  assert.equal(browser.calls.some((call) => call[2] === 'typeInto'), false, 'the text did not go into another field');
});

test('Enter is refused in a field that holds a secret, and a refusal by the page is reported', async () => {
  const secretBrowser = mockBrowser({
    inject: async (tabId, func, args = []) => {
      secretBrowser.calls.push(['inject', tabId, func.name, args]);
      if (func.name === 'focusedIsEditable') return { editable: true, secret: true };
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
  });
  const ask = scriptedAsk({ action: choice('press_enter'), argument: firstSpan });
  const refused = await runFastCommand({ ask, browser: secretBrowser, command: 'press enter', approve: approves(true), secretTokens: ['password'], t });
  assert.equal(refused.ok, false);
  assert.equal(refused.say, 'voice.saySecretField');
  assert.equal(secretBrowser.calls.some((call) => call[2] === 'pressEnter'), false);

  const pageRefuses = mockBrowser({
    inject: async (tabId, func, args = []) => {
      pageRefuses.calls.push(['inject', tabId, func.name, args]);
      if (func.name === 'pressEnter') return { ok: false, errorKey: 'voice.pageSecret' };
      return (PAGE_ANSWERS[func.name] ?? (() => ({ ok: true })))(args);
    },
  });
  const again = await runFastCommand({ ask, browser: pageRefuses, command: 'press enter', approve: approves(true), secretTokens: ['password'], t });
  assert.equal(again.ok, false);
  assert.equal(again.say, 'voice.pageSecret', 'the refusal of the page is reported');
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
  const ask = scriptedAsk({ action: choice('type_text'), argument: firstSpan, submit: { type: 'noul', noul: 0.9 } });
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
  const switched = browser.calls.find((call) => call[0] === 'updateTab');
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

test('a failing fast provider falls back to the configured backup provider', async () => {
  const calls = [];
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
