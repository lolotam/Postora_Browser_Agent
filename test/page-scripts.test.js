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
    dispatchEvent: (event) => { events.push(event.type); if (event.type === 'click') clicked += 1; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    getAttribute: () => null,
  };
  class FakeEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  }
  globalThis.window = { __agentElements: [el], MouseEvent: FakeEvent, PointerEvent: FakeEvent };
  assert.deepEqual(elementAction(0, 'activate', null, true), { ok: true, tag: 'button' });
  assert.equal(clicked, 1);
  assert.deepEqual(events, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
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
  globalThis.window = { __agentElements: [el], innerHeight: 800 };
  const result = elementAction(0, 'scroll-el', { direction: 'down', screens: 1 }, true);
  assert.equal(result.ok, true);
  assert.equal(scrolled, 1 * 400 * 0.85);
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
