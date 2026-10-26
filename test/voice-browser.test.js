import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeBrowser } from '../src/voice/voice-browser.js';

// The browser the fast path acts on, with Chrome and the worker mocked. What
// is checked here is what the panel can rely on: a cancelled command never
// looks like a finished one, and a claim is taken and given back.

function chromeMock({ tab = { id: 3, windowId: 1, url: 'https://example.test/', title: 'Example', status: 'complete' } } = {}) {
  const saved = globalThis.chrome;
  const listeners = [];
  const sent = [];
  const results = {};
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        const result = results[message.type];
        if (result instanceof Error) throw result;
        return { ok: true, result: typeof result === 'function' ? result(message) : result };
      },
    },
    tabs: {
      get: async (id) => ({ ...tab, id }),
      query: async () => [{ ...tab }],
      onUpdated: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const at = listeners.indexOf(fn);
          if (at >= 0) listeners.splice(at, 1);
        },
      },
    },
  };
  return {
    sent,
    listeners,
    results,
    restore: () => { globalThis.chrome = saved; },
  };
}

test('a command that was cancelled before the page loaded never looks like a finished one', async () => {
  const chrome = chromeMock();
  try {
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(browser.waitForLoad(3, { signal: controller.signal }), { name: 'AbortError' });
  } finally {
    chrome.restore();
  }
});

test('a cancellation while the page is settling is a cancellation, not a success', async () => {
  const chrome = chromeMock();
  try {
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    const controller = new AbortController();
    const pending = browser.waitForLoad(3, { signal: controller.signal });
    // The page finished loading: the wait settles for a moment before it ends.
    for (const listener of chrome.listeners) listener(3, { status: 'complete' });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    chrome.restore();
  }
});

test('a page that finished loading ends the wait', async () => {
  const chrome = chromeMock();
  try {
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    const controller = new AbortController();
    const pending = browser.waitForLoad(3, { signal: controller.signal });
    for (const listener of chrome.listeners) listener(3, { status: 'complete' });
    await pending;
  } finally {
    chrome.restore();
  }
});

test('the claim is taken and given back through the worker', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['voice-claim'] = { ok: true };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    assert.deepEqual(await browser.claim(3), { ok: true });
    assert.deepEqual(chrome.sent.at(-1), { type: 'voice-claim', tabId: 3, panelId: 'panel-a', sessionId: 'session-a' });

    await browser.release(3);
    assert.equal(chrome.sent.at(-1).type, 'voice-release');
    await browser.releaseAll();
    assert.equal(chrome.sent.at(-1).type, 'voice-release-all');
  } finally {
    chrome.restore();
  }
});

test('the owner lookup names the panel, so it does not block its own claim', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['tab-owner'] = { taken: false, owner: null };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    assert.equal(await browser.ownerOf(3), null);
    assert.deepEqual(chrome.sent.at(-1), { type: 'tab-owner', tabId: 3, sessionId: 'session-a', panelId: 'panel-a' });
  } finally {
    chrome.restore();
  }
});

test('a worker that cannot answer the claim fails closed', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['voice-claim'] = new Error('the worker is gone');
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    await assert.rejects(browser.claim(3));
  } finally {
    chrome.restore();
  }
});

test('real input goes through the worker, and a worker that cannot answer does nothing', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['voice-input'] = { ok: true };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    const res = await browser.input(3, [{ op: 'click', x: 4, y: 5 }]);
    assert.equal(res.ok, true);
    assert.deepEqual(chrome.sent.at(-1), { type: 'voice-input', tabId: 3, panelId: 'panel-a', steps: [{ op: 'click', x: 4, y: 5 }] });

    chrome.results['voice-input'] = new Error('the worker is gone');
    const failed = await browser.input(3, [{ op: 'click', x: 4, y: 5 }]);
    assert.equal(failed.ok, false, 'nothing is done when the worker cannot answer');
    assert.equal(failed.errorKey, 'voice.sayOwnerUnknown');
  } finally {
    chrome.restore();
  }
});

test('a tab that is opened does not take the focus before it is bound', async () => {
  const chrome = chromeMock();
  try {
    const created = [];
    globalThis.chrome.tabs.create = async (options) => {
      created.push(options);
      return { id: 9, windowId: options.windowId, url: options.url, title: '' };
    };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    const tab = await browser.openTab({ url: 'https://example.test/', windowId: 1 });
    assert.equal(tab.id, 9);
    assert.equal(created[0].active, false, 'the tab waits until it is bound and claimed');
  } finally {
    chrome.restore();
  }
});
