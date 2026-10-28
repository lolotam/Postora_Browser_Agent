import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SECTION_PARENT, createSettingsNav } from '../src/sidepanel/settings-nav.js';

// The smallest stand-in for a page: it can hide, and its heading can take the focus.
function fakePage() {
  const el = {
    hidden: true,
    focused: 0,
    focus() { el.focused += 1; },
    contains() { return false; },
    querySelector(selector) {
      return selector === 'h2[tabindex="-1"]' ? { focus: () => { el.focused += 1; } } : null;
    },
  };
  return el;
}

function fakeRow(label) {
  return {
    label,
    hidden: false,
    dataset: { search: '' },
    textContent: label,
    isConnected: true,
    focused: 0,
    focus() { this.focused += 1; },
  };
}

function navFor({ pages = ['models', 'provider-main'], rows = ['Models', 'Fast'] } = {}) {
  const elements = { index: fakePage(), title: { textContent: '' }, searchEmpty: { hidden: true } };
  elements.page = Object.fromEntries(pages.map((name) => [name, fakePage()]));
  elements.rows = rows.map((label) => fakeRow(label));
  const exits = [];
  const nav = createSettingsNav({
    index: elements.index,
    pages: elements.page,
    title: elements.title,
    titles: {
      null: () => 'Settings',
      models: () => 'Models & providers',
      'provider-main': () => 'Main provider',
    },
    search: fakePage(),
    searchEmpty: elements.searchEmpty,
    rows: elements.rows,
    onExit: () => exits.push(true),
  });
  return { elements, nav, exits };
}

test('the provider pages walk back to the models overview, and the index out of settings', () => {
  assert.equal(SECTION_PARENT['provider-main'], 'models');
  assert.equal(SECTION_PARENT['provider-backup'], 'models');
  assert.equal(SECTION_PARENT.fast, null);
});

test('showing a section hides every other page and names it', () => {
  const { elements, nav } = navFor();
  assert.equal(nav.show('models'), true);
  assert.equal(elements.page.models.hidden, false);
  assert.equal(elements.page['provider-main'].hidden, true);
  assert.equal(elements.index.hidden, true);
  assert.equal(elements.title.textContent, 'Models & providers');

  assert.equal(nav.show('provider-main'), true);
  assert.equal(elements.page.models.hidden, true);
  assert.equal(elements.page['provider-main'].hidden, false);
  assert.equal(elements.title.textContent, 'Main provider');
  assert.equal(nav.section(), 'provider-main');
});

test('an unknown section is refused, not drawn blank', () => {
  const { elements, nav } = navFor();
  assert.equal(nav.show('no-such-page'), false);
  assert.equal(elements.index.hidden, true);
  assert.equal(nav.section(), null);
});

test('back keeps the edits: pages only hide, the focus returns to the row that opened them', () => {
  const { elements, nav } = navFor();
  // The row belongs to the models page, as the settings rows really do.
  const row = fakeRow('Main model');
  elements.page.models.contains = (node) => node === row;
  nav.show('provider-main', { from: row });
  // The pages are the same elements the forms live in: hiding one does not
  // rebuild the fields of the other.
  const fields = elements.page['provider-main'];
  assert.equal(fields.hidden, false);
  const leftSettings = nav.back();
  assert.equal(leftSettings, false, 'a subpage goes back inside settings');
  assert.equal(elements.page.models.hidden, false);
  assert.equal(fields.hidden, true);
  assert.equal(row.focused, 1, 'the focus goes back to where the page was opened from');
});

test('backing out of the index leaves settings through onExit', () => {
  const { nav, exits } = navFor();
  assert.equal(nav.back(), true, 'the index is the way out');
  assert.deepEqual(exits, [true]);
});

test('the index search filters the rows and says when nothing matches', () => {
  const { elements, nav } = navFor({ rows: ['Models & providers', 'Fast layer'] });
  assert.equal(nav.filter('mod'), 1);
  assert.equal(elements.rows[0].hidden, false);
  assert.equal(elements.rows[1].hidden, true);
  assert.equal(elements.searchEmpty.hidden, true);
  assert.equal(nav.filter('zzz'), 0);
  assert.equal(elements.searchEmpty.hidden, false);
  assert.equal(nav.filter(''), 2);
  assert.equal(elements.rows[1].hidden, false);
});
