import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor } from '../src/agent/tools.js';
import { AccessAuthority, FULL_ACCESS } from '../src/permissions/policy.js';

// A browser whose URL the test moves, with a snapshot that names the page it saw.
function fakeBrowser() {
  const browser = {
    url: 'https://a.test/',
    overlay: { pointTo: async () => {}, say: async () => {} },
    currentTab: async () => ({ id: 1, url: browser.url }),
    snapshot: async () => ({ url: browser.url, title: 'T', scroll: { y: 0, viewport: 100, height: 100 }, elements: ['[0] button "Go"'], offscreen: 0, text: 'page text' }),
    pressKey: async (key) => { if (key === 'Enter') browser.url = 'https://a.test/results'; },
    // The identity of what a key goes to: the element that has the focus.
    captureTarget: async ({ kind = 'focus' } = {}) => ({
      scope: kind === 'tab' ? 'tab' : 'element',
      kind,
      tabId: 1,
      url: browser.url,
      documentId: 'doc-1',
      element: kind === 'tab' ? null : { kind, token: 't1', index: null, x: 0, y: 0, tag: 'body', editable: false, secret: false, focused: true, body: true, label: '' },
      capturedAt: Date.now(),
    }),
    validateTarget: async () => ({ ok: true }),
  };
  return browser;
}

// The worker's own authority, in Full access: this test allows everything on
// purpose, so that the page state is what it is about.
function fullAccess() {
  const access = new AccessAuthority({ sessionId: 'tool-batch-test' });
  access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });
  return access;
}

test('an action inside a batch that leaves the page alone skips the snapshot', async () => {
  const execute = createToolExecutor(fakeBrowser(), { askUser: async () => '', access: fullAccess() });
  const out = await execute('press_key', { key: 'Tab' }, { observe: false });
  assert.match(out.output, /^Pressed Tab\. \(Page state follows the last action of this turn\.\)$/);
  assert.equal(out.pageChanged, undefined);
});

test('an action inside a batch that changes the page reports the new page and flags it', async () => {
  const execute = createToolExecutor(fakeBrowser(), { askUser: async () => '', access: fullAccess() });
  const out = await execute('press_key', { key: 'Enter' }, { observe: false });
  assert.equal(out.pageChanged, true);
  assert.match(out.output, /URL: https:\/\/a\.test\/results/);
});

test('a new document at the same URL (reload, form post) counts as a page change', async () => {
  const browser = fakeBrowser();
  let doc = 'doc-1';
  browser.documentId = async () => doc;
  browser.pressKey = async () => { doc = 'doc-2'; };
  const execute = createToolExecutor(browser, { askUser: async () => '', access: fullAccess() });
  const out = await execute('press_key', { key: 'Enter' }, { observe: false });
  assert.equal(out.pageChanged, true);
});

test('the last action of a turn, and read_page, always report the page', async () => {
  const execute = createToolExecutor(fakeBrowser(), { askUser: async () => '', access: fullAccess() });
  assert.match((await execute('press_key', { key: 'Tab' })).output, /Interactive elements/);
  assert.match((await execute('read_page', {}, { observe: false })).output, /Interactive elements/);
});
