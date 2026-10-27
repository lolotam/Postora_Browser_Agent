import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeBrowser } from '../src/voice/voice-browser.js';
import * as page from '../src/voice/voice-page.js';

// The browser the fast path acts on, with Chrome and the worker mocked. What
// is checked here is what the panel can rely on: a cancelled command never
// looks like a finished one, a claim is taken and given back, and every change
// leaves the panel and goes to the worker.

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

test('a delayed cancellation reply cannot erase a newer claimed command', async () => {
  const chrome = chromeMock();
  let finish;
  try {
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    chrome.results['voice-claim'] = { ok: true, token: 'lease-1', command: { id: 'old-command' } };
    await browser.claim(3);
    chrome.results['voice-cancel'] = () => new Promise((resolve) => { finish = resolve; });
    const pending = browser.cancel();
    assert.equal(chrome.sent.at(-1).commandId, 'old-command');
    chrome.results['voice-claim'] = { ok: true, token: 'lease-2', command: { id: 'new-command' } };
    await browser.claim(3);
    finish(true);
    await pending;
    chrome.results['voice-action'] = { ok: true };
    await browser.input(3, [], { action: 'press_key' });
    assert.equal(chrome.sent.at(-1).commandId, 'new-command');
  } finally {
    finish?.(true);
    chrome.restore();
  }
});

test('the claim is taken and given back through the worker', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['voice-claim'] = { ok: true, token: 'lease-1', command: { id: 'cmd-1', revision: 1 } };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    assert.deepEqual(await browser.claim(3), { ok: true, token: 'lease-1', command: { id: 'cmd-1', revision: 1 } });
    assert.deepEqual(chrome.sent.at(-1), { type: 'voice-claim', tabId: 3, panelId: 'panel-a', sessionId: 'session-a' });

    await browser.release(3);
    assert.equal(chrome.sent.at(-1).type, 'voice-release');
    assert.equal(chrome.sent.at(-1).token, 'lease-1', 'the release names the lease it gives back');
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

test('real input goes to the worker as one action, and a worker that cannot answer does nothing', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['voice-claim'] = { ok: true, token: 'lease-1', command: { id: 'cmd-1', revision: 1 } };
    chrome.results['voice-action'] = { ok: true };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    await browser.claim(3);
    const res = await browser.input(3, [{ op: 'click', element: 'v1' }], { element: 'v1', expected: { kind: 'button' }, action: 'click' });
    assert.equal(res.ok, true);
    assert.deepEqual(chrome.sent.at(-1), {
      type: 'voice-action',
      action: 'click',
      tabId: 3,
      panelId: 'panel-a',
      sessionId: 'session-a',
      commandId: 'cmd-1',
      token: 'lease-1',
      args: { element: 'v1' },
      element: 'v1',
      expected: { kind: 'button' },
      steps: [{ op: 'click', element: 'v1' }],
    }, 'the action, the approved element and its identity travel with the input');

    chrome.results['voice-action'] = new Error('the worker is gone');
    const failed = await browser.input(3, [{ op: 'click', element: 'v1' }], { action: 'click' });
    assert.equal(failed.ok, false, 'nothing is done when the worker cannot answer');
    assert.equal(failed.errorKey, 'voice.sayOwnerUnknown');
  } finally {
    chrome.restore();
  }
});

test('a tab that is opened goes to the worker, and it waits until it is bound', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['voice-action'] = { ok: true, tab: { id: 9, windowId: 1, url: 'https://example.test/', title: '' } };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    const tab = await browser.openTab({ url: 'https://example.test/', windowId: 1, tabId: 3 });
    assert.equal(tab.id, 9);
    const sent = chrome.sent.at(-1);
    assert.equal(sent.type, 'voice-action');
    assert.equal(sent.action, 'open_tab', 'the worker opens the tab, not the panel');
    assert.equal(sent.tabId, 3, 'the tab the command is on is the one the lease covers');
    assert.equal(sent.args.url, 'https://example.test/', 'the address travels with the action');
  } finally {
    chrome.restore();
  }
});

test('a composite typed action binds the exact text and submit flag to its steps', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['voice-action'] = { ok: true };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    const steps = [{ op: 'click', element: 'field' }, { op: 'selectAll' }, { op: 'text', text: 'SYNTHETIC_VALUE' }, { op: 'key', key: 'Enter' }];
    await browser.input(3, steps, { action: 'type_text', element: 'field' });
    assert.deepEqual(chrome.sent.at(-1).args, { element: 'field', text: 'SYNTHETIC_VALUE', submit: true });
    assert.deepEqual(chrome.sent.at(-1).steps, steps);
    await browser.input(3, steps.slice(0, 3), { action: 'type_text', element: 'field' });
    assert.equal(chrome.sent.at(-1).args.submit, false);
  } finally {
    chrome.restore();
  }
});

test('the page is read through the worker, by the name of the script and never by its source', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['voice-claim'] = { ok: true, token: 'lease-1', command: { id: 'cmd-1', revision: 1 } };
    chrome.results['voice-action'] = { ok: true, result: [] };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    await browser.claim(3);
    await browser.inject(3, page.pageProbe, ['collect', { purpose: 'click' }]);
    const sent = chrome.sent.at(-1);
    assert.equal(sent.action, 'probe');
    assert.equal(sent.script, 'pageProbe', 'the name of the script travels');
    assert.equal(typeof sent.func, 'undefined', 'the source of a function never travels');
  } finally {
    chrome.restore();
  }
});

test('a script the path does not know is refused before it reaches the worker', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['voice-action'] = { ok: true, result: [] };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    await assert.rejects(browser.inject(3, () => {}, []), /not one the voice path may run/);
    assert.equal(chrome.sent.length, 0, 'nothing was sent');
  } finally {
    chrome.restore();
  }
});

test('a command that is cancelled tells the worker that the command is over', async () => {
  const chrome = chromeMock();
  try {
    chrome.results['voice-claim'] = { ok: true, token: 'lease-1', command: { id: 'cmd-1', revision: 1 } };
    chrome.results['voice-action'] = { ok: true };
    const browser = createChromeBrowser({ sessionId: 'session-a', panelId: 'panel-a' });
    await browser.claim(3);
    await browser.cancel();
    const sent = chrome.sent.at(-1);
    assert.equal(sent.type, 'voice-cancel');
    assert.equal(sent.commandId, 'cmd-1');
    assert.equal(sent.panelId, 'panel-a');
  } finally {
    chrome.restore();
  }
});
