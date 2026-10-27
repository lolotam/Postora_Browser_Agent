import { test } from 'node:test';
import assert from 'node:assert/strict';

import { APPROVAL_RESPONSE, REQUEST_EVENT, SETTLED_EVENT, createPermissionUi } from '../src/sidepanel/permissions.js';

// A DOM with just enough of itself to draw in. It is deliberately plainer
// than a browser: the helper may only use what a real element offers.
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
    this.type = '';
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

  /** The helper may never build markup out of a word from the worker. */
  get innerHTML() {
    return this._innerHTML ?? '';
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.ownerDocument?.violations.push('innerHTML');
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
    this.violations = [];
  }

  createElement(tag) {
    return new FakeNode(tag, this);
  }
}

/** A request as the worker publishes it: safe metadata and nothing else. */
function makeRequest(overrides = {}) {
  return {
    id: 'req-1',
    sessionId: 'session-a',
    revision: 7,
    action: 'click',
    kind: 'interact',
    origin: 'https://example.com',
    label: 'the blue Send button',
    ...overrides,
  };
}

/** A translator that says what it was asked for, so a test can read it. */
function makeTranslator() {
  const keys = [];
  const t = (key, vars) => {
    keys.push(key);
    return vars ? `${key}[${JSON.stringify(vars)}]` : key;
  };
  t.keys = keys;
  return t;
}

/** A panel with one chat, one revision and one connection. */
function makeScene({ t, sessionId = 'session-a', revision = 7, send } = {}) {
  const doc = new FakeDocument();
  const container = doc.createElement('div');
  const translator = t ?? makeTranslator();
  const sent = [];
  const state = {
    sessionId,
    revision,
    port: { name: 'port-1' },
  };
  const ui = createPermissionUi({
    container,
    t: translator,
    getSessionId: () => state.sessionId,
    getConnection: () => state.port,
    getRevision: () => state.revision,
    send: send ?? ((message, options) => {
      sent.push({ message, options });
      return Promise.resolve(true);
    }),
  });
  return {
    ui,
    container,
    doc,
    sent,
    state,
    t: translator,
    /** The card that is on screen, if there is one. */
    card() {
      return container.children.find((node) => node.className.split(' ').includes('permission-request')) ?? null;
    },
    /** A button of the card, by its class. */
    button(name) {
      const card = this.card();
      if (!card) return null;
      return card.all().find((node) => node.className.split(' ').includes(name)) ?? null;
    },
    /** The text of every element with a class, in the order they were drawn. */
    texts(name) {
      return container.all().filter((node) => node.className.split(' ').includes(name)).map((node) => node.textContent);
    },
  };
}

test('a request for the live chat is drawn with its words', () => {
  const scene = makeScene();
  assert.equal(scene.ui.apply(makeRequest()), true);

  const card = scene.card();
  assert.ok(card, 'the request is on screen');
  assert.equal(card.getAttribute('role'), 'group', 'the card is a group, not a div with a click handler');
  assert.equal(card.getAttribute('aria-labelledby'), scene.texts('permission-title')[0] ? card.getAttribute('aria-labelledby') : null);
  assert.ok(card.getAttribute('aria-labelledby'), 'the group is named by its heading');

  const heading = card.all().find((node) => node.tagName === 'H3');
  assert.ok(heading, 'the card has a heading');
  assert.equal(heading.textContent, 'access.approval.title');

  assert.deepEqual(scene.texts('permission-action'), ['access.approval.action[{"action":"click"}]']);
  assert.deepEqual(scene.texts('permission-site'), ['access.approval.site[{"origin":"https://example.com"}]']);
  assert.deepEqual(scene.texts('permission-target'), ['access.approval.target[{"label":"the blue Send button"}]']);
  assert.deepEqual(scene.texts('permission-allow'), ['access.approval.allow']);
  assert.deepEqual(scene.texts('permission-deny'), ['access.approval.deny']);

  const status = card.all().find((node) => node.getAttribute('role') === 'status');
  assert.ok(status, 'the card says what it is waiting for');
  assert.equal(scene.ui.count, 1);
});

test('the answer carries the id, the chat, the revision and the decision', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');

  assert.equal(scene.sent.length, 1, 'one answer went out');
  assert.deepEqual(scene.sent[0].message, {
    type: APPROVAL_RESPONSE,
    id: 'req-1',
    sessionId: 'session-a',
    revision: 7,
    decision: 'allow',
  });
  assert.deepEqual(scene.sent[0].options, {
    expectedSessionId: 'session-a',
    expectedPort: scene.state.port,
  });
  assert.equal(Object.isFrozen(scene.sent[0].message), true, 'the answer cannot be changed on the way out');
});

test('denying sends deny', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.button('permission-deny').dispatch('click');

  assert.equal(scene.sent.length, 1);
  assert.equal(scene.sent[0].message.decision, 'deny');
  assert.equal(scene.sent[0].message.id, 'req-1');
});

test('the request is not removed before the worker settles it', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');

  assert.ok(scene.card(), 'the card stays: the worker has not settled it yet');
  assert.equal(scene.ui.count, 1);
  assert.equal(scene.ui.requests[0].sending, true);
  assert.equal(scene.card().all().some((node) => node.textContent.includes('approved')), false, 'nothing is marked as allowed');

  assert.equal(scene.ui.settle({ type: SETTLED_EVENT, id: 'req-1', sessionId: 'session-a', revision: 7, approved: true, reason: 'allowed' }), true);
  assert.equal(scene.card(), null, 'the settled request is gone');
  assert.equal(scene.ui.count, 0);
});

test('a settlement for another request, or a repeated one, removes nothing', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.ui.apply(makeRequest({ id: 'req-2' }));

  assert.equal(scene.ui.settle({ type: SETTLED_EVENT, id: 'req-2', sessionId: 'session-a', revision: 7, approved: true, reason: 'allowed' }), true);
  assert.equal(scene.ui.count, 1, 'only the settled request is gone');
  assert.equal(scene.card().all().length > 0, true);

  assert.equal(scene.ui.settle({ type: SETTLED_EVENT, id: 'req-2', sessionId: 'session-a', revision: 7, approved: true, reason: 'allowed' }), false, 'a repeated settlement removes nothing');
  assert.equal(scene.ui.count, 1);
  assert.equal(scene.ui.settle({ type: SETTLED_EVENT, id: 'req-9', sessionId: 'session-a', revision: 7, approved: true, reason: 'allowed' }), false);
  assert.equal(scene.ui.count, 1);
});

test('a settlement with the wrong chat, revision or connection removes nothing', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());

  const wrong = [
    { id: 'req-1', sessionId: 'session-b', revision: 7 },
    { id: 'req-1', sessionId: 'session-a', revision: 6 },
    { id: 'req-1', sessionId: 'session-a', revision: 8 },
    { id: 'req-1', sessionId: 'session-a', revision: 7 },
  ];
  for (const event of wrong.slice(0, 3)) {
    assert.equal(scene.ui.settle({ type: SETTLED_EVENT, ...event, approved: true, reason: 'allowed' }), false);
    assert.equal(scene.ui.count, 1, 'a stale settlement changes nothing');
  }

  scene.state.port = { name: 'port-2' };
  assert.equal(scene.ui.settle({ type: SETTLED_EVENT, ...wrong[3], approved: true, reason: 'allowed' }), false, 'a settlement on another connection changes nothing');
  assert.equal(scene.ui.count, 1);
});

test('a request for another chat or another revision is not drawn', () => {
  const scene = makeScene();

  assert.equal(scene.ui.apply(makeRequest({ sessionId: 'session-b' })), false, 'another chat');
  assert.equal(scene.ui.apply(makeRequest({ revision: 6 })), false, 'an older revision');
  assert.equal(scene.ui.apply(makeRequest({ revision: 8 })), false, 'a newer revision');
  assert.equal(scene.ui.count, 0);
  assert.equal(scene.card(), null);
});

test('a malformed request is not drawn', () => {
  const scene = makeScene();
  const malformed = [
    null,
    undefined,
    'req-1',
    {},
    makeRequest({ id: '' }),
    makeRequest({ id: '   ' }),
    makeRequest({ id: 42 }),
    makeRequest({ sessionId: '' }),
    makeRequest({ sessionId: null }),
    makeRequest({ revision: 0 }),
    makeRequest({ revision: -1 }),
    makeRequest({ revision: 7.5 }),
    makeRequest({ revision: '7' }),
    makeRequest({ revision: null }),
    makeRequest({ action: undefined }),
    makeRequest({ action: null }),
    makeRequest({ action: 12 }),
  ];
  for (const request of malformed) {
    assert.equal(scene.ui.apply(request), false, `not drawn: ${JSON.stringify(request)}`);
  }
  assert.equal(scene.ui.count, 0);
});

test('a request that arrives on no live connection is not drawn', () => {
  const scene = makeScene();
  scene.state.port = null;
  assert.equal(scene.ui.apply(makeRequest()), false);
  assert.equal(scene.ui.count, 0);
});

test('the same request twice does not make a second card and does not reset an answer on its way', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');
  const cards = scene.container.children.length;

  assert.equal(scene.ui.apply(makeRequest()), false, 'a repeated request is not a new one');
  assert.equal(scene.container.children.length, cards, 'no second card');
  assert.equal(scene.ui.count, 1);
  assert.equal(scene.ui.requests[0].sending, true, 'the answer on its way is not reset');
  assert.equal(scene.button('permission-allow').disabled, true);
  assert.equal(scene.sent.length, 1, 'and nothing is sent twice');
});

test('the same id with something else in it is not a new grant', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest({ action: 'click', label: 'the blue Send button' }));
  assert.equal(scene.ui.apply(makeRequest({ action: 'type_text', label: 'the password field' })), false);

  assert.equal(scene.ui.count, 1);
  assert.deepEqual(scene.texts('permission-target'), ['access.approval.target[{"label":"the blue Send button"}]'], 'the card still says what it was asked about');

  scene.button('permission-allow').dispatch('click');
  assert.equal(scene.sent.length, 1);
  assert.equal(scene.sent[0].message.id, 'req-1');
});

test('no answer goes out when the chat changed before the click', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.state.sessionId = 'session-b';

  scene.button('permission-allow').dispatch('click');
  assert.deepEqual(scene.sent, [], 'a card of another chat answers nothing');
  assert.equal(scene.button('permission-allow').disabled, true, 'and it says so');
});

test('no answer goes out when the revision changed before the click', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.state.revision = 8;

  scene.button('permission-allow').dispatch('click');
  assert.deepEqual(scene.sent, []);
  assert.equal(scene.button('permission-allow').disabled, true);
});

test('no answer goes out when the connection changed before the click', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.state.port = { name: 'port-2' };

  scene.button('permission-allow').dispatch('click');
  assert.deepEqual(scene.sent, [], 'a card of a worker that is gone answers nothing');
  assert.equal(scene.button('permission-allow').disabled, true);
});

test('a detached card answers nothing', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  const card = scene.card();
  const allow = card.all().find((node) => node.className.includes('permission-allow'));
  card.parentNode.removeChild(card);

  allow.dispatch('click');
  assert.deepEqual(scene.sent, [], 'a card that is not in the panel any more answers nothing');
});

test('a reset takes the cards away and makes the old buttons useless', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  const button = scene.button('permission-allow');

  scene.ui.reset();
  assert.equal(scene.card(), null);
  assert.equal(scene.ui.count, 0);

  button.dispatch('click');
  assert.deepEqual(scene.sent, [], 'the button of a card that is gone answers nothing');
});

test('the answer keeps the metadata of the request, even when the chat changes while it is on its way', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const scene = makeScene({
    send: (message, options) => {
      scene.sent.push({ message, options });
      return pending;
    },
  });
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');

  const capturedPort = scene.state.port;
  scene.state.sessionId = 'session-b';
  scene.state.revision = 9;
  release(true);
  await pending;

  assert.equal(scene.sent.length, 1);
  assert.equal(scene.sent[0].message.sessionId, 'session-a', 'the answer is not refilled from the chat that is current now');
  assert.equal(scene.sent[0].message.revision, 7);
  assert.equal(scene.sent[0].options.expectedSessionId, 'session-a');
  assert.equal(scene.sent[0].options.expectedPort, capturedPort, 'the answer goes out on the connection it was drawn on');
});

test('the buttons are disabled while the answer is on its way, and a second click sends nothing', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  const allow = scene.button('permission-allow');
  const deny = scene.button('permission-deny');

  allow.dispatch('click');
  assert.equal(allow.disabled, true);
  assert.equal(deny.disabled, true, 'both buttons wait for the worker');

  deny.dispatch('click');
  assert.equal(scene.sent.length, 1, 'a second click sends nothing');
  assert.equal(scene.sent[0].message.decision, 'allow');
});

test('an answer that fails keeps the request, says so and gives the buttons back', async () => {
  const scene = makeScene({ send: () => Promise.reject(new Error('the worker is gone')) });
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.ok(scene.card(), 'the request is still waiting');
  assert.equal(scene.ui.count, 1);
  assert.deepEqual(scene.texts('permission-error'), ['access.approval.sendError']);
  assert.equal(scene.card().all().find((node) => node.className === 'permission-error').hidden, false, 'the error is shown');
  assert.equal(scene.button('permission-allow').disabled, false, 'the buttons are given back');
  assert.equal(scene.button('permission-deny').disabled, false);
  assert.equal(scene.ui.requests[0].sending, false);
});

test('an answer that returns false is a failure too', async () => {
  const scene = makeScene({ send: () => false });
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.deepEqual(scene.texts('permission-error'), ['access.approval.sendError']);
  assert.equal(scene.button('permission-allow').disabled, false);
});

test('a failed answer raises nothing', async () => {
  const raised = [];
  const onUnhandled = (reason) => raised.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const scene = makeScene({ send: () => Promise.reject(new Error('the worker is gone')) });
    scene.ui.apply(makeRequest());
    scene.button('permission-allow').dispatch('click');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    assert.deepEqual(raised, [], 'a failed answer is not an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a late failure of a request that was settled changes nothing', async () => {
  let reject;
  const pending = new Promise((resolve, no) => { reject = no; });
  const scene = makeScene({ send: () => pending });
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');

  scene.ui.settle({ type: SETTLED_EVENT, id: 'req-1', sessionId: 'session-a', revision: 7, approved: true, reason: 'allowed' });
  reject(new Error('too late'));
  await pending.catch(() => {});
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(scene.card(), null, 'the card does not come back');
  assert.equal(scene.ui.count, 0);
  assert.deepEqual(scene.texts('permission-error'), [], 'and nothing is said about it');
});

test('a late failure of one request does not touch another one', async () => {
  let reject;
  const pending = new Promise((resolve, no) => { reject = no; });
  const scene = makeScene({ send: () => pending });
  scene.ui.apply(makeRequest({ id: 'req-1' }));
  scene.ui.apply(makeRequest({ id: 'req-2' }));
  scene.button('permission-allow').dispatch('click');

  reject(new Error('too late'));
  await pending.catch(() => {});
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(scene.ui.count, 2, 'both requests are still there');
  assert.equal(scene.ui.requests[0].errorKey, 'access.approval.sendError', 'the failed one says so');
  assert.equal(scene.ui.requests[1].errorKey, null, 'the other one is untouched');
  assert.equal(scene.ui.requests[1].sending, false);
});

test('a reset makes a late answer inert', async () => {
  let reject;
  const pending = new Promise((resolve, no) => { reject = no; });
  const scene = makeScene({ send: () => pending });
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');

  scene.ui.reset();
  reject(new Error('too late'));
  await pending.catch(() => {});
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(scene.card(), null, 'nothing comes back');
  assert.equal(scene.ui.count, 0);
});

test('the replay replaces the live list with what the worker says', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest({ id: 'req-1' }));
  scene.ui.apply(makeRequest({ id: 'req-2' }));
  assert.equal(scene.ui.count, 2);

  scene.ui.replay([makeRequest({ id: 'req-2' })]);
  assert.equal(scene.ui.count, 1, 'the request that is not live any more is gone');
  assert.equal(scene.ui.requests[0].id, 'req-2');

  scene.ui.replay([]);
  assert.equal(scene.ui.count, 0);
  assert.equal(scene.card(), null);
});

test('the replay drops requests of another chat or another revision', () => {
  const scene = makeScene();
  scene.ui.replay([
    makeRequest({ id: 'req-1', sessionId: 'session-b' }),
    makeRequest({ id: 'req-2', revision: 6 }),
    makeRequest({ id: 'req-3', action: undefined }),
  ]);
  assert.equal(scene.ui.count, 0, 'nothing foreign is drawn');
  assert.equal(scene.card(), null);
});

test('the replay drops a card of a revision that moved on', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  assert.equal(scene.ui.count, 1);

  scene.state.revision = 8;
  scene.ui.replay([makeRequest({ revision: 8 })]);
  assert.equal(scene.ui.count, 1, 'the request of the revision in force is drawn');
  assert.equal(scene.ui.requests[0].revision, 8);

  scene.state.revision = 9;
  scene.ui.replay([]);
  assert.equal(scene.ui.count, 0, 'a card of an old revision is gone');
});

test('the replay keeps an answer that is on its way and does not send it again', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');

  scene.ui.replay([makeRequest()]);
  assert.equal(scene.ui.count, 1);
  assert.equal(scene.ui.requests[0].sending, true, 'the answer on its way is kept');
  assert.equal(scene.button('permission-allow').disabled, true);
  assert.equal(scene.sent.length, 1, 'and it is not sent again');
  assert.equal(scene.container.children.length, 1, 'and there is no second card');
});

test('a new language redraws the words and keeps the answer on its way', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');

  scene.ui.updateLanguage((key, vars) => (vars ? `${key}:${vars.action}` : `ar:${key}`));
  assert.deepEqual(scene.texts('permission-title'), ['ar:access.approval.title']);
  assert.deepEqual(scene.texts('permission-action'), ['access.approval.action:click']);
  assert.equal(scene.ui.count, 1, 'no request is made again');
  assert.equal(scene.container.children.length, 1, 'and no second card');
  assert.equal(scene.button('permission-allow').disabled, true, 'the answer on its way is not woken up');
  assert.equal(scene.sent.length, 1);
});

test('an untrusted label is drawn as text, not as markup', () => {
  const scene = makeScene();
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  scene.ui.apply(makeRequest({ label: hostile, origin: 'https://example.com/<b>' }));

  assert.deepEqual(scene.texts('permission-target'), [`access.approval.target[${JSON.stringify({ label: hostile })}]`]);
  assert.equal(scene.card().all().some((node) => node.tagName === 'IMG' || node.tagName === 'SCRIPT'), false, 'nothing was parsed into elements');
  assert.deepEqual(scene.doc.violations, [], 'no markup was built out of a word from the worker');
});

test('a long label is cut to a length that can be drawn', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest({ label: 'x'.repeat(5000) }));
  const drawn = scene.texts('permission-target')[0];
  assert.ok(drawn.length < 1000, `the label was cut (${drawn.length})`);
});

test('the terminal hint is shown for the actions that type into a terminal', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest({ id: 'req-1', action: 'insert_text' }));
  scene.ui.apply(makeRequest({ id: 'req-2', action: 'press_key' }));
  scene.ui.apply(makeRequest({ id: 'req-3', action: 'type_text' }));
  scene.ui.apply(makeRequest({ id: 'req-4', action: 'click' }));

  const cards = scene.container.children;
  assert.equal(cards[0].all().find((node) => node.className === 'permission-terminal').hidden, false);
  assert.equal(cards[1].all().find((node) => node.className === 'permission-terminal').hidden, false);
  assert.equal(cards[2].all().find((node) => node.className === 'permission-terminal').hidden, false);
  assert.equal(cards[3].all().find((node) => node.className === 'permission-terminal').hidden, true, 'a click is not a terminal');
});

test('several requests are drawn one after another and stay independent', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest({ id: 'req-1', label: 'first' }));
  scene.ui.apply(makeRequest({ id: 'req-2', label: 'second' }));
  assert.equal(scene.container.children.length, 2);

  const first = scene.container.children[0];
  const allow = first.all().find((node) => node.className.includes('permission-allow'));
  allow.dispatch('click');

  assert.equal(scene.sent.length, 1);
  assert.equal(scene.sent[0].message.id, 'req-1', 'only the request that was answered');
  assert.equal(scene.ui.count, 2, 'the other request is still waiting');
  assert.equal(scene.ui.requests[1].sending, false);

  const second = scene.container.children[1];
  const secondAllow = second.all().find((node) => node.className.includes('permission-allow'));
  secondAllow.dispatch('click');
  assert.equal(scene.sent.length, 2);
  assert.equal(scene.sent[1].message.id, 'req-2');
});

test('only the keys of the approval are asked of the translator', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.ui.updateLanguage((key) => key);
  for (const key of scene.t.keys) {
    assert.ok(key.startsWith('access.approval.'), `the key is under access.approval: ${key}`);
  }
  assert.ok(scene.t.keys.includes('access.approval.sendError') === false, 'the error key is only asked when it happens');
});

test('the event shapes of the worker are understood', () => {
  const scene = makeScene();
  assert.equal(scene.ui.apply({ type: REQUEST_EVENT, request: makeRequest() }), true);
  assert.equal(scene.ui.count, 1);
  assert.equal(scene.ui.settle({ type: SETTLED_EVENT, id: 'req-1', sessionId: 'session-a', revision: 7, approved: false, reason: 'denied' }), true);
  assert.equal(scene.ui.count, 0);
});

test('nothing outside the container is read or written', async () => {
  const saved = {};
  const guarded = ['document', 'localStorage', 'sessionStorage', 'history'];
  for (const name of guarded) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { throw new Error(`the helper must not touch ${name}`); },
    });
  }
  try {
    const scene = makeScene();
    scene.ui.apply(makeRequest());
    scene.button('permission-allow').dispatch('click');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    scene.ui.replay([makeRequest()]);
    scene.ui.updateLanguage((key) => key);
    scene.ui.reset();
    assert.equal(scene.sent.length, 1, 'the flow ran without touching the world outside the container');
  } finally {
    for (const name of guarded) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }
});

test('the status says what the card is waiting for', async () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  const status = scene.card().all().find((node) => node.getAttribute('role') === 'status');
  assert.equal(status.textContent, 'access.approval.waiting');

  scene.button('permission-allow').dispatch('click');
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.equal(status.textContent, 'access.approval.answering', 'the answer is on its way');
});

test('every element is made in the container of the panel', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  for (const node of scene.container.all()) {
    assert.equal(node.ownerDocument, scene.doc, 'the panel document made the element');
  }
});

test('an incoming request never takes the focus', () => {
  const scene = makeScene();
  // The user is writing in the composer.
  const composer = scene.doc.createElement('textarea');
  scene.container.appendChild(composer);
  composer.focus();
  assert.equal(scene.doc.activeElement, composer, 'the draft has the focus');

  scene.ui.apply(makeRequest());
  assert.equal(scene.doc.activeElement, composer, 'the request does not take the focus away');
  assert.equal(scene.button('permission-allow').focusCount, 0, 'and the Allow button is not focused');
});

test('a replayed request never takes the focus', () => {
  const scene = makeScene();
  const composer = scene.doc.createElement('textarea');
  scene.container.appendChild(composer);
  composer.focus();

  scene.ui.replay([makeRequest()]);
  assert.equal(scene.doc.activeElement, composer, 'the replay does not take the focus away');
  assert.equal(scene.button('permission-allow').focusCount, 0, 'and the Allow button is not focused');
});

test('a request that arrives on top of a live one never takes the focus', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest({ id: 'req-1' }));
  const composer = scene.doc.createElement('textarea');
  scene.container.appendChild(composer);
  composer.focus();

  scene.ui.apply(makeRequest({ id: 'req-2' }));
  assert.equal(scene.ui.count, 2, 'both requests are drawn');
  assert.equal(scene.doc.activeElement, composer, 'the second request does not take the focus away');
  for (const card of scene.container.children.filter((node) => node.className.includes('permission-request'))) {
    for (const node of card.all()) {
      assert.equal(node.focusCount, 0, 'no button of a card was focused');
    }
  }
});

test('a request that is answered and settled again never takes the focus', async () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  const composer = scene.doc.createElement('textarea');
  scene.container.appendChild(composer);
  composer.focus();

  scene.button('permission-allow').dispatch('click');
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  scene.ui.settle({ type: SETTLED_EVENT, id: 'req-1', sessionId: 'session-a', revision: 7, approved: true, reason: 'allowed' });

  assert.equal(scene.doc.activeElement, composer, 'the draft still has the focus');
});

test('a request that arrives while the draft has the focus approves nothing by Enter', () => {
  const scene = makeScene();
  const composer = scene.doc.createElement('textarea');
  scene.container.appendChild(composer);
  composer.focus();

  scene.ui.apply(makeRequest());
  assert.equal(scene.doc.activeElement, composer, 'the draft kept the focus');

  // The Enter that the user presses for the draft goes to the draft, and the
  // Allow button is not what is under the focus.
  composer.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(scene.sent, [], 'nothing was approved');
  assert.equal(scene.ui.requests[0].sending, false, 'the request is still waiting for an answer');
});

test('answering again after a failure clears the error', async () => {
  let fail = true;
  const scene = makeScene({
    send: () => (fail ? Promise.reject(new Error('the worker is gone')) : Promise.resolve(true)),
  });
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.deepEqual(scene.texts('permission-error'), ['access.approval.sendError']);

  fail = false;
  scene.button('permission-allow').dispatch('click');
  const error = scene.card().all().find((node) => node.className === 'permission-error');
  assert.equal(error.textContent, '', 'the old error is gone');
  assert.equal(error.hidden, true, 'and it is not shown');
  assert.equal(scene.button('permission-allow').disabled, true, 'and the answer is on its way');
});

test('a card keeps the connection that delivered its request', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.state.port = { name: 'port-2' };

  scene.ui.replay([makeRequest()]);
  assert.equal(scene.ui.count, 1);
  assert.equal(scene.container.children.length, 1, 'and there is no second card');

  scene.button('permission-allow').dispatch('click');
  assert.deepEqual(scene.sent, [], 'a card of a worker that is gone answers nothing');
  assert.equal(scene.button('permission-allow').disabled, true, 'and it says so');
});

test('the answer on its way is not woken up by a replay on another connection', () => {
  const scene = makeScene();
  scene.ui.apply(makeRequest());
  scene.button('permission-allow').dispatch('click');

  scene.state.port = { name: 'port-2' };
  scene.ui.replay([makeRequest()]);

  assert.equal(scene.ui.count, 1);
  assert.equal(scene.ui.requests[0].sending, true, 'the answer on its way is kept');
  assert.equal(scene.sent.length, 1, 'and nothing is sent again');
});
