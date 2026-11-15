import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSidePanelSender } from '../src/permissions/panel-sender.js';

const runtime = { id: 'fixture', getURL: (path) => `chrome-extension://fixture/${path}` };
const base = runtime.getURL('src/sidepanel/index.html');

test('legacy and tab-specific panels are trusted, unrelated URLs are not', () => {
  for (const url of [base, `${base}?tabId=0`, `${base}?tabId=42`]) assert.equal(isSidePanelSender({ id: runtime.id, url }, runtime), true, url);
  for (const suffix of ['.evil', '?tabId=-1', '?tabId=1&other=x', '?tabId=1#x', '?tabId=1&tabId=2', '?other=1', '?tabId=NaN', '?tabId=9007199254740992']) {
    assert.equal(isSidePanelSender({ id: runtime.id, url: base + suffix }, runtime), false, suffix);
  }
  assert.equal(isSidePanelSender({ id: 'foreign', url: base }, runtime), false);
  assert.equal(isSidePanelSender({ id: runtime.id, url: 'https://example.test/src/sidepanel/index.html?tabId=42' }, runtime), false);
  assert.equal(isSidePanelSender(null, runtime), false);
});
