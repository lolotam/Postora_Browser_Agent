import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createModelDialog } from '../src/sidepanel/model-dialog.js';
import { MESSAGES } from '../src/sidepanel/messages.js';

// The smallest stand-in for the dialog's pieces: values, flags, listeners and
// the last HTML the list was drawn with. dispatch() hands back what the
// handler returned, so an async UI handler can really be awaited.
function fakeElement() {
  const listeners = new Map();
  const classes = new Set();
  const attributes = new Map();
  const el = {
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    open: false,
    showModalCount: 0,
    closeCount: 0,
    focused: 0,
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      const results = [];
      for (const fn of listeners.get(type) ?? []) results.push(fn({ type, target: el, preventDefault() {}, ...event }));
      return results.length === 1 ? results[0] : results;
    },
    focus() { el.focused += 1; },
    showModal() { el.showModalCount += 1; el.open = true; },
    close() { el.closeCount += 1; el.open = false; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  };
  return el;
}

/** Parses the rows the dialog last drew, ids included. */
function rowsOf(list) {
  const rows = [];
  for (const match of list.innerHTML.matchAll(/<li[^>]*id="([^"]*)"[^>]*data-value="([^"]*)"[^>]*class="([^"]*)"[^>]*>/g)) {
    rows.push({
      id: match[1],
      dataset: { value: match[2] },
      className: match[3],
      chosen: match[3].includes('chosen'),
      active: match[3].includes('active'),
      scrollIntoView() {},
    });
  }
  return rows;
}

function fakeDialog() {
  const elements = {
    dialog: fakeElement(),
    title: fakeElement(),
    searchRow: fakeElement(),
    search: fakeElement(),
    list: fakeElement(),
    empty: fakeElement(),
    status: fakeElement(),
    manual: fakeElement(),
    manualInput: fakeElement(),
    manualSave: fakeElement(),
    manualBtn: fakeElement(),
    refresh: fakeElement(),
    configure: fakeElement(),
    close: fakeElement(),
    hint: fakeElement(),
  };
  let html = '';
  let rows = [];
  Object.defineProperty(elements.list, 'innerHTML', {
    get: () => html,
    set(value) {
      html = value;
      rows = rowsOf({ innerHTML: value });
      for (const row of rows) {
        row.classList = { toggle(name, on) { if (name === 'active') row.active = on; } };
        row.click = () => elements.list.dispatch('click', { target: { closest: () => row } });
      }
    },
  });
  Object.defineProperty(elements.list, 'children', { get: () => rows });
  elements.list.querySelectorAll = (selector) => (selector === '.model-option' ? rows : []);
  return { elements, dialog: createModelDialog(elements) };
}

const MODELS = [
  { id: 'mock-current', name: 'Mock Current' },
  { id: 'mock-alternative', name: 'Mock Alternative' },
  { id: 'deepseek-v3', name: 'DeepSeek V3', hidden: true },
];

test('the dialog lists the provider models and marks the chosen one', () => {
  const { elements, dialog } = fakeDialog();
  const picks = [];
  dialog.open({
    title: () => 'Main model',
    get: () => ({ current: 'mock-alternative', models: MODELS }),
    onPick: (id) => picks.push(id),
  });
  assert.equal(elements.dialog.showModalCount, 1);
  assert.equal(elements.title.textContent, 'Main model');
  const rows = elements.list.querySelectorAll('.model-option');
  assert.deepEqual(rows.map((r) => r.dataset.value), ['mock-current', 'mock-alternative', 'deepseek-v3']);
  assert.deepEqual(rows.map((r) => r.chosen), [false, true, false]);
  assert.equal(elements.list.hidden, false);
  assert.equal(elements.search.focused, 1);
  assert.equal(picks.length, 0, 'nothing is applied by opening');
});

test('a current id the list does not know stays visible as the chosen row', () => {
  const { elements, dialog } = fakeDialog();
  dialog.open({
    title: () => 'Model',
    get: () => ({ current: 'my-own-model', models: MODELS }),
    onPick: () => {},
  });
  const rows = elements.list.querySelectorAll('.model-option');
  assert.equal(rows[0].dataset.value, 'my-own-model', 'the current id is pinned first');
  assert.equal(rows[0].chosen, true);
  assert.ok(elements.list.innerHTML.includes('Enter a model ID manually'), 'the pinned row says what it is');
});

test('Search Enter commits the first real match of the query, not the kept current', () => {
  const { elements, dialog } = fakeDialog();
  const picks = [];
  dialog.open({
    title: () => 'Model',
    get: () => ({ current: 'mock-current', models: MODELS }),
    onPick: (id) => picks.push(id),
  });
  // The list keeps the chosen model visible (filterModels holds it), but the
  // old search behavior must survive: Enter is bound to the query alone.
  elements.search.value = 'alternative';
  elements.search.dispatch('input');
  const visible = elements.list.querySelectorAll('.model-option').map((r) => r.dataset.value);
  assert.ok(visible.includes('mock-current'), 'the chosen model stays listed while searching');
  elements.search.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(picks, ['mock-alternative'], 'Enter picked the match, not the current');
  assert.equal(elements.dialog.closeCount, 1, 'a pick closes the dialog');

  // Several terms narrow like the old search did.
  elements.search.value = 'deepseek v3';
  elements.search.dispatch('input');
  elements.search.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(picks, ['mock-alternative', 'deepseek-v3']);
});

test('Enter with no matching result changes nothing at all', () => {
  const { elements, dialog } = fakeDialog();
  const picks = [];
  dialog.open({
    title: () => 'Model',
    get: () => ({ current: 'mock-current', models: MODELS }),
    onPick: (id) => picks.push(id),
  });
  elements.search.value = 'nothing-matches-this';
  elements.search.dispatch('input');
  assert.equal(elements.empty.hidden, false, 'no results is said, not drawn as an empty list');
  elements.search.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(picks, [], 'a no-match Enter picks nothing');
  assert.equal(elements.dialog.closeCount, 0, 'and the dialog stays open');
});

test('arrow keys announce the cursor, and Enter then picks that row', () => {
  const { elements, dialog } = fakeDialog();
  const picks = [];
  dialog.open({
    title: () => 'Model',
    get: () => ({ current: '', models: MODELS }),
    onPick: (id) => picks.push(id),
  });
  elements.search.dispatch('keydown', { key: 'ArrowDown' });
  elements.search.dispatch('keydown', { key: 'ArrowDown' });
  const rows = elements.list.querySelectorAll('.model-option');
  assert.equal(rows[1].active, true);
  assert.equal(elements.search.getAttribute('aria-activedescendant'), rows[1].id, 'the cursor is announced on the combobox');
  assert.equal(elements.list.getAttribute('aria-activedescendant'), rows[1].id, 'and on the listbox');
  elements.search.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(picks, ['mock-alternative'], 'the row the user moved onto is the choice');
});

test('ArrowUp from the search starts at the final option', () => {
  const { elements, dialog } = fakeDialog();
  const picks = [];
  dialog.open({ title: () => 'Model', get: () => ({ models: MODELS }), onPick: (id) => picks.push(id) });
  elements.search.dispatch('keydown', { key: 'ArrowUp' });
  elements.search.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(picks, ['deepseek-v3']);
});

test('a late refresh from an earlier slot cannot end the new slot\'s refresh', async () => {
  const { elements, dialog } = fakeDialog();
  let releaseOld;
  let releaseNew;
  dialog.open({ title: () => 'Old', get: () => ({ models: [] }), onRefresh: () => new Promise((resolve) => { releaseOld = resolve; }) });
  const oldRefresh = elements.refresh.dispatch('click');
  elements.close.dispatch('click');
  dialog.open({ title: () => 'New', get: () => ({ models: MODELS }), onRefresh: () => new Promise((resolve) => { releaseNew = resolve; }) });
  const newRefresh = elements.refresh.dispatch('click');
  releaseOld();
  await oldRefresh;
  assert.equal(elements.refresh.disabled, true, 'the newer refresh is still pending');
  releaseNew();
  await newRefresh;
  assert.equal(elements.refresh.disabled, false);
});

test('Enter cannot commit a stale row while a new list is loading', () => {
  const { elements, dialog } = fakeDialog();
  const picks = [];
  dialog.open({ title: () => 'Model', get: () => ({ models: MODELS, loading: true }), onPick: (id) => picks.push(id) });
  elements.search.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(picks, []);
});

test('the search filters the list and a clicked row is picked', () => {
  const { elements, dialog } = fakeDialog();
  const picks = [];
  dialog.open({
    title: () => 'Model',
    get: () => ({ current: '', models: MODELS }),
    onPick: (id) => picks.push(id),
  });
  elements.search.value = 'deepseek';
  elements.search.dispatch('input');
  const rows = elements.list.querySelectorAll('.model-option');
  assert.deepEqual(rows.map((r) => r.dataset.value), ['deepseek-v3']);
  elements.list.children[0].click();
  assert.deepEqual(picks, ['deepseek-v3']);
});

test('the manual path sets an id through onManual', () => {
  const { elements, dialog } = fakeDialog();
  const manual = [];
  dialog.open({
    title: () => 'Model',
    get: () => ({ current: 'mock-current', models: MODELS }),
    onPick: () => {},
    onManual: (id) => manual.push(id),
  });
  assert.equal(elements.manualBtn.hidden, false, 'the manual action is offered');
  elements.manualBtn.dispatch('click');
  assert.equal(elements.manual.hidden, false, 'the id field opens');
  assert.equal(elements.manualInput.value, 'mock-current', 'it starts from the current id');
  elements.manualInput.value = '  custom/model-x  ';
  elements.manualSave.dispatch('click');
  assert.deepEqual(manual, ['custom/model-x']);
  assert.equal(elements.dialog.closeCount, 1);
});

test('a provider with no list opens straight into its own current id', () => {
  const { elements, dialog } = fakeDialog();
  dialog.open({
    title: () => 'Fast model',
    get: () => ({ current: 'jev-latest', models: [], manualOnly: true }),
    onPick: () => {},
    onManual: () => {},
  });
  assert.equal(elements.list.hidden, true, 'no list is drawn where there is none');
  assert.equal(elements.searchRow.hidden, true, 'there is nothing to search where there is no list');
  assert.equal(elements.manualBtn.hidden, true, 'the manual action is not offered as a detour');
  assert.equal(elements.manual.hidden, false, 'the id field is the dialog');
  assert.equal(elements.manualInput.value, 'jev-latest', 'it holds this slot\'s own model');
  assert.equal(elements.refresh.hidden, true, 'a provider with no list offers no list refresh');
  assert.equal(elements.manualInput.focused, 1, 'the id field takes the focus');
});

test('a fresh open never inherits another dialog\'s typed manual id', () => {
  const { elements, dialog } = fakeDialog();
  const state = { current: 'mock-current', models: MODELS, manualOnly: false };
  dialog.open({ title: () => 'Model', get: () => state, onPick: () => {}, onManual: () => {} });
  elements.manualBtn.dispatch('click');
  elements.manualInput.value = 'UNSAVED-MANUAL-MARKER';
  // Closed without applying; another slot opens afterwards.
  elements.close.dispatch('click');
  dialog.open({
    title: () => 'Fast model',
    get: () => ({ current: 'jev-latest', models: [], manualOnly: true }),
    onPick: () => {},
    onManual: () => {},
  });
  assert.equal(elements.manualInput.value, 'jev-latest', 'the field starts from the new slot\'s own id');
  assert.equal(elements.search.value, '', 'the search starts empty too');
});

test('the caller\'s loading and error states are announced where the list would be', () => {
  const { elements, dialog } = fakeDialog();
  dialog.open({
    title: () => 'Model',
    get: () => ({ current: '', models: [], loading: true, error: '' }),
    onPick: () => {},
  });
  assert.equal(elements.status.hidden, false);
  assert.ok(elements.status.textContent.includes('Loading'), 'the wait is said');
  assert.equal(elements.list.hidden, true, 'the list waits while it loads');

  dialog.update();
  assert.equal(elements.status.hidden, false, 'still drawn after an update');
  const failing = fakeDialog();
  failing.dialog.open({
    title: () => 'Model',
    get: () => ({ current: '', models: [], error: 'the provider refused the request' }),
    onPick: () => {},
  });
  assert.equal(failing.elements.status.hidden, false);
  assert.equal(failing.elements.status.textContent, 'the provider refused the request');
  assert.ok(failing.elements.status.classList.contains('error'));
});

test('refresh shows the loading state and redraws from the caller', async () => {
  const { elements, dialog } = fakeDialog();
  let resolveRefresh;
  let count = 0;
  const models = () => (count ? MODELS : []);
  dialog.open({
    title: () => 'Model',
    get: () => ({ current: '', models: models() }),
    onPick: () => {},
    onRefresh: () => new Promise((resolve) => { resolveRefresh = () => { count = 1; resolve(); }; }),
  });
  const pending = Promise.resolve(elements.refresh.dispatch('click'));
  assert.equal(elements.status.hidden, false);
  assert.ok(elements.status.textContent.includes('Loading'), 'the wait is said');
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolveRefresh();
  await pending;
  assert.equal(elements.status.hidden, true, 'the wait is over');
  assert.ok(elements.list.innerHTML.includes('mock-current'), 'the refreshed list is drawn');
});

test('a refresh callback that rejects never leaves the dialog loading', async () => {
  const { elements, dialog } = fakeDialog();
  dialog.open({
    title: () => 'Model',
    get: () => ({ current: '', models: MODELS }),
    onPick: () => {},
    onRefresh: async () => { throw new Error('boom'); },
  });
  await Promise.resolve(elements.refresh.dispatch('click'));
  assert.equal(elements.status.hidden, true, 'the wait ends even on a failure');
  assert.equal(elements.refresh.disabled, false);
});

test('the dialog closes from its close button', () => {
  const { elements, dialog } = fakeDialog();
  dialog.open({
    title: () => 'Model',
    get: () => ({ current: '', models: MODELS }),
    onPick: () => {},
  });
  elements.close.dispatch('click');
  assert.equal(elements.dialog.closeCount, 1);
  assert.equal(dialog.isOpen(), false);
});

test('the quick-control route can offer the way to the full model settings', () => {
  const { elements, dialog } = fakeDialog();
  let configured = 0;
  dialog.open({
    title: () => 'Choose a model',
    get: () => ({ current: 'mock-current', models: MODELS }),
    onPick: () => {},
    onConfigure: () => { configured += 1; },
  });
  assert.equal(elements.configure.hidden, false, 'the route is on the screen when the caller offers it');
  elements.configure.dispatch('click');
  assert.equal(configured, 1);
  assert.equal(elements.dialog.closeCount, 1);
});

test('every string the dialog draws is translated in both languages', () => {
  const keys = ['model.loading', 'model.manualAction', 'model.hiddenGroup', 'model.noMatch', 'model.pick', 'model.searchDialog', 'model.esc'];
  for (const language of Object.keys(MESSAGES)) {
    for (const key of keys) assert.ok(key in MESSAGES[language], `${language} is missing ${key}`);
  }
});
