import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pageProbe } from '../src/voice/voice-page.js';
import { isSecretField, secretRule } from '../src/voice/voice-safety.js';

// The real page script, run in a page of its own: it is the function that is
// injected into the browser, so what it leaves out is what the model never
// sees.
const PROBE = pageProbe.toString();

/** One element of the fake page: its box, its attributes and its text. */
function element({ tag = 'DIV', type = '', attrs = {}, text = '', rect = {}, labels = [], editable = false, purposes = ['click'], children = [] } = {}) {
  const el = {
    tagName: tag,
    type,
    attrs: { ...attrs },
    innerText: text,
    textContent: text,
    childNodes: [{ nodeType: 3, textContent: text }, ...children],
    isContentEditable: editable,
    disabled: false,
    labels,
    purposes,
    children,
    rect: { width: 120, height: 24, top: 10, left: 20, bottom: 34, right: 140, ...rect },
    getAttribute: (name) => (name in el.attrs ? el.attrs[name] : null),
    setAttribute: (name, value) => { el.attrs[name] = String(value); },
    removeAttribute: (name) => { delete el.attrs[name]; },
    hasAttribute: (name) => name in el.attrs,
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView: () => {},
    getBoundingClientRect: () => el.rect,
    contains: (node) => node === el || el.children.includes(node),
  };
  return el;
}

/** A label element: its own text, and the field it labels. */
function label(text, field = null) {
  const el = element({ tag: 'LABEL', text, children: field ? [field] : [] });
  el.contains = (node) => node === field || el.children.includes(node);
  return el;
}

/** The page the script sees. */
function page(elements, { active = null } = {}) {
  const doc = {
    activeElement: active,
    body: element({ tag: 'BODY' }),
    querySelectorAll: (selector) => {
      if (selector.includes('data-voice-id')) return elements.filter((el) => el.attrs['data-voice-id'] !== undefined);
      const purpose = selector.includes('[contenteditable') ? 'type' : 'click';
      return elements.filter((el) => el.purposes.includes(purpose));
    },
    querySelector: (selector) => {
      const match = /\[data-voice-id="([^"]+)"\]/.exec(selector);
      if (match) return elements.find((el) => el.attrs['data-voice-id'] === match[1]) ?? null;
      return doc.querySelectorAll(selector)[0] ?? null;
    },
    getElementById: (id) => elements.find((el) => el.attrs.id === id) ?? null,
  };
  const win = { innerHeight: 800, innerWidth: 600, scrollY: 0 };
  const globals = {
    document: doc,
    window: win,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  };
  return { ...globals, doc, win };
}

const rule = secretRule();

/** Runs the injected script in a page of its own. */
function probe(elements, kind, arg, { active = null } = {}) {
  const scope = page(elements, { active });
  const context = vm.createContext({
    document: scope.doc,
    window: scope.win,
    getComputedStyle: scope.getComputedStyle,
  });
  const fn = vm.runInContext(`(${PROBE})`, context);
  return { result: fn(kind, arg, rule), scope };
}

function collect(elements, purpose, options = {}) {
  return probe(elements, 'collect', { purpose }, options).result;
}

test('a draft in an editable field is never used as its label', () => {
  const draft = element({ tag: 'DIV', editable: true, text: 'my private draft', purposes: ['type'] });
  const area = element({ tag: 'TEXTAREA', text: 'another private draft', purposes: ['type'] });
  const result = collect([draft, area], 'type');

  assert.equal(result.length, 2, 'the fields are still there');
  for (const field of result) {
    assert.doesNotMatch(field.label, /draft/, 'the text in the field is not a label');
    assert.equal(field.label, '(unlabeled field)');
  }
  assert.doesNotMatch(JSON.stringify(result), /private/, 'no draft travels out of the page');
});

test('a label of an editable field is a label, not the text in it', () => {
  const field = element({ tag: 'DIV', editable: true, text: 'the draft', purposes: ['type'] });
  const named = label('Your email', field);
  field.labels = [named];
  const result = collect([field], 'type');

  assert.equal(result[0].label, 'Your email');
  assert.doesNotMatch(result[0].label, /draft/);
});

test('an ordinary button keeps its own text as its label', () => {
  const button = element({ tag: 'BUTTON', text: 'Sign in', purposes: ['click'] });
  const result = collect([button], 'click');

  assert.equal(result[0].label, 'Sign in');
});

test('a field that holds a secret is left out of the page, and an ordinary one is not', () => {
  const cvv = element({ tag: 'INPUT', type: 'text', attrs: { id: 'cvv', name: 'cvv' }, purposes: ['type'] });
  const card = element({ tag: 'INPUT', type: 'text', attrs: { id: 'cardNumber' }, purposes: ['type'] });
  const otp = element({ tag: 'INPUT', type: 'text', attrs: { 'aria-label': 'Enter the OTP code' }, purposes: ['type'] });
  const quantity = element({ tag: 'INPUT', type: 'number', attrs: { id: 'quantity', name: 'quantity' }, purposes: ['type'] });
  const result = collect([cvv, card, otp, quantity], 'type');

  const labels = result.map((field) => field.label);
  assert.ok(!labels.some((text) => /cvv/i.test(text)), 'the card code is not described');
  assert.ok(!labels.some((text) => /card/i.test(text)), 'the card number is not described');
  assert.ok(!labels.some((text) => /otp/i.test(text)), 'the one-time code is not described');
  assert.ok(labels.some((text) => /quantity/i.test(text)), 'an ordinary number field stays usable');
});

test('the page and the module agree on what a secret field is', () => {
  const names = ['password', 'pwd', 'cvv', 'cardNumber', 'card_number', 'credit card', 'otp', 'one-time-code',
    'verification code', 'security code', 'iban', 'account number', 'api key', 'access token', 'pin',
    'quantity', 'search', 'email', 'name', 'city', 'comment', 'pinned', 'tokenizer', 'passenger'];
  for (const name of names) {
    const field = element({ tag: 'INPUT', type: 'text', attrs: { id: name }, purposes: ['type'] });
    const described = collect([field], 'type').length > 0;
    const secret = isSecretField({ tag: 'INPUT', type: 'text', id: name, name: name, label: name });
    assert.equal(described, !secret, `"${name}" is ${secret ? 'a secret' : 'ordinary'} in both`);
  }
});

test('the field that has the focus is marked among the fields of the page', () => {
  const first = element({ tag: 'INPUT', type: 'text', attrs: { id: 'search', placeholder: 'Search' }, purposes: ['type'] });
  const second = element({ tag: 'INPUT', type: 'text', attrs: { id: 'email', placeholder: 'Email' }, purposes: ['type'] });
  const result = collect([first, second], 'type', { active: second });

  assert.equal(result.find((field) => field.id === second.attrs['data-voice-id'])?.focused, true);
  assert.equal(result.find((field) => field.id === first.attrs['data-voice-id'])?.focused, false);
});

test('the field that has the focus is reported as editable, and a secret one as a secret', () => {
  const field = element({ tag: 'INPUT', type: 'text', attrs: { id: 'search' }, purposes: ['type'] });
  const focused = probe([field], 'focused', null, { active: field }).result;
  assert.equal(focused.editable, true);
  assert.equal(focused.secret, false);

  const secret = element({ tag: 'INPUT', type: 'password', attrs: { id: 'pw' }, purposes: ['type'] });
  assert.equal(probe([secret], 'focused', null, { active: secret }).result.secret, true);
});

test('an element is located by its mark, and a secret one is not', () => {
  const button = element({ tag: 'BUTTON', text: 'Go', purposes: ['click'] });
  const collected = collect([button], 'click');
  const spot = probe([button], 'locate', { id: collected[0].id }).result;

  assert.equal(spot.ok, true);
  assert.equal(spot.x, 80, 'the middle of the element');
  assert.equal(spot.y, 22);

  // A field that was collected as ordinary and turned secret in the meantime
  // is still refused when the action is about to happen.
  const secret = element({ tag: 'INPUT', type: 'password', attrs: { id: 'pw', 'data-voice-id': '1' }, purposes: ['type'] });
  const refused = probe([secret], 'locate', { id: '1' }).result;
  assert.equal(refused.ok, false);
  assert.equal(refused.errorKey, 'voice.pageSecret');
});
