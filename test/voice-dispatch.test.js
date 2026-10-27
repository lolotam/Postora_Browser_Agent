import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BrowserController } from '../src/browser/controller.js';
import * as claims from '../src/sessions/voice-claims.js';
import { pageError, pageErrorKey, selectAllChord } from '../src/voice/voice-input.js';
import * as page from '../src/voice/voice-page.js';

// The moment the input leaves for the page. Everything before it may still be
// prepared: the debugger attaches, the overlay is drawn, the page is read
// again. The guard is asked at the last possible moment, and it looks at the
// page as well as at the lease: a field that lost the focus, an element that
// was replaced and an element that moved must not receive what was approved.
//
// The worker's own voice functions are read out of the worker and run with a
// real controller and a mocked Chrome, so the code that runs in the extension
// is the code that is tested.

const source = fs.readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const voiceInputSource = source.slice(source.indexOf('async function voiceInput('), source.indexOf('\nfunction sessionForTab('));

let nextTab = 81000;

/**
 * The worker, a controller and a page that may change while the input is
 * prepared. `hooks` decides what the page does and when.
 */
function scene(hooks = {}) {
  const tabId = ++nextTab;
  const panelId = `panel-${tabId}`;
  const state = { focus: true, identity: true, x: 12, y: 24 };
  const calls = [];
  const saved = globalThis.chrome;
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: 'https://qa.invalid/', status: 'complete' }),
      onRemoved: { addListener() {} },
    },
    debugger: {
      onDetach: { addListener() {} },
      attach: async () => hooks.attach?.(state),
      sendCommand: async (_target, method, params) => {
        calls.push({ method, ...params });
        await hooks.dispatch?.(method, params, state);
      },
      detach: async () => {},
    },
    scripting: {
      executeScript: async ({ args }) => {
        const kind = args[0];
        if (kind === 'resolve') {
          return [{ result: state.identity ? { ok: true, x: state.x, y: state.y } : { ok: false, errorKey: 'voice.pageGone' } }];
        }
        if (kind === 'focus') {
          return [{ result: state.focus ? { ok: true } : { ok: false, errorKey: 'voice.pageFocusLost' } }];
        }
        throw new Error(`Unexpected probe: ${kind}`);
      },
    },
  };
  const voiceBrowser = new BrowserController();
  voiceBrowser.overlay.click = async () => hooks.overlay?.(state);
  const app = vm.createContext({
    voiceClaims: claims,
    voiceBrowser,
    page,
    pageError,
    pageErrorKey,
    selectAllChord,
    withVoiceBrowser: (task) => task(),
  });
  vm.runInContext(voiceInputSource, app);
  const lease = claims.claimTab(tabId, { panelId, sessionId: panelId });
  return {
    tabId,
    panelId,
    token: lease.token,
    calls,
    state,
    run: (steps) => app.voiceInput({ tabId, panelId, token: lease.token, element: 'approved', expected: { label: 'Email' }, rule: {}, steps }),
    revoke: () => claims.revokeTab(tabId, { panelId, token: lease.token }),
    restore: () => {
      claims.releaseTab(tabId, { panelId, token: lease.token });
      globalThis.chrome = saved;
    },
  };
}

const mutating = (calls, type) => calls.filter((call) => call.type === type);

test('a text that is inserted after the focus moved away never reaches the page', async () => {
  const app = scene({ attach: (state) => { state.focus = false; } });
  try {
    const result = await app.run([{ op: 'text', text: 'private approved text' }]);
    assert.equal(result.ok, false, 'the input is refused');
    assert.equal(mutating(app.calls, 'insertText').length, 0, 'nothing was typed');
  } finally {
    app.restore();
  }
});

test('a lease that is withdrawn while the page is read stops the text', async () => {
  const tabId = ++nextTab;
  const panelId = `panel-${tabId}`;
  const calls = [];
  const saved = globalThis.chrome;
  let revoke = () => {};
  globalThis.chrome = {
    tabs: { get: async (id) => ({ id, url: 'https://qa.invalid/', status: 'complete' }), onRemoved: { addListener() {} } },
    debugger: {
      onDetach: { addListener() {} },
      attach: async () => {},
      sendCommand: async (_target, method, params) => { calls.push({ method, ...params }); },
      detach: async () => {},
    },
    scripting: {
      // The page is read again right before the text goes out, and the lease
      // is withdrawn while that read is under way.
      executeScript: async ({ args }) => {
        revoke();
        return [{ result: args[0] === 'focus' ? { ok: true } : { ok: true, x: 12, y: 24 } }];
      },
    },
  };
  const voiceBrowser = new BrowserController();
  voiceBrowser.overlay.click = async () => {};
  const app = vm.createContext({
    voiceClaims: claims,
    voiceBrowser,
    page,
    pageError,
    pageErrorKey,
    selectAllChord,
    withVoiceBrowser: (task) => task(),
  });
  vm.runInContext(voiceInputSource, app);
  const lease = claims.claimTab(tabId, { panelId, sessionId: panelId });
  revoke = () => claims.revokeTab(tabId, { panelId, token: lease.token });
  try {
    const result = await app.voiceInput({
      tabId, panelId, token: lease.token, element: 'approved', expected: { label: 'Email' }, rule: {}, steps: [{ op: 'text', text: 'private approved text' }],
    });
    assert.equal(result.ok, false, 'the input is refused');
    assert.equal(calls.filter((call) => call.method === 'Input.insertText').length, 0, 'nothing was typed');
  } finally {
    claims.releaseTab(tabId, { panelId, token: lease.token });
    globalThis.chrome = saved;
  }
});

test('a selection that is made after the focus moved away never reaches the page', async () => {
  const app = scene({ attach: (state) => { state.focus = false; } });
  try {
    const result = await app.run([{ op: 'selectAll' }]);
    assert.equal(result.ok, false, 'the input is refused');
    assert.equal(app.calls.filter((call) => /keydown/i.test(call.type ?? '')).length, 0, 'no key went down');
  } finally {
    app.restore();
  }
});

test('an element that was replaced while the overlay was drawn does not get the click', async () => {
  const app = scene({ overlay: (state) => { state.identity = false; } });
  try {
    const result = await app.run([{ op: 'click' }]);
    assert.equal(result.ok, false, 'the input is refused');
    assert.equal(mutating(app.calls, 'mousePressed').length, 0, 'the button was never pressed');
  } finally {
    app.restore();
  }
});

test('an element that moved while the overlay was drawn does not get the click', async () => {
  const app = scene({ overlay: (state) => { state.x = 900; state.y = 900; } });
  try {
    const result = await app.run([{ op: 'click' }]);
    assert.equal(result.ok, false, 'the input is refused');
    assert.equal(mutating(app.calls, 'mousePressed').length, 0, 'the button was never pressed');
  } finally {
    app.restore();
  }
});

test('the button is let go even when the lease is withdrawn after the press', async () => {
  let revoke = () => {};
  const app = scene({ dispatch: (method, params) => { if (params.type === 'mousePressed') revoke(); } });
  revoke = app.revoke;
  try {
    await app.run([{ op: 'click' }]);
    assert.equal(mutating(app.calls, 'mousePressed').length, 1, 'the button was pressed');
    assert.equal(mutating(app.calls, 'mouseReleased').length, 1, 'and it was let go again');
  } finally {
    app.restore();
  }
});

test('the key is let go even when the lease is withdrawn after it went down', async () => {
  let revoke = () => {};
  const app = scene({ dispatch: (method, params) => { if (params.type === 'keyDown') revoke(); } });
  revoke = app.revoke;
  try {
    await app.run([{ op: 'key', key: 'Enter' }]);
    assert.equal(app.calls.filter((call) => /keydown/i.test(call.type ?? '')).length, 1, 'the key went down');
    assert.equal(app.calls.filter((call) => /keyup/i.test(call.type ?? '')).length, 1, 'and it was let go again');
  } finally {
    app.restore();
  }
});
