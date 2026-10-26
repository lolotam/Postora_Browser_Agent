import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BrowserController } from '../src/browser/controller.js';
import * as claims from '../src/sessions/voice-claims.js';

// The worker's side of the voice path: the claim, the real input and the
// release of the tab. The functions are read out of the worker and run with a
// mocked browser, so the code that runs in the extension is the code that is
// tested.

const source = fs.readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const voiceInputSource = source.slice(source.indexOf('async function voiceInput('), source.indexOf('\nfunction sessionForTab('));
const releaseSource = source.slice(source.indexOf('async function releaseVoiceClaim('), source.indexOf('\nfunction sessionForTab('));

/** The worker's voice functions with a browser that only records what it did. */
function worker({ gate = null, calls = [], attached = new Set() } = {}) {
  const context = vm.createContext({
    voiceClaims: claims,
    withVoiceBrowser: async (task) => {
      if (gate) await gate;
      return task();
    },
    voiceBrowser: {
      borrowTab: async () => {},
      detachTab: async (tabId) => { attached.delete(tabId); },
      clickAt: async () => calls.push('click'),
      insertText: async () => calls.push('text'),
      pressKey: async () => calls.push('key'),
    },
  });
  vm.runInContext(`${voiceInputSource}\n${releaseSource}`, context);
  return context;
}

test('a claim that was given back while the input was waiting does not click or type', async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const calls = [];
  const app = worker({ gate, calls });
  claims.claimTab(21, { panelId: 'panel-a', sessionId: 'session-a' });

  const pending = app.voiceInput({ tabId: 21, panelId: 'panel-a', steps: [{ op: 'click', x: 10, y: 10 }, { op: 'text', text: 'must not type' }] });
  claims.releasePanel('panel-a');
  open();
  const result = await pending;

  assert.deepEqual(calls, [], 'nothing was clicked and nothing was typed');
  assert.equal(result.ok, false, 'the input is refused');
  claims.releasePanel('panel-a');
});

test('a claim that is still held lets the input through', async () => {
  const calls = [];
  const app = worker({ calls });
  claims.claimTab(22, { panelId: 'panel-a', sessionId: 'session-a' });

  const result = await app.voiceInput({ tabId: 22, panelId: 'panel-a', steps: [{ op: 'click', x: 10, y: 10 }, { op: 'text', text: 'hello' }] });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['click', 'text']);
  claims.releasePanel('panel-a');
});

test('another panel cannot use a claim it does not hold', async () => {
  const calls = [];
  const app = worker({ calls });
  claims.claimTab(23, { panelId: 'panel-a', sessionId: 'session-a' });

  const result = await app.voiceInput({ tabId: 23, panelId: 'panel-b', steps: [{ op: 'click', x: 10, y: 10 }] });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
  claims.releasePanel('panel-a');
});

test('giving the claim back lets the tab go, and the debugger is detached from it', async () => {
  const attached = new Set([24]);
  const app = worker({ attached });
  claims.claimTab(24, { panelId: 'panel-a', sessionId: 'session-a' });

  await app.releaseVoiceClaim(24, 'panel-a');

  assert.equal(claims.claimOf(24), null, 'the claim is given back');
  assert.equal(attached.has(24), false, 'the debugger is detached from the tab');
});

test('a session that is working in a tab is refused, even in its own group', async () => {
  const saved = globalThis.chrome;
  globalThis.chrome = {
    debugger: { onDetach: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, get: async (id) => ({ id, groupId: 7 }) },
  };
  try {
    const controller = new BrowserController({ isTakenByOther: () => 'voice control' });
    controller.groupId = 7;
    await assert.rejects(controller.claimTab(1), /voice control/);
  } finally {
    globalThis.chrome = saved;
  }
});
