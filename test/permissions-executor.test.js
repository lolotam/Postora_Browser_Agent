// The guarded executor: what runs, what does not, and what the user is asked.
//
// The authority here is the real one (src/permissions/policy.js): the tests
// answer its questions the way the panel will, so nothing about the executor
// is proved by a mock that always says yes. The browser is a small fake that
// behaves like the controller: it asks the guard before every effect and it
// keeps the page, the focus and the elements the executor approved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor } from '../src/agent/tools.js';
import { AccessAuthority, FULL_ACCESS } from '../src/permissions/policy.js';

const BODY = { index: -1, tag: 'body', label: '', secret: false, editable: false, body: true, x: 300, y: 300 };

// The executor asks Chrome about the tabs it names.
globalThis.chrome = {
  tabs: {
    get: async (id) => ({ id, url: 'https://shop.test/other', title: 'Other', active: false }),
    query: async () => [{ id: 7, url: 'https://shop.test/checkout', title: 'Checkout', active: true }],
  },
};

/** A page with a few fields, a button and a list of suggestions. */
function fakePage() {
  return {
    url: 'https://shop.test/checkout',
    document: 'doc-1',
    tabId: 7,
    elements: [
      { index: 0, tag: 'input', label: 'Message', secret: false, editable: true, value: 'original message', x: 100, y: 100 },
      { index: 1, tag: 'input', label: 'Password', secret: true, editable: true, value: 'TEST_ONLY_PASSWORD', x: 100, y: 140 },
      { index: 2, tag: 'button', label: 'Send message', secret: false, editable: false, value: '', x: 100, y: 180 },
      { index: 3, tag: 'li', label: 'Delhi', secret: false, editable: false, value: '', x: 200, y: 60 },
      // The icon of the button: it is part of it, and a click on it is a click
      // on the button.
      { index: 4, tag: 'span', label: 'Send icon', secret: false, editable: false, value: '', x: 100, y: 180, parent: 2 },
    ],
    // Another control that lies over the page: it takes no approval.
    cover: null,
    focused: 0,
    replaced: false,
    reindexed: false,
    covered: false,
    onClick: null,
    validateGate: null,
    overlayGates: [],
    suggestions: {
      scan: { tied: true, total: 1, options: ['Delhi'], matches: 1 },
      locate: { x: 200, y: 60, text: 'Delhi' },
      verify: { ok: true },
    },
  };
}

/** Whether a point lies in the box of an element. */
const within = (el, x, y) => x >= el.x - 5 && x <= el.x + 5 && y >= el.y - 5 && y <= el.y + 5;

/**
 * A browser that behaves like the controller: every call that can change the
 * page asks the guard first, and the page keeps what happened.
 */
function fakeBrowser(page = fakePage()) {
  const calls = [];
  const captions = [];
  const live = (index) => page.elements.find((el) => el.index === index);
  const shape = (el, kind, x = el.x, y = el.y) => ({
    kind,
    token: `t${el.index}`,
    index: el.index,
    x,
    y,
    tag: el.tag,
    editable: el.editable,
    secret: el.secret,
    focused: page.focused === el.index,
    body: Boolean(el.body),
    label: el.label,
  });
  const elementOf = (target) => {
    const el = target?.element;
    if (!el) return null;
    if (el.body) return BODY;
    return live(el.index);
  };
  // The element that is really under a point: a control that lies over the
  // page is on top of everything else.
  const hitAt = (x, y) => {
    if (page.cover && within(page.cover, x, y)) return page.cover;
    const hits = page.elements.filter((el) => within(el, x, y));
    return hits[hits.length - 1] ?? null;
  };
  // Whether the element under a point belongs to the approved one: the icon of
  // a button is part of the button, another control never is.
  const sameOwner = (hit, wanted) => {
    if (!hit || !wanted) return false;
    let el = hit;
    while (el) {
      if (el.index === wanted.index) return true;
      el = el.parent === undefined ? null : page.elements.find((e) => e.index === el.parent);
    }
    return false;
  };
  // The control that takes the focus when this one is clicked.
  const ownerOf = (hit) => {
    let el = hit;
    while (el) {
      if (el.editable || el.tag === 'button') return el;
      el = el.parent === undefined ? null : page.elements.find((e) => e.index === el.parent);
    }
    return null;
  };
  const browser = {
    page,
    calls,
    captions,
    overlay: {
      pointTo: async (target, caption) => {
        captions.push(caption);
        // A gate per caption: the page may be drawn on slowly, and something
        // may cover the target while it is.
        const gate = page.overlayGates?.shift();
        if (gate) await gate;
      },
      say: async (...caption) => { captions.push(caption); },
    },
    currentTab: async () => ({ id: page.tabId, url: page.url }),
    documentId: async () => page.document,
    snapshot: async () => ({
      url: page.url,
      title: 'Checkout',
      scroll: { y: 0, viewport: 100, height: 100 },
      elements: page.elements.map((el) => `[${el.index}] ${el.tag} "${el.label}"`),
      offscreen: 0,
      text: 'A checkout page.',
    }),
    text: async () => ({ start: 0, text: 'A checkout page.', total: 16, dates: [] }),
    screenshot: async () => ({ dataUrl: 'data:image/jpeg;base64,AA', width: 100, height: 100 }),
    ownsTab: () => true,
    isTakenByOther: () => null,
    takeClosedNote: () => '',
    captureTarget: async ({ kind = 'focus', index = null, x = null, y = null, tabId = null } = {}) => {
      calls.push({ name: 'captureTarget', args: { kind, index, x, y, tabId } });
      const base = { tabId: tabId ?? page.tabId, url: page.url, documentId: page.document, capturedAt: Date.now() };
      if (kind === 'tab') return { ...base, scope: 'tab', kind: 'tab', element: null };
      const scope = { ...base, scope: 'element' };
      if (kind === 'element') {
        const el = live(index);
        return el ? { ...scope, element: shape(el, 'element') } : { ...scope, element: null };
      }
      if (kind === 'point') {
        const el = hitAt(x, y);
        return el ? { ...scope, element: shape(el, 'point', x, y) } : { ...scope, element: null };
      }
      const el = page.focused === null ? BODY : live(page.focused);
      return { ...scope, element: shape(el, 'focus') };
    },
    validateTarget: async (target) => {
      calls.push({ name: 'validateTarget', args: { token: target?.element?.token ?? null } });
      if (page.validateGate) await page.validateGate;
      if (page.replaced) return { ok: false, reason: 'element-gone' };
      if (target?.url && target.url !== page.url) return { ok: false, reason: 'navigated' };
      if (target?.documentId && page.document !== target.documentId) return { ok: false, reason: 'document-changed' };
      if (page.reindexed) return { ok: false, reason: 'reindexed' };
      if (page.covered) return { ok: false, reason: 'hit-replaced' };
      // A point target is only good while the same element is under it.
      if (target?.element?.kind === 'point') {
        const hit = hitAt(target.element.x, target.element.y);
        if (!sameOwner(hit, target.element)) return { ok: false, reason: 'hit-replaced' };
      }
      return { ok: true, element: target?.element ?? null };
    },
    readField: async (target, { guard } = {}) => {
      if (typeof guard !== 'function') throw new Error('A selected value is only read after it was approved: readField needs a guard.');
      await guard();
      const el = elementOf(target);
      if (!el) throw new Error('The field that was approved is not there any more.');
      calls.push({ name: 'readField', args: { index: el.index } });
      return { ok: true, value: el.value, tag: el.tag, secret: el.secret };
    },
    assertTypingTarget: async (target, { guard } = {}) => {
      await guard?.();
      calls.push({ name: 'assertTypingTarget', args: { token: target?.element?.token ?? null } });
      const el = elementOf(target);
      if (!el || el.body || !el.editable) throw new Error('voice.inputCancelled');
      if (page.focused !== el.index) throw new Error('voice.inputCancelled');
      return true;
    },
    assertFocusTarget: async (target, { guard } = {}) => {
      await guard?.();
      calls.push({ name: 'assertFocusTarget', args: { token: target?.element?.token ?? null } });
      const el = elementOf(target);
      if (!el) throw new Error('voice.inputCancelled');
      if (page.focused !== el.index && !(el.body && page.focused === null)) throw new Error('voice.inputCancelled');
      return true;
    },
    element: async (index, action, value, { guard, target } = {}) => {
      await guard?.();
      calls.push({ name: 'element', args: { index, action, value } });
      if (page.replaced) throw new Error('The element that was approved is no longer on the page.');
      if (action === 'locate') {
        const el = live(index);
        return { x: el.x, y: el.y, tag: el.tag, label: el.label, secret: el.secret };
      }
      if (action === 'select-all') return { ok: true };
      if (action === 'select-option') return { ok: true, selected: String(value) };
      return {};
    },
    suggestions: async (index, wanted, mode, { guard } = {}) => {
      await guard?.();
      calls.push({ name: 'suggestions', args: { index, wanted, mode } });
      if (mode === 'locate' && page.suggestions.locate) {
        const spot = page.suggestions.locate;
        const option = page.elements.find((el) => el.label === wanted && el.tag === 'li');
        page.onLocateOption?.();
        return { ...spot, target: { scope: 'element', kind: 'point', tabId: page.tabId,
          url: page.url, documentId: page.document, capturedAt: Date.now(),
          element: shape(option, 'point', spot.x, spot.y) } };
      }
      return page.suggestions[mode] ?? { tied: true, total: 0, options: [], matches: 0 };
    },
    clickAt: async (x, y, { guard, target = null, tabId = null, clickCount = 1 } = {}) => {
      await guard?.();
      // The final hit check: the point must still belong to the element that
      // was approved, or to a part of it.
      if (target) {
        const hit = hitAt(x, y);
        if (!sameOwner(hit, target.element)) throw new Error('voice.inputCancelled');
      }
      calls.push({ name: 'clickAt', args: { x, y, tabId, clickCount } });
      // A click focuses what it lands on, as a page does.
      const owner = ownerOf(hitAt(x, y));
      if (owner) page.focused = owner.index;
      page.onClick?.(x, y);
      return true;
    },
    hoverAt: async (x, y, { guard, target = null, tabId = null } = {}) => {
      await guard?.();
      if (target) {
        const hit = hitAt(x, y);
        if (!sameOwner(hit, target.element)) throw new Error('voice.inputCancelled');
      }
      calls.push({ name: 'hoverAt', args: { x, y, tabId } });
      return true;
    },
    insertText: async (text, { guard, target = null, tabId = null } = {}) => {
      await guard?.();
      if (target) await browser.assertTypingTarget(target, { guard });
      calls.push({ name: 'insertText', args: { text, tabId } });
      const el = page.focused === null ? null : live(page.focused);
      if (el) el.value += text;
      return true;
    },
    pressKey: async (key, { guard, target = null, tabId = null } = {}) => {
      await guard?.();
      if (target) await browser.assertFocusTarget(target, { guard });
      calls.push({ name: 'pressKey', args: { key, tabId } });
      return true;
    },
    scroll: async (screens, at, { guard, target = null, tabId = null } = {}) => {
      await guard?.();
      // A scroll inside an element is bound to that element.
      if (target?.element) {
        const hit = hitAt(at?.x ?? 0, at?.y ?? 0);
        if (!sameOwner(hit, target.element)) throw new Error('voice.inputCancelled');
      }
      calls.push({ name: 'scroll', args: { screens, at: at ?? null, tabId } });
      return true;
    },
    navigate: async (url, { guard, tabId = null } = {}) => {
      await guard?.();
      calls.push({ name: 'navigate', args: { url, tabId } });
      page.url = url;
      return true;
    },
    history: async (action, { guard, tabId = null } = {}) => {
      await guard?.();
      calls.push({ name: 'history', args: { action, tabId } });
      return true;
    },
    useTab: async (tabId, { guard } = {}) => {
      await guard?.();
      calls.push({ name: 'useTab', args: { tabId } });
      return { id: tabId, url: page.url };
    },
    openTab: async (url, { guard } = {}) => {
      await guard?.();
      calls.push({ name: 'openTab', args: { url } });
      return { id: 8, url };
    },
    closeOwnedTab: async (tabId, { guard } = {}) => {
      await guard?.();
      calls.push({ name: 'closeOwnedTab', args: { tabId } });
      return true;
    },
    evaluate: async (expression, { guard } = {}) => {
      await guard?.();
      calls.push({ name: 'evaluate', args: { expression } });
      return null;
    },
    waitForLoad: async () => {},
  };
  return browser;
}

/** The worker's own authority, with the answers the test gives it. */
function authority({ decision = 'deny', mode = 'ask-first', onRequest = null } = {}) {
  const questions = [];
  const access = new AccessAuthority({
    sessionId: 'executor-test',
    onRequest: (request) => {
      questions.push(request);
      onRequest?.(request);
      if (decision) access.respondApproval({ id: request.id, sessionId: request.sessionId, revision: request.revision, decision });
    },
  });
  if (mode === 'full-access') access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });
  return { access, questions };
}

/** An executor with a browser, an authority and a notebook-free session. */
function executor(browser, access, options = {}) {
  return createToolExecutor(browser, {
    askUser: async () => { throw new Error('ask_user is not permission approval'); },
    access,
    ...options,
  });
}

const named = (calls, name) => calls.filter((call) => call.name === name);

test('a session without an authority reads nothing and changes nothing', async () => {
  const browser = fakeBrowser();
  const execute = executor(browser, null);

  const page = await execute('read_page', {});
  assert.equal(page.isError, true);
  assert.match(page.output, /no access authority/);

  const click = await execute('click', { index: 2 });
  assert.equal(click.isError, true);
  assert.match(click.output, /no access authority/);
  assert.equal(named(browser.calls, 'clickAt').length, 0);
  assert.equal(named(browser.calls, 'captureTarget').length, 1, 'the target is named before the refusal');
});

test('Ask first asks the authority about the exact operation and runs nothing when the answer is no', async () => {
  const browser = fakeBrowser();
  const { access, questions } = authority({ decision: 'deny' });
  const execute = executor(browser, access);

  const result = await execute('click', { index: 2 });

  assert.equal(result.isError, true);
  assert.equal(questions.length, 1, 'the authority was asked once');
  assert.equal(questions[0].action, 'click');
  assert.deepEqual(questions[0].args, { index: 2, double: false });
  assert.equal(questions[0].kind, 'interact');
  assert.equal(questions[0].tabId, 7);
  assert.equal(questions[0].target.element.token, 't2');
  assert.equal(named(browser.calls, 'clickAt').length, 0, 'nothing was clicked');
});

test('Ask first runs the action once the user allows it', async () => {
  const browser = fakeBrowser();
  const { access, questions } = authority({ decision: 'allow' });
  const execute = executor(browser, access);

  const result = await execute('click', { index: 2 });

  assert.equal(result.isError, undefined);
  assert.match(result.output, /Clicked \[2\] <button>/);
  assert.equal(questions.length, 1);
  assert.equal(named(browser.calls, 'clickAt').length, 1);
});

test('the authority is asked before the action runs, and the answer is awaited', async () => {
  const browser = fakeBrowser();
  let pending = null;
  const { access, questions } = authority({ decision: null, onRequest: (request) => { pending = request; } });
  const execute = executor(browser, access);

  const running = execute('click', { index: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(named(browser.calls, 'clickAt').length, 0, 'nothing runs while the question is open');

  access.respondApproval({ id: pending.id, sessionId: pending.sessionId, revision: pending.revision, decision: 'allow' });
  const result = await running;
  assert.equal(result.isError, undefined);
  assert.equal(named(browser.calls, 'clickAt').length, 1);
  assert.equal(questions.length, 1);
});

test('Full access asks no question at all', async () => {
  const browser = fakeBrowser();
  const { access, questions } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const result = await execute('click', { index: 2 });

  assert.equal(result.isError, undefined);
  assert.equal(questions.length, 0, 'no question is asked in Full access');
  assert.equal(named(browser.calls, 'clickAt').length, 1);
});

test('a tool argument cannot allow anything or relabel a click', async () => {
  const browser = fakeBrowser();
  const { access, questions } = authority({ decision: 'deny' });
  const execute = executor(browser, access);

  const result = await execute('click', { index: 2, mode: 'full-access', kind: 'observe', approved: true, action: 'read_page' });

  assert.equal(result.isError, true);
  assert.equal(questions.length, 1, 'the action was still asked about');
  assert.equal(questions[0].action, 'click');
  assert.equal(questions[0].kind, 'interact', 'a click is not an observation');
  assert.equal(named(browser.calls, 'clickAt').length, 0);
});

test('the approval is bound to the exact operation that was asked about', async () => {
  const browser = fakeBrowser();
  const { access, questions } = authority({ decision: 'allow' });
  const permits = [];
  const authorize = access.authorize.bind(access);
  access.authorize = async (operation, options) => {
    const answer = await authorize(operation, options);
    permits.push({ operation, permit: answer.permit });
    return answer;
  };
  const execute = executor(browser, access);

  await execute('type_text', { index: 0, text: 'hello', clear: true, submit: false });

  const asked = questions[0];
  assert.equal(asked.action, 'type_text');
  assert.deepEqual(asked.args, { index: 0, text: 'hello', clear: true, submit: false });
  assert.equal(asked.target.element.token, 't0');
  assert.equal(asked.target.element.index, 0);

  // The permit is good for that operation and for nothing else.
  const { operation, permit } = permits[0];
  assert.equal(access.grantValid(permit, operation), true);
  assert.equal(access.grantValid(permit, { ...operation, args: { ...operation.args, text: 'something else' } }), false);
  assert.equal(access.grantValid(permit, { ...operation, target: null }), false);
  assert.equal(access.grantValid(permit, { ...operation, action: 'click' }), false);
});

test('a target in the tool arguments is ignored: the captured one is what is approved', async () => {
  const browser = fakeBrowser();
  const { access, questions } = authority({ decision: 'allow' });
  const execute = executor(browser, access);

  await execute('click', {
    index: 2,
    target: { tabId: 7, url: 'https://shop.test/checkout', documentId: 'doc-1', element: { kind: 'element', token: 'forged', index: 1 } },
    tabId: 99,
    permit: 'forged',
    approved: true,
  });

  assert.equal(questions[0].target.element.token, 't2', 'the target is the one that was captured');
  assert.equal(questions[0].tabId, 7, 'the tab is the one the action acts on');
  assert.equal(named(browser.calls, 'clickAt').length, 1);
});

test('a field value is read only after it was allowed', async () => {
  const browser = fakeBrowser();
  const denied = authority({ decision: 'deny' });
  const refused = await executor(browser, denied.access)('read_field', { index: 1 });

  assert.equal(refused.isError, true);
  assert.doesNotMatch(refused.output, /TEST_ONLY_PASSWORD/, 'no value leaves the page');
  assert.equal(named(browser.calls, 'readField').length, 0);

  const allowed = authority({ decision: 'allow' });
  const read = await executor(browser, allowed.access)('read_field', { index: 1 });
  assert.equal(read.isError, undefined);
  assert.match(read.output, /TEST_ONLY_PASSWORD/);
  assert.equal(named(browser.calls, 'readField').length, 1);
});

test('the value of a secret field never appears in a caption', async () => {
  const browser = fakeBrowser();
  const { access } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const result = await execute('type_text', { index: 1, text: 'TEST_ONLY_TYPED_SECRET' });

  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.output, /TEST_ONLY_TYPED_SECRET/, 'the typed text is not in the observation');
  assert.doesNotMatch(JSON.stringify(browser.captions), /TEST_ONLY_TYPED_SECRET/, 'the typed text is not in a caption');
  assert.deepEqual(browser.captions[0], ['typeSecret'], 'a field that holds a secret is captioned as one');
});

test('the text goes into the field that was approved and into no other', async () => {
  const browser = fakeBrowser();
  browser.page.onClick = () => { browser.page.focused = 1; }; // the page moves the focus away
  const { access } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const result = await execute('type_text', { index: 0, text: 'must not land' });

  assert.equal(result.isError, true);
  assert.match(result.output, /focus moved to another element/);
  assert.equal(named(browser.calls, 'insertText').length, 0, 'no text was typed anywhere');
  assert.equal(browser.page.elements[0].value, 'original message');
  assert.equal(browser.page.elements[1].value, 'TEST_ONLY_PASSWORD');
});

test('a replaced element does not inherit the approval', async () => {
  const browser = fakeBrowser();
  browser.page.replaced = true;
  const { access, questions } = authority({ decision: 'allow' });
  const execute = executor(browser, access);

  const result = await execute('click', { index: 2 });

  assert.equal(result.isError, true);
  assert.equal(questions.length, 1);
  assert.equal(named(browser.calls, 'clickAt').length, 0, 'the click did not happen');
});

test('a replaced document does not inherit the approval', async () => {
  const browser = fakeBrowser();
  let pending = null;
  const { access } = authority({ decision: null, onRequest: (request) => { pending = request; } });
  const execute = executor(browser, access);

  const running = execute('click', { index: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  browser.page.document = 'doc-2'; // the page was replaced at the same address
  access.respondApproval({ id: pending.id, sessionId: pending.sessionId, revision: pending.revision, decision: 'allow' });

  const result = await running;
  assert.equal(result.isError, true);
  assert.equal(named(browser.calls, 'clickAt').length, 0);
});

test('the approval is asked again after the page was checked', async () => {
  const browser = fakeBrowser();
  let release;
  browser.page.validateGate = new Promise((resolve) => { release = resolve; });
  const { access } = authority({ decision: 'allow' });
  const execute = executor(browser, access);

  const running = execute('click', { index: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The mode moves while the page is being checked: the approval is gone.
  access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });
  release();

  const result = await running;
  assert.equal(result.isError, true);
  assert.equal(named(browser.calls, 'clickAt').length, 0, 'the click did not happen');
});

test('a stopped command is allowed nothing', async () => {
  const browser = fakeBrowser();
  const stop = new AbortController();
  let pending = null;
  const { access, questions } = authority({ decision: null, onRequest: (request) => { pending = request; } });
  const execute = executor(browser, access, { signal: stop.signal });

  const running = execute('click', { index: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  stop.abort();

  const result = await running;
  assert.equal(result.isError, true);
  assert.match(result.output, /stopped/);
  assert.equal(questions.length, 1);
  assert.equal(named(browser.calls, 'clickAt').length, 0, 'nothing was clicked');
});

test('one approval covers the steps of a suggestion', async () => {
  const browser = fakeBrowser();
  const { access, questions } = authority({ decision: 'allow' });
  const execute = executor(browser, access);

  const result = await execute('choose_suggestion', { index: 0, text: 'Del', option: 'Delhi' });

  assert.equal(result.isError, undefined);
  assert.match(result.output, /Chose "Delhi" in \[0\]/);
  assert.equal(questions.length, 1, 'the whole choice was one question');
  assert.equal(named(browser.calls, 'insertText').length, 1);
  assert.equal(named(browser.calls, 'clickAt').length, 2, 'the field and the option');
});

test('insert_text types into the focused field only', async () => {
  const browser = fakeBrowser();
  browser.page.focused = 0;
  const { access, questions } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const typed = await execute('insert_text', { text: 'echo hello' });
  assert.equal(typed.isError, undefined);
  assert.equal(browser.page.elements[0].value, 'original messageecho hello');
  assert.equal(browser.page.elements[1].value, 'TEST_ONLY_PASSWORD');
  assert.equal(questions.length, 0);

  // The body takes no text.
  browser.page.focused = null;
  const refused = await execute('insert_text', { text: 'never' });
  assert.equal(refused.isError, true);
  assert.doesNotMatch(refused.output, /Unknown tool/);
  assert.equal(browser.page.elements[0].value, 'original messageecho hello');
});

test('the text of a secret field is never shown, not even in the caption of a focused insert', async () => {
  const browser = fakeBrowser();
  browser.page.focused = 1; // the field that holds a secret has the focus
  const { access } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const result = await execute('insert_text', { text: 'TEST_ONLY_TYPED_SECRET' });

  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.output, /TEST_ONLY_TYPED_SECRET/, 'the typed text is not in the observation');
  assert.doesNotMatch(JSON.stringify(browser.captions), /TEST_ONLY_TYPED_SECRET/, 'the typed text is not in a caption');
  assert.deepEqual(browser.captions, [['typeSecret', {}]], 'a field that holds a secret is captioned as one');
});

test('an approved click cannot land on a control that covers it', async () => {
  const browser = fakeBrowser();
  let pending = null;
  const { access } = authority({ decision: null, onRequest: (request) => { pending = request; } });
  const execute = executor(browser, access);

  const running = execute('click', { index: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Another button lies over the one that was approved.
  browser.page.cover = { index: 5, tag: 'button', label: 'Something else', x: 100, y: 180 };
  access.respondApproval({ id: pending.id, sessionId: pending.sessionId, revision: pending.revision, decision: 'allow' });

  const result = await running;
  assert.equal(result.isError, true);
  assert.equal(named(browser.calls, 'clickAt').length, 0, 'the click did not happen');
});

test('a control that covers the approved one while the page is drawn on is caught', async () => {
  const browser = fakeBrowser();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  browser.page.overlayGates = [gate];
  const { access } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const running = execute('click', { index: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  browser.page.cover = { index: 5, tag: 'button', label: 'Something else', x: 100, y: 180 };
  release();

  const result = await running;
  assert.equal(result.isError, true);
  assert.equal(named(browser.calls, 'clickAt').length, 0, 'the click did not happen');
});

test('the icon of the approved button is part of it', async () => {
  const browser = fakeBrowser();
  const { access } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const result = await execute('click', { index: 2 });

  assert.equal(result.isError, undefined);
  assert.equal(named(browser.calls, 'clickAt').length, 1, 'the click went to the button');
});

test('the option of a suggestion is clicked on the point that was approved', async () => {
  const browser = fakeBrowser();
  const { access } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const result = await execute('choose_suggestion', { index: 0, text: 'Del', option: 'Delhi' });

  assert.equal(result.isError, undefined);
  assert.match(result.output, /Chose "Delhi" in \[0\]/);
  // The actual option is registered by locate, never recaptured from the topmost point.
  const choice = browser.calls.filter((call) => call.name === 'captureTarget' && call.args.kind === 'point');
  assert.equal(choice.length, 0, 'no covering control can become the chosen option');
});

test('a covering control present before option location never becomes the choice', async () => {
  const browser = fakeBrowser();
  const { access } = authority({ mode: 'full-access' });
  browser.page.onLocateOption = () => {
    browser.page.cover = { index: 9, tag: 'button', label: 'Delete', x: 200, y: 60 };
  };
  const result = await executor(browser, access)('choose_suggestion', { index: 0, text: 'Del', option: 'Delhi' });
  assert.equal(result.isError, true);
  assert.equal(named(browser.calls, 'clickAt').length, 1, 'only the field click ran');
});

test('a control that covers the option of a suggestion is caught', async () => {
  const browser = fakeBrowser();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // The caption of the option is drawn on slowly: the option is named before
  // that, so a control that covers it in the meantime is caught.
  browser.page.overlayGates = [null, gate];
  const { access } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const running = execute('choose_suggestion', { index: 0, text: 'Del', option: 'Delhi' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  browser.page.cover = { index: 5, tag: 'button', label: 'Something else', x: 200, y: 60 };
  release();

  const result = await running;
  assert.equal(result.isError, true);
  assert.equal(named(browser.calls, 'clickAt').length, 1, 'only the click on the field happened');
});

test('without an authority the page is not read either', async () => {
  const browser = fakeBrowser();
  const execute = executor(browser, null);

  for (const [name, args] of [['read_page', {}], ['get_text', {}], ['screenshot', {}], ['list_tabs', {}]]) {
    const result = await execute(name, args);
    assert.equal(result.isError, true, `${name} was refused`);
    assert.match(result.output, /no access authority/);
  }
  assert.equal(named(browser.calls, 'snapshot').length, 0, 'the page was never read');
  assert.equal(named(browser.calls, 'text').length, 0);
  assert.equal(named(browser.calls, 'screenshot').length, 0);
});

test('with an authority the page is read without a question', async () => {
  const browser = fakeBrowser();
  const { access, questions } = authority({ decision: 'deny' });
  const execute = executor(browser, access);

  const result = await execute('read_page', {});

  assert.equal(result.isError, undefined);
  assert.match(result.output, /Interactive elements/);
  assert.equal(questions.length, 0, 'reading asks nobody');
});

test('the notebook and the questions to the user stay usable without an authority', async () => {
  const browser = fakeBrowser();
  const execute = createToolExecutor(browser, { askUser: async (question) => `answer to ${question}` });

  const asked = await execute('ask_user', { question: 'Which one?' });
  assert.match(asked.output, /User answered: answer to Which one\?/);
  const waited = await execute('wait', { seconds: 0.5 });
  assert.match(waited.output, /Waited 0.5s/);
});

test('a tab that cannot be named is refused', async () => {
  const browser = fakeBrowser();
  const original = browser.captureTarget;
  browser.captureTarget = async (what) => {
    const target = await original(what);
    return what?.kind === 'tab' ? { ...target, scope: 'element' } : target; // a browser that does not name tabs
  };
  const { access, questions } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const result = await execute('navigate', { url: 'https://shop.test/other' });

  assert.equal(result.isError, true);
  assert.match(result.output, /could not be named/);
  assert.equal(questions.length, 0, 'nothing was asked about a tab that is not there');
  assert.equal(named(browser.calls, 'navigate').length, 0);
});

test('a stopped command runs nothing at all', async () => {
  const browser = fakeBrowser();
  const stop = new AbortController();
  stop.abort();
  const { access, questions } = authority({ mode: 'full-access' });
  const execute = executor(browser, access, { signal: stop.signal });

  const result = await execute('click', { index: 2 });

  assert.equal(result.isError, true);
  assert.match(result.output, /Stopped by user/);
  assert.equal(questions.length, 0, 'no question was asked');
  assert.equal(browser.calls.length, 0, 'the browser was never touched');
});

test('press_key is pinned to the element that has the focus', async () => {
  const browser = fakeBrowser();
  browser.page.focused = 0;
  let pending = null;
  const { access } = authority({ decision: null, onRequest: (request) => { pending = request; } });
  const execute = executor(browser, access);

  const running = execute('press_key', { key: 'Enter' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  browser.page.focused = 2; // the focus moved to another element while the question was open
  access.respondApproval({ id: pending.id, sessionId: pending.sessionId, revision: pending.revision, decision: 'allow' });

  const refused = await running;
  assert.equal(refused.isError, true);
  assert.equal(named(browser.calls, 'pressKey').length, 0, 'the key did not follow the focus');

  // The focus that was approved still has the focus: the key goes to it.
  browser.page.focused = 0;
  const full = authority({ mode: 'full-access' });
  const pressed = await executor(browser, full.access)('press_key', { key: 'Enter' });
  assert.equal(pressed.isError, undefined);
  assert.equal(named(browser.calls, 'pressKey').length, 1);
});

test('an unknown or unoffered tool does nothing at all', async () => {
  const browser = fakeBrowser();
  const { access, questions } = authority({ mode: 'full-access' });
  const execute = executor(browser, access, { allowed: new Set(['read_page']) });

  const unknown = await execute('click', { index: 2 });
  assert.deepEqual(unknown, { output: 'Unknown tool "click".', isError: true });
  assert.equal(named(browser.calls, 'captureTarget').length, 0, 'nothing was even captured');
  assert.equal(questions.length, 0);
});

test('a tab that went somewhere else does not inherit the approval', async () => {
  const browser = fakeBrowser();
  let pending = null;
  const { access } = authority({ decision: null, onRequest: (request) => { pending = request; } });
  const execute = executor(browser, access);

  const running = execute('navigate', { url: 'https://shop.test/other' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  browser.page.url = 'https://shop.test/elsewhere'; // the tab went somewhere else meanwhile
  access.respondApproval({ id: pending.id, sessionId: pending.sessionId, revision: pending.revision, decision: 'allow' });

  const result = await running;
  assert.equal(result.isError, true);
  assert.equal(named(browser.calls, 'navigate').length, 0, 'the page was not navigated');
});

test('a page that is not there any more is refused before the user is asked', async () => {
  const browser = fakeBrowser();
  const { access, questions } = authority({ mode: 'full-access' });
  const execute = executor(browser, access);

  const result = await execute('click', { index: 99 });

  assert.equal(result.isError, true);
  assert.match(result.output, /not on the page any more/);
  assert.equal(questions.length, 0, 'no question about an element that is not there');
});

test('every tool that can change a page, and every read of a value, asks the authority', async () => {
  const tools = [
    ['click', { index: 2 }],
    ['click_at', { x: 100, y: 180 }],
    ['type_text', { index: 0, text: 'hello' }],
    ['insert_text', { text: 'hello' }],
    ['press_key', { key: 'Enter' }],
    ['select_option', { index: 2, option: 'Send' }],
    ['choose_suggestion', { index: 0, text: 'Del', option: 'Delhi' }],
    ['hover', { index: 2 }],
    ['scroll', { direction: 'down' }],
    ['navigate', { url: 'https://shop.test/other' }],
    ['web_search', { query: 'a thing' }],
    ['history', { action: 'back' }],
    ['switch_tab', { tab_id: 9 }],
    ['open_tab', { url: 'https://shop.test/other' }],
    ['close_tab', { tab_id: 9 }],
    ['read_field', { index: 0 }],
  ];
  for (const [name, args] of tools) {
    const browser = fakeBrowser();
    const { access, questions } = authority({ decision: 'allow' });
    const execute = executor(browser, access);
    const result = await execute(name, args);
    assert.equal(questions.length, 1, `${name} asked the authority about itself`);
    assert.equal(result.isError, undefined, `${name} ran: ${result.output}`);
  }
});

test('the tools that only read ask nothing', async () => {
  const tools = [['read_page', {}], ['get_text', {}], ['list_tabs', {}], ['wait', { seconds: 1 }]];
  for (const [name, args] of tools) {
    const browser = fakeBrowser();
    const { access, questions } = authority({ decision: 'deny' });
    const execute = executor(browser, access);
    const result = await execute(name, args);
    assert.equal(questions.length, 0, `${name} asked nothing`);
    assert.equal(result.isError, undefined, `${name} ran`);
  }
});
