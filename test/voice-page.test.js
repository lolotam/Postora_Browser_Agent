import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pageProbe, scrollPage, mediaControl, findText } from '../src/voice/voice-page.js';
import { isSecretField, secretRule } from '../src/voice/voice-safety.js';

// The real page script, run in a page of its own: it is the function that is
// injected into the browser, so what it leaves out is what the model never
// sees.
const PROBE = pageProbe.toString();

test('injected reads and mutations reject a replacement document before touching it', async () => {
  const context = vm.createContext({ performance: { timeOrigin: 2 } });
  for (const [fn, args] of [
    [pageProbe, ['read', { id: 'old-field', documentId: '1' }, secretRule()]],
    [scrollPage, ['down', '1']],
    [mediaControl, ['toggle', '1']],
    [findText, ['private text', '1']],
  ]) {
    const injected = vm.runInContext(`(${fn.toString()})`, context);
    // No document/window is even supplied: the stale action must return before
    // resolving a field, querying media, scrolling or changing a selection.
    const result = await injected(...args);
    assert.equal(result.ok, false);
    assert.equal(result.errorKey, 'voice.pageGone');
  }
});

/** One element of the fake page: its box, its attributes and its text. */
function element({ tag = 'DIV', type = '', attrs = {}, text = '', rect = {}, labels = [], editable = false, purposes = ['click'], children = [], connected = true, value = '' } = {}) {
  const el = {
    tagName: tag,
    type,
    attrs: { ...attrs },
    innerText: text,
    textContent: text,
    childNodes: [{ nodeType: 3, textContent: text }, ...children],
    isContentEditable: editable,
    disabled: false,
    readOnly: false,
    value,
    labels,
    purposes,
    children,
    isConnected: connected,
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

/**
 * The page the script sees. The scope holds the world of the extension: the
 * elements it collected are kept there, and the page cannot reach them.
 */
function scope(elements, { active = null } = {}) {
  const body = element({ tag: 'BODY' });
  const doc = {
    activeElement: active,
    body,
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
    // The element that is under the point that would be clicked.
    elementFromPoint: (x, y) => elements.find((el) => {
      const r = el.rect;
      return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    }) ?? null,
  };
  const win = { innerHeight: 800, innerWidth: 600, scrollY: 0 };
  const context = vm.createContext({
    document: doc,
    window: win,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  });
  return { context, doc, win };
}

const rule = secretRule();

/** Runs the injected script in a page of its own. */
function probe(elements, kind, arg, { active = null, scope: shared = null } = {}) {
  const world = shared ?? scope(elements, { active });
  const fn = world.context.__probe ?? vm.runInContext(`(${PROBE})`, world.context);
  world.context.__probe = fn;
  return { result: fn(kind, arg, rule), scope: world };
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

test('a field that holds a secret is named, and its value never travels with it', () => {
  const cvv = element({ tag: 'INPUT', type: 'text', attrs: { id: 'cvv', name: 'cvv' }, purposes: ['type'], value: '4111' });
  const card = element({ tag: 'INPUT', type: 'text', attrs: { id: 'cardNumber' }, purposes: ['type'], value: '4111 1111 1111 1111' });
  const otp = element({ tag: 'INPUT', type: 'text', attrs: { 'aria-label': 'Enter the OTP code' }, purposes: ['type'], value: '123456' });
  const quantity = element({ tag: 'INPUT', type: 'number', attrs: { id: 'quantity', name: 'quantity' }, purposes: ['type'] });
  const result = collect([cvv, card, otp, quantity], 'type');

  // A field that holds a secret is a candidate like any other: the user has
  // to be able to say which field they mean.
  assert.equal(result.length, 4, 'every field is a candidate');
  assert.equal(result.filter((field) => field.secret).length, 3, 'the secret ones are marked as secret');
  assert.ok(result.some((field) => /quantity/i.test(field.label)), 'an ordinary number field stays usable');
  // What is in them never travels: not the value, not a draft.
  const shown = JSON.stringify(result);
  assert.doesNotMatch(shown, /4111/, 'no value of a secret field is described');
  assert.doesNotMatch(shown, /123456/, 'no one-time code is described');
});

test('the page and the module agree on what a secret field is', () => {
  const names = ['password', 'pwd', 'cvv', 'cardNumber', 'card_number', 'credit card', 'otp', 'one-time-code',
    'verification code', 'security code', 'iban', 'account number', 'api key', 'access token', 'pin',
    'quantity', 'search', 'email', 'name', 'city', 'comment', 'pinned', 'tokenizer', 'passenger'];
  for (const name of names) {
    const field = element({ tag: 'INPUT', type: 'text', attrs: { id: name }, purposes: ['type'] });
    const found = collect([field], 'type')[0] ?? null;
    const secret = isSecretField({ tag: 'INPUT', type: 'text', id: name, name: name, label: name });
    assert.ok(found, `"${name}" is on the page`);
    assert.equal(Boolean(found.secret), secret, `"${name}" is ${secret ? 'a secret' : 'ordinary'} in both`);
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

test('an element is located by its mark, and a secret one is reported as one', () => {
  const button = element({ tag: 'BUTTON', text: 'Go', purposes: ['click'] });
  const world = scope([button]);
  const collected = probe([button], 'collect', { purpose: 'click' }, { scope: world }).result;
  const spot = probe([button], 'locate', { id: collected[0].id }, { scope: world }).result;

  assert.equal(spot.ok, true);
  assert.equal(spot.x, 80, 'the middle of the element');
  assert.equal(spot.y, 22);

  // A field that was collected as ordinary and turned secret in the meantime
  // is reported as a secret when the action is about to happen: the worker
  // asks the user about that field, and the value never travels.
  const field = element({ tag: 'INPUT', type: 'text', attrs: { id: 'pw' }, purposes: ['type'] });
  const fieldWorld = scope([field]);
  const fieldCollected = probe([field], 'collect', { purpose: 'type' }, { scope: fieldWorld }).result;
  field.type = 'password'; // the page turned it into a password box
  const flagged = probe([field], 'locate', { id: fieldCollected[0].id }, { scope: fieldWorld }).result;
  assert.equal(flagged.ok, true);
  assert.equal(flagged.secret, true);
});

test('the identity of an element is the element itself, not the mark on it', () => {
  const field = element({ tag: 'INPUT', type: 'text', attrs: { id: 'email' }, purposes: ['type'] });
  const world = scope([field]);
  const collected = probe([field], 'collect', { purpose: 'type' }, { scope: world }).result;
  const id = collected[0].id;

  // The page replaces the element with a twin that carries the same mark.
  const twin = element({ tag: 'INPUT', type: 'text', attrs: { id: 'email', 'data-voice-id': id }, purposes: ['type'], rect: { left: 300 } });
  field.isConnected = false;

  const spot = probe([twin], 'resolve', { id }, { scope: world }).result;
  assert.equal(spot.ok, false, 'the mark alone does not make it the same element');
  assert.equal(spot.errorKey, 'voice.pageGone');
});

test('an element that was taken out of the page is gone, even with its mark', () => {
  const field = element({ tag: 'INPUT', type: 'text', attrs: { id: 'email' }, purposes: ['type'], connected: false });
  const world = scope([field]);
  const collected = probe([field], 'collect', { purpose: 'type' }, { scope: world }).result;
  const spot = probe([field], 'resolve', { id: collected[0].id }, { scope: world }).result;

  assert.equal(spot.ok, false);
  assert.equal(spot.errorKey, 'voice.pageGone');
});

test('something that covers the element does not get the click', () => {
  const field = element({ tag: 'INPUT', type: 'text', attrs: { id: 'email' }, purposes: ['type'] });
  const overlay = element({ tag: 'DIV', text: 'overlay', purposes: [] });
  const world = scope([field, overlay]);
  const collected = probe([field, overlay], 'collect', { purpose: 'type' }, { scope: world }).result;
  // The overlay lies over the field.
  overlay.rect = { ...field.rect };
  world.doc.elementFromPoint = () => overlay;

  const spot = probe([field, overlay], 'locate', { id: collected[0].id }, { scope: world }).result;
  assert.equal(spot.ok, false);
  assert.equal(spot.errorKey, 'voice.pageMoved');
});

test('the capture of an element changes nothing on the page', () => {
  const field = element({ tag: 'INPUT', type: 'text', attrs: { id: 'email' }, purposes: ['type'] });
  let scrolled = 0;
  field.scrollIntoView = () => { scrolled += 1; };
  const world = scope([field]);
  const collected = probe([field], 'collect', { purpose: 'type' }, { scope: world }).result;

  // The capture is what happens before the question is asked: it may not move
  // anything on the page.
  const spot = probe([field], 'resolve', { id: collected[0].id }, { scope: world }).result;
  assert.equal(spot.ok, true);
  assert.equal(scrolled, 0, 'the element was brought into view before the answer');

  // The place of the element is only needed when the action goes out.
  const located = probe([field], 'locate', { id: collected[0].id }, { scope: world }).result;
  assert.equal(located.ok, true);
  assert.equal(scrolled, 1, 'the element is brought into view when the action goes out');
});

test('the focus is checked against the element that was approved', () => {
  const field = element({ tag: 'INPUT', type: 'text', attrs: { id: 'email' }, purposes: ['type'] });
  const other = element({ tag: 'INPUT', type: 'password', attrs: { id: 'pw' }, purposes: ['type'] });
  const world = scope([field, other], { active: other });
  const collected = probe([field, other], 'collect', { purpose: 'type' }, { scope: world }).result;

  const lost = probe([field, other], 'focus', { id: collected[0].id }, { scope: world }).result;
  assert.equal(lost.ok, false, 'the focus went to another field');
  assert.equal(lost.errorKey, 'voice.pageFocusLost');

  // Without an identity nothing is approved: there is no fallback to
  // whatever has the focus now.
  const unknown = probe([field, other], 'focus', { id: null }, { scope: world }).result;
  assert.equal(unknown.ok, false, 'the focus was not approved for anything');
  assert.equal(unknown.errorKey, 'voice.pageFocusLost');
});

test('the body is named like every other element, and it is approved as itself', () => {
  const button = element({ tag: 'BUTTON', text: 'Go', purposes: ['click'] });
  const world = scope([button]);
  world.doc.activeElement = world.doc.body;

  const focused = probe([button], 'focused', null, { scope: world }).result;
  assert.ok(focused.id, 'the body is named, so an approved Enter is tied to it');
  assert.equal(focused.editable, false);
  assert.equal(focused.secret, false, 'the body is not a secret field');
  assert.equal(focused.label, undefined, 'the body is never described: its text is the text of the page');

  const onBody = probe([button], 'focus', { id: focused.id }, { scope: world }).result;
  assert.equal(onBody.ok, true, 'the body that has the focus is the one that was approved');
  assert.equal(onBody.body, true);
});

test('the body does not lend its approval to a field that has the focus now', () => {
  const field = element({ tag: 'INPUT', type: 'text', attrs: { id: 'email' }, purposes: ['type'] });
  const world = scope([field]);
  world.doc.activeElement = world.doc.body;
  const focused = probe([field], 'focused', null, { scope: world }).result;

  // The focus moves to an ordinary field while the question is open.
  world.doc.activeElement = field;
  const moved = probe([field], 'focus', { id: focused.id }, { scope: world }).result;
  assert.equal(moved.ok, false, 'a child of the body does not inherit the approval');
  assert.equal(moved.errorKey, 'voice.pageFocusLost');
});

test('the body of another document is not the body that was approved', () => {
  const field = element({ tag: 'INPUT', type: 'text', attrs: { id: 'email' }, purposes: ['type'] });
  const world = scope([field]);
  world.doc.activeElement = world.doc.body;
  const focused = probe([field], 'focused', null, { scope: world }).result;

  // The page is replaced: the body that was approved is gone with it.
  world.doc.body.isConnected = false;
  world.doc.activeElement = null;
  const gone = probe([field], 'focus', { id: focused.id }, { scope: world }).result;
  assert.equal(gone.ok, false);
  assert.equal(gone.errorKey, 'voice.pageGone');
});

test('a secret field that has the focus is reported, and its value never travels', () => {
  const secret = element({ tag: 'INPUT', type: 'password', attrs: { id: 'pw' }, purposes: ['type'], value: 'hunter2' });
  const world = scope([secret], { active: secret });
  const focused = probe([secret], 'focused', null, { scope: world }).result;
  assert.equal(focused.secret, true);
  assert.ok(focused.id, 'the element that has the focus is named');
  assert.doesNotMatch(JSON.stringify(focused), /hunter2/, 'no value travels with the name');

  const check = probe([secret], 'focus', { id: focused.id }, { scope: world }).result;
  assert.equal(check.ok, true, 'the focus is still the one that was named');
  assert.equal(check.secret, true);
});

test('the page and the module agree on the secret fields of a page in Arabic', () => {
  const names = ['كلمة المرور', 'رمز التحقق', 'رقم البطاقة', 'رمز الأمان', 'MM/YY', 'expiry',
    'quantity', 'search', 'email', 'comment'];
  for (const name of names) {
    const field = element({ tag: 'INPUT', type: 'text', attrs: { id: name }, purposes: ['type'] });
    const found = collect([field], 'type')[0] ?? null;
    const secret = isSecretField({ tag: 'INPUT', type: 'text', id: name, name, label: name });
    assert.ok(found, `"${name}" is on the page`);
    assert.equal(Boolean(found.secret), secret, `"${name}" is ${secret ? 'a secret' : 'ordinary'} in both`);
  }
});

test('a card expiry and a one-time code are secrets, an ordinary field is not', () => {
  const expiry = element({ tag: 'INPUT', type: 'text', attrs: { id: 'MM/YY', name: 'MM/YY' }, purposes: ['type'] });
  const code = element({ tag: 'INPUT', type: 'text', attrs: { 'aria-label': 'رمز التحقق' }, purposes: ['type'] });
  const quantity = element({ tag: 'INPUT', type: 'number', attrs: { id: 'quantity', name: 'quantity' }, purposes: ['type'] });
  const search = element({ tag: 'INPUT', type: 'search', attrs: { id: 'search', name: 'search' }, purposes: ['type'] });

  const result = collect([expiry, code, quantity, search], 'type');

  assert.equal(result.length, 4, 'every field is a candidate');
  assert.equal(result.filter((field) => field.secret).length, 2, 'the expiry and the code are secrets');
  assert.ok(result.some((field) => /quantity/i.test(field.label)));
  assert.ok(result.some((field) => /search/i.test(field.label)));
});

test('the expiry of a card in Arabic is a secret, and an ordinary field stays usable', () => {
  const names = ['تاريخ الانتهاء', 'انتهاء الصلاحية', 'تاريخ انتهاء الصلاحية'];
  for (const name of names) {
    const field = element({ tag: 'INPUT', type: 'text', attrs: { 'aria-label': name }, purposes: ['type'] });
    const found = collect([field], 'type')[0] ?? null;
    assert.ok(found, `"${name}" is on the page`);
    assert.equal(found.secret, true, `"${name}" is a secret in the page too`);
    assert.equal(isSecretField({ tag: 'INPUT', type: 'text', ariaLabel: name, label: name }), true,
      `"${name}" is a secret in the module too`);
  }
  const quantity = element({ tag: 'INPUT', type: 'number', attrs: { id: 'quantity' }, purposes: ['type'] });
  const search = element({ tag: 'INPUT', type: 'search', attrs: { id: 'search' }, purposes: ['type'] });
  const email = element({ tag: 'INPUT', type: 'email', attrs: { id: 'email' }, purposes: ['type'] });
  const result = collect([quantity, search, email], 'type');
  assert.equal(result.length, 3, 'the ordinary fields stay usable');
});

test('a field that becomes a card expiry in Arabic is reported when the action is about to happen', () => {
  const field = element({ tag: 'INPUT', type: 'text', attrs: { id: 'plain' }, purposes: ['type'] });
  const world = scope([field]);
  const collected = probe([field], 'collect', { purpose: 'type' }, { scope: world }).result;
  assert.equal(collected[0].secret, false, 'the field was ordinary when it was collected');

  field.attrs['aria-label'] = 'تاريخ الانتهاء';
  const flagged = probe([field], 'locate', { id: collected[0].id }, { scope: world }).result;
  assert.equal(flagged.ok, true);
  assert.equal(flagged.secret, true, 'the worker is told that the field holds a secret now');
});

test('the label a field really has is kept apart from the label the model reads', () => {
  const plain = element({ tag: 'INPUT', type: 'text', attrs: { id: 'note' }, purposes: ['type'] });
  const world = scope([plain]);
  const collected = probe([plain], 'collect', { purpose: 'type' }, { scope: world }).result;

  assert.equal(collected[0].label, '(unlabeled field)', 'the model reads a fallback');
  assert.equal(collected[0].identityLabel, '', 'the element keeps the label it really has');

  const spot = probe([plain], 'resolve', { id: collected[0].id, expected: { kind: 'text input', label: '' } }, { scope: world }).result;
  assert.equal(spot.ok, true, 'an empty label is a label too');

  // The label of the element drifts: the consent does not follow it.
  plain.attrs['aria-label'] = 'Your note';
  const drifted = probe([plain], 'resolve', { id: collected[0].id, expected: { kind: 'text input', label: '' } }, { scope: world }).result;
  assert.equal(drifted.ok, false, 'a label that drifted is refused');
});

test('two links with the same address keep separate labels and approved DOM identities', () => {
  const first = element({ tag: 'A', text: 'Item', attrs: { href: '/page?merged' }, purposes: ['click'] });
  const second = element({ tag: 'A', text: 'Detailed item title', attrs: { href: '/page?merged' }, purposes: ['click'], rect: { left: 300 } });
  const world = scope([first, second]);
  const collected = probe([first, second], 'collect', { purpose: 'click' }, { scope: world }).result;

  assert.equal(collected.length, 2, 'different handlers may live on links with the same href');
  assert.equal(collected[0].label, 'Item');
  assert.equal(collected[0].identityLabel, 'Item', 'the identity keeps the label of the element');
  assert.equal(collected[1].label, 'Detailed item title');
  assert.equal(collected[1].identityLabel, 'Detailed item title');
  assert.notEqual(collected[0].id, collected[1].id);
  const detailed = probe([first, second], 'locate', { id: collected[1].id, expected: { kind: 'link', label: 'Detailed item title' } }, { scope: world }).result;
  assert.equal(detailed.ok, true);
  assert.equal(detailed.x, 360, 'the title selects the second DOM element, not the first href match');

  const spot = probe([first, second], 'locate', { id: collected[0].id, expected: { kind: 'link', label: 'Item' } }, { scope: world }).result;
  assert.equal(spot.ok, true, 'the element that was collected is the one that is clicked');

  // The label of that element drifts: the consent does not follow the label.
  first.innerText = 'Something else';
  first.childNodes[0].textContent = 'Something else';
  const drifted = probe([first, second], 'locate', { id: collected[0].id, expected: { kind: 'link', label: 'Item' } }, { scope: world }).result;
  assert.equal(drifted.ok, false, 'a label that drifted is refused');
});
