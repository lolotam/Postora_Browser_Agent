// The browser foundation: the identity of a target, the check that the target
// is still the same thing when the action goes out, and the one way a selected
// value leaves the page.
//
// The page scripts are the functions that are injected into a web page, so
// they are run here in a page of their own: what they leave out is what never
// reaches the model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  permissionTarget, elementAction, suggestionAction, snapshotPage, pageText,
} from '../src/browser/page-scripts.js';
import { isSecretField, secretRule } from '../src/voice/voice-safety.js';

const rule = secretRule();

/** Whether a node matches one part of a selector list. */
function matches(node, selector) {
  return String(selector).split(',').some((part) => {
    const s = part.trim();
    if (!s) return false;
    if (s === '*') return true;
    const attr = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/.exec(s);
    if (attr) {
      const [, name, value] = attr;
      if (name === 'contenteditable') return node.editable && (value === undefined || value === '' || value === 'true');
      if (name === 'onclick') return 'onclick' in node.attrs;
      if (!(name in node.attrs)) return false;
      return value === undefined ? true : String(node.attrs[name]) === value;
    }
    const tag = /^([a-z0-9]+)/i.exec(s)?.[1]?.toLowerCase();
    if (!tag) return false;
    if (node.tagName.toLowerCase() !== tag) return false;
    if (tag === 'input' && s.includes(':not([type="hidden"])') && node.type === 'hidden') return false;
    if (tag === 'a' && s.includes('[href]') && !node.attrs.href) return false;
    return true;
  });
}

/**
 * A page of its own: its elements, their boxes, the focus and the document
 * they live in. Enough of a page for the scripts that are injected into one.
 */
function makePage({ text = 'A page with ordinary words.' } = {}) {
  const state = { elements: [], activeElement: null, timeOrigin: 1000 };
  let body = null;

  const make = ({
    tag = 'DIV', type = '', attrs = {}, value = '', innerText = '', rect = {},
    editable = false, connected = true, readOnly = false, disabled = false,
    children = [], shadow = null, parent = 'body',
  } = {}) => {
    const node = {
      nodeType: 1,
      tagName: tag,
      type,
      attrs: { ...attrs },
      value,
      innerText,
      textContent: innerText,
      childNodes: [],
      children,
      isContentEditable: editable,
      readOnly,
      disabled,
      isConnected: connected,
      style: {},
      labels: [],
      options: [],
      shadowRoot: shadow ? { activeElement: shadow.activeElement ?? null, querySelectorAll: () => [], contains: (other) => other === shadow.activeElement } : null,
      id: attrs.id ?? '',
      name: attrs.name ?? '',
      parentElement: null,
      rect: { width: 120, height: 24, top: 10, left: 20, bottom: 34, right: 140, ...rect },
      calls: [],
    };
    // The text of the element is a text node of its own, as in a page.
    Object.defineProperty(node, 'childNodes', {
      get: () => [...(innerText ? [{ nodeType: 3, nodeValue: innerText, textContent: innerText }] : []), ...node.children],
    });
    // The text of the element is the text of its own and of its children.
    Object.defineProperty(node, 'textContent', {
      configurable: true,
      get: () => [innerText, ...children.map((child) => child.textContent ?? '')].filter(Boolean).join(''),
    });
    node.getAttribute = (name) => (name in node.attrs ? node.attrs[name] : null);
    node.setAttribute = (name, value) => { node.attrs[name] = String(value); };
    node.removeAttribute = (name) => { delete node.attrs[name]; };
    node.hasAttribute = (name) => name in node.attrs;
    node.querySelector = (selector) => node.children.find((child) => matches(child, selector)) ?? null;
    node.querySelectorAll = (selector) => node.children.filter((child) => matches(child, selector));
    node.scrollIntoView = () => { node.calls.push('scroll'); };
    node.focus = () => { node.calls.push('focus'); state.activeElement = node; };
    node.select = () => { node.calls.push('select'); };
    node.getBoundingClientRect = () => node.rect;
    node.getClientRects = () => (node.isConnected ? [node.rect] : []);
    node.contains = (other) => other === node || node.children.includes(other);
    node.matches = (selector) => matches(node, selector);
    node.closest = () => null;
    for (const child of children) child.parentElement = node;
    state.elements.push(node);
    if (parent === 'body' && body) {
      body.children.push(node);
      node.parentElement = body;
    }
    return node;
  };

  body = make({ tag: 'BODY', innerText: text, parent: null });
  const document = {
    body,
    documentElement: { scrollHeight: 2400 },
    title: 'Permission test page',
    createTreeWalker: () => ({ nextNode: () => null }),
    querySelectorAll: (selector) => state.elements.filter((node) => matches(node, selector)),
    querySelector: (selector) => state.elements.find((node) => matches(node, selector)) ?? null,
    getElementById: (id) => state.elements.find((node) => node.attrs.id === id) ?? null,
    elementFromPoint: (x, y) => state.elements.find((node) => {
      const r = node.rect;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }) ?? null,
  };
  Object.defineProperty(document, 'activeElement', { get: () => state.activeElement });

  const performance = {};
  Object.defineProperty(performance, 'timeOrigin', { get: () => state.timeOrigin });

  const window = { innerHeight: 800, innerWidth: 600, scrollY: 0, devicePixelRatio: 1, __agentElements: [] };
  const context = vm.createContext({
    document,
    window,
    location: { href: 'https://example.test/page' },
    performance,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4 },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    Event: class { constructor(type) { this.type = type; } },
    setTimeout,
    clearTimeout,
    crypto: { getRandomValues: (array) => { array[0] = 7; array[1] = 9; return array; } },
  });

  const compiled = new Map();
  /** Runs an injected script in this page, exactly as the browser would. */
  const run = (source, ...args) => {
    if (!compiled.has(source)) compiled.set(source, vm.runInContext(`(${source})`, context));
    return compiled.get(source)(...args);
  };

  return {
    state,
    context,
    window,
    document,
    make,
    run,
    focus: (node) => { state.activeElement = node; },
  };
}

/** The target as the controller hands it to the page. */
function asTarget(captured, tabId = 7) {
  return {
    tabId,
    url: 'https://example.test/page',
    documentId: captured.documentId,
    element: captured.element,
    capturedAt: 1700000000000,
  };
}

const TARGET = permissionTarget.toString();
const ELEMENT = elementAction.toString();
const SUGGESTION = suggestionAction.toString();
const SNAPSHOT = snapshotPage.toString();
const TEXT = pageText.toString();

test('an editor referenced as another field label never exposes its contents', () => {
  const page = makePage();
  const editor = page.make({ tag: 'DIV', editable: true, attrs: { id: 'token-editor', 'aria-label': 'Access token' }, innerText: 'TEST_EDITOR_SECRET' });
  const alias = page.make({ tag: 'INPUT', attrs: { id: 'alias', 'aria-labelledby': 'token-editor' } });
  page.window.__agentElements = [editor, alias];
  const captured = page.run(TARGET, 'capture', { kind: 'element', index: 1 }, rule);
  assert.equal(captured.ok, true);
  assert.doesNotMatch(JSON.stringify(captured), /TEST_EDITOR_SECRET/);
  const snapshot = page.run(SNAPSHOT, 250, 3500, rule);
  assert.doesNotMatch(JSON.stringify(snapshot), /TEST_EDITOR_SECRET/);
});

test('capturing a button does not read a different secret editor even to test whether it is empty', () => {
  const page = makePage();
  const button = page.make({ tag: 'BUTTON', attrs: { 'aria-label': 'Send' }, innerText: 'Send' });
  const editor = page.make({ tag: 'DIV', editable: true, attrs: { 'aria-label': 'Access token' } });
  let reads = 0;
  Object.defineProperty(editor, 'textContent', { get() { reads += 1; return 'UNREQUESTED_EDITOR_VALUE'; } });
  page.window.__agentElements = [button];
  assert.equal(page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule).ok, true);
  assert.equal(reads, 0);
});

test('the label that belongs to a field is part of its name', () => {
  const page = makePage();
  // A field whose id says nothing, but whose label says what it is.
  const label = page.make({ tag: 'LABEL', innerText: 'Access token' });
  const field = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'unusual' }, value: 'TEST_ASSOCIATED_LABEL_SECRET' });
  field.labels = [label];
  page.window.__agentElements = [field];

  const snap = page.run(SNAPSHOT, 250, 3500, rule);
  const described = snap.elements.join('\n');
  assert.doesNotMatch(described, /TEST_ASSOCIATED_LABEL_SECRET/, 'the value of the field is not described');
  assert.match(described, /Access token/, 'the label of the field is its name');

  const captured = page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule);
  assert.equal(captured.element.secret, true, 'the rule of the module sees the label too');
});

test('a date inside a control that holds a secret is not a date of the page', () => {
  const page = makePage();
  const date = page.make({ tag: 'TIME', attrs: { datetime: '2026-10-08T00:00:00Z' }, innerText: 'TEST_DATE_SECRET' });
  const editor = page.make({
    tag: 'DIV',
    attrs: { 'aria-label': 'Access token', contenteditable: 'true' },
    editable: true,
    children: [date],
  });
  page.window.__agentElements = [editor];

  const snap = page.run(SNAPSHOT, 250, 3500, rule);
  assert.doesNotMatch(JSON.stringify(snap.dates), /TEST_DATE_SECRET/, 'the date of a secret editor is not a date of the page');
  const text = page.run(TEXT, 0, 4000, rule);
  assert.doesNotMatch(JSON.stringify(text.dates), /TEST_DATE_SECRET/);
});

test('an ordinary date is still a date of the page', () => {
  const page = makePage();
  page.make({ tag: 'TIME', attrs: { datetime: '2026-10-08T00:00:00Z' }, innerText: '2 days ago' });

  const snap = page.run(SNAPSHOT, 250, 3500, rule);
  assert.match(JSON.stringify(snap.dates), /2026-10-08T00:00:00Z/, 'the ordinary date stays');
});

test('the capture of a target reads no value of any field', () => {
  const page = makePage();
  const ordinary = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message', 'aria-label': 'Message' } });
  const secret = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'token', 'aria-label': 'Access token' } });
  let reads = 0;
  Object.defineProperty(secret, 'value', { get() { reads += 1; return 'UNREQUESTED_TEST_SECRET'; } });
  page.window.__agentElements = [ordinary, secret];

  const captured = page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule);

  assert.equal(captured.ok, true);
  assert.equal(reads, 0, 'the identity of a target is not a field-value read');
  assert.equal(captured.element.secret, false, 'the ordinary field is not a secret');
  assert.doesNotMatch(JSON.stringify(captured), /UNREQUESTED_TEST_SECRET/);
});

test('the capture names an element, and reads no value of any field', () => {
  const page = makePage();
  const password = page.make({ tag: 'INPUT', type: 'password', attrs: { id: 'password', name: 'password' }, value: 'TEST_ONLY_PASSWORD' });
  const message = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message', name: 'message' }, value: 'TEST_ONLY_MESSAGE' });
  page.window.__agentElements = [password, message];

  const captured = page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule);

  assert.equal(captured.ok, true);
  const json = JSON.stringify(captured);
  assert.doesNotMatch(json, /TEST_ONLY_PASSWORD/, 'no value is in the capture');
  assert.doesNotMatch(json, /TEST_ONLY_MESSAGE/, 'no value is in the capture');
  assert.equal(JSON.parse(json).element.index, 0);
  assert.equal(captured.element.kind, 'element');
  assert.ok(captured.element.token, 'the element is named by a token of the extension');
  assert.equal(captured.element.secret, true, 'the password box is a field that holds a secret');
  assert.deepEqual(password.calls, [], 'nothing was scrolled, focused or selected');
  assert.equal(password.style.outline, undefined, 'nothing was flashed');
});

test('the capture names the element under a point, and the element that has the focus', () => {
  const page = makePage();
  const button = page.make({ tag: 'BUTTON', innerText: 'Send message', rect: { left: 100, top: 50, right: 220, bottom: 80 } });
  const field = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' } });
  page.window.__agentElements = [button, field];

  const at = page.run(TARGET, 'capture', { kind: 'point', x: 150, y: 60 }, rule);
  assert.equal(at.ok, true);
  assert.equal(at.element.kind, 'point');
  assert.equal(at.element.x, 150);
  assert.equal(at.element.y, 60);

  page.focus(field);
  const focused = page.run(TARGET, 'capture', { kind: 'focus' }, rule);
  assert.equal(focused.ok, true);
  assert.equal(focused.element.kind, 'focus');
  assert.equal(focused.element.editable, true);
  assert.equal(focused.element.focused, true);
});

test('the identity of an element is the element itself, not the mark on it', () => {
  const page = makePage();
  const field = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' } });
  page.window.__agentElements = [field];
  const captured = page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule);

  // The page takes the element out of the page and puts a twin in its place
  // that carries the same mark.
  const twin = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message', 'data-agent-idx': '0' } });
  field.isConnected = false;

  const resolved = page.run(TARGET, 'resolve', { target: asTarget(captured) }, rule);
  assert.equal(resolved.ok, false, 'a twin does not inherit the approval');
  assert.equal(resolved.reason, 'element-gone');
  assert.equal(twin.calls.length, 0, 'the twin is never touched');
});

test('the element list was rebuilt: the index names another element now', () => {
  const page = makePage();
  const field = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' } });
  const other = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'other' } });
  page.window.__agentElements = [field];
  const captured = page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule);

  // A new snapshot put another element at that index.
  page.window.__agentElements = [other];

  const resolved = page.run(TARGET, 'resolve', { target: asTarget(captured) }, rule);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'reindexed');
});

test('the same address, a new document: the approval does not travel with it', () => {
  const page = makePage();
  const field = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' } });
  page.window.__agentElements = [field];
  const captured = page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule);

  // The page is replaced at the same address.
  page.state.timeOrigin = 2000;

  const resolved = page.run(TARGET, 'resolve', { target: asTarget(captured) }, rule);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'document-changed');
});

test('the focus that was approved is not the focus that is there now', () => {
  const page = makePage();
  const approved = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' } });
  const other = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'other' } });
  page.window.__agentElements = [approved, other];
  page.focus(approved);
  const captured = page.run(TARGET, 'capture', { kind: 'focus' }, rule);

  // The page moves the focus to another field.
  page.focus(other);

  const focus = page.run(TARGET, 'focus', { target: asTarget(captured) }, rule);
  assert.equal(focus.ok, false);
  assert.equal(focus.reason, 'focus-lost');

  const typing = page.run(TARGET, 'typing', { target: asTarget(captured) }, rule);
  assert.equal(typing.ok, false, 'the text would go into another field');
  assert.equal(typing.reason, 'focus-lost');
});

test('another element is under the point that was approved', () => {
  const page = makePage();
  const button = page.make({ tag: 'BUTTON', innerText: 'Send', rect: { left: 100, top: 50, right: 220, bottom: 80 } });
  const cover = page.make({ tag: 'DIV', rect: { left: 100, top: 50, right: 220, bottom: 80 } });
  page.window.__agentElements = [button];
  const captured = page.run(TARGET, 'capture', { kind: 'point', x: 150, y: 60 }, rule);
  assert.equal(captured.ok, true);

  // Something else lies over the button now.
  page.document.elementFromPoint = () => cover;

  const resolved = page.run(TARGET, 'resolve', { target: asTarget(captured) }, rule);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'hit-replaced');
});

test('the body keeps the Enter it was approved for, and takes no text', () => {
  const page = makePage();
  const body = page.document.body;
  page.focus(body);
  const captured = page.run(TARGET, 'capture', { kind: 'focus' }, rule);

  assert.equal(captured.ok, true);
  assert.equal(captured.element.body, true);
  assert.equal(captured.element.editable, false);
  assert.equal(captured.element.label, '', 'the body is never described: its text is the text of the page');

  const focus = page.run(TARGET, 'focus', { target: asTarget(captured) }, rule);
  assert.equal(focus.ok, true, 'the body that has the focus is the one that was approved');

  const typing = page.run(TARGET, 'typing', { target: asTarget(captured) }, rule);
  assert.equal(typing.ok, false, 'text never goes into the body');
  assert.equal(typing.reason, 'not-editable');
});

test('the hidden helper of a terminal takes the text, as a terminal asks', () => {
  const page = makePage();
  const helper = page.make({ tag: 'TEXTAREA', attrs: { 'aria-label': 'Terminal input' } });
  const terminal = page.make({ tag: 'DIV', attrs: { role: 'application', tabindex: '0' }, shadow: { activeElement: helper } });
  page.window.__agentElements = [terminal];
  page.focus(terminal);

  const captured = page.run(TARGET, 'capture', { kind: 'focus' }, rule);
  assert.equal(captured.ok, true);
  assert.equal(captured.element.tag, 'textarea', 'the focus is deep inside the terminal');

  const typing = page.run(TARGET, 'typing', { target: asTarget(captured) }, rule);
  assert.equal(typing.ok, true, 'the helper of the terminal can be written to');

  // The terminal itself is approved: the helper inside it does not inherit
  // the approval, because the focus is approved for one element only.
  const approved = page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule);
  const into = page.run(TARGET, 'typing', { target: asTarget(approved) }, rule);
  assert.equal(into.ok, false, 'a container does not lend its approval to the field inside it');
  assert.equal(into.reason, 'focus-lost');
});

test('a field that cannot be written to takes no text', () => {
  const page = makePage();
  const locked = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' }, readOnly: true });
  page.window.__agentElements = [locked];
  page.focus(locked);
  const captured = page.run(TARGET, 'capture', { kind: 'focus' }, rule);

  const typing = page.run(TARGET, 'typing', { target: asTarget(captured) }, rule);
  assert.equal(typing.ok, false);
  assert.equal(typing.reason, 'not-editable');
});

test('a role alone does not make an element a field', () => {
  const page = makePage();
  // A box that says it is a textbox, but that cannot be written into.
  const fake = page.make({ tag: 'DIV', attrs: { role: 'textbox', tabindex: '0' }, innerText: 'Not actually editable' });
  page.window.__agentElements = [fake];
  page.focus(fake);
  const captured = page.run(TARGET, 'capture', { kind: 'focus' }, rule);

  assert.equal(captured.element.editable, false, 'a role is a claim, not a capability');
  const typing = page.run(TARGET, 'typing', { target: asTarget(captured) }, rule);
  assert.equal(typing.ok, false, 'the text does not go into a box that cannot hold it');
  assert.equal(typing.reason, 'not-editable');

  const read = page.run(TARGET, 'read', { target: asTarget(captured) }, rule);
  assert.equal(read.ok, false, 'and nothing is read out of it either');
  assert.equal(read.reason, 'not-editable');
});

test('the focus of the body is not the focus of the field that took it', () => {
  const page = makePage();
  const field = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' } });
  page.window.__agentElements = [field];
  page.focus(page.document.body);
  const captured = page.run(TARGET, 'capture', { kind: 'focus' }, rule);
  assert.equal(captured.element.body, true);

  // The page moves the focus into a field.
  page.focus(field);
  const focus = page.run(TARGET, 'focus', { target: asTarget(captured) }, rule);
  assert.equal(focus.ok, false, 'the body does not lend its approval to a field');
  assert.equal(focus.reason, 'focus-lost');
});

test('the snapshot does not carry the value of a field that holds a secret', () => {
  const page = makePage({ text: 'The page shows ordinary words.' });
  const password = page.make({ tag: 'INPUT', type: 'password', attrs: { id: 'password', name: 'password' }, value: 'TEST_ONLY_PASSWORD' });
  const code = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'otp', 'aria-label': 'Verification code', autocomplete: 'one-time-code' }, value: 'TEST_ONLY_OTP' });
  const token = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'accessToken', 'aria-label': 'Access token' }, value: 'TEST_ONLY_TOKEN' });
  const expiry = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'expiry', 'aria-label': 'تاريخ الانتهاء' }, value: '09/30' });
  const message = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message', 'aria-label': 'Message' }, value: 'TEST_ONLY_MESSAGE' });
  page.window.__agentElements = [password, code, token, expiry, message];

  const snap = page.run(SNAPSHOT, 250, 3500, rule);
  const described = snap.elements.join('\n');

  assert.doesNotMatch(described, /TEST_ONLY_PASSWORD/, 'the password is not described');
  assert.doesNotMatch(described, /TEST_ONLY_OTP/, 'the one-time code is not described');
  assert.doesNotMatch(described, /TEST_ONLY_TOKEN/, 'the token is not described');
  assert.doesNotMatch(described, /09\/30/, 'the card expiry is not described');
  assert.match(described, /value="TEST_ONLY_MESSAGE"/, 'the value of an ordinary field is what the page shows');
  assert.match(described, /Message/, 'the ordinary label stays');
  assert.match(described, /Verification code/, 'the ordinary name of a field stays');
  assert.match(snap.text, /The page shows ordinary words/, 'the ordinary text of the page stays');
});

test('the contents of a control that holds a secret stay out of the page and its name', () => {
  const page = makePage({ text: 'A page with a secret editor in it.' });
  // An editor that holds a secret: the rule of the module names it.
  const editor = page.make({
    tag: 'DIV',
    attrs: { 'aria-label': 'Access token', role: 'textbox' },
    innerText: 'TEST_EDITOR_SECRET',
    editable: true,
  });
  // The box around it shows the text of the editor as its own.
  const wrapper = page.make({ tag: 'DIV', children: [editor] });
  Object.defineProperty(wrapper, 'innerText', { get: () => editor.innerText });
  page.window.__agentElements = [wrapper, editor];

  const snap = page.run(SNAPSHOT, 250, 3500, rule);
  const described = snap.elements.join('\n');
  assert.doesNotMatch(described, /TEST_EDITOR_SECRET/, 'the secret of the editor is not described');
  assert.doesNotMatch(snap.text, /TEST_EDITOR_SECRET/, 'the secret of the editor is not in the page text');

  const text = page.run(TEXT, 0, 4000, rule);
  assert.doesNotMatch(text.text, /TEST_EDITOR_SECRET/, 'the secret of the editor is not in the text of the page');
});

test('the page text is the text of the page: a secret shown as text is ordinary text', () => {
  const page = makePage({ text: 'Your code is TEST_ONLY_OTP today.' });
  page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'otp', 'aria-label': 'Verification code', autocomplete: 'one-time-code' }, value: 'TEST_ONLY_OTP' });

  const text = page.run(TEXT, 0, 4000, rule);
  assert.match(text.text, /Your code is/, 'the text of the page stays');
});

test('the value of an approved field is read when it is asked for by name', () => {
  const page = makePage();
  const password = page.make({ tag: 'INPUT', type: 'password', attrs: { id: 'password', name: 'password' }, value: 'TEST_ONLY_PASSWORD' });
  const button = page.make({ tag: 'BUTTON', innerText: 'Send' });
  page.window.__agentElements = [password, button];

  const captured = page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule);
  const read = page.run(TARGET, 'read', { target: asTarget(captured) }, rule);
  assert.equal(read.ok, true, 'the approved field is read');
  assert.equal(read.value, 'TEST_ONLY_PASSWORD');
  assert.equal(read.secret, true, 'it is a field that holds a secret, and it was asked for by name');

  // A field that is not a field cannot be read.
  const other = page.run(TARGET, 'capture', { kind: 'element', index: 1 }, rule);
  const refused = page.run(TARGET, 'read', { target: asTarget(other) }, rule);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not-editable');

  // A field that was taken out of the page cannot be read any more.
  password.isConnected = false;
  const gone = page.run(TARGET, 'read', { target: asTarget(captured) }, rule);
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, 'element-gone');
});

test('an element action does not fall back to the mark on the page', () => {
  const page = makePage();
  const marked = page.make({ tag: 'BUTTON', innerText: 'Send', attrs: { 'data-agent-idx': '0' } });
  page.window.__agentElements = [];

  const result = page.run(ELEMENT, 0, 'locate', null, true, rule, null);
  assert.match(result.error, /no longer exists/, 'the mark of the page is not the identity of an element');
  assert.deepEqual(marked.calls, []);
});

test('an element action checks the target in the same script that acts', () => {
  const page = makePage();
  const field = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' } });
  const other = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'other' } });
  page.window.__agentElements = [field];
  const captured = page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule);

  // The list was rebuilt while the question was open.
  page.window.__agentElements = [other];

  const refused = page.run(ELEMENT, 0, 'select-all', null, true, rule, asTarget(captured));
  assert.match(refused.error, /approved/, 'the action is refused');
  assert.deepEqual(other.calls, [], 'the other element is never touched');
});

test('a suggestion action does not fall back to the mark on the page either', () => {
  const page = makePage();
  const marked = page.make({ tag: 'INPUT', type: 'text', attrs: { 'data-agent-idx': '0' } });
  page.window.__agentElements = [];

  const result = page.run(SUGGESTION, 0, 'Delhi', 'scan', rule, null);
  assert.match(result.error, /no longer exists/);
  assert.deepEqual(marked.calls, []);
});

test('the page and the module agree on what a field that holds a secret is', () => {
  const names = ['password', 'pwd', 'cvv', 'cardNumber', 'card_number', 'credit card', 'otp', 'one-time-code',
    'verification code', 'security code', 'iban', 'account number', 'api key', 'access token', 'pin',
    'quantity', 'search', 'email', 'name', 'city', 'comment', 'pinned', 'tokenizer', 'passenger',
    'كلمة المرور', 'رمز التحقق', 'رقم البطاقة', 'رمز الأمان', 'MM/YY', 'expiry', 'تاريخ الانتهاء'];
  for (const name of names) {
    const page = makePage();
    const field = page.make({ tag: 'INPUT', type: 'text', attrs: { id: name, 'aria-label': name } });
    page.window.__agentElements = [field];
    const captured = page.run(TARGET, 'capture', { kind: 'element', index: 0 }, rule);
    const secret = isSecretField({ tag: 'INPUT', type: 'text', id: name, name, ariaLabel: name, label: name });
    assert.equal(captured.element.secret, secret, `"${name}" is ${secret ? 'a secret' : 'ordinary'} in both`);
  }
});

// The controller: the target is plain JSON, the guard is asked again right
// before the command goes out, and the tab a command acts on is the one that
// was captured when it started.

const { BrowserController } = await import('../src/browser/controller.js');

/** Chrome with one tab and one page: the scripts run in that page. */
function fakeChrome(page, { onGet = null, onDetach = null, onAttach = null } = {}) {
  const tabs = { 7: { id: 7, url: 'https://example.test/page', active: true, groupId: -1, windowId: 1, title: 'Page', status: 'complete' } };
  const commands = [];
  const calls = { grouped: 0, removed: 0, detached: 0 };
  globalThis.chrome = {
    debugger: {
      onDetach: { addListener() {} },
      attach: async () => { if (onAttach) await onAttach(); },
      detach: async () => { calls.detached += 1; if (onDetach) await onDetach(); },
      sendCommand: async ({ tabId }, method, params) => {
        commands.push({ tabId, method, params });
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
        return {};
      },
    },
    tabs: {
      onRemoved: { addListener() {} },
      get: async (id) => {
        if (onGet) await onGet(id);
        if (!tabs[id]) throw new Error(`No tab with id: ${id}.`);
        return { ...tabs[id] };
      },
      query: async () => Object.values(tabs).filter((tab) => tab.active),
      create: async ({ url }) => {
        const id = 8;
        tabs[id] = { id, url, active: false, groupId: -1, windowId: 1, title: '', status: 'complete' };
        return { ...tabs[id] };
      },
      update: async (id, props) => { Object.assign(tabs[id], props); return { ...tabs[id] }; },
      remove: async (id) => { calls.removed += 1; delete tabs[id]; },
      group: async () => { calls.grouped += 1; return 100; },
      goBack: async () => {},
      goForward: async () => {},
      reload: async () => {},
    },
    tabGroups: { update: async () => {} },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        const fn = vm.runInContext(`(${func.toString()})`, page.context);
        return [{ result: fn(...(args ?? [])) }];
      },
    },
  };
  return { tabs, commands, calls };
}

test('the controller captures a target as plain JSON, bound to the tab and the document', async () => {
  const page = makePage();
  const field = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' } });
  page.window.__agentElements = [field];
  fakeChrome(page);

  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  const target = await browser.captureTarget({ kind: 'element', index: 0 });

  assert.equal(target.tabId, 7);
  assert.equal(target.url, 'https://example.test/page');
  assert.equal(target.documentId, String(page.state.timeOrigin));
  assert.equal(target.element.index, 0);
  assert.doesNotMatch(JSON.stringify(target), /value/i);
  const round = JSON.parse(JSON.stringify(target));
  assert.deepEqual(round, { ...target, element: { ...target.element } }, 'the target is plain JSON');

  const check = await browser.validateTarget(target);
  assert.equal(check.ok, true);
});

test('the controller refuses a target whose page, tab or element is gone', async () => {
  const page = makePage();
  const field = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' } });
  page.window.__agentElements = [field];
  const { tabs } = fakeChrome(page);

  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  const target = await browser.captureTarget({ kind: 'element', index: 0 });

  field.isConnected = false;
  const gone = await browser.validateTarget(target);
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, 'element-gone');

  field.isConnected = true;
  tabs[7].url = 'https://example.test/other';
  const moved = await browser.validateTarget(target);
  assert.equal(moved.ok, false);
  assert.equal(moved.reason, 'navigated');

  delete tabs[7];
  const closed = await browser.validateTarget(target);
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, 'tab-gone');
});

test('tab consent retains document binding when a later identity read fails or returns no identity', async () => {
  const page = makePage();
  fakeChrome(page);
  const browser = new BrowserController();
  const target = await browser.captureTarget({ kind: 'tab', tabId: 7 });
  assert.ok(target.documentId);
  chrome.scripting.executeScript = async () => { throw new Error('page unavailable'); };
  assert.equal((await browser.validateTarget(target)).ok, false);
  chrome.scripting.executeScript = async () => [{ result: { ok: true } }];
  assert.equal((await browser.validateTarget(target)).ok, false);
});

test('a value is only read after it was approved', async () => {
  const page = makePage();
  const password = page.make({ tag: 'INPUT', type: 'password', attrs: { id: 'password', name: 'password' }, value: 'TEST_ONLY_PASSWORD' });
  page.window.__agentElements = [password];
  fakeChrome(page);

  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  const target = await browser.captureTarget({ kind: 'element', index: 0 });

  await assert.rejects(browser.readField(target), /readField needs a guard/, 'a value is never read without a guard');

  let asked = 0;
  const read = await browser.readField(target, { guard: async () => { asked += 1; return true; } });
  assert.equal(read.value, 'TEST_ONLY_PASSWORD');
  assert.ok(asked >= 1, 'the guard is asked before the value is read');
  assert.equal(read.secret, true);

  await assert.rejects(
    browser.readField(target, { guard: async () => false }),
    /voice\.inputCancelled/,
    'a withdrawn approval reads nothing',
  );
});

test('a value is not read when the approval is withdrawn while the page is prepared', async () => {
  const page = makePage();
  const password = page.make({ tag: 'INPUT', type: 'password', attrs: { id: 'password', name: 'password' }, value: 'TEST_ONLY_PASSWORD' });
  page.window.__agentElements = [password];
  fakeChrome(page);

  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  const target = await browser.captureTarget({ kind: 'element', index: 0 });

  let permit = true;
  const original = browser.pinnedTab.bind(browser);
  let count = 0;
  let release;
  let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { reached = resolve; });
  browser.pinnedTab = async (...args) => {
    const tab = await original(...args);
    if (++count === 2) {
      reached();
      await gate;
    }
    return tab;
  };

  const pending = browser.readField(target, { guard: () => permit })
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: error.message }));
  await ready;
  permit = false;
  release();

  const result = await pending;
  assert.equal(result.ok, false, 'the value is not read after the approval was withdrawn');
  assert.doesNotMatch(JSON.stringify(result), /TEST_ONLY_PASSWORD/, 'the value never left the page');
});

test('the command does not go out when the approval is withdrawn while the page is checked', async () => {
  const page = makePage();
  const { commands } = fakeChrome(page);
  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  await browser.startOn();

  let permit = true;
  let blocked = false;
  try {
    await browser.cdp('Input.insertText', { text: 'must not dispatch' }, {
      guard: () => permit,
      precheck: async () => {
        await Promise.resolve();
        permit = false; // the approval is withdrawn while the page is checked
        return true;
      },
    });
  } catch {
    blocked = true;
  }
  assert.equal(blocked, true, 'the command was refused');
  assert.equal(commands.filter((command) => command.method === 'Input.insertText').length, 0, 'nothing went out');
});

test('text goes only into the field that was approved', async () => {
  const page = makePage();
  const approved = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'message' } });
  const other = page.make({ tag: 'INPUT', type: 'text', attrs: { id: 'other' } });
  page.window.__agentElements = [approved, other];
  page.focus(approved);
  const { commands } = fakeChrome(page);

  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  const target = await browser.captureTarget({ kind: 'focus' });

  // The page moves the focus to another field while the question is open.
  page.focus(other);

  await assert.rejects(
    browser.insertText('hello', { target }),
    /voice\.inputCancelled/,
    'the text does not follow the focus to another field',
  );
  assert.equal(commands.filter((command) => command.method === 'Input.insertText').length, 0, 'no text went out');

  // With the focus where it was, the text goes out.
  page.focus(approved);
  await browser.insertText('hello', { target });
  const typed = commands.filter((command) => command.method === 'Input.insertText');
  assert.equal(typed.length, 1);
  assert.equal(typed[0].params.text, 'hello');
});

test('Enter on the body is an ordinary thing to do', async () => {
  const page = makePage();
  page.focus(page.document.body);
  const { commands } = fakeChrome(page);

  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  const target = await browser.captureTarget({ kind: 'focus' });
  assert.equal(target.element.body, true);

  await browser.pressKey('Enter', { target, wait: false });
  const keys = commands.filter((command) => command.method === 'Input.dispatchKeyEvent');
  assert.equal(keys.length, 2, 'the key goes down and comes up again');
  assert.equal(keys[0].params.key, 'Enter');
});

test('the guard is asked again right before the command goes out', async () => {
  const page = makePage();
  const { commands } = fakeChrome(page);
  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  await browser.startOn();

  let asked = 0;
  await browser.clickAt(10, 20, { guard: async () => { asked += 1; return true; }, wait: false });
  assert.ok(asked >= 3, `the guard is asked before the move, after the attach and before the press (${asked})`);

  const before = commands.length;
  const refused = [];
  await browser.clickAt(10, 20, { guard: async () => false, wait: false }).catch((err) => refused.push(err.message));
  assert.equal(refused.length, 1);
  assert.match(refused[0], /voice\.inputCancelled/);
  assert.equal(commands.length, before, 'nothing went out to the page');
});

test('a command acts on the tab it captured, not on a tab that was taken meanwhile', async () => {
  const page = makePage();
  const { tabs, commands } = fakeChrome(page);
  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  await browser.startOn();

  const target = await browser.captureTarget({ kind: 'focus' });
  assert.equal(target.tabId, 7);

  // Another tab joins the session while the command waits.
  tabs[8] = { id: 8, url: 'https://example.test/other', active: false, groupId: 100, windowId: 1, title: 'Other', status: 'complete' };
  await browser.useTab(8);

  await browser.clickAt(10, 20, { wait: false, tabId: target.tabId });
  const click = commands.filter((command) => command.method === 'Input.dispatchMouseEvent');
  assert.ok(click.length > 0);
  for (const command of click) assert.equal(command.tabId, 7, 'the click went to the tab it captured');
});

test('the hover keeps its guard while the debugger is attached', async () => {
  const page = makePage();
  let permit = true;
  const { commands } = fakeChrome(page, { onAttach: () => { permit = false; } });
  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  await browser.startOn();

  await assert.rejects(browser.hoverAt(5, 5, { guard: () => permit }), /voice\.inputCancelled/);
  assert.equal(commands.filter((command) => command.method === 'Input.dispatchMouseEvent').length, 0, 'the mouse did not move');
});

test('the scroll keeps its guard through the last lookup of the tab', async () => {
  const page = makePage();
  const { commands } = fakeChrome(page);
  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  await browser.startOn();

  let permit = true;
  const original = browser.pinnedTab.bind(browser);
  let lookups = 0;
  browser.pinnedTab = async (...args) => {
    const tab = await original(...args);
    if (++lookups === 3) permit = false; // the approval is withdrawn while the tab is looked up
    return tab;
  };

  await assert.rejects(browser.scroll(1, null, { guard: () => permit }), /voice\.inputCancelled/);
  assert.equal(commands.filter((command) => command.method === 'Input.dispatchMouseEvent').length, 0, 'the page did not scroll');
});

test('a tab is not grouped when the approval is withdrawn while it is looked up', async () => {
  const page = makePage();
  let permit = true;
  const { tabs, calls } = fakeChrome(page, { onGet: () => { permit = false; } });
  tabs[8] = { id: 8, url: 'https://example.test/other', active: false, groupId: -1, windowId: 1, title: 'Other', status: 'complete' };
  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  browser.tabId = 7;

  await assert.rejects(browser.useTab(8, { guard: () => permit }), /voice\.inputCancelled/);
  assert.equal(calls.grouped, 0, 'the tab was not grouped');
  assert.equal(browser.tabId, 7, 'the session kept the tab it works on');
});

test('an explicit close is refused after the debugger was detached', async () => {
  const page = makePage();
  let permit = true;
  const { calls } = fakeChrome(page, { onDetach: () => { permit = false; } });
  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  browser.tabId = 7;
  browser.attached.add(8);
  browser.disposable.add(8);

  await assert.rejects(browser.closeOwnedTab(8, { guard: () => permit }), /voice\.inputCancelled/);
  assert.equal(calls.removed, 0, 'the tab was not closed');
  assert.equal(browser.disposable.has(8), true, 'the tab is not forgotten as though it had closed');
});

test('a tab target names the tab without taking it', async () => {
  const page = makePage();
  const { tabs, calls } = fakeChrome(page);
  tabs[8] = { id: 8, url: 'https://example.test/other', active: false, groupId: -1, windowId: 1, title: 'Other', status: 'complete' };
  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  browser.tabId = 7;

  const target = await browser.captureTarget({ kind: 'tab', tabId: 8 });
  assert.equal(target.scope, 'tab');
  assert.equal(target.tabId, 8);
  assert.equal(target.element, null, 'a tab target names no element');
  assert.equal(browser.tabId, 7, 'the session kept the tab it works on');
  assert.equal(calls.grouped, 0, 'the tab was not grouped');

  const check = await browser.validateTarget(target);
  assert.equal(check.ok, true, 'the tab is still the tab that was named');
});

test('an element capture that fails stays an element target', async () => {
  const page = makePage();
  fakeChrome(page);
  const browser = new BrowserController({ title: 'Test', isTakenByOther: () => null });
  await browser.startOn();

  const target = await browser.captureTarget({ kind: 'element', index: 99 });
  assert.equal(target.scope, 'element');
  assert.equal(target.element, null);
  const check = await browser.validateTarget(target);
  assert.equal(check.ok, false, 'a failed capture is not widened into a tab target');
  assert.equal(check.reason, 'no-element');
});
