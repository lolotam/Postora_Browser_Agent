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

test('the mic window and the worker are recognised, and pages are not', async () => {
  const { isMicWindowSender, isWorkerSender } = await import('../src/permissions/panel-sender.js');
  const runtime = { id: 'ext', getURL: (p) => `chrome-extension://ext/${p}` };
  const mic = 'chrome-extension://ext/src/sidepanel/mic.html';
  assert.equal(isMicWindowSender({ id: 'ext', url: `${mic}?lang=en&epoch=3`, tab: { id: 9 } }, runtime), true);
  assert.equal(isMicWindowSender({ id: 'ext', url: 'https://evil.test/', tab: { id: 9 } }, runtime), false);
  assert.equal(isMicWindowSender({ id: 'other', url: mic }, runtime), false);
  assert.equal(isMicWindowSender({ id: 'ext', url: `${mic}x` }, runtime), false);
  const worker = 'chrome-extension://ext/src/background/service-worker.js';
  assert.equal(isWorkerSender({ id: 'ext', url: worker }, runtime), true);
  assert.equal(isWorkerSender({ id: 'ext', url: worker, tab: { id: 1 } }, runtime), false);
  assert.equal(isWorkerSender({ id: 'ext' }, runtime), true, 'a worker sender without a URL');
  assert.equal(isWorkerSender({ id: 'ext', tab: { id: 1 } }, runtime), false);
  assert.equal(isWorkerSender({ id: 'ext', url: 'https://evil.test/', tab: { id: 1 } }, runtime), false);
});
