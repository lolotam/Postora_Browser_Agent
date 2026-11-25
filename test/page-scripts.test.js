import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elementAction, pointSnap } from '../src/browser/page-scripts.js';

// The smallest element elementAction('locate') reads, with the given attributes.
function locate(attrs, type = 'text') {
  const el = {
    isConnected: true,
    type,
    tagName: 'INPUT',
    innerText: '',
    style: {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }),
    getAttribute: (name) => attrs[name] ?? null,
  };
  globalThis.window = { __agentElements: [el] };
  return elementAction(0, 'locate', null, true);
}

test('locate marks password, payment and one-time-code fields as secret', () => {
  assert.equal(locate({}, 'password').secret, true);
  assert.equal(locate({ autocomplete: 'cc-number' }).secret, true);
  assert.equal(locate({ autocomplete: 'one-time-code' }).secret, true);
});

test('locate finds secret autocomplete tokens behind section and grouping prefixes', () => {
  assert.equal(locate({ autocomplete: 'section-checkout billing cc-number' }).secret, true);
  assert.equal(locate({ autocomplete: 'shipping  CC-CSC' }).secret, true);
  assert.equal(locate({ autocomplete: 'section-login current-password' }).secret, true);
});

test('locate leaves ordinary fields readable', () => {
  assert.equal(locate({ autocomplete: 'shipping email' }).secret, false);
  assert.equal(locate({ autocomplete: 'one-time-code-hint' }).secret, false);
  assert.equal(locate({ placeholder: 'Search' }).label, 'Search');
});

test('a point just outside a control is clamped inside its box', () => {
  const button = {
    closest: (s) => (s.includes('button') ? button : null),
    getBoundingClientRect: () => ({ left: 100, top: 280, width: 90, height: 36, right: 190, bottom: 316 }),
  };
  globalThis.document = { elementFromPoint: () => button };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  // The model aimed 8 px above the button: the click lands just inside it.
  assert.deepEqual(pointSnap(120, 272), { x: 120, y: 282 });
  // A point already inside the box stays exactly where the model aimed it.
  assert.equal(pointSnap(150, 300), null);
});

test('a point on the background stays on the background', () => {
  const background = { closest: () => null };
  const button = {
    closest: (s) => (s.includes('button') ? button : null),
    getBoundingClientRect: () => ({ left: 104, top: 104, width: 60, height: 30, right: 164, bottom: 134 }),
  };
  globalThis.document = { elementFromPoint: (x, y) => (x === 100 && y === 100 ? background : button) };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  // (100, 100) is a deliberate click on empty space — dismissing a dialog by
  // clicking outside it, say. A button four pixels away must not swallow it.
  assert.equal(pointSnap(100, 100), null);
});

test('the body, a page-sized surface and nothing at all are never snapped', () => {
  const body = { closest: () => null };
  globalThis.document = { elementFromPoint: () => body };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  assert.equal(pointSnap(50, 50), null, 'the body is not a control');
  const surface = {
    closest: (s) => (s.includes('[role="button"]') ? surface : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 780, right: 1280, bottom: 780 }),
  };
  globalThis.document = { elementFromPoint: () => surface };
  assert.equal(pointSnap(100, 100), null, 'a box that covers the viewport is a surface, not a control');
});

test('activate clicks the element in its own frame', () => {
  let clicked = 0;
  const events = [];
  const el = {
    isConnected: true, tagName: 'BUTTON', innerText: '', style: {},
    scrollIntoView() {},
    dispatchEvent: (event) => { events.push(event.type); if (event.type === 'click') clicked += 1; return true; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    getAttribute: () => null,
  };
  class FakeEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  }
  globalThis.window = { __agentElements: [el], MouseEvent: FakeEvent, PointerEvent: FakeEvent };
  globalThis.document = { elementFromPoint: () => el };
  assert.deepEqual(elementAction(0, 'activate', null, true), { ok: true, tag: 'button' });
  assert.equal(clicked, 1);
  assert.deepEqual(events, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
});

// An element for the activate tests: it can take the focus, and `hit` is what
// the page returns for the point at its centre.
function pressable(tagName, hit) {
  const el = {
    isConnected: true, tagName, innerText: '', style: {},
    events: [], focused: 0,
    scrollIntoView() {},
    dispatchEvent(event) { el.events.push(event.type); return true; },
    focus() { el.focused += 1; },
    closest: () => el,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    getAttribute: () => null,
  };
  class FakeEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  }
  globalThis.window = { __agentElements: [el], MouseEvent: FakeEvent, PointerEvent: FakeEvent };
  globalThis.document = { elementFromPoint: () => hit(el) };
  return el;
}

test('activate does not click an element that another element covers', () => {
  const cover = { tagName: 'DIV', matches: () => true, parentElement: null };
  const el = pressable('BUTTON', () => cover);
  const result = elementAction(0, 'activate', null, true);
  assert.match(result.error, /covered by another element/);
  assert.deepEqual(el.events, [], 'no event reached the covered control');
});

test('activate moves the focus to the input it presses', () => {
  const el = pressable('INPUT', (self) => self);
  assert.deepEqual(elementAction(0, 'activate', null, true), { ok: true, tag: 'input' });
  assert.equal(el.focused, 1, 'a synthetic press does the focus step of a real one');
});

test('focus-el puts the focus on the element of its own frame', () => {
  let focused = 0;
  const el = {
    isConnected: true, tagName: 'TEXTAREA', innerText: '', style: {},
    scrollIntoView() {},
    focus: () => { focused += 1; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    getAttribute: () => null,
  };
  globalThis.window = { __agentElements: [el] };
  assert.deepEqual(elementAction(0, 'focus-el', null, true), { ok: true, tag: 'textarea' });
  assert.equal(focused, 1);
});

test('scroll-el scrolls the element itself by about a screen', () => {
  let scrolled;
  const el = {
    isConnected: true, tagName: 'DIV', innerText: '', style: {},
    scrollIntoView() {},
    scrollBy: ({ top }) => { scrolled = top; el.scrollTop = top; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 400 }),
    getAttribute: () => null,
  };
  el.clientHeight = 400;
  el.scrollHeight = 2000; // a real scrollable pane
  globalThis.window = { __agentElements: [el], innerHeight: 800 };
  globalThis.document = { body: {}, documentElement: {} };
  globalThis.getComputedStyle = () => ({ overflowY: 'auto' });
  const result = elementAction(0, 'scroll-el', { direction: 'down', screens: 1 }, true);
  assert.equal(result.ok, true);
  assert.equal(scrolled, 1 * 400 * 0.85);
});

test('scroll-el turns the document when the element has no scrollable pane', () => {
  let scrolled;
  const el = {
    isConnected: true, tagName: 'BUTTON', innerText: '', style: {},
    scrollIntoView() {},
    scrollBy: () => assert.fail('a button has no overflow to scroll'),
    clientHeight: 20, scrollHeight: 20,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 30, height: 20 }),
    getAttribute: () => null,
  };
  const scroller = { scrollTop: 0 };
  globalThis.window = { __agentElements: [el], innerHeight: 800, scrollBy: ({ top }) => { scrolled = top; scroller.scrollTop = top; } };
  globalThis.document = { body: {}, documentElement: {}, scrollingElement: scroller };
  globalThis.getComputedStyle = () => ({ overflowY: 'visible' });
  const result = elementAction(0, 'scroll-el', { direction: 'down', screens: 1 }, true);
  assert.equal(result.ok, true);
  assert.equal(result.pane, false);
  assert.equal(scrolled, 800 * 0.85);
  assert.equal(result.top, 800 * 0.85);
});

test('elementFrame answers null for the top document and its frame for a child frame', async () => {
  const { BrowserController } = await import('../src/browser/controller.js');
  const controller = Object.create(BrowserController.prototype);
  controller.snapshotFrames = [
    { frameId: 0, offset: 0, count: 3 },
    { frameId: 5, offset: 3, count: 2 },
  ];
  assert.equal(controller.elementFrame(0), null, 'the top document takes the trusted CDP path');
  assert.equal(controller.elementFrame(2), null);
  assert.equal(controller.elementFrame(3), 5, 'a child frame element takes the in-frame path');
  assert.equal(controller.elementFrame(4), 5);
  assert.equal(controller.elementFrame(9), null, 'an index past the snapshot has no frame');
});

test('snapshotPage anchors text around the current viewport when scrolled down', async () => {
  const { snapshotPage } = await import('../src/browser/page-scripts.js');
  const topBlock = {
    nodeType: 1,
    tagName: 'DIV',
    childNodes: [{ nodeType: 3, nodeValue: 'TOP_HEADING_TEXT '.repeat(40) }],
    getBoundingClientRect: () => ({ top: -600, bottom: -100, left: 0, right: 800, width: 800, height: 500 }),
    getAttribute: () => null,
  };
  const midBlock = {
    nodeType: 1,
    tagName: 'DIV',
    childNodes: [{ nodeType: 3, nodeValue: 'VIEWPORT_VISIBLE_SECTION '.repeat(30) }],
    getBoundingClientRect: () => ({ top: 40, bottom: 540, left: 0, right: 800, width: 800, height: 500 }),
    getAttribute: () => null,
  };
  const body = {
    innerText: `${topBlock.childNodes[0].nodeValue}\n${midBlock.childNodes[0].nodeValue}`,
    childNodes: [topBlock, midBlock],
    querySelectorAll: () => [],
  };
  globalThis.window = { scrollY: 700, innerHeight: 800, innerWidth: 1280, __agentElements: [] };
  globalThis.location = { href: 'https://example.test/long' };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  globalThis.document = {
    title: 'Long Page',
    body,
    documentElement: { scrollHeight: 2400 },
    querySelectorAll: () => [],
  };
  const snap = snapshotPage(50, 200, { tokens: [], words: [], fragments: [] }, 1);
  assert.match(snap.text, /VIEWPORT_VISIBLE_SECTION/, 'scrolled snapshot starts with text in the viewport');
  assert.doesNotMatch(snap.text, /TOP_HEADING_TEXT/, 'scrolled-past top blocks do not crowd out the viewport text');
});

test('BrowserController.snapshot enforces one total maxElements cap across frames and BrowserController.text accepts a frame argument', async () => {
  const { BrowserController } = await import('../src/browser/controller.js');
  const { createToolExecutor, toolDefinitions } = await import('../src/agent/tools.js');
  const { FULL_ACCESS } = await import('../src/permissions/policy.js');

  const getTextDef = toolDefinitions({}).find((t) => t.name === 'get_text');
  assert.equal(getTextDef.parameters.properties.frame?.type, 'integer');

  const controller = Object.create(BrowserController.prototype);
  controller.injectFrames = async () => [
    {
      frameId: 0,
      result: {
        url: 'https://example.test/',
        title: 'Main',
        scroll: { y: 0, viewport: 800, height: 800 },
        elements: ['[0] button "Main 0"', '[1] button "Main 1"', '[2] button "Main 2"'],
        offscreen: 1,
        text: 'Main text',
        dates: [],
      },
    },
    {
      frameId: 7,
      result: {
        url: 'https://frame.test/',
        title: 'Child',
        scroll: { y: 0, viewport: 400, height: 400 },
        elements: ['[0] button "Child 0"', '[1] button "Child 1"', '[2] button "Child 2"'],
        offscreen: 2,
        text: 'Child text',
        dates: [],
      },
    },
  ];
  const snap = await controller.snapshot({ maxElements: 4, maxTextChars: 1000 });
  assert.equal(snap.elements.length, 4, 'combined elements across frames are capped at maxElements');
  assert.deepEqual(snap.elements, [
    '[0] button "Main 0"',
    '[1] button "Main 1"',
    '[2] button "Main 2"',
    '[3] button "Child 0" (in frame)',
  ]);
  assert.equal(snap.offscreen, 1 + 2 + 2, 'dropped elements from the cap are added to offscreen');
  assert.equal(controller.frameOf(3)?.frameId, 7);
  assert.equal(controller.frameOf(4), null, 'dropped frame elements are not mapped');

  const injectedCalls = [];
  controller.inject = async (_fn, args, opts = {}) => {
    injectedCalls.push({ args, opts });
    return { start: args[0], total: 120, text: `frame-${opts.frameId ?? 0}-text`, dates: [] };
  };
  controller.currentTab = async () => ({ id: 1, url: 'https://example.test/', title: 'Main' });

  const access = {
    mode: FULL_ACCESS,
    authorize: async () => ({ permit: 'p-1' }),
    grantValid: () => true,
  };
  const execute = createToolExecutor(controller, { access });

  const mainText = await execute('get_text', { start: 0, length: 500 });
  assert.match(mainText.output, /frame-0-text/);
  assert.equal(injectedCalls.at(-1).opts.frameId, undefined);

  const childBySlot = await execute('get_text', { start: 10, length: 600, frame: 1 });
  assert.match(childBySlot.output, /frame-7-text/);
  assert.equal(injectedCalls.at(-1).opts.frameId, 7);

  const childById = await execute('get_text', { start: 0, length: 600, frame: 7 });
  assert.match(childById.output, /frame-7-text/);
  assert.equal(injectedCalls.at(-1).opts.frameId, 7);
});

test('a focus capture takes the frame that is in the focus chain, not a frame that held the focus before', async () => {
  const { BrowserController } = await import('../src/browser/controller.js');
  const controller = Object.create(BrowserController.prototype);
  controller.currentGeneration = 1;
  controller.currentTab = async () => ({ id: 1, url: 'https://example.test/' });
  const field = (token) => ({ kind: 'focus', token, tag: 'input', body: false });
  const answer = (frameId, token, hasFocus) => ({ frameId, result: { ok: true, documentId: `d${frameId}`, generation: 1, hasFocus, element: field(token) } });
  // Frame 5 answers first, but the focus moved to frame 9 after it.
  controller.injectFrames = async () => [
    { frameId: 0, result: { ok: true, documentId: 'd0', generation: 1, hasFocus: true, element: { kind: 'focus', token: 'top', tag: 'iframe', body: false } } },
    answer(5, 'old', false),
    answer(9, 'now', true),
  ];
  const target = await controller.captureTarget({ kind: 'focus' });
  assert.equal(target.frameId, 9);
  assert.equal(target.element.token, 'now');

  // The window itself has no focus: nothing tells the frames apart, and the
  // first real field still wins as before.
  controller.injectFrames = async () => [
    { frameId: 0, result: { ok: true, documentId: 'd0', generation: 1, hasFocus: false, element: { kind: 'focus', token: 'top', tag: 'iframe', body: false } } },
    answer(5, 'old', false),
    answer(9, 'now', false),
  ];
  assert.equal((await controller.captureTarget({ kind: 'focus' })).frameId, 5);
});

test('typing in a frame needs the approved frame itself in the focus chain, not just any iframe', async () => {
  const { BrowserController } = await import('../src/browser/controller.js');
  const controller = Object.create(BrowserController.prototype);
  const target = { tabId: 1, frameId: 5 };
  const run = async ({ top, inApproved }) => {
    const asked = [];
    controller.inject = async (fn, _args, opts = {}) => {
      asked.push(opts.frameId ?? 0);
      return fn.name === 'focusInFrame' ? top : inApproved;
    };
    try { await controller.assertFocusChain(target); return { ok: true, asked }; } catch { return { ok: false, asked }; }
  };
  assert.equal((await run({ top: { iframe: true, focused: true }, inApproved: true })).ok, true);
  const sibling = await run({ top: { iframe: true, focused: true }, inApproved: false });
  assert.equal(sibling.ok, false, 'focus moved to a sibling frame after the approval');
  assert.deepEqual(sibling.asked, [0, 5], 'the approved frame is the one asked');
  assert.equal((await run({ top: { iframe: false, focused: true }, inApproved: true })).ok, false);
  // Without window focus no frame can be told from another: the old check stands.
  assert.equal((await run({ top: { iframe: true, focused: false }, inApproved: false })).ok, true);
});
