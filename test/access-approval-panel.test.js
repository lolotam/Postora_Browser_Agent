import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { ASK_FIRST, FULL_ACCESS } from '../src/permissions/policy.js';
import { createPermissionUi } from '../src/sidepanel/permissions.js';
import { MESSAGES } from '../src/sidepanel/messages.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panelSource = fs.readFileSync(path.join(ROOT, 'src/sidepanel/panel.js'), 'utf8');
const panelHtml = fs.readFileSync(path.join(ROOT, 'src/sidepanel/index.html'), 'utf8');
const panelCss = fs.readFileSync(path.join(ROOT, 'src/sidepanel/panel.css'), 'utf8');

// The wiring of the panel around the approvals: the section of the panel that
// draws them, and the handler that routes the events of the worker. Both are
// run as they are, with the real helper and a mocked worker behind them.
const approvalsSource = panelSource.slice(
  panelSource.indexOf('// ---------- approvals ----------'),
  panelSource.indexOf('\nfunction onEvent('),
);
const eventSource = panelSource.slice(
  panelSource.indexOf('function onEvent('),
  panelSource.indexOf('\nfunction threadPart('),
);
const connectSource = panelSource.slice(
  panelSource.indexOf('function connect('),
  panelSource.indexOf('\n// Picking the session'),
);

// A DOM with just enough of itself to draw in. It is deliberately plainer
// than a browser: the panel may only use what a real element offers.
class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.focusCount = 0;
    this._text = '';
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = value === null || value === undefined ? '' : String(value);
    for (const child of this.children.splice(0)) child.parentNode = null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) {
      this.children.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatch(type, event = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      handler({ type, target: this, preventDefault() {}, stopPropagation() {}, ...event });
    }
  }

  focus() {
    this.focusCount += 1;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  /** Every element in the tree, so a test can look for what was drawn. */
  all() {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
  }

  createElement(tag) {
    return new FakeNode(tag, this);
  }
}

/** A request as the worker publishes it: safe metadata and nothing else. */
function makeRequest(overrides = {}) {
  return {
    id: 'req-1',
    sessionId: 'chat-a',
    revision: 1,
    action: 'type_text',
    kind: 'interact',
    origin: 'http://127.0.0.1:8123',
    label: 'the search field',
    ...overrides,
  };
}

/** The panel's own translator, in the language the panel is in. */
function translator(state, key, vars = {}) {
  const text = MESSAGES[state.language][key] ?? MESSAGES.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

/**
 * The panel, with one chat, one revision and one connection.
 *
 * The helper is the real one: what the panel draws and what it sends are the
 * helper's own doing, and only the worker behind them is mocked.
 */
function makePanel({ sessionId = 'chat-a', revision = 1, language = 'en' } = {}) {
  const doc = new FakeDocument();
  const container = doc.createElement('div');
  const state = { language, sessionId, revision, port: { name: 'port-1' } };
  const sent = [];
  const asked = [];
  const accessUi = {
    confirmed: { sessionId, mode: ASK_FIRST, revision },
    /** The worker said what the mode is: the control takes it, as it does. */
    apply(next) {
      if (!next || next.sessionId !== state.sessionId) return this.confirmed;
      if (!(next.revision > this.confirmed.revision)) return this.confirmed;
      this.confirmed = { sessionId: next.sessionId, mode: next.mode, revision: next.revision };
      return this.confirmed;
    },
  };
  const elements = new Map([['approvals', container]]);
  const context = vm.createContext({
    Promise, DOMException, Map, Set, Object, Array, Number, String, Boolean, JSON, Math, Error, TypeError,
    createPermissionUi,
    ASK_FIRST, FULL_ACCESS,
    t: (key, vars) => translator(state, key, vars),
    $: (id) => {
      asked.push(id);
      if (!elements.has(id)) elements.set(id, new FakeNode('div', doc));
      return elements.get(id);
    },
    // The port the panel sends on: the answer keeps the connection it was
    // drawn on, and the panel never rebuilds it.
    send: (message, options) => {
      sent.push({ message, options });
      return Promise.resolve(true);
    },
    accessUi,
    /** The mode the worker confirmed, as the panel applies it. */
    applyAccessState: (next) => accessUi.apply(next),
    replaying: false,
  });
  context.sessionId = sessionId;
  context.port = state.port;
  vm.runInContext(`${approvalsSource}\n${eventSource}`, context);
  return {
    context,
    container,
    state,
    sent,
    asked,
    accessUi,
    /** The cards that are on the screen. */
    cards() {
      return container.children;
    },
    /** A button of a card, by its class. */
    button(index, name) {
      const card = container.children[index];
      if (!card) return null;
      return card.all().find((node) => node.className.split(' ').includes(name)) ?? null;
    },
    /** The text of every element with a class. */
    texts(name) {
      return container.all().filter((node) => node.className.split(' ').includes(name)).map((node) => node.textContent);
    },
  };
}

test('the approvals of both screens are drawn in one place', () => {
  const approvals = panelHtml.indexOf('id="approvals"');
  const chat = panelHtml.indexOf('id="chatView"');
  const voice = panelHtml.indexOf('id="voiceView"');
  assert.ok(approvals > 0, 'the panel has no shared area for the approvals');
  assert.ok(approvals < chat, 'the shared area is not outside the chat');
  assert.ok(approvals < voice, 'the shared area is not outside the voice screen');
  // One area only: the voice screen may not draw a second one.
  assert.equal(panelHtml.split('id="approvals"').length - 1, 1);
  // The voice screen keeps its own approval of the fast voice path: the two
  // routes are apart until the voice path is wired to the same authority.
  assert.match(panelHtml, /id="voiceApproval"/);
});

test('the card is drawn with the panel\'s own design', () => {
  for (const name of ['permission-request', 'permission-title', 'permission-action', 'permission-site', 'permission-target', 'permission-terminal', 'permission-actions', 'permission-allow', 'permission-deny', 'permission-status', 'permission-error']) {
    assert.match(panelCss, new RegExp(`\\.${name}\\b`), `the panel has no .${name}`);
  }
  // The card uses the mint primary action and the ghost deny of the panel, and
  // it brings no palette of its own.
  const card = panelCss.slice(panelCss.indexOf('.permission-request'), panelCss.indexOf('/* ---------- settings ---------- */'));
  assert.doesNotMatch(card, /#[0-9a-f]{3,6}/i, 'the card brings a colour of its own');
});

test('a request of the worker is drawn as a card', () => {
  const panel = makePanel();
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });

  assert.equal(panel.cards().length, 1, 'the request is on the screen');
  assert.equal(panel.cards()[0].className, 'permission-request');
  assert.equal(panel.container.hidden, false, 'the shared area is on the screen');
  assert.deepEqual(panel.texts('permission-action'), ['Action: Type text into a field']);
  assert.deepEqual(panel.texts('permission-site'), ['Site: http://127.0.0.1:8123']);
  assert.deepEqual(panel.texts('permission-target'), ['Target: the search field']);
});

test('the answer carries the chat and the connection the card was drawn for', () => {
  const panel = makePanel();
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });
  panel.button(0, 'permission-allow').dispatch('click');

  assert.equal(panel.sent.length, 1, 'one answer went out');
  assert.deepEqual(panel.sent[0].message, {
    type: 'access-approval',
    id: 'req-1',
    sessionId: 'chat-a',
    revision: 1,
    decision: 'allow',
  });
  assert.deepEqual(panel.sent[0].options, {
    expectedSessionId: 'chat-a',
    expectedPort: panel.state.port,
  });
});

test('a settled request takes its card away', () => {
  const panel = makePanel();
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });
  panel.context.onEvent({ type: 'access-request-settled', id: 'req-1', sessionId: 'chat-a', revision: 1, approved: true, reason: 'allowed' });

  assert.equal(panel.cards().length, 0, 'the card is gone');
  assert.equal(panel.container.hidden, true, 'and the shared area is empty again');
});

test('the replay applies the mode before the requests', () => {
  const panel = makePanel({ revision: 1 });
  panel.context.applyAccessReplay(
    { sessionId: 'chat-a', mode: ASK_FIRST, revision: 5 },
    [makeRequest({ id: 'req-5', revision: 5 })],
  );

  assert.equal(panel.accessUi.confirmed.revision, 5, 'the mode the worker confirmed is applied');
  assert.equal(panel.cards().length, 1, 'the request of that revision is drawn');
  assert.equal(panel.texts('permission-target')[0], 'Target: the search field');
});

test('a mode that moved takes the cards of the old mode with it', () => {
  const panel = makePanel({ revision: 1 });
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });
  assert.equal(panel.cards().length, 1);

  panel.context.onEvent({ type: 'access-state', sessionId: 'chat-a', mode: FULL_ACCESS, revision: 2 });

  assert.equal(panel.cards().length, 0, 'the card of the old revision is gone');
  assert.equal(panel.container.hidden, true);
});

test('a settlement that arrives before the mode is processed, and the card does not come back', () => {
  const panel = makePanel({ revision: 1 });
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });
  // The worker says that the request ended before it says what the mode is.
  panel.context.onEvent({ type: 'access-request-settled', id: 'req-1', sessionId: 'chat-a', revision: 1, approved: false, reason: 'mode-changed' });
  assert.equal(panel.cards().length, 0, 'the settled request is gone');

  panel.context.onEvent({ type: 'access-state', sessionId: 'chat-a', mode: FULL_ACCESS, revision: 2 });
  assert.equal(panel.cards().length, 0, 'and it does not come back with the new mode');
});

test('a request of another chat is not drawn, and the history is not a question', () => {
  const panel = makePanel();
  panel.context.onEvent({ type: 'access-request', request: makeRequest({ sessionId: 'chat-b' }) });
  assert.equal(panel.cards().length, 0, 'another chat is not on the screen');

  panel.context.replaying = true;
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });
  assert.equal(panel.cards().length, 0, 'the history of the chat is not a question that waits');
});

test('a worker that is gone takes the cards with it', () => {
  const panel = makePanel();
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });
  const allow = panel.button(0, 'permission-allow');
  panel.context.resetApprovals();

  assert.equal(panel.cards().length, 0, 'the cards are gone');
  assert.equal(panel.container.hidden, true);
  // A card that is gone answers nothing.
  allow.dispatch('click');
  assert.equal(panel.sent.length, 0, 'nothing went out for the card that was gone');
});

test('a new connection clears the cards of the one that is gone', () => {
  const resets = { approvals: 0, access: 0 };
  const context = vm.createContext({
    Promise, DOMException,
    sessionId: 'chat-a',
    voicePanelId: 'panel-a',
    reconnected: false,
    t: (key) => key,
    cancelVoiceTask() {},
    releaseVoiceClaims() {},
    refreshAuthStates() {},
    onEvent() {},
    accessUi: { reset() { resets.access += 1; }, reconnect() {} },
    resetApprovals() { resets.approvals += 1; },
    chrome: { runtime: { connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }) } },
  });
  vm.runInContext(connectSource, context);
  context.connect();

  assert.equal(resets.approvals, 1, 'a new connection clears the approvals of the old one');
  assert.equal(resets.access, 1, 'and the mode with them');
});

test('a settlement of another request does not take a live card with it', () => {
  const panel = makePanel({ revision: 1 });
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });
  assert.equal(panel.cards().length, 1);

  // A settlement that names the id but not the chat, the revision or the
  // connection is not the settlement of this request.
  panel.context.onEvent({ type: 'access-request-settled', id: 'req-1', sessionId: 'chat-b', revision: 1, approved: true, reason: 'allowed' });
  assert.equal(panel.cards().length, 1, 'the card of the live request is still there');

  // The mode the worker confirms again keeps the request that is still live.
  panel.context.onEvent({ type: 'access-state', sessionId: 'chat-a', mode: ASK_FIRST, revision: 1 });
  assert.equal(panel.cards().length, 1, 'the live request was not taken with it');
  assert.equal(panel.texts('permission-target')[0], 'Target: the search field');
});

test('a settlement of the request itself takes its card away', () => {
  const panel = makePanel({ revision: 1 });
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });
  panel.context.onEvent({ type: 'access-request-settled', id: 'req-1', sessionId: 'chat-a', revision: 1, approved: true, reason: 'allowed' });
  assert.equal(panel.cards().length, 0);

  // The request is gone, so the mode that is confirmed again does not bring it back.
  panel.context.onEvent({ type: 'access-state', sessionId: 'chat-a', mode: ASK_FIRST, revision: 1 });
  assert.equal(panel.cards().length, 0, 'the settled request does not come back');
});

test('the name of the tool is translated, and an unknown tool keeps its own', () => {
  const panel = makePanel({ language: 'ar' });
  assert.equal(panel.context.approvalWords('access.approval.action', { action: 'type_text' }), 'الإجراء: كتابة نص في حقل');
  assert.equal(panel.context.approvalWords('access.approval.action', { action: 'not_a_tool' }), 'الإجراء: not_a_tool');
});

test('voice-only action previews and selected-field activity names exist in both languages', () => {
  for (const language of ['en', 'ar']) {
    const panel = makePanel({ language });
    for (const action of ['zoom_in', 'zoom_out', 'zoom_reset', 'media_play_pause', 'media_mute', 'find_on_page']) {
      panel.context.onEvent({ type: 'access-request', request: makeRequest({ id: action, action }) });
    }
    assert.equal(panel.cards().length, 6);
    for (const text of panel.texts('permission-action')) assert.doesNotMatch(text, /zoom_|media_|find_on_page|access\.approval\./);
    const source = panelSource.slice(panelSource.indexOf('const VOICE_ACTIONS = {'), panelSource.indexOf('\n/**\n * The question the user answers'));
    const context = vm.createContext({ t: (key) => MESSAGES[language][key] ?? key });
    vm.runInContext(source, context);
    assert.equal(context.voiceActionName('read_field'), MESSAGES[language]['voice.actionReadField']);
    assert.equal(context.voiceActionName('insert_text'), MESSAGES[language]['voice.actionInsertText']);
  }
});

test('a new language redraws the cards without making them again', () => {
  const panel = makePanel();
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });
  panel.state.language = 'ar';
  const ui = vm.runInContext('permissionUi', panel.context);
  ui.updateLanguage(vm.runInContext('approvalWords', panel.context));

  assert.equal(panel.cards().length, 1, 'no second card');
  assert.deepEqual(panel.texts('permission-title'), ['اسمح بهذا الإجراء؟']);
  assert.deepEqual(panel.texts('permission-action'), ['الإجراء: كتابة نص في حقل']);
});

test('an approval never touches the draft, the files or the question of the user', () => {
  const panel = makePanel();
  panel.context.onEvent({ type: 'access-request', request: makeRequest() });
  panel.button(0, 'permission-allow').dispatch('click');
  panel.context.onEvent({ type: 'access-request-settled', id: 'req-1', sessionId: 'chat-a', revision: 1, approved: true, reason: 'allowed' });

  for (const id of ['input', 'fileChips', 'fileInput', 'attachments', 'hint', 'composer']) {
    assert.equal(panel.asked.includes(id), false, `the approval touched #${id}`);
  }
});

test('the words of an approval exist in both languages', () => {
  const keys = [
    'access.approval.title',
    'access.approval.action',
    'access.approval.site',
    'access.approval.target',
    'access.approval.terminal',
    'access.approval.allow',
    'access.approval.deny',
    'access.approval.waiting',
    'access.approval.sendError',
  ];
  for (const key of keys) {
    for (const language of ['ar', 'en']) {
      const text = MESSAGES[language][key];
      assert.equal(typeof text, 'string', `${language} has no ${key}`);
      assert.ok(text.trim() !== '', `${language} ${key} is empty`);
      assert.notEqual(text, key, `${language} ${key} was never written`);
    }
  }
  // The placeholders are the same in both languages.
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(placeholders(MESSAGES.ar['access.approval.action']), ['action']);
  assert.deepEqual(placeholders(MESSAGES.en['access.approval.action']), ['action']);
  assert.deepEqual(placeholders(MESSAGES.ar['access.approval.site']), ['origin']);
  assert.deepEqual(placeholders(MESSAGES.en['access.approval.site']), ['origin']);
  assert.deepEqual(placeholders(MESSAGES.ar['access.approval.target']), ['label']);
  assert.deepEqual(placeholders(MESSAGES.en['access.approval.target']), ['label']);
});
