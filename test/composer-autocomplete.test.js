import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposerAutocomplete, parseAutocompleteTrigger } from '../src/sidepanel/composer-autocomplete.js';

function fakeDom() {
  const inputListeners = new Map();
  const input = {
    value: '',
    selectionStart: 0,
    setSelectionRange(start) { this.selectionStart = start; },
    focus() {},
    addEventListener(name, fn) { inputListeners.set(name, fn); },
    triggerInput(val) {
      this.value = val;
      this.selectionStart = val.length;
      inputListeners.get('input')?.();
    },
    triggerKeyDown(key, opts = {}) {
      let prevented = false;
      inputListeners.get('keydown')?.({
        key,
        ...opts,
        preventDefault() { prevented = true; },
        stopPropagation() {},
      });
      return prevented;
    },
  };
  const doc = {
    createElement(tag) {
      return {
        tag,
        type: '',
        className: '',
        dir: '',
        textContent: '',
        children: [],
        attrs: {},
        listeners: new Map(),
        setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener(k, fn) { this.listeners.set(k, fn); },
        append(...nodes) { this.children.push(...nodes); },
      };
    },
  };
  const list = {
    hidden: true,
    children: [],
    ownerDocument: doc,
    replaceChildren(...nodes) { this.children = nodes; },
  };
  return { input, list };
}

test('parseAutocompleteTrigger detects leading slash commands and @file mentions', () => {
  assert.deepEqual(parseAutocompleteTrigger('/co'), {
    kind: 'slash',
    query: 'co',
    tokenStart: 0,
    tokenEnd: 3,
  });
  assert.equal(parseAutocompleteTrigger('hello /co'), null, 'slash commands only trigger at the start');
  assert.deepEqual(parseAutocompleteTrigger('Read @src/agent/ag'), {
    kind: 'file',
    query: 'src/agent/ag',
    directory: 'src/agent',
    prefix: 'ag',
    tokenStart: 5,
    tokenEnd: 18,
  });
  assert.deepEqual(parseAutocompleteTrigger('Read @"My Files/doc'), {
    kind: 'file',
    query: 'My Files/doc',
    directory: 'My Files',
    prefix: 'doc',
    tokenStart: 5,
    tokenEnd: 19,
  });
});

test('createComposerAutocomplete completes /compact and @file mentions', async () => {
  const { input, list } = fakeDom();
  const ac = createComposerAutocomplete({
    input,
    list,
    getSessionId: () => 's1',
    getProject: () => ({ name: 'app', root: '/app' }),
    t: (k) => k,
    resize: () => {},
    request: async (type, payload) => {
      assert.equal(type, 'project-list-ui');
      if (payload.path === '.') {
        return {
          entries: [
            { name: 'README.md', directory: false },
            { name: 'src', directory: true },
          ],
        };
      }
      return { entries: [] };
    },
  });

  // 1. Slash command autocomplete
  input.triggerInput('/c');
  assert.equal(ac.isOpen(), true);
  assert.equal(ac.items()[0].id, '/compact');
  assert.equal(input.triggerKeyDown('Tab'), true);
  assert.equal(input.value, '/compact ');
  assert.equal(ac.isOpen(), false);

  // 2. @file autocomplete
  input.triggerInput('Check @READ');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ac.isOpen(), true);
  assert.equal(ac.items().length, 1);
  assert.equal(ac.items()[0].id, 'README.md');
  assert.equal(input.triggerKeyDown('Enter', { isComposing: true }), false, 'IME composition Enter does not accept suggestion');
  assert.equal(input.triggerKeyDown('Enter'), true);
  assert.equal(input.value, 'Check @"README.md" ');
  assert.equal(ac.isOpen(), false);

  // 3. Moving caret away from token invalidates selection
  input.triggerInput('/c');
  assert.equal(ac.isOpen(), true);
  input.selectionStart = 0;
  assert.equal(input.triggerKeyDown('Tab'), false, 'moving caret away prevents stale suggestion insertion');
});
