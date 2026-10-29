import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindComposerSize } from '../src/sidepanel/composer-size.js';

function setup(t) {
  const original = globalThis.ResizeObserver;
  let onResize;
  globalThis.ResizeObserver = class {
    constructor(callback) { onResize = callback; }
    observe() {}
  };
  t.after(() => { globalThis.ResizeObserver = original; });
  const events = {};
  const input = {
    visible: true, style: { transition: '' }, scrollHeight: 48, offsetHeight: 48,
    getClientRects() { return this.visible ? [{}] : []; },
    getBoundingClientRect() { return { height: 48 }; },
    addEventListener(name, callback) { events[name] = callback; },
  };
  const resize = bindComposerSize(input);
  return { input, resize, type: () => events.input(), width: (width) => onResize([{ contentRect: { width } }]) };
}

test('composer measures newlines and shrinks a cleared draft without overriding motion preferences', (t) => {
  const { input, resize, type } = setup(t);
  assert.equal(input.style.height, '48px');
  input.scrollHeight = 180;
  type();
  assert.equal(input.style.height, '180px');
  assert.equal(input.style.transition, '');
  input.scrollHeight = 48;
  resize();
  assert.equal(input.style.height, '48px');
});

test('composer retries on screen/width changes but not on its own height changes', (t) => {
  const { input, width } = setup(t);
  input.visible = false;
  input.scrollHeight = 140;
  width(0);
  assert.equal(input.style.height, '48px');
  input.visible = true;
  width(300);
  assert.equal(input.style.height, '140px');
  input.scrollHeight = 200;
  width(300);
  assert.equal(input.style.height, '140px', 'height changes must not cause an observer loop');
  width(250);
  assert.equal(input.style.height, '200px');
});
