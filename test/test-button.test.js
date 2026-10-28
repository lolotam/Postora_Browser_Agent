import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindTestButton } from '../src/sidepanel/test-button.js';

// Minimal stand-ins for the button, result line and form scope.
function element() {
  const listeners = {};
  return {
    dataset: {},
    textContent: '',
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    fire: (type, event = {}) => Promise.all((listeners[type] ?? []).map((fn) => fn(event))),
  };
}

function setup() {
  const button = element();
  const result = element();
  const scope = element();
  const pending = [];
  const show = bindTestButton({ button, result, scope, run: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  return { button, result, scope, pending, show };
}

test('a finished test shows its result', async () => {
  const { button, result, pending } = setup();
  const click = button.fire('click');
  pending[0].resolve('✓ ok');
  await click;
  assert.equal(result.textContent, '✓ ok');
  assert.equal(button.dataset.state, 'ok');
});

test('editing a field while a test runs discards its late result', async () => {
  const { button, result, scope, pending } = setup();
  const click = button.fire('click');
  await scope.fire('input', { target: {} });
  pending[0].resolve('✓ stale');
  await click;
  assert.equal(result.textContent, '');
  assert.equal(button.dataset.state, '');
});

test('only the newest of overlapping tests paints its result', async () => {
  const { button, result, pending } = setup();
  const first = button.fire('click');
  const second = button.fire('click');
  pending[1].reject(new Error('401 bad key'));
  await second;
  pending[0].resolve('✓ old key');
  await first;
  assert.equal(result.textContent, '✗ 401 bad key');
  assert.equal(button.dataset.state, 'fail');
});

test('programmatic model changes clear and invalidate an in-flight test', async () => {
  const { button, result, pending, show } = setup();
  const click = button.fire('click');
  show('', '');
  pending[0].resolve('old model tested');
  await click;
  assert.equal(result.textContent, '');
  assert.equal(button.dataset.state, '');
});
