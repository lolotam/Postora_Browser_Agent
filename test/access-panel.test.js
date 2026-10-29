import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { ASK_FIRST, FULL_ACCESS } from '../src/permissions/policy.js';
import { createAccessUi } from '../src/sidepanel/access.js';
import { MESSAGES } from '../src/sidepanel/messages.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The strings the access control shows. Every one of them is written in both
// languages, and none of them is the key it was asked for.
const ACCESS_KEYS = [
  'access.label',
  'access.askFirst',
  'access.full',
  'access.state.askFirst',
  'access.state.full',
  'access.state.fullRisk',
  'access.warning.title',
  'access.warning.desc',
  'access.warning.forms',
  'access.warning.data',
  'access.warning.terminal',
  'access.warning.fields',
  'access.warning.providers',
  'access.warning.history',
  'access.warning.limits',
  'access.warning.stops',
  'access.warning.acknowledge',
  'access.warning.confirm',
  'access.warning.cancel',
  'access.error.send',
];

// What the warning has to say, in the words of each language. The risk is
// never carried by colour alone, so the words themselves have to name it.
const TOPICS = {
  en: {
    forms: /form/i,
    data: /send .*delete|delete .*data/i,
    terminal: /terminal/i,
    fields: /sensitive field/i,
    providers: /AI provider/i,
    history: /chat history/i,
    limits: /Chrome/,
    stops: /stops the work/i,
  },
  ar: {
    forms: /نماذج/,
    data: /يرسل البيانات[\s\S]*يحذفها/,
    terminal: /طرفية/,
    fields: /الحقول الحساسة/,
    providers: /الذكاء الاصطناعي/,
    history: /سجل المحادثة/,
    limits: /Chrome/,
    stops: /يوقف العمل/,
  },
};

/** The panel's own translator, without a browser to set the language in. */
const translator = (language) => (key) => MESSAGES[language][key] ?? MESSAGES.en[key] ?? key;

// A panel element with just enough of the DOM to drive the control. It is
// deliberately plainer than a browser: the control may only use what a real
// element offers.
class FakeElement {
  constructor(name = 'element') {
    this.name = name;
    this.value = '';
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.focusCount = 0;
    this.handlers = new Map();
    this.classes = new Map();
    this.classList = { toggle: (className, on) => { this.classes.set(className, Boolean(on)); } };
  }

  addEventListener(name, handler) {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }

  async dispatch(name, event = {}) {
    for (const handler of [...(this.handlers.get(name) ?? [])]) {
      await handler({ target: this, preventDefault() {}, ...event });
    }
  }

  showModal() { this.open = true; }

  close() {
    this.open = false;
    queueMicrotask(() => { for (const handler of [...(this.handlers.get('close') ?? [])]) handler({}); });
  }

  focus() { this.focusCount += 1; }
}

/** The control with the panel's own markup behind it. */
function makeControl(language, { sessionId = 'session-a' } = {}) {
  const elements = {};
  for (const name of ['select', 'state', 'risk', 'voice', 'warning', 'acknowledge', 'confirm', 'cancel']) {
    elements[name] = new FakeElement(name);
  }
  const sent = [];
  const ui = createAccessUi({
    elements,
    t: translator(language),
    request: async (message) => { sent.push(message); return true; },
    getSessionId: () => sessionId,
  });
  return { ui, elements, sent };
}

test('every access string is written in Arabic and in English', () => {
  for (const key of ACCESS_KEYS) {
    for (const language of ['ar', 'en']) {
      const text = MESSAGES[language][key];
      assert.equal(typeof text, 'string', `${language} has no ${key}`);
      assert.ok(text.trim() !== '', `${language} ${key} is empty`);
      assert.notEqual(text, key, `${language} ${key} was never written`);
    }
  }
});

test('the warning says plainly what Full access allows, in both languages', () => {
  for (const language of ['ar', 'en']) {
    const copy = [
      'access.warning.title',
      'access.warning.desc',
      'access.warning.forms',
      'access.warning.data',
      'access.warning.terminal',
      'access.warning.fields',
      'access.warning.providers',
      'access.warning.history',
      'access.warning.limits',
      'access.warning.stops',
      'access.state.fullRisk',
    ].map((key) => MESSAGES[language][key]).join('\n');
    for (const [topic, pattern] of Object.entries(TOPICS[language])) {
      assert.match(copy, pattern, `${language} copy does not speak about ${topic}`);
    }
  }
});

test('the risk the label carries is the risk the warning names', () => {
  for (const language of ['ar', 'en']) {
    const risk = MESSAGES[language]['access.state.fullRisk'];
    assert.match(risk, TOPICS[language].fields, `${language} risk does not name the sensitive fields`);
    assert.match(risk, TOPICS[language].providers, `${language} risk does not name the providers`);
    assert.match(risk, TOPICS[language].history, `${language} risk does not name the history`);
  }
});

test('the control draws the copy of the language it is in', () => {
  for (const language of ['ar', 'en']) {
    const { ui, elements } = makeControl(language);
    ui.apply({ sessionId: 'session-a', mode: ASK_FIRST, revision: 1 });
    assert.equal(elements.select.value, ASK_FIRST);
    assert.equal(elements.state.textContent, MESSAGES[language]['access.state.askFirst']);
    assert.equal(elements.risk.hidden, true, 'the risk is not shown while the mode is Ask first');
    assert.equal(elements.voice.textContent, MESSAGES[language]['access.askFirst']);

    ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 2 });
    assert.equal(elements.select.value, FULL_ACCESS);
    assert.equal(elements.state.textContent, MESSAGES[language]['access.state.full']);
    assert.equal(elements.risk.textContent, MESSAGES[language]['access.state.fullRisk']);
    assert.equal(elements.risk.hidden, false, 'the risk is not shown while the mode is Full');
    assert.equal(elements.select.title, MESSAGES[language]['access.state.fullRisk']);
    assert.equal(elements.select.classes.get('risk'), true);
    // The voice screen shows the same mode the chat shows, in the same words.
    assert.equal(elements.voice.textContent, MESSAGES[language]['access.full']);
    assert.equal(elements.voice.title, MESSAGES[language]['access.state.full']);
    assert.equal(elements.voice.classes.get('risk'), true);
  }
});

test('the mode is never drawn before the worker confirmed it', () => {
  const { ui, elements } = makeControl('en');
  ui.apply({ sessionId: 'session-a', mode: FULL_ACCESS, revision: 2 });
  assert.equal(elements.select.value, FULL_ACCESS);
  // A redraw keeps the confirmed mode; a reset drops it and waits for the
  // worker to say again what the mode is.
  ui.render();
  assert.equal(elements.select.value, FULL_ACCESS);
  ui.reset();
  assert.equal(elements.select.value, ASK_FIRST);
  assert.equal(elements.risk.hidden, true);
  assert.equal(elements.select.classes.get('risk'), false);
  assert.equal(elements.select.title, MESSAGES.en['access.state.askFirst']);
  assert.equal(elements.state.textContent, MESSAGES.en['access.state.askFirst']);
});

test('the panel markup holds the pieces the control drives', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/sidepanel/index.html'), 'utf8');
  for (const id of ['accessSelect', 'accessState', 'accessRisk', 'voiceAccess', 'accessWarning', 'accessAcknowledge', 'accessConfirm', 'accessCancel']) {
    assert.match(html, new RegExp(`id="${id}"`), `the panel has no #${id}`);
  }
  // The dialog names its heading and its description, so it is read out.
  assert.match(html, /<span class="sr-only" id="accessRisk"/);
  assert.doesNotMatch(html, /<p[^>]+id="accessRisk"/);
  assert.match(html, /aria-describedby="accessState accessRisk"/);
  const dialog = html.slice(html.indexOf('id="accessWarning"'));
  assert.match(dialog, /aria-labelledby="accessWarningTitle"/);
  assert.match(dialog, /aria-describedby="accessWarningDesc"/);
  assert.match(html, /id="accessWarningTitle"/);
  assert.match(html, /id="accessWarningDesc"/);
  // The acknowledgment starts unticked and the confirm starts closed.
  assert.match(html, /<input type="checkbox" id="accessAcknowledge" \/>/);
  assert.match(html, /id="accessConfirm"[^>]*disabled/);
  // The selection carries the two modes the worker knows.
  assert.match(html, /<option value="ask-first"/);
  assert.match(html, /<option value="full-access"/);
  // The voice screen has its own indicator of the same mode.
  const voice = html.slice(html.indexOf('id="voiceView"'), html.indexOf('id="settingsView"'));
  assert.match(voice, /id="voiceAccess"/);
});

test('the access control and model picker share the inline composer toolbar', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/sidepanel/index.html'), 'utf8');
  const composer = html.indexOf('<form id="composer">');
  const box = html.indexOf('id="composerBox"', composer);
  const toolbar = html.indexOf('class="composer-toolbar"', box);
  const end = html.indexOf('</form>', composer);
  assert.ok(composer > 0 && box > composer && toolbar > box);
  for (const id of ['modelQuickBtn', 'accessSelect', 'accessState', 'accessRisk', 'accessError', 'attachBtn', 'voiceToggle', 'stopBtn', 'sendBtn']) {
    const control = html.indexOf(`id="${id}"`, toolbar);
    assert.ok(control > toolbar && control < end, `${id} must remain inside the form`);
  }
  assert.doesNotMatch(html, /class="access-bar"/);
});

// The wiring of the panel around the control: the choice of the user, the
// worker that is gone, and the state that has to come before anything is
// asked for. The panel code is run as it is, with the control and the worker
// as the only things it is given.
const panelSource = fs.readFileSync(path.join(ROOT, 'src/sidepanel/panel.js'), 'utf8');
const accessWiring = panelSource.slice(
  panelSource.indexOf('/** The reason the last mode request did not go out'),
  panelSource.indexOf('\nasync function send('),
);

/** A panel that sees the choice of the user before the control does. */
function makeWiring({ connected = false, revision = 0, sessionId = 'chat-a' } = {}) {
  const select = { value: ASK_FIRST, events: [], dispatchEvent(event) { this.events.push(event); return true; } };
  const error = { textContent: '', hidden: false };
  const handlers = [];
  const document = {
    addEventListener(name, handler, capture) { handlers.push({ name, handler, capture }); },
    dispatch(target) {
      const event = {
        target, stopped: false,
        stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopped = true; },
      };
      for (const entry of handlers) {
        if (entry.name !== 'change') continue;
        entry.handler(event);
        if (event.stopped) break;
      }
      return event;
    },
  };
  const calls = { restores: 0, connects: 0, applies: [] };
  const accessUi = {
    connected,
    confirmed: { sessionId, mode: ASK_FIRST, revision },
    restore() { calls.restores += 1; select.value = ASK_FIRST; },
    apply(state) { calls.applies.push(state); },
  };
  const context = vm.createContext({
    document,
    sessionId,
    port: null,
    accessUi,
    ASK_FIRST,
    FULL_ACCESS,
    Event: class {
      constructor(type, options = {}) { this.type = type; this.bubbles = Boolean(options.bubbles); this.target = null; }
      stopPropagation() {}
      stopImmediatePropagation() {}
    },
    t: (key) => key,
    connect() { calls.connects += 1; },
    $: (id) => (id === 'accessSelect' ? select : error),
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(accessWiring, context);
  return { context, select, document, handlers, calls, accessUi, error };
}

test('the choice of the user is seen before the control sees it', () => {
  const app = makeWiring({ connected: true, revision: 2 });
  assert.equal(app.handlers.length, 1, 'the panel listens for the choice of the user');
  assert.equal(app.handlers[0].capture, true, 'the panel sees the choice before the control does');
});

test('a choice the control can bind is left to the control', () => {
  const app = makeWiring({ connected: true, revision: 2 });
  app.select.value = FULL_ACCESS;
  const event = app.document.dispatch(app.select);
  assert.equal(event.stopped, false, 'the control may act on the choice');
  assert.equal(app.calls.connects, 0, 'the worker is not asked again for nothing');
});

test('a choice made while the worker is gone waits for the worker', () => {
  const app = makeWiring({ connected: false, revision: 0 });
  app.select.value = FULL_ACCESS;
  const event = app.document.dispatch(app.select);
  assert.equal(event.stopped, true, 'the control must not act on a choice it cannot bind');
  assert.equal(app.select.value, ASK_FIRST, 'the selection goes back to the confirmed mode');
  assert.equal(app.calls.restores, 1, 'the control is put back where it was');
  assert.equal(app.calls.connects, 1, 'the worker is asked again');
});

test('the waiting choice is handed over only after the worker said what the mode is', () => {
  const app = makeWiring({ connected: false, revision: 0 });
  app.select.value = FULL_ACCESS;
  app.document.dispatch(app.select);
  // The worker answers: the mode of this chat, and the revision it is at.
  app.accessUi.connected = true;
  app.accessUi.confirmed = { sessionId: 'chat-a', mode: ASK_FIRST, revision: 3 };
  app.context.applyAccessState({ sessionId: 'chat-a', mode: ASK_FIRST, revision: 3 });
  assert.equal(app.select.events.length, 1, 'the choice was handed to the control');
  assert.equal(app.select.value, FULL_ACCESS, 'the control opens the warning for the choice');
});

test('a choice for a chat that is left is not handed over', () => {
  const app = makeWiring({ connected: false, revision: 0 });
  app.select.value = FULL_ACCESS;
  app.document.dispatch(app.select);
  // The chat changes while the panel waits for the worker.
  app.context.sessionId = 'chat-b';
  app.accessUi.connected = true;
  app.accessUi.confirmed = { sessionId: 'chat-b', mode: ASK_FIRST, revision: 1 };
  app.context.applyAccessState({ sessionId: 'chat-b', mode: ASK_FIRST, revision: 1 });
  assert.equal(app.select.events.length, 0, 'the choice of the chat that was left is not handed over');
});

test('a choice is not handed over before the worker has confirmed a mode', () => {
  const app = makeWiring({ connected: false, revision: 0 });
  app.select.value = FULL_ACCESS;
  app.document.dispatch(app.select);
  app.accessUi.connected = true;
  app.accessUi.confirmed = { sessionId: 'chat-a', mode: ASK_FIRST, revision: 0 };
  app.context.applyAccessState({ sessionId: 'chat-a', mode: ASK_FIRST, revision: 0 });
  assert.equal(app.select.events.length, 0, 'nothing is handed over without a confirmed mode');
});

test('a worker that does not answer leaves the mode as it was, and says so', () => {
  const app = makeWiring({ connected: false, revision: 0 });
  app.select.value = FULL_ACCESS;
  app.document.dispatch(app.select);
  // The worker does not answer, and does not answer the second time either.
  app.context.accessIntentTimeout();
  app.context.accessIntentTimeout();
  assert.equal(app.select.events.length, 0, 'nothing was asked for');
  assert.equal(app.select.value, ASK_FIRST, 'the mode is the one the worker confirmed');
  assert.equal(app.error.textContent, 'access.error.connect', 'the panel says why');
  assert.equal(app.error.hidden, false, 'the reason is on the screen');
});
